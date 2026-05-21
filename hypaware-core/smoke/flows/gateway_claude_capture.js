// @ts-check

import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'

import { Attr, installObservability } from '../../../src/core/observability/index.js'
import { defaultConfigPath } from '../../../src/core/config/schema.js'
import { runDaemon } from '../../../src/core/daemon/runtime.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'

/**
 * Phase 7 smoke — Anthropic-style passthrough plus failed-upstream
 * capture under the daemon boot path.
 *
 * Boots `runDaemon` with `@hypaware/ai-gateway` activated, pointed at
 * three test upstreams:
 *
 *   - `anthropic_ok`     — succeeds with 200 + echoed body (mirrors a
 *                          successful Anthropic call from Claude Code).
 *   - `anthropic_fail`   — returns 500 with a JSON error body (mirrors
 *                          a provider-side failure).
 *   - `anthropic_dead`   — points at a port nothing listens on; the
 *                          proxy returns 502 and records the connection
 *                          error.
 *
 * Bead `hy-bbyi` assertions:
 *
 *   - Each exchange writes one normalized request message row to
 *     `ai_gateway_messages`, all queryable by `dev_run_id` via
 *     `hyp query sql`.
 *   - Gateway diagnostics survive under `attributes.gateway`.
 *   - Daemon self-telemetry (JSONL exporter, under `HYP_DEV_TELEMETRY=1`)
 *     contains `source.start` (ai-gateway), at least one `sink.tick`,
 *     `cache.append` for `ai_gateway_messages`, and `daemon.shutdown`.
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'gateway_claude_capture: tracer provider not installed — expected HYP_DEV_TELEMETRY=1'
    )
  }

  // ----- Spin up upstreams the gateway will route to -----
  const echo = await startEchoUpstream()
  const errorUpstream = await startStatusUpstream(500, {
    type: 'invalid_request_error',
    message: 'simulated upstream failure',
  })
  const deadPort = await reserveFreePort()

  // ----- Stage a v2 config that selects @hypaware/ai-gateway -----
  const configPath = defaultConfigPath(harness.hypHome)
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, JSON.stringify({
    version: 2,
    plugins: [
      {
        name: '@hypaware/ai-gateway',
        config: {
          listen: '127.0.0.1:0',
          upstreams: [
            { name: 'anthropic_ok',   base_url: echo.url,          path_prefix: '/v1/messages' },
            { name: 'anthropic_fail', base_url: errorUpstream.url, path_prefix: '/v1/error'    },
            { name: 'anthropic_dead', base_url: `http://127.0.0.1:${deadPort}`, path_prefix: '/v1/dead' },
          ],
        },
      },
    ],
    query: { cache: { retention: { default_days: 30 } } },
  }, null, 2))

  process.env.HYP_HOME = harness.hypHome
  process.env.HYP_CONFIG = configPath

  // ----- Boot the daemon (under the new boot path) -----
  // tickIntervalMs=50 so at least one `sink.tick` span fires before stop.
  const handle = await runDaemon({
    hypHome: harness.hypHome,
    configPath,
    env: process.env,
    runId: harness.devRunId,
    tickIntervalMs: 50,
    installSignalHandlers: false,
  })

  const snapshot = handle.snapshot()
  expect.that(
    'snapshot: ai-gateway source bound to a loopback host',
    snapshot.sources.find((s) => s.name === 'ai-gateway')?.details,
    (v) => v !== undefined &&
      typeof /** @type {any} */ (v).host === 'string' &&
      typeof /** @type {any} */ (v).port === 'number',
  )
  const gatewayDetails = /** @type {{ host: string, port: number }} */ (
    snapshot.sources.find((s) => s.name === 'ai-gateway')?.details
  )
  const gatewayUrl = `http://${gatewayDetails.host}:${gatewayDetails.port}`

  // ----- Issue three exchanges through the daemon's gateway -----
  const okBody = JSON.stringify({
    model: 'claude-3-opus',
    messages: [{ role: 'user', content: `ok ${harness.devRunId}` }],
  })
  const okResp = await postJson(`${gatewayUrl}/v1/messages`, harness.devRunId, okBody)
  expect.that(
    'gateway: anthropic_ok upstream returned 200',
    okResp.statusCode,
    (v) => v === 200,
  )

  const failBody = JSON.stringify({
    model: 'claude-3-opus',
    messages: [{ role: 'user', content: `fail ${harness.devRunId}` }],
  })
  const failResp = await postJson(`${gatewayUrl}/v1/error`, harness.devRunId, failBody)
  expect.that(
    'gateway: anthropic_fail upstream returned 500',
    failResp.statusCode,
    (v) => v === 500,
  )

  const deadBody = JSON.stringify({
    model: 'claude-3-opus',
    messages: [{ role: 'user', content: `dead ${harness.devRunId}` }],
  })
  const deadResp = await postJson(`${gatewayUrl}/v1/dead`, harness.devRunId, deadBody)
  expect.that(
    'gateway: anthropic_dead returned 502 (upstream connection failed)',
    deadResp.statusCode,
    (v) => v === 502,
  )

  // Wait for the in-flight sink tick interval to fire at least once so
  // the JSONL exporter captures a `sink.tick` span before shutdown.
  await sleep(120)

  // ----- Shut down the daemon (drains the gateway's recorder) -----
  await handle.stop()
  await handle.done

  // The kernel is dead; flush observability before we boot a fresh
  // dispatch kernel for the query so the JSONL files contain every
  // daemon-emitted span when `expect.traces()` reads them.
  await obs.shutdown()

  await echo.close()
  await errorUpstream.close()

  // ----- Query ai_gateway_messages with a fresh dispatch boot -----
  const sql = `
    select
      content_text,
      JSON_VALUE(attributes, '$.gateway.status_code') as status_code,
      JSON_VALUE(attributes, '$.gateway.error') as error,
      JSON_VALUE(attributes, '$.gateway.upstream') as upstream,
      JSON_VALUE(attributes, '$.gateway.path') as path
    from ai_gateway_messages
    where JSON_VALUE(attributes, '$.dev_run_id') = '${harness.devRunId}'
    order by message_created_at
  `.trim().replace(/\s+/g, ' ')
  const stdoutBuf = makeBuf()
  const stderrBuf = makeBuf()
  const code = await dispatch(
    ['query', 'sql', sql, '--refresh', 'always', '--format', 'json'],
    { stdout: stdoutBuf, stderr: stderrBuf, env: { ...process.env, HYP_HOME: harness.hypHome, HYP_CONFIG: configPath } },
  )
  expect.that('dispatch: query sql exited 0', code, (v) => v === 0)
  expect.that(
    'stderr: query sql had no errors',
    stderrBuf.text(),
    (v) => typeof v === 'string' && v.length === 0,
  )

  /** @type {any[]} */
  let rows
  try {
    rows = JSON.parse(stdoutBuf.text())
  } catch (err) {
    expect.that(
      `stdout: query sql --format json was valid JSON (${err instanceof Error ? err.message : String(err)})`,
      false,
      (v) => v === true,
    )
    return
  }
  expect.that(
    'query: ai_gateway_messages has exactly three normalized request rows for the dev_run_id',
    rows,
    (v) => Array.isArray(v) && v.length === 3,
  )

  // The diagnostic fields live under attributes.gateway on each part row.
  const byUpstream = new Map(rows.map((r) => [r.upstream, r]))
  expect.that(
    'query: anthropic_ok row has status_code=200 and no error',
    [byUpstream.get('anthropic_ok')?.status_code, byUpstream.get('anthropic_ok')?.error],
    ([s, e]) => Number(s) === 200 && (e === null || e === undefined),
  )
  expect.that(
    'query: anthropic_fail row has status_code=500',
    byUpstream.get('anthropic_fail')?.status_code,
    (v) => Number(v) === 500,
  )
  expect.that(
    'query: anthropic_dead row has status_code=502 and a non-null error string',
    [byUpstream.get('anthropic_dead')?.status_code, byUpstream.get('anthropic_dead')?.error],
    ([s, e]) => Number(s) === 502 && typeof e === 'string' && e.length > 0,
  )

  // ----- Daemon-self-telemetry assertions (JSONL) -----
  const traces = await expect.traces()

  const sourceStart = traces.filter(
    (/** @type {any} */ t) => t.name === 'source.start' && t.attributes?.hyp_source === 'ai-gateway',
  )
  expect.that(
    'traces: source.start span for ai-gateway emitted under daemon boot',
    sourceStart,
    (rows) => Array.isArray(rows) && rows.length >= 1,
  )

  const sinkTicks = traces.filter((/** @type {any} */ t) => t.name === 'sink.tick')
  expect.that(
    'traces: at least one sink.tick span fired during the daemon run',
    sinkTicks,
    (rows) => Array.isArray(rows) && rows.length >= 1,
  )

  const cacheAppends = traces.filter(
    (/** @type {any} */ t) =>
      t.name === 'cache.append' && t.attributes?.hyp_dataset === 'ai_gateway_messages',
  )
  expect.that(
    'traces: at least three cache.append spans for ai_gateway_messages (one per exchange)',
    cacheAppends,
    (rows) => Array.isArray(rows) && rows.length >= 3,
  )

  const shutdownSpans = traces.filter((/** @type {any} */ t) => t.name === 'daemon.shutdown')
  expect.that(
    'traces: daemon.shutdown span recorded under the daemon boot path',
    shutdownSpans,
    (rows) => Array.isArray(rows) && rows.length >= 1,
  )

  // The contract header still tags the per-exchange log event even
  // though query rows now expose it via attributes.dev_run_id.
  const logs = await expect.logs()
  const exchanges = logs.filter(
    (/** @type {any} */ l) =>
      l.body === 'aigw.exchange' && l.attributes?.[Attr.DEV_RUN_ID] === harness.devRunId,
  )
  expect.that(
    'logs: aigw.exchange tagged with dev_run_id for every captured request',
    exchanges,
    (rows) => Array.isArray(rows) && rows.length === 3,
  )
}

