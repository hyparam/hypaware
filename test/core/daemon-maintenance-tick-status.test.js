// @ts-check

// @ref LLP 0220#tick-reports-degraded [tests]: `withSpan` derives the span's
// status code from a `status` attribute snapshot taken before the callback
// runs, and always calls `setStatus` after the callback resolves - so a
// `span.setAttribute('status', 'degraded')` made once the report is in hand
// (this tick's own verdict) never reached the span's OTel status code; the
// post-hoc `setStatus(OK)` clobbered it. `runtime.js`'s maintenance tick was
// rewritten to manage its span directly instead of through `withSpan` so the
// real verdict wins. This drives a real daemon through one degraded tick and
// reads the exported span back off disk (round-1 review finding 4).

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runDaemon } from '../../src/core/daemon/runtime.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { appendRowsToSourceTable, readCursorSync, writeCursor } from '../../src/core/cache/partition.js'

/** @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js' */
/** @import { PartitionCursor } from '../../src/core/cache/types.js' */

/** @type {ColumnSpec[]} */
const SESSION_COLUMNS = [
  { name: 'id', type: 'INT32', nullable: false },
  { name: 'session_id', type: 'STRING', nullable: false },
  { name: 'attributes', type: 'STRING', nullable: true },
]

const SESSION_DECLARATION = {
  source: { columns: ['source'] },
  iceberg: { fields: [{ column: 'session_id', transform: 'identity' }] },
}

/** @param {string} dir @param {number} baselineFiles */
async function plantStamplessRecord(dir, baselineFiles) {
  const cursor = readCursorSync(dir)
  /** @type {PartitionCursor} */
  const next = {
    ...cursor,
    compaction: {
      previousTableDir: 'table',
      compactedAt: '2026-08-12T21:55:35.168Z',
      resettleBaselineFiles: baselineFiles,
    },
  }
  await writeCursor(dir, next)
}

/** @param {string} dir */
async function tearOneDataFile(dir) {
  const cursor = readCursorSync(dir)
  const dataDir = path.join(dir, cursor.tableDir ?? 'table', 'data')
  const entries = await fs.readdir(dataDir, { withFileTypes: true })
  const [torn] = entries
    .filter((e) => e.isFile() && e.name.endsWith('.parquet'))
    .map((e) => path.join(dataDir, e.name))
  assert.ok(torn, 'fixture invariant: the partition must hold a live data file to tear')
  await fs.truncate(torn, 4)
}

/**
 * Poll a JSONL file for a line matching `predicate`, since the tracer
 * exporter writes to an `fs.WriteStream` with no flush hook this daemon
 * ever calls: the write lands async relative to the tick's own promise
 * resolving.
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

test('a degraded maintenance tick sets the span status code, not just the attribute', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-daemon-maint-status-'))
  const savedHypHome = process.env.HYP_HOME
  const savedDevTelemetry = process.env.HYP_DEV_TELEMETRY
  let handle
  try {
    const cacheRoot = path.join(hypHome, 'hypaware', 'cache')
    // Two waves over the same sessions, so the owed retry is an in-place
    // merge (LLP 0310) that reads the torn file instead of a floor
    // reassessment that reads no data.
    for (const wave of [0, 1]) {
      const rows = Array.from({ length: 2 }, (_, i) => ({
        id: wave * 2 + i,
        session_id: `s-${i}`,
        attributes: `{"gateway":{"session":"s-${i}","wave":${wave}}}`,
      }))
      await appendRowsToSourceTable(
        cacheRoot, 'ai_gateway_messages', ['source=claude'], SESSION_COLUMNS, rows,
        { declaration: SESSION_DECLARATION }
      )
    }
    const partDir = path.join(cacheRoot, 'datasets', 'ai_gateway_messages', 'source=claude')
    await plantStamplessRecord(partDir, 4)
    await tearOneDataFile(partDir)

    const configPath = defaultConfigPath(hypHome)
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, JSON.stringify({
      version: 2,
      query: { cache: { maintenance: { interval_minutes: 0.001 } } },
    }))

    // `installObservability()` (called inside `runDaemon`) reads real
    // `process.env`, not the `env` option below - the same mechanism the
    // hermetic smokes use (CLAUDE.md's "temp HYP_HOME and
    // HYP_DEV_TELEMETRY=1"), so the JSONL span exporter has to be armed here.
    process.env.HYP_HOME = hypHome
    process.env.HYP_DEV_TELEMETRY = '1'

    handle = await runDaemon({
      hypHome,
      configPath,
      env: { ...process.env, HYP_HOME: hypHome },
      runId: 'maint-status-test',
      tickIntervalMs: 0,
      installSignalHandlers: false,
    })

    const tracesPath = path.join(hypHome, 'hypaware', 'dev-telemetry', `traces-${process.pid}.jsonl`)
    const span = await pollJsonlFor(tracesPath, (r) => r.name === 'maintenance.tick', 5_000)

    assert.ok(span, 'the maintenance.tick span must be exported within the poll window')
    assert.equal(span.attributes.status, 'degraded', 'sanity: the attribute this tick set')
    assert.equal(
      span.status, 'failed',
      'the span status CODE (not just the attribute) must reflect the degraded tick - ' +
      'a bare setAttribute inside withSpan would leave this "ok"'
    )
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
