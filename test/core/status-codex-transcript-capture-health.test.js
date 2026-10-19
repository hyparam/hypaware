// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus } from '../../src/core/daemon/status.js'
import { renderStatusJson, renderStatusText } from '../../src/core/commands/status.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { appendRowsToSourceTable } from '../../src/core/cache/partition.js'
import { aiGatewayDatasetRegistration } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'

/** @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js' */

/**
 * Default-mode Codex captures by transcript sweep: no marker, no telemetry,
 * no gateway entrypoint. Its capture-health line is the one signal that can
 * say it works, and it reads the newest row the sweep landed (issue #2069).
 *
 * @ref LLP 0546#newest-partition [tests]: a row found is ok, none is unknown, and only the newest date partition is read
 */

/** @type {ColumnSpec[]} */
const COLUMNS = [
  { name: 'session_id', type: 'STRING', nullable: false },
  { name: 'client_name', type: 'STRING', nullable: true },
  { name: 'message_created_at', type: 'TIMESTAMP', nullable: false },
  { name: 'date', type: 'STRING', nullable: false },
]

function makeBuf() {
  let value = ''
  return {
    write(/** @type {string} */ chunk) {
      value += String(chunk)
      return true
    },
    text() {
      return value
    },
  }
}

/**
 * @param {(ctx: { hypHome: string, cacheRoot: string, collect: (codexConfig: Record<string, unknown>) => Promise<{ report: any, text: string, json: any }> }) => Promise<void>} body
 */
async function withHome(body) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-codex-health-'))
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-codex-health-home-'))
  try {
    const stateRoot = path.join(hypHome, 'hypaware')
    await fs.mkdir(stateRoot, { recursive: true })
    const cacheRoot = path.join(stateRoot, 'cache')
    const env = { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '', HOME: home }
    /** @param {Record<string, unknown>} codexConfig */
    const collect = async (codexConfig) => {
      await fs.writeFile(
        defaultConfigPath(hypHome),
        JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/codex', config: codexConfig }] }) + '\n'
      )
      const report = await collectHypAwareStatus({ env, homeDir: home })
      const stdout = makeBuf()
      renderStatusText({ report, clientNames: [], datasets: [], cacheRoot, stdout })
      const json = renderStatusJson({ report, clientNames: [], datasets: [], cacheRoot })
      return { report, text: stdout.text(), json }
    }
    await body({ hypHome, cacheRoot, collect })
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
    await fs.rm(home, { recursive: true, force: true })
  }
}

/**
 * @param {string} cacheRoot
 * @param {Record<string, unknown>[]} rows
 */
async function appendCodexRows(cacheRoot, rows) {
  await appendRowsToSourceTable(cacheRoot, 'ai_gateway_messages', ['source=codex'], COLUMNS, rows, {
    declaration: aiGatewayDatasetRegistration().cachePartitioning,
  })
}

test('a transcript-mode codex with no cached rows reads capture unconfirmed', async () => {
  await withHome(async ({ collect }) => {
    const { report, text, json } = await collect({})
    const entry = report.captureHealth.find((/** @type {any} */ c) => c.client === 'codex')
    assert.ok(entry, 'codex gets a capture-health line')
    assert.equal(entry.state, 'unknown', 'configured is not captured')
    assert.equal(entry.lastEventAt, null)
    assert.match(text, /- codex {2}no captured rows yet {2}\[capture unconfirmed\]/)
    assert.equal(
      report.diagnostics.filter((/** @type {any} */ d) => d.kind === 'capture_gap').length,
      0,
      'unconfirmed raises no diagnostic'
    )
    const row = json.capture_health.find((/** @type {any} */ c) => c.client === 'codex')
    assert.equal(row.state, 'unknown')
  })
})

test('a transcript-mode codex with cached rows reads the newest partition and is ok', async () => {
  await withHome(async ({ cacheRoot, collect }) => {
    await appendCodexRows(cacheRoot, [
      { session_id: 's1', client_name: 'codex', message_created_at: '2026-08-16T09:00:00Z', date: '2026-08-16' },
      // Out of step with its partition on purpose: a read of every partition
      // would return this, the bounded one never opens it.
      { session_id: 's1', client_name: 'codex', message_created_at: '2026-08-20T00:00:00Z', date: '2026-08-16' },
    ])
    await appendCodexRows(cacheRoot, [
      { session_id: 's2', client_name: 'codex', message_created_at: '2026-08-17T08:00:00Z', date: '2026-08-17' },
      { session_id: 's2', client_name: 'codex', message_created_at: '2026-08-17T09:30:00Z', date: '2026-08-17' },
    ])
    const { report, text, json } = await collect({})
    const entry = report.captureHealth.find((/** @type {any} */ c) => c.client === 'codex')
    assert.ok(entry)
    assert.equal(entry.state, 'ok')
    assert.equal(entry.lastEventAt, '2026-08-17T09:30:00.000Z', 'newest row of the newest partition')
    assert.equal(entry.lastTranscriptActivityAt, null)
    assert.equal(entry.gapMs, 0)
    assert.match(text, /- codex {2}last captured row /)
    assert.doesNotMatch(text, /- codex .*\[capture unconfirmed\]/)
    const row = json.capture_health.find((/** @type {any} */ c) => c.client === 'codex')
    assert.equal(row.state, 'ok')
  })
})

test('gateway-mode codex gets no transcript-lane capture-health line', async () => {
  await withHome(async ({ cacheRoot, collect }) => {
    await appendCodexRows(cacheRoot, [
      { session_id: 's1', client_name: 'codex', message_created_at: '2026-08-17T09:00:00Z', date: '2026-08-17' },
    ])
    const { report } = await collect({ capture_mode: 'gateway' })
    assert.equal(report.captureHealth.find((/** @type {any} */ c) => c.client === 'codex'), undefined)
  })
})
