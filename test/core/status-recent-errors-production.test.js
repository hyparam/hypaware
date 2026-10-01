// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus } from '../../src/core/daemon/status.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { centralSeedPath } from '../../src/core/config/apply.js'

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

// The third boundary case, and the ordinary one: on every install whose log is
// still smaller than the tail, the read starts at byte 0 and there is no
// fragment at all, so the discard must not fire. That is what the `start > 0`
// guard is for, and nothing pinned it: a discard that runs unconditionally
// eats the first record of the file, and on a log whose only error is that
// record the count is back to 0. The fixture opens with the error so that
// dropping the guard is visible rather than silent.
// @ref LLP 0349#bounded-reads [tests]:
test('a daemon log smaller than the tail is read whole, first record included', async () => {
  const { hypHome, stateRoot } = await makeHome()
  await writeDaemonLog(stateRoot, [
    { level: 'error', event: 'daemon.boot_failed', agoMs: 60 * 60_000 },
    { level: 'info', event: 'daemon.starting', agoMs: 50 * 60_000 },
  ])

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(
    report.recentErrorCount,
    1,
    'the first line of a short log is a whole record, not a fragment to discard',
  )
})

// Issue #1187, item 1. LLP 0349 #bounded-reads opens "Every read is bounded,
// because `hyp status` is a report", but the dev-telemetry store was the one
// input read whole: `fsp.readFile(..., 'utf8')` per `logs-*.jsonl`, inside a
// `catch { continue }`. A file past V8's maximum string length makes that read
// throw, the catch swallows it, and the file contributes 0 - the same silent
// zero the rest of this counter exists to remove. The store is reachable only
// under `HYP_DEV_TELEMETRY=1`, but the claim in the doc is unqualified, so the
// read is bounded per file the same way the daemon log is. The fixture holds
// four ERROR records: two before the tail, the one the boundary cuts, and one
// inside the tail. Only the last is in scope, so an unbounded read counts 4
// where a bounded read counts 1.
// @ref LLP 0349#bounded-reads [tests]:
test('each dev-telemetry file is read from a tail, not whole', async () => {
  const { hypHome, stateRoot } = await makeHome()
  // Stated independently of the constant that implements it, the same way the
  // daemon-log tail is above.
  const tailBytes = 1024 * 1024
  /**
   * An OTel log record of a chosen byte length, padded inside `body` so the
   * padding cannot be mistaken for structure.
   *
   * @param {'INFO'|'ERROR'} severityText
   * @param {number} bytes
   */
  const line = (severityText, bytes) => {
    const base = JSON.stringify({
      serviceName: 'hypaware',
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      severityNumber: severityText === 'ERROR' ? 17 : 9,
      severityText,
      body: '',
    })
    return base.slice(0, -2) + 'x'.repeat(Math.max(0, bytes - base.length)) + '"}'
  }

  // Older than the tail, and so uncounted no matter how long the developer has
  // been running with dev telemetry on.
  const head = [line('ERROR', 300), line('ERROR', 300)]
  // The record the tail boundary falls inside. It is an ERROR, so counting the
  // fragment would be visible rather than silent.
  const boundary = line('ERROR', 4000)
  const tail = [line('INFO', 300)]
  let tailLen = Buffer.byteLength(tail[0]) + 1
  while (tailLen < tailBytes - 3000) {
    const filler = line('INFO', 300)
    tail.push(filler)
    tailLen += Buffer.byteLength(filler) + 1
  }
  const lastError = line('ERROR', 300)
  tail.push(lastError)
  tailLen += Buffer.byteLength(lastError) + 1

  const content = [...head, boundary, ...tail].join('\n') + '\n'
  const size = Buffer.byteLength(content)
  const boundaryStart = head.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0)
  const readFrom = size - tailBytes
  assert.ok(size > tailBytes, 'the fixture is larger than the tail')
  assert.ok(
    readFrom > boundaryStart && readFrom < boundaryStart + Buffer.byteLength(boundary),
    'the fixture puts the tail boundary inside a record, not at a record edge',
  )
  const dir = path.join(stateRoot, 'dev-telemetry')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'logs-4242.jsonl'), content)

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(
    report.recentErrorCount,
    1,
    'the one error inside the tail, not the two before it and not the half-record at the boundary',
  )
})