// ---------------------------------------------------------------------
// Test upstream helpers
// ---------------------------------------------------------------------

/**
 * Start an in-process HTTP echo upstream — the proxy's "happy path".
 * Returns 200 with a JSON body that echoes the bytes the proxy
 * forwarded.
 *
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
async function startEchoUpstream() {
  const server = http.createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          url: req.url ?? '',
          method: req.method ?? '',
          bodyBytes: Buffer.concat(chunks).byteLength,
        }),
      )
    })
    req.on('error', () => res.end())
  })
  await listen(server)
  const addr = server.address()
  if (!addr || typeof addr !== 'object') throw new Error('echo: failed to bind')
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => closeServer(server),
  }
}

/**
 * Start an upstream that always responds with `statusCode` and a JSON
 * error body. Used to simulate a "real" provider-side failure (the
 * connection succeeds but the request is rejected).
 *
 * @param {number} statusCode
 * @param {Record<string, unknown>} body
 */
async function startStatusUpstream(statusCode, body) {
  const payload = JSON.stringify(body)
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(statusCode, { 'content-type': 'application/json' })
      res.end(payload)
    })
  })
  await listen(server)
  const addr = server.address()
  if (!addr || typeof addr !== 'object') throw new Error('error-upstream: failed to bind')
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => closeServer(server),
  }
}

