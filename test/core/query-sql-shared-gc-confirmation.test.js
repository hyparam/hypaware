// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { executeQuerySql, QueryExecutionBudgetError } from '../../src/core/query/sql.js'

/**
 * @import { AsyncDataSource } from 'squirreling/src/types.js'
 */

// The staggered-arrival harness from hypaware-server#159, adapted (#2526) at
// a quarter of its byte scale so the file stays quick: every size is divided
// by four, so the garbage one row stride adds is the same share of the
// budget. It drives the real guard against a simulated process heap:
// heapUsed is BASE plus the live set of every running query plus collectible
// garbage, a forced GC drops the garbage, and a simulated clock advances per
// scanned row. Arrival is staggered on rows scanned, not wall time, because
// queries that start together share a baseline and show no amplification at
// all: the earliest query's baseline must be taken while it runs alone, so
// the live sets of the queries that join later eat its headroom.
// @ref LLP 0526#shared-confirmation [tests]: forced GCs are bounded by the shared policy, not by how many checks ask, and every refusal rests on a fresh collection

const MB = 1024 * 1024
const BASE = 100 * MB
const BUDGET = 16 * MB
const STRIDE = 4096
const ROWS = 150_000
const GARBAGE_PER_ROW = 256
const LIVE_PER_QUERY = 7 * MB
const STAGGER_ROWS = 25_000
/** Simulated scan time per row: one query's 150k rows take 1.2s. */
const MS_PER_ROW = 0.008
const STAND_IN_MS = 1000

const sim = { live: 0, garbage: 0, nowMs: 1e6, gcs: 0, rows: 0 }
/** @type {Array<{ rows: number, resolve: () => void }>} */
let milestones = []

const realMemoryUsage = process.memoryUsage
const realNow = performance.now
const globals = /** @type {any} */ (globalThis)
const realGc = globals.gc
// The guard resolves and caches its GC handle on its first crossing, and it
// prefers globalThis.gc, so install a counting stand-in before any query in
// this file runs. This file runs in a process of its own.
globals.gc = () => {
  sim.gcs++
  sim.garbage = 0
}
process.memoryUsage = /** @type {any} */ (() => ({ ...realMemoryUsage(), heapUsed: BASE + sim.live + sim.garbage }))
performance.now = () => sim.nowMs

test.after(() => {
  process.memoryUsage = realMemoryUsage
  performance.now = realNow
  globals.gc = realGc
})

/** @param {number} rows */
function reachRows(rows) {
  return new Promise((resolve) => {
    milestones.push({ rows, resolve: () => resolve(undefined) })
  })
}

/**
 * One scanned row of simulated work: garbage or retention, and the clock.
 * Retention lands in one lump on the last row of each stride, so the heap
 * crosses exactly at an inline check and no watchdog tick sees it first.
 *
 * @param {{ pulled: number, retainPerStride?: number, trace?: Array<{ ms: number, heap: number }> }} shape
 */
function scanOneRow(shape) {
  shape.pulled++
  sim.rows++
  sim.nowMs += MS_PER_ROW
  if (shape.retainPerStride) {
    if (shape.pulled % STRIDE === 0) {
      sim.live += shape.retainPerStride
      // What a collection made at this stride's check would measure.
      shape.trace?.push({ ms: sim.nowMs, heap: BASE + sim.live })
    }
  } else {
    sim.garbage += GARBAGE_PER_ROW
  }
  if (milestones.length && sim.rows >= milestones[0].rows) milestones.shift()?.resolve()
}

/**
 * @param {number} rows
 * @param {{ pulled?: number, retainPerStride?: number, trace?: Array<{ ms: number, heap: number }>, onRow?: (i: number) => void }} [shape]
 * @returns {AsyncDataSource}
 */
function simulatedSource(rows, shape = {}) {
  const state = Object.assign(shape, { pulled: 0 })
  return {
    columns: ['v'],
    numRows: rows,
    scan() {
      return {
        appliedWhere: false,
        appliedLimitOffset: false,
        async *rows() {
          for (let i = 0; i < rows; i++) {
            scanOneRow(state)
            state.onRow?.(i)
            yield { columns: ['v'], cells: { v: () => Promise.resolve(i) }, resolved: { v: i } }
            if ((i & 0xff) === 0) await new Promise((r) => setImmediate(r))
          }
        },
      }
    },
  }
}

const storage = /** @type {any} */ ({ cacheRoot: '/nonexistent', pendingInfo: async () => ({ pending: false }) })

/** @param {AsyncDataSource} source */
function registryFor(source) {
  return /** @type {any} */ ({ getDataset: () => ({ discoverPartitions: async () => [{}], createDataSource: () => source }) })
}

