// @ts-check

/**
 * Recent errors for `hyp status`: bounded tails of the daemon log and dev
 * telemetry, and sink outbox batches waiting to send.
 *
 * @import { SinkMaterializeFailure, SinkSnapshot, StatusDiagnostic } from '../../../../src/core/daemon/types.js'
 * @import { FileHandle } from 'node:fs/promises'
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import { diagnosticEntries, readDiagnosticRecord } from '../../sinks/diagnostic_history.js'
import { daemonLogPath, devTelemetryDir, processingStateRoot, sinksRoot } from '../../runtime/paths.js'
import { sanitizeLabel } from '../../util/json_util.js'
import { formatGapDuration } from './capture_health.js'

/**
 * The horizon `recent_error_count` reports over. The counter had none: it
 * returned every ERROR record still on disk, so a machine that failed once in
 * March carried the warning until someone deleted the file. A day is the
 * shortest window that still spans an overnight brownout (the #1003 incident
 * ran for hours while nobody was watching), and it is self-clearing, so an
 * install that was repaired stops warning on its own.
 *
 * @ref LLP 0349#the-window [implements]: a stated 24-hour horizon, so "recent" means something and a fixed install stops warning
 */
export const RECENT_ERROR_WINDOW_HOURS = 24

export const RECENT_ERROR_WINDOW_MS = RECENT_ERROR_WINDOW_HOURS * 3_600_000

/**
 * How much of `daemon.log` is read. The file is appended to for the life of
 * the install and nothing rotates it (the note on the control-file watcher in
 * `src/core/daemon/control.js` says so in as many words), so it is the one
 * store here that could be arbitrarily large, and `hyp status` is a report
 * that must not grow a cost with the age of the machine.
 *
 * The bound is sized against the worst case the window has to hold. A daemon
 * that fails at every tick writes 1,440 records a day, and one
 * `daemon.tick_failed` line with a real message runs a little over 200 bytes,
 * so a day of them is around 300 KiB before the info and warn lines
 * interleaved with them. A quarter-megabyte tail would therefore have cut
 * inside the stated window on exactly the install that most needs counting; a
 * megabyte clears it several times over and still reads in a millisecond or
 * two. The count stays a floor rather than a census: a daemon noisy enough to
 * overflow even this reports every error the tail holds, which is emphatically
 * not zero.
 *
 * @ref LLP 0349#bounded-reads [implements]: the daemon log is read from the tail, never whole
 */
const DAEMON_LOG_TAIL_BYTES = 1024 * 1024

/**
 * The same number as the daemon log, applied per dev-telemetry file, but not
 * the same sizing argument. That store is written only under
 * `HYP_DEV_TELEMETRY=1`, and nothing rotates it either, so a developer who
 * leaves the flag on has the same unbounded file the daemon log would be. A
 * whole-file read of one past V8's maximum string length throws, and the
 * counter's `catch` turns that into the file contributing 0: the silent zero
 * this counter exists to remove, arriving by a different door. One tail per
 * file closes that door.
 *
 * What does not carry over is the headroom. LLP 0349 sized the daemon log's
 * megabyte against ~200-byte records from `fileLog` alone, several times over
 * the worst case the 24-hour window has to hold. This store takes every
 * `getLogger` emission at every severity, with the full attribute and
 * resource bags attached, which measures around 475 bytes a record: roughly
 * 2,200 records to the megabyte, not the daemon log's five thousand. So on a
 * busy developer machine this tail can start inside the window rather than
 * before it, and errors older than the tail go uncounted. That is the floor
 * this counter already promises rather than a census, and it is bounded on a
 * store no production install has, which is why the number is left at one
 * megabyte here. Sizing it against this store's own rate is a separate
 * question from closing the silent zero.
 *
 * @ref LLP 0349#bounded-reads [implements]: every read is bounded, this one included
 */
const DEV_TELEMETRY_TAIL_BYTES = 1024 * 1024