// The ordinary dev-telemetry file is smaller than the tail, so it is read from
// byte 0 and has no leading fragment to discard. A discard that fires
// unconditionally eats its first record, and on a file whose only error is
// that record the count is back to 0.
// @ref LLP 0349#bounded-reads [tests]:
test('a dev-telemetry file smaller than the tail keeps its first record', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const dir = path.join(stateRoot, 'dev-telemetry')
  await fs.mkdir(dir, { recursive: true })
  const record = (/** @type {'INFO'|'ERROR'} */ severityText) => JSON.stringify({
    serviceName: 'hypaware',
    timestamp: new Date().toISOString(),
    severityNumber: severityText === 'ERROR' ? 17 : 9,
    severityText,
    body: 'sink.export_batch.failed',
  })
  await fs.writeFile(
    path.join(dir, 'logs-4242.jsonl'),
    [record('ERROR'), record('INFO')].join('\n') + '\n',
  )

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.recentErrorCount, 1, 'the first line of a short file is a whole record')
})

// The same defect one process boundary later. LLP 0038 moved every source,
// sink, maintenance and config failure into the supervised processing child,
// which appends to its own `daemon.log` below `processing/`. A counter that
// read only the gateway's log would go back to reporting a quiet machine
// while the half of the daemon that captures anything was failing, and it
// would do it silently: a zero, not an error.
// @ref LLP 0038#lifecycle-and-operator-behavior [tests]: the processor keeps its own runtime files, so a reader of the daemon log has two to read
test('errors the processing daemon recorded are counted too', async () => {
  const { hypHome, stateRoot } = await makeHome()
  // The gateway's own log carries only its supervision lines.
  await writeDaemonLog(stateRoot, [
    { level: 'info', event: 'gateway.ready', agoMs: 90 * 60_000 },
    { level: 'error', event: 'gateway.status_failed', agoMs: 80 * 60_000 },
  ])
  // Everything the kernel daemon emits is now under `processing/`.
  await writeDaemonLog(path.join(stateRoot, 'processing'), [
    { level: 'info', event: 'daemon.healthy', agoMs: 70 * 60_000 },
    { level: 'error', event: 'daemon.tick_failed', agoMs: 60 * 60_000 },
    { level: 'error', event: 'daemon.sink_materialize_failed', agoMs: 50 * 60_000 },
    { level: 'warn', event: 'daemon.source_status_failed', agoMs: 40 * 60_000 },
  ])

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.recentErrorCount, 3, 'one gateway error plus two processing errors')
  const diag = report.diagnostics.find((d) => d.kind === 'recent_errors')
  assert.ok(diag, 'a recent_errors diagnostic is raised')
  assert.ok(diag.message.includes('3 in the daemon log'), diag.message)
})

/**
 * A `HYP_HOME` with one configured destination, a daemon snapshot recording
 * its last success, and one outbox file per failed export.
 *
 * @param {{ failures: number[], success?: number | string, outbox?: boolean }} scenario
 */
async function seedDestination(scenario) {
  const { hypHome, stateRoot } = await makeHome()
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2, plugins: [], sinks: { central: { plugin: '@hypaware/central', config: {} } },
  }))
  await fs.mkdir(path.join(stateRoot, 'run'), { recursive: true })
  // A destination that has never succeeded has no stamp at all, which is a
  // different fixture from one whose stamp is unusable: both must warn, and
  // only writing the row for the second tells them apart.
  const lastSuccessAt = typeof scenario.success === 'number'
    ? new Date(Date.now() - scenario.success * 60_000).toISOString()
    : scenario.success
  await fs.writeFile(path.join(stateRoot, 'run', 'status.json'), JSON.stringify({
    sinks: [{ instance: 'central', ...(lastSuccessAt === undefined ? {} : { lastSuccessAt }) }],
  }))
  if (scenario.outbox !== false) {
    await writeOutbox(stateRoot, 'central', scenario.failures.map((minutes) => ({ agoMs: minutes * 60_000, error: 'fetch failed' })))
  }
  return { hypHome, stateRoot }
}

