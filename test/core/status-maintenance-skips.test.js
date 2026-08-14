// @ts-check

// A partition maintenance deliberately leaves fragmented (LLP 0217, LLP 0218)
// was stated on exactly two surfaces an operator has to go looking for: a
// `hyp query maintain` line and a span attribute. The daemon, which runs the
// walk hourly, threw the report away. These tests pin the standing surface
// that replaces that silence: the snapshot the tick persists, its bound, the
// reason vocabulary it uses, and what `hyp status` does with it.
// @ref LLP 0224#status-file-is-the-surface [tests]:

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  collectHypAwareStatus,
  MAX_SKIPPED_PARTITIONS_REPORTED,
  maintenanceSkipsFromStatus,
  summarizeMaintenanceSkips,
  writeStatusFile,
} from '../../src/core/daemon/status.js'
import { runDaemon } from '../../src/core/daemon/runtime.js'
import { renderStatusJson, renderStatusText } from '../../src/core/commands/status.js'
import { maintainCache } from '../../src/core/cache/maintenance.js'
import { appendRowsToSourceTable, readCursorSync, writeCursor } from '../../src/core/cache/partition.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'

/**
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js'
 * @import { MaintenancePartitionReport, MaintenanceReport, PartitionCursor } from '../../src/core/cache/types.js'
 * @import { CollectStatusOptions, MaintenanceSkipSnapshot } from '../../src/core/daemon/types.js'
 */

/* ---------- report fixtures ---------- */

/**
 * One entry of a `maintainCache` report. Defaults are a healthy converged
 * partition: the overwhelming majority of every cache, and the thing the
 * surface must stay quiet about.
 *
 * @param {Partial<MaintenancePartitionReport>} patch
 * @returns {MaintenancePartitionReport}
 */
function partitionReport(patch = {}) {
  return {
    dataset: 'ai_gateway_messages',
    partition: { source: 'claude' },
    path: '/cache/datasets/ai_gateway_messages/source=claude',
    snapshotsExpired: 0,
    compacted: false,
    rowCount: 10,
    dataFilesBefore: 4,
    dataFilesAfter: 4,
    ...patch,
  }
}

/**
 * @param {MaintenancePartitionReport[]} partitions
 * @returns {MaintenanceReport}
 */
function maintenanceReport(partitions) {
  return {
    partitions,
    totalSnapshotsExpired: 0,
    totalCompacted: partitions.filter((p) => p.compacted).length,
    totalRebaselined: partitions.filter((p) => p.rebaselined).length,
    dryRun: false,
    elapsedMs: 12,
  }
}

/* ---------- the summary the daemon persists ---------- */

// The ids are the `maintenance.partition` span's attribute names, which are
// themselves the report's field names: one spelling across the trace, the
// status file, `hyp status`, and the daemon log.
// @ref LLP 0224#reason-ids-are-span-attribute-names [tests]:
test('summarizeMaintenanceSkips names both skip reasons in the vocabulary the report already uses', () => {
  const snapshot = summarizeMaintenanceSkips(maintenanceReport([
    partitionReport({
      dataset: 'ai_gateway_messages',
      partition: { source: 'claude' },
      compactionIneffective: true,
      compactionIneffectiveFiles: 1521,
    }),
    partitionReport({
      dataset: 'traces',
      partition: { source: 'codex' },
      compactionAttemptFailed: true,
      compactionAttemptFailedAt: '2026-08-12T21:55:35.168Z',
    }),
    partitionReport({ dataset: 'logs', partition: { source: 'claude' } }),
  ]), { at: '2026-08-13T09:00:00.000Z' })

  assert.deepEqual(snapshot, {
    tickAt: '2026-08-13T09:00:00.000Z',
    partitionsVisited: 3,
    skippedTotal: 2,
    reasons: { compaction_ineffective: 1, compaction_attempt_failed: 1 },
    partitions: [
      {
        dataset: 'ai_gateway_messages',
        partition: 'source=claude',
        reason: 'compaction_ineffective',
        dataFiles: 1521,
      },
      {
        dataset: 'traces',
        partition: 'source=codex',
        reason: 'compaction_attempt_failed',
        failedAt: '2026-08-12T21:55:35.168Z',
      },
    ],
  })
})

