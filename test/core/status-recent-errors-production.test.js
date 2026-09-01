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

// The daemon log is unrotated and grows for the life of the install, so it is
// read from a tail rather than whole. Two things have to hold at once and
// neither was pinned: the read must stop at the tail, so an ever-growing file
// does not make `hyp status` an ever-growing cost, and the record the tail
// boundary cuts in half must be discarded rather than parsed as a whole one.
// The fixture places the boundary in the middle of a known `error` line, so a
// fragment that was miscounted, or that crashed the parse, shows up as a wrong
// number instead of passing quietly.
// @ref LLP 0349#bounded-reads [tests]:
test('only the tail of the daemon log is read, and the record it cuts is discarded', async () => {
  const { hypHome, stateRoot } = await makeHome()
  // Stated independently of the constant that implements it, the same way the
  // window is: the size of the tail is a promise the report makes to its reader.
  const tailBytes = 1024 * 1024
  /**
   * A parseable daemon-log line of a chosen byte length, padded inside the
   * message field so the padding cannot be mistaken for structure.
   *
   * @param {'info'|'error'} level
   * @param {number} bytes
   */
  const line = (level, bytes) => {
    const base = JSON.stringify({
      ts: new Date(Date.now() - 60_000).toISOString(),
      level,
      event: 'daemon.tick_failed',
      pid: 4242,
      dev_run_id: 'test-run',
      mode: 'detached',
      message: '',
    })
    return base.slice(0, -2) + 'x'.repeat(Math.max(0, bytes - base.length)) + '"}'
  }

  // Everything after the boundary line: three errors that must all be counted,
  // padded out to just under the tail size.
  const tail = [line('error', 300), line('info', 300), line('error', 300)]
  let tailLen = tail.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0)
  while (tailLen < tailBytes - 3000) {
    const filler = line('info', 300)
    tail.push(filler)
    tailLen += Buffer.byteLength(filler) + 1
  }
  const lastError = line('error', 300)
  tail.push(lastError)
  tailLen += Buffer.byteLength(lastError) + 1

  // The line the boundary falls inside. It is an `error`, so counting the
  // fragment would be visible; it is long enough that the boundary lands well
  // inside it rather than at either edge.
  const boundary = line('error', 4000)
  // Older still, and so outside the tail: errors that must not be counted no
  // matter how long the file has been growing.
  const head = [line('error', 300), line('error', 300)]

  const content = [...head, boundary, ...tail].join('\n') + '\n'
  const size = Buffer.byteLength(content)
  const boundaryStart = head.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0)
  const readFrom = size - tailBytes
  assert.ok(size > tailBytes, 'the fixture is larger than the tail')
  assert.ok(
    readFrom > boundaryStart && readFrom < boundaryStart + Buffer.byteLength(boundary),
    'the fixture puts the tail boundary inside the boundary line, not at a record edge',
  )
  await fs.mkdir(path.join(stateRoot, 'logs'), { recursive: true })
  await fs.writeFile(path.join(stateRoot, 'logs', 'daemon.log'), content)

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(
    report.recentErrorCount,
    3,
    'the three errors inside the tail, not the two before it and not the half-line at the boundary',
  )
})

// The other half of the boundary. When the tail offset happens to land exactly
// on the start of a record, the tail already begins at a record edge and there
// is no fragment to discard - but a discard that fires unconditionally eats a
// whole valid line. On a log whose only error is that line, the count reads 0
// again, which is the one answer this counter exists to stop giving.
// @ref LLP 0349#bounded-reads [tests]:
test('a tail boundary that lands on a record edge keeps that record', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const tailBytes = 1024 * 1024
  /**
   * @param {'info'|'error'} level
   * @param {number} bytes
   */
  const line = (level, bytes) => {
    const base = JSON.stringify({
      ts: new Date(Date.now() - 60_000).toISOString(),
      level,
      event: 'daemon.tick_failed',
      pid: 4242,
      dev_run_id: 'test-run',
      mode: 'detached',
      message: '',
    })
    return base.slice(0, -2) + 'x'.repeat(Math.max(0, bytes - base.length)) + '"}'
  }

  // Build a suffix of exactly `tailBytes`, beginning with the error whose
  // first byte the boundary lands on.
  const boundary = line('error', 300)
  const suffix = [boundary, line('info', 300), line('error', 300)]
  let suffixLen = suffix.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0)
  while (suffixLen < tailBytes - 2000) {
    const filler = line('info', 300)
    suffix.push(filler)
    suffixLen += Buffer.byteLength(filler) + 1
  }
  // Pad one last line so the suffix is exactly the tail, to the byte.
  const pad = line('info', tailBytes - suffixLen - 1)
  suffix.push(pad)
  suffixLen += Buffer.byteLength(pad) + 1
  assert.equal(suffixLen, tailBytes, 'the suffix is exactly one tail long')

  // Anything before it is out of the tail and must not be counted.
  const head = [line('error', 300), line('error', 300)]
  const content = [...head, ...suffix].join('\n') + '\n'
  const headLen = head.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0)
  assert.equal(
    Buffer.byteLength(content) - tailBytes,
    headLen,
    'the fixture puts the tail boundary exactly on the first byte of a record',
  )
  await fs.mkdir(path.join(stateRoot, 'logs'), { recursive: true })
  await fs.writeFile(path.join(stateRoot, 'logs', 'daemon.log'), content)

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(
    report.recentErrorCount,
    2,
    'the record the boundary lands on is kept, not discarded as a fragment',
  )
})
