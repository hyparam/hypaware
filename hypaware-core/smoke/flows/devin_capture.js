// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'

import { captureSession } from '../../bridges/devin/capture.js'
import { devinDetail, devinMessages, devinPage } from '../fixtures/devin.js'
import { installObservability, getLogger } from '../../../src/core/observability/index.js'
import { runDaemon } from '../../../src/core/daemon/runtime.js'
import { defaultConfigPath } from '../../../src/core/config/schema.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'

/** @import { AddressInfo } from 'node:net' */

/**
 * Fake vendor API -> selected-session bridge -> real OTLP receiver -> cache -> SQL.
 * Includes a failed API request, collector outage and restart from checkpoint.
 * Vendor traffic is synthetic. This does not establish real Devin access.
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  const log = getLogger('smoke.devin')
  const configPath = defaultConfigPath(harness.hypHome)
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, JSON.stringify({ version: 2,
    plugins: [{ name: '@hypaware/otel', config: { listen_host: '127.0.0.1', listen_port: 0 } }],
    query: { cache: { retention: { default_days: 30 } } },
  }))
  process.env.HYP_CONFIG = configPath
  const daemon = await runDaemon({ hypHome: harness.hypHome, configPath, env: process.env,
    runId: harness.devRunId, installSignalHandlers: false, tickIntervalMs: 50 })
  const details = /** @type {{ listen_port: number }} */ (daemon.snapshot().sources.find(s => s.name === 'otlp')?.details)
  const target = `http://127.0.0.1:${details.listen_port}/v1/logs`
  let apiAttempts = 0
  let collectorDown = true
  let failedPosts = 0
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (req.method === 'POST' && url.pathname === '/v1/logs') {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        if (collectorDown) {
          failedPosts++
          res.writeHead(503).end('{}')
          return
        }
        assert.equal(req.headers.authorization, undefined)
        const response = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks) })
        res.writeHead(response.status, { 'content-type': 'application/json' }).end(await response.text())
        return
      }
      assert.equal(req.headers.authorization, 'Bearer cog_synthetic')
      assert.equal(req.method, 'GET')
      assert.ok(url.pathname.startsWith('/v3/organizations/org-fixture/sessions/devin-abc123'))
      res.setHeader('content-type', 'application/json')
      if (!apiAttempts++) {
        res.writeHead(503).end('{}')
        return
      }
      res.end(JSON.stringify(url.pathname.endsWith('/messages') ? devinPage(url.searchParams.get('after')) : devinDetail))
    } catch { res.writeHead(500).end('{}') }
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)))
    const port = /** @type {AddressInfo} */ (server.address()).port
    const base = `http://127.0.0.1:${port}`
    const options = { orgId: 'org-fixture', sessionId: 'devin-abc123', token: 'cog_synthetic',
      endpoint: `${base}/v1/logs`, statePath: path.join(harness.tmpDir, 'checkpoint.json') }
    const runtime = { apiBase: base, sleep: async () => {} }
    log.info('smoke.step', { smoke_name: harness.smokeName, smoke_step: 'collector_outage', status: 'ok' })
    await assert.rejects(captureSession(options, runtime), /otlp_retry_exhausted/)
    assert.equal(failedPosts, 3)
    collectorDown = false
    log.info('smoke.step', { smoke_name: harness.smokeName, smoke_step: 'recovery', status: 'ok' })
    const recovered = await captureSession(options, runtime)
    assert.equal(recovered.distinctMessages, 2)
    assert.equal(recovered.delivered, 3)
    const replay = await captureSession(options, runtime)
    assert.equal(replay.delivered, 0)
    assert.equal(replay.pages, 1)
  } finally {
    await new Promise(resolve => {
      server.close(() => resolve(undefined))
      server.closeAllConnections()
    })
    await daemon.stop()
    await daemon.done
  }
  log.info('smoke.step', { smoke_name: harness.smokeName, smoke_step: 'query', status: 'ok' })
  const stdout = makeBuf()
  const stderr = makeBuf()
  const code = await dispatch(['query', 'sql',
    "select timestamp, observedTimestamp, body, attributes from logs where serviceName = 'devin' order by timestamp",
    '--refresh', 'always', '--format', 'json'],
  { stdout, stderr, env: { ...process.env, HYP_HOME: harness.hypHome, HYP_CONFIG: configPath } })
  assert.equal(code, 0, stderr.text())
  const rows = JSON.parse(stdout.text())
  expect.that('query: exactly two messages and one session snapshot survive outage/replay', rows.length, n => n === 3)
  const bodies = rows.map((/** @type {any} */ row) => typeof row.body === 'string' ? JSON.parse(row.body) : row.body)
  assert.deepEqual(bodies, [...devinMessages, devinDetail])
  const first = rows[0]
  assert.equal(new Date(first.timestamp).getTime(), devinMessages[0].created_at * 1000)
  assert.ok(new Date(first.observedTimestamp).getTime() > new Date(first.timestamp).getTime())
  const attrs = typeof first.attributes === 'string' ? JSON.parse(first.attributes) : first.attributes
  assert.equal(attrs.event_id, devinMessages[0].event_id)
  assert.equal(attrs.session_id, 'devin-abc123')
  await obs.shutdown()
  const logs = await expect.logs()
  expect.that('telemetry: failed collector attempt and subsequent recovery are recorded', logs,
    records => records.some((/** @type {any} */ r) => r.body === 'devin.bridge.failed') &&
      records.some((/** @type {any} */ r) => r.body === 'devin.bridge.done'))
  assert.ok(!JSON.stringify(logs).includes('cog_synthetic'))
  assert.ok(!JSON.stringify(logs).includes(devinMessages[0].message))
  const traces = await expect.traces()
  expect.that('telemetry: real receiver persisted Devin logs', traces,
    records => records.some((/** @type {any} */ r) => r.name === 'otel.receive' && r.attributes?.signal === 'logs' && r.attributes?.status === 'ok'))
}

function makeBuf() {
  const chunks = []
  return {
    write(/** @type {unknown} */ value) {
      chunks.push(String(value))
      return true
    },
    text() { return chunks.join('') },
  }
}
