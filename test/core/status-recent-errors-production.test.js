// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus } from '../../src/core/daemon/status.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'

/** @import { CollectStatusOptions } from '../../src/core/daemon/types.js' */

// Issue #1182 (the surviving half of #1003). `recent_error_count` walked
// `dev-telemetry/`, a directory that only exists under `HYP_DEV_TELEMETRY=1`.
// On an ordinary install the counter was therefore structurally zero: not "we
// looked and found nothing" but "we did not look", printed as a fact. During
// the #1003 brownout it read `0` while the central sink was failing 1,016
// exports with `429 gateway_pending_high_water` and 849 with `fetch failed`,
// every one of which had already been written to the local record.
// @ref LLP 0349#read-the-records-production-keeps [tests]:

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-recent-errors-'))
  const stateRoot = path.join(hypHome, 'hypaware')
  await fs.mkdir(stateRoot, { recursive: true })
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }) + '\n')
  return { hypHome, stateRoot }
}

/**
 * @param {string} hypHome
 * @returns {CollectStatusOptions}
 */
function collectOpts(hypHome) {
  // Stub the launch-agent probe so the developer's own installed daemon
  // cannot leak into the report.
  return {
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
    platform: 'darwin',
    isLaunchAgentInstalled: () => false,
  }
}

/**
 * The line-oriented record `openDaemonLog` appends to on every install,
 * dev telemetry or not.
 *
 * @param {string} stateRoot
 * @param {{ level: string, event: string, agoMs: number }[]} records
 */
async function writeDaemonLog(stateRoot, records) {
  const dir = path.join(stateRoot, 'logs')
  await fs.mkdir(dir, { recursive: true })
  const lines = records.map((r) => JSON.stringify({
    ts: new Date(Date.now() - r.agoMs).toISOString(),
    level: r.level,
    event: r.event,
    pid: 4242,
    dev_run_id: 'test-run',
    mode: 'detached',
  }))
  await fs.writeFile(path.join(dir, 'daemon.log'), lines.join('\n') + '\n')
}

/**
 * One file per failed export batch, exactly as the sink driver's
 * `persistOutbox` writes them: `<batchId>.json` under the sink instance,
 * where `batchId` is `<instance>-<iso>-<seq>`.
 *
 * @param {string} stateRoot
 * @param {string} instance
 * @param {{ agoMs: number, error: string }[]} batches
 */
async function writeOutbox(stateRoot, instance, batches) {
  const dir = path.join(stateRoot, 'sinks', instance, 'outbox')
  await fs.mkdir(dir, { recursive: true })
  let seq = 0
  for (const batch of batches) {
    seq += 1
    const recordedAt = new Date(Date.now() - batch.agoMs).toISOString()
    const batchId = `${instance}-${recordedAt}-${seq}`
    await fs.writeFile(path.join(dir, `${batchId}.json`), JSON.stringify({
      batchId,
      sinkInstance: instance,
      plugin: '@hypaware/central',
      recordedAt,
      error: batch.error,
      partitions: [],
    }))
  }
}

test('a production install with recorded failures does not report zero recent errors', async () => {
  const { hypHome, stateRoot } = await makeHome()

  // Ground truth for the defect: this install has never run with
  // `HYP_DEV_TELEMETRY=1`, so the only directory the old counter read does
  // not exist at all.
  await assert.rejects(
    () => fs.stat(path.join(stateRoot, 'dev-telemetry')),
    /ENOENT/,
    'a production install has no dev-telemetry directory',
  )

  // What such an install does keep: the daemon log, and one outbox file per
  // failed export batch.
  await writeDaemonLog(stateRoot, [
    { level: 'info', event: 'daemon.healthy', agoMs: 90 * 60_000 },
    { level: 'error', event: 'daemon.tick_failed', agoMs: 60 * 60_000 },
    { level: 'warn', event: 'daemon.source_status_failed', agoMs: 50 * 60_000 },
    { level: 'error', event: 'daemon.maintenance_failed', agoMs: 40 * 60_000 },
    { level: 'error', event: 'daemon.sink_materialize_failed', agoMs: 30 * 60_000 },
  ])
  await writeOutbox(stateRoot, 'central', [
    { agoMs: 20 * 60_000, error: '429 gateway_pending_high_water' },
    { agoMs: 10 * 60_000, error: 'fetch failed' },
  ])

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.recentErrorCount, 5, 'three daemon-log errors plus two failed export batches')
  const diag = report.diagnostics.find((d) => d.kind === 'recent_errors')
  assert.ok(diag, 'a recent_errors diagnostic is raised')
  assert.equal(diag.severity, 'warning')
})

// The over-fixing guard, half one. The dev-telemetry path this counter was
// built on still counts exactly what it counted before: `severityText` of
// `ERROR` in `logs-<pid>.jsonl`, and nothing else in the directory.
test('the dev-telemetry counter still counts ERROR log records', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const dir = path.join(stateRoot, 'dev-telemetry')
  await fs.mkdir(dir, { recursive: true })
  const line = (/** @type {string} */ severityText, /** @type {string} */ body) => JSON.stringify({
    serviceName: 'hypaware',
    timestamp: new Date().toISOString(),
    severityNumber: 17,
    severityText,
    body,
  })
  await fs.writeFile(path.join(dir, 'logs-4242.jsonl'), [
    line('INFO', 'sink.export_batch.ok'),
    line('ERROR', 'sink.export_batch.failed'),
    line('ERROR', 'sink.outbox_write_failed'),
    'not json at all',
  ].join('\n') + '\n')
  // A sibling signal file in the same directory must stay uncounted.
  await fs.writeFile(path.join(dir, 'traces-4242.jsonl'), line('ERROR', 'a span, not a log') + '\n')

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.recentErrorCount, 2)
  assert.ok(report.diagnostics.find((d) => d.kind === 'recent_errors'), 'the diagnostic still fires')
})

// The over-fixing guard, half two. A quiet install still reports zero and
// raises nothing: the fix must not turn every install into a warning.
test('an install with nothing recorded still reports zero recent errors', async () => {
  const { hypHome, stateRoot } = await makeHome()
  await writeDaemonLog(stateRoot, [
    { level: 'info', event: 'daemon.healthy', agoMs: 60_000 },
    { level: 'warn', event: 'daemon.degraded', agoMs: 30_000 },
  ])
  await fs.mkdir(path.join(stateRoot, 'sinks', 'local', 'outbox'), { recursive: true })

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.recentErrorCount, 0)
  assert.equal(report.diagnostics.find((d) => d.kind === 'recent_errors'), undefined)
})

// "Recent" now has a stated horizon, so an install that failed last month and
// was fixed does not carry a standing warning forever.
test('failures older than the window are not counted', async () => {
  const { hypHome, stateRoot } = await makeHome()
  // Older than the stated 24-hour horizon. Written as a literal rather than
  // imported: the horizon is a promise the report makes to its reader, so the
  // test states it independently of the constant that implements it.
  const stale = 25 * 3_600_000
  await writeDaemonLog(stateRoot, [
    { level: 'error', event: 'daemon.tick_failed', agoMs: stale },
  ])
  await writeOutbox(stateRoot, 'central', [
    { agoMs: stale, error: 'fetch failed' },
    { agoMs: 60_000, error: 'fetch failed' },
  ])

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.recentErrorCount, 1, 'only the batch inside the window counts')
})