// A destination needs attention while it holds a failed export that no later
// success has answered. One unresolved failure is enough, and no amount of
// ageing turns one into a recovery. The four rows whose answer the threshold
// rule got wrong are marked: it could not fire on a destination exporting
// more slowly than the bar, so `never succeeded, two failures` printed
// `HypAware · Healthy` while its only destination had never delivered
// anything (issue #2337).
// @ref LLP 0453#warning-rule [tests]: an unresolved failure warns; only a strictly later success clears it
for (const scenario of [
  // Was `false` under the threshold rule (one failure, no span).
  { name: 'never succeeded, one failure', failures: [1], warns: true },
  // Was `false`: two failures never reached the count of three. This is the
  // blocker case - the only destination has never delivered anything.
  { name: 'never succeeded, two failures', failures: [20, 1], warns: true },
  // Was `false`: the whole burst had aged out of the 24-hour window. Ageing
  // is not recovery, so the window no longer decides this.
  { name: 'unresolved failure older than the window', failures: [1500], warns: true },
  { name: 'never succeeded, sustained failures', failures: [20, 10, 1], warns: true },
  { name: 'a later success clears every earlier failure', failures: [20, 10, 2], success: 1, warns: false },
  // Was `false`: the streak restarted at the success and never rebuilt. Two
  // failures stand after it, so two failures are unanswered.
  { name: 'failures after a success still stand', failures: [40, 30, 20, 10, 1], success: 15, warns: true },
  { name: 'a success stamp that does not parse is no recovery evidence', failures: [20, 10, 1], success: 'invalid', warns: true },
  { name: 'a success stamp in the future is no recovery evidence', failures: [20, 10, 1], success: -60, warns: true },
  // Symmetric with the row above: a stamp ahead of the clock is evidence
  // about nothing, whichever side of the comparison it sits on.
  { name: 'a failure stamp in the future does not warn', failures: [-60], warns: false },
  { name: 'a configured destination with an empty outbox does not warn', failures: [], warns: false },
  { name: 'a configured destination with no outbox at all does not warn', failures: [], outbox: false, warns: false },
  { name: 'a past success and no failures does not warn', failures: [], success: 30, warns: false },
]) {
  test(`export warning: ${scenario.name}`, async (t) => {
    const { hypHome } = await seedDestination(scenario)
    t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
    const report = await collectHypAwareStatus(collectOpts(hypHome))
    // The 24-hour window survives everywhere it was already doing a job: the
    // history count still drops the failure from 25 hours ago, in the same
    // run where that failure raises the warning.
    assert.equal(
      report.recentErrorCount,
      scenario.outbox === false ? 0 : scenario.failures.filter((minutes) => minutes < 1440).length,
      'recent_error_count keeps its 24-hour horizon',
    )
    assert.equal(report.diagnostics.some((d) => d.kind === 'recent_errors'), false)
    const warning = report.diagnostics.find((d) => d.kind === 'sink_export_failing')
    assert.equal(Boolean(warning), scenario.warns)
    if (warning) {
      // A success only answers failures older than itself, and only when it
      // is usable at all: an unparseable or future stamp answers nothing.
      const clearsOlderThan = typeof scenario.success === 'number' && scenario.success >= 0 ? scenario.success : Infinity
      const unresolved = scenario.failures.filter((minutes) => minutes > 0 && minutes <= clearsOlderThan).length
      assert.equal(warning.severity, 'warning')
      assert.match(warning.message, new RegExp(`^central: ${unresolved} failed export attempt${unresolved === 1 ? '' : 's'} with no later success recorded; last failure .+ ago$`))
      // A remote destination is not repaired by bouncing the local daemon.
      assert.equal(warning.repair.some((r) => r.includes('daemon restart')), false)
    }
  })
}

