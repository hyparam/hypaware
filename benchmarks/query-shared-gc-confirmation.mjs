// @ts-check

// Real-heap companion to test/core/query-sql-shared-gc-confirmation.test.js
// (#2526). The test proves the shared confirmation policy on a simulated
// heap; this runs the same staggered shape on V8's own heap so the forced-GC
// count and the CPU they cost are measured, not modeled. Each query scans
// rows that each allocate a fresh string (collectible garbage) while it holds
// a live set of its own for its lifetime, and each later query starts once
// the first has scanned another stagger of rows, so the earliest query's
// baseline excludes the live sets that join after it.
//
//   node --expose-gc benchmarks/query-shared-gc-confirmation.mjs [--queries 3] [--rows 400000]
//
// It counts calls through globalThis.gc, which the guard resolves before any
// other handle, by wrapping it before the first query runs. That wrapper is
// benchmark-only instrumentation.

import { performance } from 'node:perf_hooks'

import { executeQuerySql } from '../src/core/query/sql.js'

const MB = 1024 * 1024
const args = parseArgs(process.argv.slice(2))
const QUERIES = args.queries ?? 3
const ROWS = args.rows ?? 400_000
const STAGGER_ROWS = Math.floor(ROWS / 6)
const BUDGET = args.budgetMb ? args.budgetMb * MB : 64 * MB
const LIVE_PER_QUERY = args.liveMb ? args.liveMb * MB : 28 * MB
const ROW_BYTES = 1024

const globals = /** @type {any} */ (globalThis)
if (typeof globals.gc !== 'function') throw new Error('run with node --expose-gc')
const realGc = globals.gc
let forcedGcs = 0
let forcedGcMs = 0
globals.gc = () => {
  const start = performance.now()
  realGc()
  forcedGcMs += performance.now() - start
  forcedGcs++
}

let scanned = 0
/** @type {Array<{ rows: number, resolve: () => void }>} */
const milestones = []

/** @param {number} rows */
function reachRows(rows) {
  return new Promise((resolve) => milestones.push({ rows, resolve: () => resolve(undefined) }))
}

/** A live set of roughly `bytes` on the JS heap, held while a query runs. */
function liveSet(/** @type {number} */ bytes) {
  const out = []
  for (let i = 0; i < bytes / ROW_BYTES; i++) out.push(`live-${i}-`.padEnd(ROW_BYTES, 'l'))
  return out
}

/** @param {number} rows */
function garbageSource(rows) {
  return {
    columns: ['v'],
    numRows: rows,
    scan() {
      return {
        appliedWhere: false,
        appliedLimitOffset: false,
        async *rows() {
          for (let i = 0; i < rows; i++) {
            scanned++
            if (milestones.length && scanned >= milestones[0].rows) milestones.shift()?.resolve()
            const row = `row-${i}-`.padEnd(ROW_BYTES, 'g')
            yield { columns: ['v'], cells: { v: () => Promise.resolve(row.length) }, resolved: { v: row.length } }
            if ((i & 0xff) === 0) await new Promise((r) => setImmediate(r))
          }
        },
      }
    },
  }
}

const storage = /** @type {any} */ ({ cacheRoot: '/nonexistent', pendingInfo: async () => ({ pending: false }) })

async function runOne() {
  let live = liveSet(LIVE_PER_QUERY)
  const source = garbageSource(ROWS)
  try {
    const result = await executeQuerySql({
      query: 'SELECT sum(v) AS n FROM t WHERE v >= 0',
      registry: /** @type {any} */ ({ getDataset: () => ({ discoverPartitions: async () => [{}], createDataSource: () => source }) }),
      storage,
      maxHeapBytes: BUDGET,
      includeLocalOnly: true,
    })
    return { refused: false, live: live.length, rows: result.rows.length }
  } catch (err) {
    return { refused: true, error: /** @type {Error} */ (err).message, live: live.length }
  } finally {
    live = []
  }
}

realGc()
const cpuStart = process.cpuUsage()
const wallStart = performance.now()
const runs = [runOne()]
for (let i = 1; i < QUERIES; i++) {
  await reachRows(i * STAGGER_ROWS)
  runs.push(runOne())
}
const results = await Promise.all(runs)
const cpu = process.cpuUsage(cpuStart)
const wallMs = performance.now() - wallStart

console.log(JSON.stringify({
  queries: QUERIES,
  rows_per_query: ROWS,
  budget_mb: BUDGET / MB,
  live_per_query_mb: LIVE_PER_QUERY / MB,
  refused: results.filter((r) => r.refused).length,
  forced_gcs: forcedGcs,
  forced_gc_ms: Math.round(forcedGcMs),
  cpu_ms: Math.round((cpu.user + cpu.system) / 1000),
  wall_ms: Math.round(wallMs),
  node: process.version,
}))

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ queries?: number, rows?: number, budgetMb?: number, liveMb?: number }} */
  const out = {}
  for (let i = 0; i < argv.length; i += 2) {
    const value = Number(argv[i + 1])
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${argv[i]} needs a positive number`)
    if (argv[i] === '--queries') out.queries = value
    else if (argv[i] === '--rows') out.rows = value
    else if (argv[i] === '--budget-mb') out.budgetMb = value
    else if (argv[i] === '--live-mb') out.liveMb = value
    else throw new Error(`unknown flag ${argv[i]}`)
  }
  return out
}