/**
 * Count the retained failures this install recorded in the last
 * {@link RECENT_ERROR_WINDOW_HOURS} hours, across every store that exists on
 * an ordinary install.
 *
 * The two stores a production install keeps are disjoint, so nothing there is
 * counted twice: `daemon.log` carries what `fileLog` emits (boot, tick,
 * reload, source and maintenance failures) and the sink driver does not write
 * to it directly. The daemon records bounded sink transitions as warnings,
 * while the sink outbox retains up to 100 failed export records per instance.
 *
 * `daemon.log` is read twice because there are two of them (LLP 0038): the
 * gateway keeps the one at the primary state root, and the processing child
 * it supervises keeps its own below `processing/`. Every failure this counter
 * was built for - tick, source, sink materialize, maintenance, config apply -
 * is emitted by the kernel daemon, which is now the child, so reading only
 * the primary log would report a quiet machine while the work that captures
 * anything was failing. They are disjoint (one process appends to each), so
 * the two counts add. A pre-split install has no `processing/` directory and
 * the second read contributes nothing.
 *
 * `dev-telemetry/logs-*.jsonl` is the third store, and it does overlap:
 * `recordFailure` in `src/core/sinks/driver.js` logs
 * `sink.export_batch.failed` through `getLogger` for the same batch
 * `persistOutbox` has just written a file for, so with `HYP_DEV_TELEMETRY=1`
 * set one failed export is counted once here and once there. That directory
 * exists only when that variable is set, which is why this counter used to
 * read zero on every real machine and why the overlap cannot reach one. The
 * history count retains that overlap. Export ERROR records do not also feed
 * the generic warning: the outbox and last-success stamp decide that warning.
 *
 * @param {string} stateRoot
 * @param {SinkSnapshot[]} configuredSinks
 * @param {unknown} snapshotSinks
 * @param {number} rollbackAtMs when a config probation expired, NaN otherwise
 * @param {number} [nowMs]
 * @returns {Promise<{ total: number, warningCount: number, sinkMaterialize: number, breakdown: string[], sinkDiagnostics: StatusDiagnostic[], probationSinkFailures: SinkMaterializeFailure[] }>}
 */
export async function countRecentErrors(stateRoot, configuredSinks, snapshotSinks, rollbackAtMs, nowMs = Date.now()) {
  const sinceMs = nowMs - RECENT_ERROR_WINDOW_MS
  // Config-derived sink rows omit runtime stamps, so the last success comes
  // from the already-loaded daemon snapshot, read after the daemon has exited
  // as happily as while it runs: a success is a historical fact, not a
  // liveness claim, and the daemon carries the stamp across its own restarts
  // (`recoverSinkSnapshots` in `runtime.js`). A stamp that does not parse, or
  // that sits in the future, is no evidence of recovery and leaves the
  // destination at "never succeeded" rather than quietly clearing a failure.
  const lastSuccess = new Map(configuredSinks.map((s) => [s.instance, -Infinity]))
  if (Array.isArray(snapshotSinks)) {
    for (const sink of snapshotSinks) {
      if (!sink || typeof sink !== 'object' || !lastSuccess.has(sink.instance)) continue
      const at = typeof sink.lastSuccessAt === 'string' ? Date.parse(sink.lastSuccessAt) : NaN
      if (Number.isFinite(at) && at <= nowMs) {
        lastSuccess.set(sink.instance, Math.max(lastSuccess.get(sink.instance) ?? -Infinity, at))
      }
    }
  }
  const [gatewayLog, processingLog, sinkOutbox, devTelemetry] = await Promise.all([
    countDaemonLogErrors(daemonLogPath(stateRoot), sinceMs, rollbackAtMs),
    countDaemonLogErrors(daemonLogPath(processingStateRoot(stateRoot)), sinceMs, rollbackAtMs),
    countSinkOutboxBatches(sinksRoot(stateRoot), sinceMs, nowMs, lastSuccess),
    countDevTelemetryErrors(devTelemetryDir(stateRoot), sinceMs),
  ])
  const daemonLog = gatewayLog.count + processingLog.count
  const daemonLogSinkMaterialize = gatewayLog.sinkMaterialize + processingLog.sinkMaterialize
  /** @type {string[]} */
  const breakdown = []
  if (daemonLog > 0) {
    breakdown.push(`${daemonLog} in the daemon log${sinkMaterializeOfThem(daemonLogSinkMaterialize)}`)
  }
  if (devTelemetry.warningCount > 0) {
    breakdown.push(`${devTelemetry.warningCount} in dev telemetry${sinkMaterializeOfThem(devTelemetry.sinkMaterialize)}`)
  }
  return {
    total: daemonLog + sinkOutbox.total + devTelemetry.total,
    warningCount: daemonLog + devTelemetry.warningCount,
    sinkMaterialize: daemonLogSinkMaterialize + devTelemetry.sinkMaterialize,
    breakdown,
    sinkDiagnostics: sinkOutbox.diagnostics,
    // The kernel daemon is the processing child, so its log speaks first; a
    // pre-split install keeps everything in the primary log.
    probationSinkFailures: processingLog.probationSinkFailures.length > 0
      ? processingLog.probationSinkFailures
      : gatewayLog.probationSinkFailures,
  }
}

