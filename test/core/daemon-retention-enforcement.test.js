// @ts-check

// @ref LLP 0336#rides-the-maintenance-tick [tests]: `query.cache.retention`
// was validated, defaulted, and reported by `hyp status`, but
// `createRetentionEnforcer` had no non-test caller (issue #1131): no daemon
// or CLI path ever deleted a row for being older than the window. This
// drives a real daemon through its scheduled maintenance path and asserts
// the window is enforced there: over-age rows are gone, under-age rows are
// not, and the pass left its span behind as proof the scheduled path (not a
// test-constructed enforcer) did the deleting.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runDaemon } from '../../src/core/daemon/runtime.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { appendRowsToSourceTable, readCursorSync, writeCursor } from '../../src/core/cache/partition.js'
import { readRowsFromTable } from '../../src/core/cache/iceberg/store.js'

/** @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js' */

/** @type {ColumnSpec[]} */
const COLUMNS = [
  { name: 'id', type: 'INT32', nullable: false },
  { name: 'value', type: 'STRING', nullable: true },
  { name: 'timestamp', type: 'STRING', nullable: true },
]

/** @param {number} daysAgo */
function isoDateDaysAgo(daysAgo) {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString()
}

/**
 * Poll a JSONL file for a line matching `predicate`. The span exporter
 * writes through an `fs.WriteStream` with no flush hook this daemon ever
 * calls, so the write lands async relative to the tick's own promise.
 *
 * @param {string} filePath
 * @param {(record: any) => boolean} predicate
 * @param {number} timeoutMs
 * @returns {Promise<any>}
 */
