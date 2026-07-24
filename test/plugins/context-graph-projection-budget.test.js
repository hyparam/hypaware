// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  projectGraph,
  resolveProjectionMaxHeapBytes,
} from '../../hypaware-core/plugins-workspace/context-graph/src/project.js'

// Regression for issue #376 step 1: graph projection must pass its OWN finite
// heap budget (HYP_GRAPH_PROJECTION_MAX_HEAP_MB, default 3 GiB) to every
// executeQuerySql scan, instead of inheriting the 1 GiB user-query default
// (#295). The shared scan fully materializes the source table, so on prod it
// trips that default and freezes the graph. A dedicated FINITE budget (never 0)
// unblocks it while preserving the fail-clean property and leaving the
// user-query guard untouched.

const KNOB = 'HYP_GRAPH_PROJECTION_MAX_HEAP_MB'
const DEFAULT_BYTES = 3072 * 1024 * 1024

/** @returns {import('../../hypaware-core/plugins-workspace/context-graph/src/types.js').Contract} */
function probeContract() {
  return {
    name: 'budget-probe',
    plugin: '@test/budget',
    sourceDataset: 'src_table',
    projector: 'test.t0',
    projectorVersion: 1,
    rules: [
      // Declarative rule -> exercises the shared per-contract scan site.
      {
        kind: 'node',
        type: 'Thing',
        columns: ['id'],
        toRow: (r) => ({ node_id: `n-${r.id}`, first_seen: '2026-01-01T00:00:00.000Z' }),
      },
      // Raw-SQL rule -> exercises the raw-SQL rule scan site.
      {
        kind: 'edge',
        type: 'rel',
        sql: 'SELECT a, b FROM src_table',
        toRow: (r) => ({ edge_id: `e-${r.a}-${r.b}`, first_seen: '2026-01-01T00:00:00.000Z' }),
      },
    ],
  }
}

/**
 * Run projectGraph with a recording SQL seam and a no-op storage. Returns the
 * captured { query, maxHeapBytes } for every executeQuerySql call: the shared
 * scan, the raw-SQL rule scan, and both dedup id reads.
 *
 * @returns {Promise<{ query: string, maxHeapBytes: number | undefined }[]>}
 */
async function captureBudgets() {
  /** @type {{ query: string, maxHeapBytes: number | undefined }[]} */
  const calls = []
  /** @type {any} */
  const fakeExec = async (args) => {
    calls.push({ query: args.query, maxHeapBytes: args.maxHeapBytes })
    if (args.query === 'SELECT id FROM src_table') return { rows: [{ id: '1' }] }
    if (args.query === 'SELECT a, b FROM src_table') return { rows: [{ a: 'x', b: 'y' }] }
    // Dedup reads: empty committed set, so freshNodes/freshEdges are non-empty
    // and the append (a no-op storage) fires.
    return { rows: [] }
  }
  /** @type {any} */
  const storage = {
    cacheTablePath: (dataset) => `/fake/${dataset}`,
    appendRows: async () => {},
  }
  await projectGraph({
    query: /** @type {any} */ ({}),
    storage,
    contracts: [probeContract()],
    __executeSql: fakeExec,
  })
  return calls
}

test('projectGraph passes the default 3 GiB projection budget at all three scan sites when the knob is unset', async () => {
  const prev = process.env[KNOB]
  delete process.env[KNOB]
  try {
    const calls = await captureBudgets()

    const shared = calls.find((c) => c.query === 'SELECT id FROM src_table')
    const rawSql = calls.find((c) => c.query === 'SELECT a, b FROM src_table')
    const dedupNode = calls.find((c) => c.query === 'SELECT node_id FROM node')
    const dedupEdge = calls.find((c) => c.query === 'SELECT edge_id FROM edge')

    assert.ok(shared, 'the shared per-contract scan ran')
    assert.ok(rawSql, 'the raw-SQL rule scan ran')
    assert.ok(dedupNode, 'the node dedup id read ran')
    assert.ok(dedupEdge, 'the edge dedup id read ran')

    for (const c of [shared, rawSql, dedupNode, dedupEdge]) {
      assert.equal(
        c.maxHeapBytes,
        DEFAULT_BYTES,
        `${c.query}: must carry the dedicated 3 GiB projection budget, not inherit the 1 GiB user-query default`
      )
      // The whole point of a DEDICATED budget over an exemption: never 0.
      assert.notEqual(c.maxHeapBytes, 0, `${c.query}: budget must never be 0 (0 disables the OOM guard)`)
      assert.ok(Number.isFinite(c.maxHeapBytes), `${c.query}: budget must be finite`)
    }
  } finally {
    if (prev === undefined) delete process.env[KNOB]
    else process.env[KNOB] = prev
  }
})

test('HYP_GRAPH_PROJECTION_MAX_HEAP_MB overrides the projection budget at every scan site', async () => {
  const prev = process.env[KNOB]
  process.env[KNOB] = '512'
  try {
    const calls = await captureBudgets()
    assert.ok(calls.length >= 4, 'all scan sites ran')
    for (const c of calls) {
      assert.equal(c.maxHeapBytes, 512 * 1024 * 1024, `${c.query}: knob override reaches the scan`)
    }
  } finally {
    if (prev === undefined) delete process.env[KNOB]
    else process.env[KNOB] = prev
  }
})

test('resolveProjectionMaxHeapBytes defaults to 3 GiB and never returns 0', () => {
  const prev = process.env[KNOB]
  try {
    // Unset -> default.
    delete process.env[KNOB]
    assert.equal(resolveProjectionMaxHeapBytes(), DEFAULT_BYTES)

    // A positive knob converts MB -> bytes.
    process.env[KNOB] = '2048'
    assert.equal(resolveProjectionMaxHeapBytes(), 2048 * 1024 * 1024)

    // The dangerous inputs must NEVER remove the guard: blank, zero, negative,
    // and non-numeric all fall back to the finite default, never 0.
    for (const bad of ['', '   ', '0', '-1', 'abc']) {
      process.env[KNOB] = bad
      const resolved = resolveProjectionMaxHeapBytes()
      assert.equal(resolved, DEFAULT_BYTES, `knob=${JSON.stringify(bad)} falls back to the default`)
      assert.notEqual(resolved, 0, `knob=${JSON.stringify(bad)} must never disable the guard`)
    }
  } finally {
    if (prev === undefined) delete process.env[KNOB]
    else process.env[KNOB] = prev
  }
})