/** @param {number} n */
function sinkMaterializeOfThem(n) {
  return n > 0 ? `, ${n} of them sink materialize failure${n === 1 ? '' : 's'}` : ''
}

/**
 * Is a recorded instant inside the window? A record whose timestamp is
 * missing or unreadable counts: this whole defect was a counter that stayed
 * silent about failures it could not classify, and an unparseable stamp on a
 * record that says `level: "error"` is still an error someone should see.
 *
 * @param {unknown} value
 * @param {number} sinceMs
 */
function recordedWithinWindow(value, sinceMs) {
  if (typeof value !== 'string') return true
  const at = Date.parse(value)
  if (!Number.isFinite(at)) return true
  return at >= sinceMs
}

/**
 * Read the last `maxBytes` of a line-oriented file, with any partial record at
 * the front discarded. Returns the empty string for a file that cannot be
 * opened or read: every caller here is counting, and a store it cannot read
 * contributes nothing rather than failing the report.
 *
 * The read starts one byte before the tail offset, so the newline ending the
 * previous record always leads the buffer. Without it, a boundary that happens
 * to be line-aligned looks exactly like a mid-record cut and the discard eats
 * a whole valid record: on a file whose only error is that record, the count
 * reads 0, which is the answer these counters exist to stop giving. The
 * `start > 0` guard is the other half: a file smaller than the cap is read
 * from byte 0 and has no fragment, so discarding unconditionally would eat its
 * first record.
 *
 * @ref LLP 0349#bounded-reads [implements]: no store is read whole
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
async function readFileTail(filePath, maxBytes) {
  /** @type {FileHandle} */
  let handle
  try {
    handle = await fsp.open(filePath, 'r')
  } catch {
    return ''
  }
  try {
    const { size } = await handle.stat()
    const offset = Math.max(0, size - maxBytes)
    const start = offset > 0 ? offset - 1 : 0
    const length = size - start
    if (length <= 0) return ''
    const buf = Buffer.allocUnsafe(length)
    const { bytesRead } = await handle.read(buf, 0, length, start)
    const text = buf.subarray(0, bytesRead).toString('utf8')
    if (start === 0) return text
    const nl = text.indexOf('\n')
    return nl < 0 ? '' : text.slice(nl + 1)
  } catch {
    return ''
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * How many sink materialize failures one boot's worth of the daemon log keeps
 * for the probation hint. A boot logs one per configured sink that failed, so
 * this only bounds a hostile or corrupt file.
 */
const PROBATION_SINK_FAILURES_MAX = 8

/**
 * Count `level: "error"` records in the tail of the daemon log. This is the
 * production-side record: `openDaemonLog` runs on every boot, in every mode,
 * with no environment variable to enable it.
 *
 * The same pass also answers the two questions the repair hints need (issue
 * #2547), so the tail is read once. `sinkMaterialize` is how many of the
 * counted errors are `daemon.sink_materialize_failed`, which a restart alone
 * does not fix. `probationSinkFailures` is the sinks that failed to
 * materialize in the boot that was running when a config probation expired
 * at `rollbackAtMs`. A boot begins at `daemon.starting`. When that boot had
 * not yet materialized its sinks by then (no materialize failure and no
 * `daemon.healthy` or `daemon.degraded`), the expiry was found at boot, so
 * the boot before it is the one that could not confirm the revision. A boot
 * that did materialize with no failure explains nothing, whatever an earlier
 * boot logged.
 *
 * @param {string} logPath
 * @param {number} sinceMs
 * @param {number} rollbackAtMs NaN when no probation expiry is in question
 * @returns {Promise<{ count: number, sinkMaterialize: number, probationSinkFailures: SinkMaterializeFailure[] }>}
 */
async function countDaemonLogErrors(logPath, sinceMs, rollbackAtMs) {
  let count = 0
  let sinkMaterialize = 0
  /** @type {SinkMaterializeFailure[]} */
  let previousBoot = []
  /** @type {SinkMaterializeFailure[]} */
  let currentBoot = []
  // True once the current boot has materialized its sinks, which it reports
  // with a failure or with its `daemon.healthy` / `daemon.degraded` outcome.
  let currentBootMaterialized = false
  for (const line of (await readFileTail(logPath, DAEMON_LOG_TAIL_BYTES)).split('\n')) {
    if (!line) continue
    /** @type {any} */
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    const isSinkFailure = parsed.event === 'daemon.sink_materialize_failed'
    if (Number.isFinite(rollbackAtMs)) {
      const at = typeof parsed.ts === 'string' ? Date.parse(parsed.ts) : NaN
      if (Number.isFinite(at) && at <= rollbackAtMs) {
        if (parsed.event === 'daemon.starting') {
          previousBoot = currentBoot
          currentBoot = []
          currentBootMaterialized = false
        } else if (parsed.event === 'daemon.healthy' || parsed.event === 'daemon.degraded') {
          currentBootMaterialized = true
        } else if (isSinkFailure) {
          currentBootMaterialized = true
          if (currentBoot.length < PROBATION_SINK_FAILURES_MAX) {
            currentBoot.push({
              instance: typeof parsed.instance === 'string' ? parsed.instance : null,
              errorKind: typeof parsed.error_kind === 'string' ? parsed.error_kind : null,
            })
          }
        }
      }
    }
    if (parsed.level !== 'error') continue
    if (!recordedWithinWindow(parsed.ts, sinceMs)) continue
    count += 1
    if (isSinkFailure) sinkMaterialize += 1
  }
  return { count, sinkMaterialize, probationSinkFailures: currentBootMaterialized ? currentBoot : previousBoot }
}

/**
 * Count failed export batches still sitting in the sink outboxes. One file is
 * one batch the sink could not hand over (`persistOutbox`), which is the only
 * durable trace a sink export failure leaves on an install without dev
 * telemetry: the driver's own `sink.export_batch.failed` goes to the OTel
 * logger, which has no exporter configured on an ordinary machine.
 *
 * One listing answers two questions on two horizons. The history count keeps
 * the shared 24-hour window, because `recent_error_count` reports what this
 * install has recorded lately. The warning is a recovery question rather than
 * a recency one, and waiting is not a recovery, so it takes no window at all:
 * a failure that has aged out of the count still warns while nothing has
 * succeeded since. Bounding it by the window instead meant a destination
 * exporting more slowly than the bar could never reach it, so an install
 * whose only destination had never once succeeded printed "Healthy"
 * (issue #2337).
 *
 * "Later" is strict, so a success sharing a failure's millisecond leaves the
 * warning standing: at equal stamps nothing says which came first, and the
 * conservative reading is the one that keeps looking. A stamp in the future
 * is evidence about nothing and is skipped on both sides, so a clock that ran
 * ahead cannot invent a warning and one that was set back cannot clear one.
 *
 * Costs one listing of `sinksDir` plus one listing per sink directory on
 * disk, configured or not (the walk does not consult the config), and one
 * open with a read of at most a 4 KiB prefix per recognized record, since
 * `recordedAt` sits ahead of the partition inventory. A configured sink's
 * driver keeps its outbox to a bounded history; one a removed sink left
 * behind is not pruned. Both answers accumulate in the same pass with no sort
 * and nothing retained per failure. The collector already walks the whole
 * cache tree with a `stat` per file (`measureCacheStats`), so this sits well
 * inside its budget.
 *
 * An outbox with no entry in `lastSuccess` belongs to a destination this
 * install no longer has, since the map is keyed by the configured sinks alone.
 * Its files still count as history, but nothing asks an operator to repair a
 * destination they have removed.
 *
 * @param {string} sinksDir
 * @param {number} sinceMs
 * @param {number} nowMs
 * @param {Map<string, number>} lastSuccess
 * @returns {Promise<{ total: number, diagnostics: StatusDiagnostic[] }>}
 */
// @ref LLP 0453#warning-rule [implements]: a destination warns while it holds an export failure with no later success, however old
async function countSinkOutboxBatches(sinksDir, sinceMs, nowMs, lastSuccess) {
  const result = { total: 0, diagnostics: /** @type {StatusDiagnostic[]} */ ([]) }
  try {
    const instances = await fsp.opendir(sinksDir)
    for await (const instance of instances) {
      if (!instance.isDirectory()) continue
      const dir = path.join(sinksDir, instance.name, 'outbox')
      const success = lastSuccess.get(instance.name)
      let unresolved = 0
      let last = -Infinity
      try {
        // @ref LLP 0471#diagnostic-history [implements]: stream retained evidence with bounded metadata, never partition inventories
        for await (const name of diagnosticEntries(dir, instance.name)) {
          const record = await readDiagnosticRecord(dir, name, instance.name)
          if (!record) continue
          const at = record.at
          if (at >= sinceMs) result.total += 1
          if (success === undefined || at > nowMs || at < success) continue
          unresolved += 1
          last = Math.max(last, at)
        }
      } catch { /* Missing or unreadable history contributes only evidence already read. */ }
      if (unresolved > 0) {
        result.diagnostics.push({
          severity: 'warning',
          kind: 'sink_export_failing',
          message: `${sanitizeLabel(instance.name) ?? 'unknown'}: ${unresolved} retained failed export record${unresolved === 1 ? '' : 's'} with no later success recorded; last failure ${formatGapDuration(nowMs - last)} ago`,
          repair: [`check destination connectivity and inspect failure records in ${sanitizeLabel(dir, 512)}`],
        })
      }
    }
  } catch { /* No readable sink history. */ }
  return result
}

/**
 * Walk the dev telemetry directory and count log entries whose `severityText`
 * is `ERROR`. Returns zero counts when the directory does not exist, which on an
 * ordinary install is always: this is the developer's store, kept as one
 * input among three rather than removed, because under `HYP_DEV_TELEMETRY=1`
 * it holds every `getLogger` error, and all but one of them reach no other
 * file. The exception is the sink driver's `sink.export_batch.failed`, which
 * describes a batch the outbox has a file for; `countRecentErrors` records
 * why that overlap is left alone. Each file is read from a tail of
 * {@link DEV_TELEMETRY_TAIL_BYTES}, never whole.
 *
 * @param {string} telemetryDir
 * @param {number} sinceMs
 * @returns {Promise<{ total: number, warningCount: number, sinkMaterialize: number }>}
 */
async function countDevTelemetryErrors(telemetryDir, sinceMs) {
  const result = { total: 0, warningCount: 0, sinkMaterialize: 0 }
  /** @type {string[]} */
  let entries
  try {
    entries = await fsp.readdir(telemetryDir)
  } catch {
    return result
  }
  for (const entry of entries) {
    if (!entry.startsWith('logs-') || !entry.endsWith('.jsonl')) continue
    const raw = await readFileTail(path.join(telemetryDir, entry), DEV_TELEMETRY_TAIL_BYTES)
    for (const line of raw.split('\n')) {
      if (!line) continue
      try {
        const parsed = JSON.parse(line)
        if (!parsed || typeof parsed !== 'object') continue
        if (/** @type {any} */ (parsed).severityText !== 'ERROR') continue
        if (!recordedWithinWindow(/** @type {any} */ (parsed).timestamp, sinceMs)) continue
        result.total += 1
        if (parsed.body !== 'sink.export_batch.failed') result.warningCount += 1
        // The OTel half of `daemon.sink_materialize_failed`, so the repair
        // hint treats it the same way (issue #2547).
        if (parsed.body === 'sink.materialize_failed') result.sinkMaterialize += 1
      } catch {
        // skip malformed lines silently
      }
    }
  }
  return result
}