async function pollJsonlFor(filePath, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const raw = await fs.readFile(filePath, 'utf8')
      for (const line of raw.split('\n')) {
        if (!line) continue
        const record = JSON.parse(line)
        if (predicate(record)) return record
      }
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err
    }
    if (Date.now() > deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test('the daemon maintenance path enforces the configured retention window', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-daemon-retention-'))
  const savedHypHome = process.env.HYP_HOME
  const savedDevTelemetry = process.env.HYP_DEV_TELEMETRY
  let handle
  try {
    const cacheRoot = path.join(hypHome, 'hypaware', 'cache')

    // One dataset, two source partitions: every row in `stale` is past the
    // 30 day window, every row in `fresh` is inside it.
    await appendRowsToSourceTable(cacheRoot, 'test_ds', ['source=stale'], COLUMNS, [
      { id: 1, value: 'old-1', timestamp: isoDateDaysAgo(45) },
      { id: 2, value: 'old-2', timestamp: isoDateDaysAgo(41) },
    ])
    await appendRowsToSourceTable(cacheRoot, 'test_ds', ['source=fresh'], COLUMNS, [
      { id: 3, value: 'new-1', timestamp: isoDateDaysAgo(2) },
      { id: 4, value: 'new-2', timestamp: isoDateDaysAgo(1) },
    ])

    const configPath = defaultConfigPath(hypHome)
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, JSON.stringify({
      version: 2,
      query: {
        cache: {
          retention: { default_days: 30 },
          maintenance: { interval_minutes: 0.001 },
        },
      },
    }))

    // `installObservability()` (inside `runDaemon`) reads real
    // `process.env`, so the JSONL span exporter has to be armed here.
    process.env.HYP_HOME = hypHome
    process.env.HYP_DEV_TELEMETRY = '1'

    handle = await runDaemon({
      hypHome,
      configPath,
      env: { ...process.env, HYP_HOME: hypHome },
      runId: 'retention-enforce-test',
      tickIntervalMs: 0,
      installSignalHandlers: false,
    })

    const tracesPath = path.join(hypHome, 'hypaware', 'dev-telemetry', `traces-${process.pid}.jsonl`)
    const span = await pollJsonlFor(tracesPath, (r) => r.name === 'retention.tick', 10_000)
    assert.ok(
      span,
      'a retention.tick span must be exported from the scheduled maintenance path - ' +
      'its absence means the daemon never enforced the configured window (issue #1131)'
    )
    assert.equal(span.attributes.rows_deleted, 2, 'the pass deleted exactly the two over-age rows')

    const staleDir = path.join(cacheRoot, 'datasets', 'test_ds', 'source=stale')
    const freshDir = path.join(cacheRoot, 'datasets', 'test_ds', 'source=fresh')
    const staleCursor = readCursorSync(staleDir)
    const freshCursor = readCursorSync(freshDir)

    const staleRows = await readRowsFromTable(path.join(staleDir, staleCursor.tableDir ?? 'table'))
    assert.equal(staleRows.length, 0, 'every row past the window is evicted')

    const freshRows = await readRowsFromTable(path.join(freshDir, freshCursor.tableDir ?? 'table'))
    assert.equal(freshRows.length, 2, 'rows inside the window are untouched')
    assert.deepEqual(
      freshRows.map((r) => r.value).sort(),
      ['new-1', 'new-2'],
      'the surviving rows are the under-age ones, not remnants of the stale partition'
    )

    // The delete is durable and attributed: the retention cursor on the
    // stale partition records the pass that removed its rows.
    assert.equal(staleCursor.retention?.rowsDeleted, 2)
  } finally {
    if (handle) {
      await handle.stop()
      await handle.done
    }
    if (savedHypHome === undefined) delete process.env.HYP_HOME
    else process.env.HYP_HOME = savedHypHome
    if (savedDevTelemetry === undefined) delete process.env.HYP_DEV_TELEMETRY
    else process.env.HYP_DEV_TELEMETRY = savedDevTelemetry
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('a whole-partition eviction leaves its durable line even when the cursor counted no rows', async () => {
  // @ref LLP 0336#durable-line [tests]: the removal of a whole partition
  // directory is the one cache mutation nothing can reconstruct afterwards,
  // and `rowsDeleted` for that path is `cursor.rowCount` - a count of what
  // OTHER passes committed, which can legitimately read 0 for a directory
  // that still exists. Gating the line on it means the daemon deletes a
  // partition and says nothing at all.
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-daemon-retention-evict-'))
  const savedHypHome = process.env.HYP_HOME
  const savedDevTelemetry = process.env.HYP_DEV_TELEMETRY
  let handle
  try {
    const cacheRoot = path.join(hypHome, 'hypaware', 'cache')
    // No candidate timestamp column in the schema, so the pass falls back to
    // removing the partition on data-file mtime.
    await appendRowsToSourceTable(cacheRoot, 'no_ts_ds', ['source=test'], [
      { name: 'id', type: 'INT32', nullable: false },
      { name: 'message', type: 'STRING', nullable: true },
    ], [
      { id: 1, message: 'no timestamp' },
    ])
    const partitionDir = path.join(cacheRoot, 'datasets', 'no_ts_ds', 'source=test')
    await writeCursor(partitionDir, { ...readCursorSync(partitionDir), rowCount: 0 })
    const stale = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000)
    const dataDir = path.join(partitionDir, 'table', 'data')
    for (const name of await fs.readdir(dataDir)) {
      await fs.utimes(path.join(dataDir, name), stale, stale)
    }

    const configPath = defaultConfigPath(hypHome)
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, JSON.stringify({
      version: 2,
      query: { cache: { retention: { default_days: 30 }, maintenance: { interval_minutes: 0.001 } } },
    }))

    process.env.HYP_HOME = hypHome
    process.env.HYP_DEV_TELEMETRY = '1'
    handle = await runDaemon({
      hypHome,
      configPath,
      env: { ...process.env, HYP_HOME: hypHome },
      runId: 'retention-evict-line-test',
      tickIntervalMs: 0,
      installSignalHandlers: false,
    })

    // Asserted from `daemon.log` and not from a span: the durable line is
    // the channel #durable-line is about, and it is the only one an operator
    // has with no tracer running. (`installObservability` is also process
    // wide, so a second daemon in this file does not get its own span file.)
    const logPath = path.join(hypHome, 'hypaware', 'logs', 'daemon.log')
    const line = await pollJsonlFor(logPath, (r) => r.event === 'daemon.retention_evicted', 10_000)
    assert.ok(
      line,
      'the directory is gone, so the durable line naming it is the only record left that it was ever here'
    )
    assert.equal(line.hyp_dataset, 'no_ts_ds')
    assert.equal(line.partition, 'source=test')
    assert.equal(await fs.access(partitionDir).then(() => true, () => false), false)
  } finally {
    if (handle) {
      await handle.stop()
      await handle.done
    }
    if (savedHypHome === undefined) delete process.env.HYP_HOME
    else process.env.HYP_HOME = savedHypHome
    if (savedDevTelemetry === undefined) delete process.env.HYP_DEV_TELEMETRY
    else process.env.HYP_DEV_TELEMETRY = savedDevTelemetry
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})