// The boundary the one-line rule does not settle, pinned at the millisecond
// rather than approached from a relative offset: the fixture reads the stamp
// back out of the filename the sink driver wrote, so the two values are the
// same instant by construction and not by arithmetic that could drift.
//
// A tie warns. At equal stamps nothing in the record says which came first,
// and the conservative reading of "no later success" is the one that keeps
// looking. One millisecond later, the success is strictly later and clears.
// @ref LLP 0453#warning-rule [tests]: only a strictly later success clears a failure, so equal stamps warn
test('export warning: a success sharing the failure millisecond warns, one millisecond later clears', async (t) => {
  const { hypHome, stateRoot } = await seedDestination({ failures: [5] })
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  const outbox = path.join(stateRoot, 'sinks', 'central', 'outbox')
  const [batchFile] = await fs.readdir(outbox)
  const stamp = /-(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)-\d+\.json$/.exec(batchFile)
  assert.ok(stamp, `the fixture filename carries the batch stamp: ${batchFile}`)
  const failedAtMs = Date.parse(stamp[1])

  /** @param {number} ms */
  const reportWithSuccessAt = async (ms) => {
    await fs.writeFile(path.join(stateRoot, 'run', 'status.json'), JSON.stringify({
      sinks: [{ instance: 'central', lastSuccessAt: new Date(ms).toISOString() }],
    }))
    const report = await collectHypAwareStatus(collectOpts(hypHome))
    return report.diagnostics.some((d) => d.kind === 'sink_export_failing')
  }

  assert.equal(await reportWithSuccessAt(failedAtMs), true, 'an identical stamp is not a later success')
  assert.equal(await reportWithSuccessAt(failedAtMs - 1), true, 'an earlier success is not a later success')
  assert.equal(await reportWithSuccessAt(failedAtMs + 1), false, 'one millisecond later is a later success')
})

// Three properties that argue with each other, in one fixture:
//
//  - Recovery is per destination: `recovered` succeeding must not mask
//    `failing`, which still holds three unanswered failures.
//  - `removed` has a failing outbox and is not in `sinks[]`, so it is a
//    destination this install no longer has, and nothing asks an operator to
//    repair one they already deleted. Leaving `sinks[]` is also the only door
//    out of a warning nothing else can clear, since no success is ever
//    recorded for a destination that is never exercised again.
//  - Its files are still history: all ten errors stay in
//    `recent_error_count`, the three from `removed` included.
// @ref LLP 0453#warning-rule [tests]: one destination's success clears only its own warning; an unconfigured destination raises none
test('export recovery is per destination and dev telemetry cannot revive recovered warnings', async (t) => {
  const { hypHome, stateRoot } = await makeHome()
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2, plugins: [], sinks: {
      recovered: { plugin: '@hypaware/central', config: {} },
      failing: { plugin: '@hypaware/central', config: {} },
    },
  }))
  await fs.mkdir(path.join(stateRoot, 'run'), { recursive: true })
  await fs.writeFile(path.join(stateRoot, 'run', 'status.json'), JSON.stringify({
    sinks: [{ instance: 'recovered', lastSuccessAt: new Date().toISOString() }],
  }))
  for (const instance of ['recovered', 'failing', 'removed']) {
    await writeOutbox(stateRoot, instance, [20, 10, 1].map((minutes) => ({ agoMs: minutes * 60_000, error: 'HTTP 504' })))
  }
  await fs.mkdir(path.join(stateRoot, 'dev-telemetry'), { recursive: true })
  await fs.writeFile(path.join(stateRoot, 'dev-telemetry', 'logs-4242.jsonl'), JSON.stringify({
    severityText: 'ERROR', timestamp: new Date().toISOString(), body: 'sink.export_batch.failed',
  }) + '\n')
  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.recentErrorCount, 10, 'all historical errors remain counted')
  assert.equal(report.diagnostics.some((d) => d.kind === 'recent_errors'), false)
  const warnings = report.diagnostics.filter((d) => d.kind === 'sink_export_failing')
  assert.equal(warnings.length, 1, warnings.map((w) => w.message).join(' | '))
  assert.match(warnings[0].message, /^failing: 3 failed export attempts with no later success recorded/)
})