// The cap on write bounds entry *count*; this pins that the write side also
// sanitizes and clamps the bytes *inside* each entry, not only the count.
// LLP 0224#last-tick-only says the cap and the sanitizing are "re-applied on
// read as well as on write", which presumes the write side already produced
// something clean. Partition labels are row-derived
// (`resolveSourceSegments` -> `sanitizePathSegment`, which strips only
// path-hostile bytes, not bidi/zero-width/DEL, and applies no length
// clamp), so a hostile `client_name` reaches `summarizeMaintenanceSkips`
// unsanitized. The daemon log's `worst` field reads `partitions[0]` straight
// off this snapshot with no read-side cleanup of its own, so this is also
// the only thing standing between a row-derived label and `tail -f`.
// @ref LLP 0224#last-tick-only [tests]: the write side sanitizes and clamps too, not only the read side
test('summarizeMaintenanceSkips sanitizes and clamps hostile dataset and partition labels on write, into status.json itself', async () => {
  const BIDI = String.fromCharCode(0x202e) // right-to-left override
  const ZW = String.fromCharCode(0x200b) // zero-width space
  const SHY = String.fromCharCode(0x00ad) // soft hyphen
  const DEL = String.fromCharCode(0x7f)
  const hostile = `claude${BIDI}${ZW}${SHY}${DEL}` + 'x'.repeat(200)

  const snapshot = summarizeMaintenanceSkips(maintenanceReport([
    partitionReport({
      dataset: hostile,
      partition: { source: hostile },
      compactionIneffective: true,
      compactionIneffectiveFiles: 3,
    }),
  ]))

  assert.equal(snapshot.partitions.length, 1)
  const [p] = snapshot.partitions
  for (const bad of [BIDI, ZW, SHY, DEL]) {
    assert.equal(p.dataset.includes(bad), false, 'dataset must not carry hostile bytes')
    assert.equal(p.partition.includes(bad), false, 'partition must not carry hostile bytes')
  }
  assert.ok(p.dataset.length <= 120, `dataset must be clamped, got ${p.dataset.length} chars`)
  assert.ok(p.partition.length <= 120, `partition must be clamped, got ${p.partition.length} chars`)

  // Not only the in-memory snapshot: the bytes that actually land in
  // status.json, which is what the daemon writes and what a `tail -f` on
  // the daemon log's `worst` field is downstream of.
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-maintenance-sanitize-'))
  try {
    const stateRoot = path.join(hypHome, 'hypaware')
    await fs.mkdir(path.join(stateRoot, 'run'), { recursive: true })
    writeStatusFile(stateRoot, /** @type {any} */ ({ state: 'healthy', sources: [], sinks: [], maintenance: snapshot }))
    const raw = await fs.readFile(path.join(stateRoot, 'run', 'status.json'), 'utf8')
    for (const bad of [BIDI, ZW, SHY, DEL]) {
      assert.equal(raw.includes(bad), false, `status.json bytes must not carry ${JSON.stringify(bad)}`)
    }
    assert.ok(raw.length < 2000, `a single hostile label must not balloon status.json, got ${raw.length} bytes`)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// Convergence (LLP 0199#baseline-gate) is the healthy case, a rebaseline (LLP
// 0207) is work the tick did, and a rewrite that achieved nothing is a run
// that ran. None of the three is a partition the kernel has stopped
// rewriting, which is what this surface is for.
test('a converged, rebaselined, or freshly rewritten partition is not on the surface', () => {
  const snapshot = summarizeMaintenanceSkips(maintenanceReport([
    partitionReport({ dataset: 'logs' }),
    partitionReport({ dataset: 'traces', rebaselined: true }),
    partitionReport({ dataset: 'metrics', compacted: true, compactionIneffective: true, compactionIneffectiveFiles: 12 }),
  ]))

  assert.equal(snapshot.skippedTotal, 0)
  assert.deepEqual(snapshot.partitions, [])
  assert.deepEqual(snapshot.reasons, { compaction_ineffective: 0, compaction_attempt_failed: 0 })
  assert.equal(snapshot.partitionsVisited, 3)
})

// The status file is read back and printed to a terminal, so the named list
// is bounded. The counts beside it are not, so the bound never hides the size
// of the problem.
// @ref LLP 0224#last-tick-only [tests]:
test('the named list is capped in the walk order the tick already used, and the count stays exact', () => {
  const snapshot = summarizeMaintenanceSkips(maintenanceReport(
    // Walk order is descending live data-file count (LLP 0199#neediest-first),
    // so position in the report is the ranking: index 0 is the worst.
    Array.from({ length: 20 }, (_, i) => partitionReport({
      dataset: `dataset_${String(i).padStart(2, '0')}`,
      compactionIneffective: true,
      compactionIneffectiveFiles: 500 - i,
    }))
  ))

  assert.equal(snapshot.skippedTotal, 20)
  assert.equal(snapshot.reasons.compaction_ineffective, 20)
  assert.equal(snapshot.partitions.length, MAX_SKIPPED_PARTITIONS_REPORTED)
  assert.equal(MAX_SKIPPED_PARTITIONS_REPORTED, 8)
  assert.equal(snapshot.partitions[0].dataset, 'dataset_00')
  assert.equal(snapshot.partitions[7].dataset, 'dataset_07')
})

// The retention rule is "the last tick, whole": a skip reason is a state the
// tick re-derives from the cursor, so a partition that thawed has to be able
// to leave the surface without an expiry rule.
test('a tick that skipped nothing still produces a snapshot, so the surface clears itself', () => {
  const snapshot = summarizeMaintenanceSkips(maintenanceReport([partitionReport({ compacted: true })]))
  assert.equal(snapshot.skippedTotal, 0)
  assert.equal(snapshot.partitionsVisited, 1)
  assert.ok(!Number.isNaN(Date.parse(snapshot.tickAt)), 'a snapshot always timestamps its tick')
})

/* ---------- reading a file this build did not necessarily write ---------- */

test('maintenanceSkipsFromStatus is null for a daemon that has never reported a tick', () => {
  assert.equal(maintenanceSkipsFromStatus(null), null)
  assert.equal(maintenanceSkipsFromStatus(/** @type {any} */ ({ state: 'healthy' })), null)
  // No usable tick timestamp: every render of the block is relative to it.
  assert.equal(
    maintenanceSkipsFromStatus(/** @type {any} */ ({ maintenance: { skippedTotal: 3, partitions: [] } })),
    null
  )
  assert.equal(
    maintenanceSkipsFromStatus(/** @type {any} */ ({ maintenance: { tickAt: 'not a date' } })),
    null
  )
})

test('a foreign status file is capped, cleaned, and stripped of reasons this build cannot explain', () => {
  const ESC = String.fromCharCode(27)
  const LF = String.fromCharCode(10)
  const snapshot = maintenanceSkipsFromStatus(/** @type {any} */ ({
    maintenance: {
      tickAt: '2026-08-13T09:00:00.000Z',
      partitionsVisited: -4,
      skippedTotal: 900,
      reasons: { compaction_ineffective: 900, compaction_attempt_failed: 'lots', compaction_from_the_future: 5 },
      partitions: [
        { dataset: `ai_gateway_messages${ESC}[2K${LF}  daemon:   FORGED`, partition: 'source=claude', reason: 'compaction_ineffective', dataFiles: 1521 },
        { dataset: 'traces', partition: 'source=codex', reason: 'compaction_from_the_future' },
        { dataset: 'logs', reason: 'compaction_ineffective' },
        null,
        ...Array.from({ length: 40 }, (_, i) => ({
          dataset: `dataset_${i}`,
          partition: 'source=claude',
          reason: 'compaction_attempt_failed',
          failedAt: '2026-08-12T21:55:35.168Z',
        })),
      ],
    },
  }))

  assert.ok(snapshot)
  assert.equal(snapshot.partitions.length, MAX_SKIPPED_PARTITIONS_REPORTED)
  assert.equal(snapshot.partitions[0].dataset.includes(ESC), false, 'no escape byte survives')
  assert.equal(snapshot.partitions[0].dataset.includes(LF), false, 'no newline survives')
  // An unknown reason id and an entry with no partition tuple are dropped
  // rather than printed: a line this build cannot explain is worse than a
  // shorter list.
  assert.deepEqual(
    snapshot.partitions.map((p) => p.reason),
    ['compaction_ineffective', ...Array.from({ length: 7 }, () => 'compaction_attempt_failed')]
  )
  // Unknown reason keys never reach the counts, and a non-numeric one reads
  // as zero rather than as text on a terminal.
  assert.deepEqual(snapshot.reasons, { compaction_ineffective: 900, compaction_attempt_failed: 0 })
  // A negative count is not a count, and 900 partitions were recorded
  // skipped, so visited is floored at the skipped total rather than at the
  // capped list length: "8 of 900" is exactly the impossible-looking
  // sentence a missing floor would render.
  assert.equal(snapshot.partitionsVisited, 900, 'partitionsVisited must never read smaller than skippedTotal')
  assert.equal(snapshot.skippedTotal, 900)
})

test('a total smaller than the list it labels is corrected upward, never rendered as a lie', () => {
  const snapshot = maintenanceSkipsFromStatus(/** @type {any} */ ({
    maintenance: {
      tickAt: '2026-08-13T09:00:00.000Z',
      skippedTotal: 1,
      reasons: {},
      partitions: [
        { dataset: 'a', partition: 'source=claude', reason: 'compaction_ineffective' },
        { dataset: 'b', partition: 'source=claude', reason: 'compaction_ineffective' },
        { dataset: 'c', partition: 'source=claude', reason: 'compaction_ineffective' },
      ],
    },
  }))
  assert.ok(snapshot)
  assert.equal(snapshot.skippedTotal, 3)
})

/* ---------- hyp status ---------- */

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-maintenance-'))
  const stateRoot = path.join(hypHome, 'hypaware')
  await fs.mkdir(path.join(stateRoot, 'run'), { recursive: true })
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }) + '\n')
  return { hypHome, stateRoot }
}