/**
 * Run one query holding `live` bytes for its lifetime, the way a running
 * scan's operator state would, and report where it refused, if it did.
 *
 * @param {AsyncDataSource} source
 * @param {{ live?: number, budget?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ refused: false } | { refused: true, site: string, settled: number, baseline: number, atMs: number }>}
 */
async function runOne(source, opts = {}) {
  const live = opts.live ?? 0
  sim.live += live
  try {
    await executeQuerySql({
      query: 'SELECT sum(v) AS n FROM t WHERE v >= 0',
      registry: registryFor(source),
      storage,
      maxHeapBytes: opts.budget ?? BUDGET,
      includeLocalOnly: true,
      signal: opts.signal,
    })
    return { refused: false }
  } catch (err) {
    if (!(err instanceof QueryExecutionBudgetError)) throw err
    const diagnostics = /** @type {{ site: string, baselineBytes: number }} */ (err.diagnostics)
    return { refused: true, site: diagnostics.site, settled: err.observedBytes, baseline: diagnostics.baselineBytes, atMs: sim.nowMs }
  } finally {
    sim.live -= live
  }
}

function resetHeap() {
  sim.live = 0
  sim.garbage = 0
  sim.gcs = 0
  sim.rows = 0
  milestones = []
}

/**
 * Start `n` garbage-heavy, bounded-retention queries, each after the first
 * has scanned another STAGGER_ROWS rows.
 *
 * @param {number} n
 * @param {number} [livePerQuery]
 */
async function staggered(n, livePerQuery = LIVE_PER_QUERY) {
  resetHeap()
  const startMs = sim.nowMs
  const runs = [runOne(simulatedSource(ROWS), { live: livePerQuery })]
  for (let i = 1; i < n; i++) {
    await reachRows(i * STAGGER_ROWS)
    runs.push(runOne(simulatedSource(ROWS), { live: livePerQuery }))
  }
  const results = await Promise.all(runs)
  return { results, gcs: sim.gcs, rows: sim.rows, simMs: sim.nowMs - startMs }
}

/**
 * The most forced GCs the shared policy allows for `n` queries: each may
 * force once before any collection follows its baseline, once at its
 * terminal check, and once when the last shared collection showed it over
 * budget; beyond those, one per lapsed stand-in interval and one per budget
 * of heap growth across the whole process. Nothing scales with how many
 * checks ask.
 *
 * @param {number} n
 * @param {number} simMs
 * @param {number} grownBytes
 */
function policyBound(n, simMs, grownBytes) {
  return 3 * n + Math.ceil(simMs / STAND_IN_MS) + 1 + Math.ceil(grownBytes / BUDGET)
}

test('staggered garbage-heavy queries share forced GCs: the count is bounded by the policy, not by the callers', async (t) => {
  for (const live of [LIVE_PER_QUERY, 7.75 * MB]) {
    for (const n of [1, 2, 3]) {
      const run = await staggered(n, live)
      const bound = policyBound(n, run.simMs, n * (ROWS * GARBAGE_PER_ROW + live))
      t.diagnostic(`N=${n} live/query=${live / MB}MB forcedGCs=${run.gcs} perQuery=${(run.gcs / n).toFixed(1)} bound=${bound} simMs=${Math.round(run.simMs)}`)
      assert.ok(run.results.every((r) => !r.refused), `N=${n}: bounded retention never refuses`)
      assert.ok(run.gcs <= bound, `N=${n}: ${run.gcs} forced GCs within the policy bound ${bound}`)
    }
  }
})

test('a retaining query alone refuses at the first check past its budget, as before', async () => {
  resetHeap()
  // 1MB per stride: the live set reaches 16MB at the 16th stride and passes
  // it at the 17th, where the inline check forces a GC and refuses.
  const shape = { pulled: 0, retainPerStride: 1 * MB }
  const result = await runOne(simulatedSource(ROWS, shape))
  assert.deepEqual({ refused: result.refused, site: result.refused && result.site, pulled: shape.pulled }, { refused: true, site: 'row_scan', pulled: 17 * STRIDE })
  assert.equal(sim.gcs, 1, 'one forced GC, and it refused')
})

test('a retaining query among staggered scans still refuses, within the stand-in bounds of crossing', async (t) => {
  resetHeap()
  const first = runOne(simulatedSource(ROWS), { live: LIVE_PER_QUERY })
  await reachRows(STAGGER_ROWS)
  const second = runOne(simulatedSource(ROWS), { live: LIVE_PER_QUERY })
  await reachRows(2 * STAGGER_ROWS)
  /** @type {Array<{ ms: number, heap: number }>} */
  const trace = []
  const crasher = await runOne(simulatedSource(ROWS, { retainPerStride: 1 * MB, trace }))
  await Promise.all([first, second])
  assert.ok(crasher.refused, 'retained growth is refused while sibling collections stand in')
  // The first of its checks where a collection would already have refused.
  const crossing = trace.find((p) => p.heap - crasher.baseline > BUDGET)
  assert.ok(crossing, 'the crasher crossed its budget')
  const lagMs = crasher.atMs - crossing.ms
  t.diagnostic(`crossed at +${Math.round(crossing.ms - trace[0].ms)}ms, refused ${Math.round(lagMs)}ms later at ${crasher.site}, settled ${(crasher.settled / MB).toFixed(1)}MB of ${BUDGET / MB}MB`)
  // One stride of all three scans is the slack for where the next check lands.
  assert.ok(lagMs <= STAND_IN_MS + 3 * STRIDE * MS_PER_ROW, `refused ${lagMs}ms after crossing`)
  assert.ok(crasher.settled <= 2 * BUDGET, 'a stand-in hides less than one budget of retained growth')
})