// Deleting the `sinks` key is a removal like emptying it or replacing the set,
// so it must silence the destination too (issue #2361). It is the one spelling
// that leaves `sinks[]` recovered from the prior daemon's `status.json`, which
// the report still needs for the install's shape but must not read as a
// destination there is anything left to repair.
// @ref LLP 0453#warning-rule [tests]: a destination only the status file still names is not a configured destination, so it raises no warning
test('export warning: a sink only a prior daemon status file names shows its shape and raises no warning', async (t) => {
  const { hypHome, stateRoot } = await makeHome()
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  // No `sinks` key at all: the operator deleted the destination from the config.
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }))
  await fs.mkdir(path.join(stateRoot, 'run'), { recursive: true })
  await fs.writeFile(path.join(stateRoot, 'run', 'status.json'), JSON.stringify({
    sinks: [{ instance: 'ghost', plugin: '@hypaware/central', kind: 'request' }],
  }))
  // One failure outside the 24-hour history window and one inside it, so a
  // pass on `recentErrorCount` can only mean the in-window failure was
  // actually counted, not that the window excluded everything on offer.
  await writeOutbox(stateRoot, 'ghost', [
    { agoMs: 90 * 24 * 60 * 60_000, error: 'fetch failed' },
    { agoMs: 60_000, error: 'fetch failed' },
  ])

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.deepEqual(
    report.sinks.map((s) => s.instance),
    ['ghost'],
    'the recovered row still renders the shape of the install',
  )
  assert.deepEqual(
    report.diagnostics.filter((d) => d.kind === 'sink_export_failing').map((d) => d.message),
    [],
    'a destination the operator deleted raises no export warning',
  )
  // The files are still history: the in-window failure is counted even
  // though the destination that produced it is not configured.
  assert.equal(report.recentErrorCount, 1)
})

// A local config that fails to parse is not the operator naming a smaller
// `sinks` set; it is a file `hyp status` could not read. Reading it the same
// way as a deleted `sinks` key would silence a live export failure the
// operator never asked to stop hearing about, the exact silent-suppression
// issue #2337 built this warning against.
// @ref LLP 0453#warning-rule [tests]: an unreadable local config is not a configured-set removal, so a destination it would have named still warns
test('export warning: an unreadable local config still warns about a failing sink', async (t) => {
  const { hypHome, stateRoot } = await makeHome()
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  // Central names no sinks either, so `config.sinks` is empty for a reason
  // that has nothing to do with the unreadable local file.
  await fs.mkdir(path.dirname(centralSeedPath(stateRoot)), { recursive: true })
  await fs.writeFile(centralSeedPath(stateRoot), JSON.stringify({ version: 2, plugins: [] }))
  await fs.writeFile(defaultConfigPath(hypHome), '{{{ not json')
  await fs.mkdir(path.join(stateRoot, 'run'), { recursive: true })
  await fs.writeFile(path.join(stateRoot, 'run', 'status.json'), JSON.stringify({
    sinks: [{ instance: 'central', plugin: '@hypaware/central', kind: 'request' }],
  }))
  await writeOutbox(stateRoot, 'central', [{ agoMs: 60_000, error: 'fetch failed' }])

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.deepEqual(
    report.sinks.map((s) => s.instance),
    ['central'],
    'the recovered row still renders the shape of the install',
  )
  const warnings = report.diagnostics.filter((d) => d.kind === 'sink_export_failing')
  assert.equal(warnings.length, 1, 'an unreadable config must not suppress a live export failure')
  assert.match(warnings[0].message, /^central: 1 failed export attempt with no later success recorded/)
})