/**
 * Reserve and immediately release an ephemeral port. Used to simulate
 * a "dead" upstream — pointing the gateway at this port produces a
 * connection-refused error the proxy turns into a 502 + recorded
 * `error` row.
 *
 * @returns {Promise<number>}
 */
async function reserveFreePort() {
  const probe = http.createServer()
  await listen(probe)
  const addr = probe.address()
  if (!addr || typeof addr !== 'object') throw new Error('reserveFreePort: no address')
  const port = addr.port
  await closeServer(probe)
  return port
}

/**
 * @param {http.Server} server
 */
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.once('listening', () => resolve(undefined))
    server.listen(0, '127.0.0.1')
  })
}

/**
 * @param {http.Server} server
 */
function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve(undefined)))
  })
}

/**
 * Issue one POST through the gateway carrying the contract header.
 *
 * @param {string} url
 * @param {string} runId
 * @param {string} body
 * @returns {Promise<{ statusCode: number, body: string }>}
 */
function postJson(url, runId, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const req = http.request(
      {
        method: 'POST',
        hostname: parsed.hostname,
        port: Number.parseInt(parsed.port, 10),
        path: parsed.pathname + parsed.search,
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
          'x-hyp-dev-run-id': runId,
        },
      },
      (res) => {
        /** @type {Buffer[]} */
        const chunks = []
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeBuf() {
  /** @type {string[]} */
  const chunks = []
  return {
    /** @param {unknown} chunk */
    write(chunk) {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk))
      return true
    },
    text() {
      return chunks.join('')
    },
  }
}
