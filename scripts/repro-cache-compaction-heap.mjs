// @ts-check

import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { maintainCache } from '../src/core/cache/maintenance.js'
import { appendRowsToSourceTable, readCursorSync } from '../src/core/cache/partition.js'

/** @import { ColumnSpec } from '../hypaware-plugin-kernel-types.js' */

/** @type {ColumnSpec[]} */
const COLUMNS = [
  { name: '_hyp_cache_row_id', type: 'STRING', nullable: false },
  { name: 'session_id', type: 'STRING', nullable: false },
  { name: 'date', type: 'STRING', nullable: false },
  { name: 'attributes', type: 'STRING', nullable: false },
]

const DECLARATION = {
  source: { columns: ['source'] },
  iceberg: {
    fields: [
      { column: 'session_id', transform: 'identity', required: true },
      { column: 'date', transform: 'identity', required: true },
    ],
  },
}

const command = process.argv[2]
const cacheRoot = process.argv[3]
const runId = process.env.DEV_RUN_ID ?? 'cache-compaction-heap-repro'

if (!['seed', 'compact'].includes(command) || !cacheRoot) {
  console.error('usage: repro-cache-compaction-heap.mjs <seed|compact> <cache-root>')
  process.exitCode = 2
} else if (command === 'seed') {
  await seedFixture(cacheRoot)
} else {
  await compactFixture(cacheRoot)
}

/** @param {string} root */
async function seedFixture(root) {
  const historicalSessions = numberEnv('HISTORICAL_SESSIONS', 4000)
  const recentSessions = numberEnv('RECENT_SESSIONS', 16)
  const recentWaves = numberEnv('RECENT_WAVES', 8)
  const payloadChars = numberEnv('PAYLOAD_CHARS', 64 * 1024)

  await fs.mkdir(root, { recursive: true })
  phase('seed.start', { root, historicalSessions, recentSessions, recentWaves, payloadChars })

  const historical = rowsForWave('historical', 0, historicalSessions, payloadChars)
  await appendRowsToSourceTable(
    root, 'ai_gateway_messages', ['source=claude'], COLUMNS, historical,
    { declaration: DECLARATION }
  )
  phase('seed.historical_appended', { rows: historical.length })

  const baseline = await maintainCache({ cacheRoot: root, force: true, compactOnly: true })
  phase('seed.baseline_compacted', reportFields(baseline))

  for (let wave = 0; wave < recentWaves; wave++) {
    const recent = rowsForWave('recent', wave, recentSessions, payloadChars)
    await appendRowsToSourceTable(
      root, 'ai_gateway_messages', ['source=claude'], COLUMNS, recent,
      { declaration: DECLARATION }
    )
    phase('seed.recent_wave_appended', { wave, rows: recent.length })
  }

  const dir = partitionDir(root)
  const cursor = readCursorSync(dir)
  phase('seed.ready', {
    cursorRowCount: cursor.rowCount,
    baselineFiles: baseline.partitions[0]?.dataFilesAfter,
    liveFiles: await dataFileCount(path.join(dir, cursor.tableDir ?? 'table')),
  })
}

/** @param {string} root */
async function compactFixture(root) {
  phase('compact.start', { root })
  const before = process.memoryUsage()
  const settleOptions = process.env.DISABLE_SETTLE === '1'
    ? {}
    : {
        // The daemon threads the gateway's re-settle hook through maintenance.
        // An identity hook is enough to exercise the core retention shape;
        // pre-LLP-0300 compactGeneration held every fallback until scan end.
        storage: /** @type {any} */ ({}),
        getSettleHook: () => async (rows) => rows,
      }
  const report = await maintainCache({
    cacheRoot: root,
    compactOnly: true,
    force: process.env.FORCE === '1',
    ...settleOptions,
  })
  const after = process.memoryUsage()
  phase('compact.complete', {
    ...reportFields(report),
    heapUsedBefore: before.heapUsed,
    heapUsedAfter: after.heapUsed,
    rssAfter: after.rss,
  })
}

/**
 * @param {'historical'|'recent'} cohort
 * @param {number} wave
 * @param {number} sessions
 * @param {number} payloadChars
 */
function rowsForWave(cohort, wave, sessions, payloadChars) {
  return Array.from({ length: sessions }, (_, session) => {
    const sessionId = `${cohort}-session-${String(session).padStart(5, '0')}`
    const prefix = `${cohort}:${wave}:${session}:`
    const blob = prefix + 'x'.repeat(Math.max(0, payloadChars - prefix.length - 64))
    return {
      _hyp_cache_row_id: `${cohort}-${wave}-${session}`,
      session_id: sessionId,
      date: cohort === 'historical' ? '2026-01-01' : '2026-08-24',
      attributes: JSON.stringify({
        gateway: { identity_source: 'gateway_fallback' },
        blob,
      }),
    }
  })
}

/** @param {string} root */
function partitionDir(root) {
  return path.join(root, 'datasets', 'ai_gateway_messages', 'source=claude')
}

/** @param {string} tableDir */
async function dataFileCount(tableDir) {
  const entries = await fs.readdir(path.join(tableDir, 'data'), { withFileTypes: true })
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.parquet')).length
}

/** @param {Awaited<ReturnType<typeof maintainCache>>} report */
function reportFields(report) {
  const part = report.partitions[0]
  return {
    totalCompacted: report.totalCompacted,
    totalFailed: report.totalFailed,
    elapsedMs: report.elapsedMs,
    dataFilesBefore: part?.dataFilesBefore,
    dataFilesAfter: part?.dataFilesAfter,
    rows: part?.rowCount,
  }
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} fields
 */
function phase(name, fields) {
  const memory = process.memoryUsage()
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    dev_run_id: runId,
    phase: name,
    heap_used: memory.heapUsed,
    rss: memory.rss,
    ...fields,
  })
  console.log(line)
  if (process.env.REPRO_LOG) fsSync.appendFileSync(process.env.REPRO_LOG, `${line}\n`, 'utf8')
}

/**
 * @param {string} name
 * @param {number} fallback
 */
function numberEnv(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}