// A local `sinks` entry the central layer's merge drops as `invalid_merge`
// (an unknown plugin, say) is a rejected local addition, not the operator
// clearing the destination. It leaves `config.sinks` empty by the same path
// as a deleted `sinks` key, so it must not be read as the same intent.
// @ref LLP 0453#warning-rule [tests]: a sinks entry the layer merge dropped is not a configured-set removal, so the destination still warns
test('export warning: a sinks entry the central layer merge dropped still warns', async (t) => {
  const { hypHome, stateRoot } = await makeHome()
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  await fs.mkdir(path.dirname(centralSeedPath(stateRoot)), { recursive: true })
  await fs.writeFile(centralSeedPath(stateRoot), JSON.stringify({ version: 2, plugins: [] }))
  // Names a plugin this install has no manifest for, so `resolveLayeredConfig`
  // drops it rather than merging it in.
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2, plugins: [], sinks: { central: { plugin: '@hypaware/does-not-exist', config: {} } },
  }))
  await fs.mkdir(path.join(stateRoot, 'run'), { recursive: true })
  await fs.writeFile(path.join(stateRoot, 'run', 'status.json'), JSON.stringify({
    sinks: [{ instance: 'central', plugin: '@hypaware/central', kind: 'request' }],
  }))
  await writeOutbox(stateRoot, 'central', [{ agoMs: 60_000, error: 'fetch failed' }])

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.deepEqual(
    report.sinks.map((s) => s.instance),
    ['central'],
    'the recovered row still renders the shape of the install',
  )
  assert.deepEqual(
    report.layered?.drops,
    [{ section: 'sinks', key: 'central', reason: 'invalid_merge', detail: 'sink_plugin_unknown' }],
    'ground truth: the merge actually dropped the local entry',
  )
  const warnings = report.diagnostics.filter((d) => d.kind === 'sink_export_failing')
  assert.equal(warnings.length, 1, 'a merge-dropped entry must not suppress a live export failure')
  assert.match(warnings[0].message, /^central: 1 failed export attempt with no later success recorded/)
})

// A central layer that fails to parse is the third non-removal: it leaves
// `config.sinks` empty the same way an unreadable local config or a
// merge-dropped entry does, without the operator having removed the
// destination the central layer itself names. Reading it as a removal would
// silence a live export failure the same way the other two spellings would.
// @ref LLP 0453#warning-rule [tests]: an unreadable central layer is not a configured-set removal, so a destination it would have named still warns
test('export warning: an unreadable central layer still warns about a failing sink', async (t) => {
  const { hypHome, stateRoot } = await makeHome()
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  // Local config names no sinks either, so `config.sinks` is empty for a
  // reason that has nothing to do with the unreadable central file.
  await fs.mkdir(path.dirname(centralSeedPath(stateRoot)), { recursive: true })
  await fs.writeFile(centralSeedPath(stateRoot), '{{{ not json')
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }))
  await fs.mkdir(path.join(stateRoot, 'run'), { recursive: true })
  await fs.writeFile(path.join(stateRoot, 'run', 'status.json'), JSON.stringify({
    sinks: [{ instance: 'central', plugin: '@hypaware/central', kind: 'request' }],
  }))
  await writeOutbox(stateRoot, 'central', [{ agoMs: 60_000, error: 'fetch failed' }])

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.deepEqual(
    report.sinks.map((s) => s.instance),
    ['central'],
    'the recovered row still renders the shape of the install',
  )
  const warnings = report.diagnostics.filter((d) => d.kind === 'sink_export_failing')
  assert.equal(warnings.length, 1, 'an unreadable central layer must not suppress a live export failure')
  assert.match(warnings[0].message, /^central: 1 failed export attempt with no later success recorded/)
})