/**
 * @param {string} hypHome
 * @returns {CollectStatusOptions}
 */
function collectOpts(hypHome) {
  return {
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
    platform: 'darwin',
    isLaunchAgentInstalled: () => false,
  }
}

/** @returns {{ write(chunk: string): void, text(): string }} */
function buffer() {
  /** @type {string[]} */
  const chunks = []
  return { write: (chunk) => { chunks.push(chunk) }, text: () => chunks.join('') }
}

/** @param {string} stateRoot @param {MaintenanceSkipSnapshot | undefined} maintenance */
function writeDaemonStatus(stateRoot, maintenance) {
  writeStatusFile(stateRoot, /** @type {any} */ ({
    state: 'healthy',
    sources: [],
    sinks: [],
    ...(maintenance ? { maintenance } : {}),
  }))
}

test('hyp status names the frozen partitions, and says so without calling the install broken', async () => {
  const { hypHome, stateRoot } = await makeHome()
  try {
    writeDaemonStatus(stateRoot, {
      tickAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      partitionsVisited: 12,
      skippedTotal: 3,
      reasons: { compaction_ineffective: 2, compaction_attempt_failed: 1 },
      partitions: [
        { dataset: 'ai_gateway_messages', partition: 'source=claude', reason: 'compaction_ineffective', dataFiles: 1521 },
        { dataset: 'traces', partition: 'source=codex', reason: 'compaction_attempt_failed', failedAt: '2026-08-12T21:55:35.168Z' },
      ],
    })

    const report = await collectHypAwareStatus(collectOpts(hypHome))
    assert.equal(report.maintenance?.skippedTotal, 3)

    const diagnostic = report.diagnostics.find((d) => d.kind === 'maintenance_partitions_skipped')
    assert.ok(diagnostic, 'a frozen partition raises a diagnostic an operator scanning status will see')
    assert.equal(diagnostic.severity, 'warning')
    assert.match(diagnostic.message, /3 partitions fragmented|leaving 3 partitions fragmented/)
    assert.ok(diagnostic.repair.includes('hyp query maintain --force'))
    // The daemon is running and capture works: this is a thing to know
    // about, not an outage.
    assert.equal(report.overall, 'healthy')

    const stdout = buffer()
    renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: path.join(stateRoot, 'cache'), stdout })
    const text = stdout.text()
    assert.match(text, /maintenance:/)
    assert.match(text, /3 of 12 partitions left fragmented, as of the tick 5m ago \(2 compaction_ineffective, 1 compaction_attempt_failed\)/)
    assert.match(text, /- ai_gateway_messages\/source=claude {2}\[compaction_ineffective\] {2}the last rewrite of 1521 files reduced nothing/)
    assert.match(text, /- traces\/source=codex {2}\[compaction_attempt_failed\] {2}the retry failed at 2026-08-12T21:55:35\.168Z/)
    // Two of three are named, so the render says where the third is.
    assert.match(text, /\.\.\. and 1 more \(hyp query maintain --dry-run lists them all\)/)

    const json = renderStatusJson({ report, clientNames: [], datasets: [], cacheRoot: path.join(stateRoot, 'cache') })
    assert.equal(json.maintenance?.skipped_total, 3)
    assert.equal(json.maintenance?.partitions_visited, 12)
    assert.deepEqual(json.maintenance?.reasons, { compaction_ineffective: 2, compaction_attempt_failed: 1 })
    assert.deepEqual(json.maintenance?.skipped[0], {
      dataset: 'ai_gateway_messages',
      partition: 'source=claude',
      reason: 'compaction_ineffective',
      data_files: 1521,
    })
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('an install with nothing frozen keeps the V1 text surface, and a daemon that never ran reports null', async () => {
  const { hypHome, stateRoot } = await makeHome()
  try {
    // A tick ran and skipped nothing.
    writeDaemonStatus(stateRoot, {
      tickAt: new Date().toISOString(),
      partitionsVisited: 12,
      skippedTotal: 0,
      reasons: { compaction_ineffective: 0, compaction_attempt_failed: 0 },
      partitions: [],
    })
    const clean = await collectHypAwareStatus(collectOpts(hypHome))
    assert.equal(clean.maintenance?.skippedTotal, 0)
    assert.equal(clean.diagnostics.some((d) => d.kind === 'maintenance_partitions_skipped'), false)
    const stdout = buffer()
    renderStatusText({ report: clean, clientNames: [], datasets: [], cacheRoot: path.join(stateRoot, 'cache'), stdout })
    assert.doesNotMatch(stdout.text(), /maintenance:/)

    // No tick has ever reported. Absent is not "nothing is frozen", so
    // nothing is claimed either way.
    writeDaemonStatus(stateRoot, undefined)
    const silent = await collectHypAwareStatus(collectOpts(hypHome))
    assert.equal(silent.maintenance, null)
    const json = renderStatusJson({ report: silent, clientNames: [], datasets: [], cacheRoot: path.join(stateRoot, 'cache') })
    assert.equal(json.maintenance, null)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// `describeMaintenanceSkipReasons` filters to reasons in the known
// vocabulary with a nonzero count and joins; when a status.json's only
// nonzero counts are for reasons this build does not recognize, the join is
// '', and both `hyp status`'s text render and its
// `maintenance_partitions_skipped` diagnostic interpolate that
// unconditionally, so the rendered line ends "fragmented ()". This is
// unreachable from a file this build wrote (every skip it records has one of
// the two known reasons by construction), but the read path's whole
// justification is that this build did not necessarily write the file, and
// LLP 0224#consequences names exactly this extension ("a new id and a new
// count key, not a new shape") as the forward-compatible path. The existing
// foreign-file test above keeps `compaction_ineffective: 900` alongside its
// unknown reason id, so that case never hits the all-unknown branch.
//
// Separately, `partitionsVisited` fell back to `partitions.length` with no
// floor at `skippedTotal`, while `skippedTotal` is floored at
// `partitions.length`. A status.json omitting `partitionsVisited` (as an
// older or different build might) alongside a positive `skippedTotal` and an
// empty `partitions` list rendered "5 of 0 partitions" - a sentence no tick
// can produce, since visited can never be smaller than skipped.
// @ref LLP 0224#last-tick-only [tests]: a foreign status file's reason breakdown and visited count stay sentences a tick could actually produce
test('a status.json carrying only reasons this build does not recognize renders no empty parenthetical and no impossible visited count', async () => {
  const { hypHome, stateRoot } = await makeHome()
  try {
    writeStatusFile(stateRoot, /** @type {any} */ ({
      state: 'healthy',
      sources: [],
      sinks: [],
      maintenance: {
        tickAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        // No partitionsVisited at all: a later or different build might not
        // have written one either.
        skippedTotal: 5,
        reasons: { compaction_from_the_future: 5 },
        partitions: [],
      },
    }))

    const report = await collectHypAwareStatus(collectOpts(hypHome))
    assert.equal(report.maintenance?.skippedTotal, 5)
    // The floor: visited can never render smaller than skipped.
    assert.ok(
      (report.maintenance?.partitionsVisited ?? 0) >= 5,
      `partitionsVisited must be floored at skippedTotal, got ${report.maintenance?.partitionsVisited}`
    )

    const diagnostic = report.diagnostics.find((d) => d.kind === 'maintenance_partitions_skipped')
    assert.ok(diagnostic, 'a positive skippedTotal still raises the diagnostic')
    assert.doesNotMatch(diagnostic.message, /\(\)/, 'no bare parenthetical in the diagnostic message')
    assert.match(diagnostic.message, /reasons this build does not recognize/)

    const stdout = buffer()
    renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: path.join(stateRoot, 'cache'), stdout })
    const text = stdout.text()
    assert.doesNotMatch(text, /\(\)/, 'no bare parenthetical in the rendered text')
    assert.doesNotMatch(text, /5 of 0 partitions/, 'visited must never render smaller than skipped')
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

/* ---------- against a real frozen partition ---------- */

/** @type {ColumnSpec[]} */
const SESSION_COLUMNS = [
  { name: 'id', type: 'INT32', nullable: false },
  { name: 'session_id', type: 'STRING', nullable: false },
  { name: 'attributes', type: 'STRING', nullable: true },
]

/**
 * The production shape behind #723: one identity-partitioned tuple per
 * session, so the partition already sits on its file-count floor and every
 * rewrite reproduces it.
 */
const SESSION_DECLARATION = {
  source: { columns: ['source'] },
  iceberg: { fields: [{ column: 'session_id', transform: 'identity' }] },
}

/**
 * Seed a partition and plant the cursor a rewrite that achieved nothing
 * leaves behind: the baseline sits on the live count (so the LLP 0199 gate
 * skips it), the record says the rewrite started from that same count (so the
 * verdict is "reduced nothing"), and the stamp names the writer running now
 * (so no retry is owed).
 *
 * @param {string} cacheRoot
 * @param {number} sessions
 * @returns {Promise<string>} the partition directory
 */
async function seedFrozenPartition(cacheRoot, sessions) {
  const rows = Array.from({ length: sessions }, (_, i) => ({
    id: i,
    session_id: `s-${i}`,
    attributes: `{"gateway":{"session":"s-${i}"}}`,
  }))
  await appendRowsToSourceTable(
    cacheRoot, 'ai_gateway_messages', ['source=claude'], SESSION_COLUMNS, rows,
    { declaration: SESSION_DECLARATION }
  )
  const dir = path.join(cacheRoot, 'datasets', 'ai_gateway_messages', 'source=claude')
  const cursor = readCursorSync(dir)
  /** @type {PartitionCursor} */
  const next = {
    ...cursor,
    compaction: {
      previousTableDir: 'table',
      compactedAt: '2026-08-12T21:55:35.168Z',
      resettleBaselineFiles: sessions,
      dataFilesBefore: sessions,
      writerGeneration: 2,
    },
  }
  await writeCursor(dir, next)
  return dir
}

// The vocabulary is only worth anything if it is the vocabulary a real walk
// produces. This runs maintenance over a partition frozen exactly the way
// #723's was and summarizes what comes back.
test('a real maintenance walk over a frozen partition summarizes into the reason it reported', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-maintenance-frozen-'))
  try {
    await seedFrozenPartition(cacheRoot, 6)
    const report = await maintainCache({ cacheRoot, compactOnly: true })
    assert.equal(report.totalCompacted, 0, 'fixture invariant: the partition must be skipped, not rewritten')

    const snapshot = summarizeMaintenanceSkips(report)
    assert.equal(snapshot.skippedTotal, 1)
    assert.deepEqual(snapshot.reasons, { compaction_ineffective: 1, compaction_attempt_failed: 0 })
    assert.deepEqual(snapshot.partitions, [{
      dataset: 'ai_gateway_messages',
      partition: 'source=claude',
      reason: 'compaction_ineffective',
      dataFiles: 6,
    }])
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// The defect itself: `runMaintenance` awaited `maintainCache` and dropped the
// result, so nothing the walk decided reached any surface the daemon keeps.
// @ref LLP 0224#status-file-is-the-surface [tests]: the tick persists what it left fragmented
test('the daemon maintenance tick persists what it left fragmented into status.json', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-daemon-maintenance-'))
  const stateRoot = path.join(hypHome, 'hypaware')
  let handle
  try {
    await seedFrozenPartition(path.join(stateRoot, 'cache'), 6)
    const configPath = defaultConfigPath(hypHome)
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, JSON.stringify({
      version: 2,
      plugins: [],
      // 0.01 minutes: the maintenance timer is not clamped the way the sink
      // tick is, so a tick lands inside the wait below.
      query: { cache: { maintenance: { interval_minutes: 0.01 } } },
    }))

    handle = await runDaemon({
      hypHome,
      configPath,
      env: { ...process.env, HYP_HOME: hypHome },
      runId: 'maintenance-skip-tick',
      tickIntervalMs: 1,
      installSignalHandlers: false,
    })

    const deadline = Date.now() + 30_000
    /** @type {MaintenanceSkipSnapshot | null} */
    let maintenance = null
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      const raw = await fs.readFile(path.join(stateRoot, 'run', 'status.json'), 'utf8').catch(() => null)
      maintenance = raw ? (JSON.parse(raw).maintenance ?? null) : null
      if (maintenance && maintenance.skippedTotal > 0) break
    }
    assert.ok(maintenance, 'no maintenance snapshot ever reached status.json')
    assert.equal(maintenance.skippedTotal, 1)
    assert.deepEqual(maintenance.reasons, { compaction_ineffective: 1, compaction_attempt_failed: 0 })
    assert.equal(maintenance.partitions[0].dataset, 'ai_gateway_messages')
    assert.equal(maintenance.partitions[0].reason, 'compaction_ineffective')
  } finally {
    if (handle) {
      await handle.stop()
      await handle.done
    }
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})