test('a stand-in never passes a terminal check: tail retention under one budget of growth is still refused', async () => {
  resetHeap()
  // The first stride's last row lands 10MB retained and 32MB of garbage in one
  // lump, so the heap is flat until then and the collection that check (or a
  // watchdog tick just before it) forces is the one that passes, showing 10MB
  // of growth. The next 4000 rows retain 8MB more: 18MB settled, over budget,
  // but under one budget of heap growth since that collection, and inside the
  // interval because this source does not advance the clock. Two real waits
  // longer than the watchdog interval pin its ticks instead of leaving them to
  // the scheduler: one while the heap is flat, one on the last row with the
  // 18MB held, where the tick must let that collection stand in. The terminal
  // check forces its own and refuses.
  const rows = STRIDE + 4000
  const tick = () => new Promise((resolve) => setTimeout(resolve, 125))
  /** @type {AsyncDataSource} */
  const source = {
    columns: ['v'],
    numRows: rows,
    scan() {
      return {
        appliedWhere: false,
        appliedLimitOffset: false,
        async *rows() {
          for (let i = 0; i < rows; i++) {
            sim.rows++
            if (i === STRIDE - 1) {
              sim.live += 10 * MB
              sim.garbage += 32 * MB
            } else if (i >= STRIDE) {
              sim.live += 2 * 1024
            }
            if (i === STRIDE - 600 || i === rows - 1) await tick()
            yield { columns: ['v'], cells: { v: () => Promise.resolve(i) }, resolved: { v: i } }
          }
        },
      }
    },
  }
  const result = await runOne(source)
  sim.live = 0
  assert.equal(sim.gcs, 2, 'one passing GC at the stride, one forced at terminal')
  assert.deepEqual({ refused: result.refused, site: result.refused && result.site }, { refused: true, site: 'terminal' })
})

test('the watchdog still refuses retention in a phase that scans no rows', async () => {
  resetHeap()
  // The source yields one row, then stalls in a phase that pulls nothing
  // but yields to the event loop while retained memory grows and the clock
  // runs. Only the watchdog can see it.
  /** @type {AsyncDataSource} */
  const source = {
    columns: ['v'],
    numRows: 2,
    scan() {
      return {
        appliedWhere: false,
        appliedLimitOffset: false,
        async *rows() {
          yield { columns: ['v'], cells: { v: () => Promise.resolve(0) }, resolved: { v: 0 } }
          for (let i = 0; i < 40; i++) {
            sim.live += 1 * MB
            sim.nowMs += 100
            await new Promise((r) => setTimeout(r, 20))
          }
          yield { columns: ['v'], cells: { v: () => Promise.resolve(1) }, resolved: { v: 1 } }
        },
      }
    },
  }
  const result = await runOne(source)
  sim.live = 0
  assert.deepEqual({ refused: result.refused, site: result.refused && result.site }, { refused: true, site: 'watchdog' })
})

test('an aborted query leaves nothing in the shared state, and the state does not grow across queries', async () => {
  resetHeap()
  const controller = new AbortController()
  const aborted = runOne(simulatedSource(ROWS, {
    onRow: (i) => {
      if (i === 100_000) controller.abort(new Error('caller went away'))
    },
  }), { live: LIVE_PER_QUERY, signal: controller.signal })
  await assert.rejects(aborted, /caller went away/)
  assert.equal(sim.live, 0)
  // A fresh query after the abort behaves exactly as a first query does:
  // nothing the aborted one did is charged to it or holds it back.
  const after = await staggered(1)
  assert.ok(after.results.every((r) => !r.refused))
  assert.ok(after.gcs <= policyBound(1, after.simMs, ROWS * GARBAGE_PER_ROW + LIVE_PER_QUERY))
})

test('a disabled budget never samples, collects, or refuses', async () => {
  resetHeap()
  const result = await runOne(simulatedSource(100_000, { retainPerStride: 1 * MB }), { budget: 0 })
  sim.live = 0
  assert.deepEqual(result, { refused: false })
  assert.equal(sim.gcs, 0)
})
