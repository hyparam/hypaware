// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { appendRowsToSourceTable } from '../../src/core/cache/partition.js'
import { createQueryStorageService } from '../../src/core/cache/storage.js'
import { createQueryRegistry } from '../../src/core/registry/datasets.js'
import { EDGE_COLUMNS, graphDatasetRegistration, NODE_COLUMNS } from '../../hypaware-core/plugins-workspace/context-graph/src/datasets.js'
import { queryNeighbors, resolveSeed, traverse } from '../../hypaware-core/plugins-workspace/context-graph/src/query.js'

/**
 * @param {string} node_id
 * @param {string} node_type
 * @param {string} natural_key
 * @param {string | null} label
 */
function n(node_id, node_type, natural_key, label) {
  return { node_id, node_type, natural_key, label }
}

/**
 * @param {string} src_id
 * @param {string} dst_id
 * @param {string} edge_type
 */
function e(src_id, dst_id, edge_type) {
  return { src_id, dst_id, edge_type }
}

// A small Session-rooted activity graph. f2 is isolated (no edges). It exists
// only to collide on the `index.js` basename for the ambiguity test.
const NODES = [
  n('s1', 'Session', 'conv-1', null),
  n('s2', 'Session', 'conv-2', null),
  n('a1', 'App', 'claude-code', 'claude-code'),
  n('m1', 'Model', 'sonnet', 'sonnet'),
  n('t1', 'Tool', 'Bash', 'Bash'),
  n('f1', 'File', '/repo/index.js', 'index.js'),
  n('f2', 'File', '/other/index.js', 'index.js'),
]

const EDGES = [
  e('s1', 'a1', 'via'),
  e('s1', 'm1', 'used_model'),
  e('s1', 't1', 'used'),
  e('s1', 'f1', 'touched'),
  e('s2', 'a1', 'via'),
  e('s2', 'f1', 'touched'),
]

/**
 * Assert a traversal succeeded and return it as a plain object for field access.
 * @param {ReturnType<typeof traverse>} r
 * @returns {any}
 */
function ok(r) {
  assert.equal(r.ok, true, r.ok ? '' : `expected ok, got error: ${r.error}`)
  return r
}

/** @param {any[]} neighbors */
const idsOf = (neighbors) => new Set(neighbors.map((x) => x.node.node_id))

test('depth-1 out from a Session reaches its app/model/tool/file', () => {
  const r = ok(traverse({ nodes: NODES, edges: EDGES, seed: 's1', depth: 1, direction: 'out' }))
  assert.equal(r.neighbors.length, 4)
  assert.deepEqual(idsOf(r.neighbors), new Set(['a1', 'm1', 't1', 'f1']))
  assert.ok(r.neighbors.every((x) => x.hop === 1 && x.direction === 'out'))
})

test('depth-1 in from a File reaches the Sessions that touched it', () => {
  const r = ok(traverse({ nodes: NODES, edges: EDGES, seed: '/repo/index.js', depth: 1, direction: 'in' }))
  assert.deepEqual(idsOf(r.neighbors), new Set(['s1', 's2']))
  assert.ok(r.neighbors.every((x) => x.hop === 1 && x.direction === 'in' && x.edge_type === 'touched'))
})

test('depth-2 both from a File yields co-occurrence (file → sessions → resources)', () => {
  const r = ok(traverse({ nodes: NODES, edges: EDGES, seed: 'f1', depth: 2, direction: 'both' }))
  // hop1: s1, s2 ; hop2: a1, m1, t1 (f1 already visited, not revisited)
  assert.equal(r.neighbors.length, 5)
  const hop2 = r.neighbors.filter((x) => x.hop === 2)
  assert.deepEqual(idsOf(hop2), new Set(['a1', 'm1', 't1']))
})

test('--edge-type restricts which relations are walked', () => {
  const r = ok(traverse({ nodes: NODES, edges: EDGES, seed: 's1', depth: 1, direction: 'out', edgeTypes: ['used'] }))
  assert.deepEqual(idsOf(r.neighbors), new Set(['t1']))
})

test('direction out from a leaf File yields no neighbors (but succeeds)', () => {
  const r = ok(traverse({ nodes: NODES, edges: EDGES, seed: 'f1', depth: 2, direction: 'out' }))
  assert.equal(r.neighbors.length, 0)
})

test('--limit truncates in BFS order and reports the true reachable total', () => {
  const r = ok(traverse({ nodes: NODES, edges: EDGES, seed: 's1', depth: 1, direction: 'out', limit: 2 }))
  assert.equal(r.neighbors.length, 2)
  assert.equal(r.truncated, true)
  assert.equal(r.reachable, 4)
})

test('a node with no visited dedup is never revisited across hops', () => {
  // s1 is reachable from f1 (hop1) and would re-appear via s2→f1→... ; ensure
  // the seed and already-seen nodes are not re-emitted.
  const r = ok(traverse({ nodes: NODES, edges: EDGES, seed: 'f1', depth: 3, direction: 'both' }))
  const ids = [...idsOf(r.neighbors)]
  assert.equal(ids.includes('f1'), false, 'seed not emitted as its own neighbor')
  assert.equal(new Set(ids).size, ids.length, 'no duplicate neighbors')
})

test('resolveSeed matches node_id, then natural_key, then label', () => {
  /** @type {[string, string][]} */
  const cases = [['s1', 's1'], ['conv-1', 's1'], ['/repo/index.js', 'f1'], ['Bash', 't1']]
  for (const [token, expected] of cases) {
    const r = resolveSeed(NODES, token, undefined)
    assert.equal(r.ok, true, `expected ${token} to resolve`)
    assert.equal(r.ok && r.node.node_id, expected)
  }
})

test('resolveSeed reports ambiguity with candidates rather than silently picking', () => {
  const r = resolveSeed(NODES, 'index.js', undefined)
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.candidates?.length, 2)
})

test('resolveSeed --type narrows the match', () => {
  const r = resolveSeed(NODES, 'sonnet', 'Model')
  assert.equal(r.ok && r.node.node_id, 'm1')
})

test('traverse returns an error shape for an unresolved seed', () => {
  const r = traverse({ nodes: NODES, edges: EDGES, seed: 'does-not-exist' })
  assert.equal(r.ok, false)
})

/** @param {Partial<Record<string, unknown>>} o */
function fullNode(o) {
  return {
    node_id: 'n', node_type: 'Session', natural_key: 'k', label: null, props: null,
    first_seen: '2026-06-01T00:00:00Z', source_dataset: 'ai_gateway_messages', source_keys: null,
    projector: 'ai-gateway.t0', projector_version: 1, ...o,
  }
}

/** @param {Partial<Record<string, unknown>>} o */
function fullEdge(o) {
  return {
    edge_id: 'e', edge_type: 'used', src_id: 'a', dst_id: 'b', src_type: 'Session', dst_type: 'Tool',
    props: null, first_seen: '2026-06-01T00:00:00Z', source_dataset: 'ai_gateway_messages', source_keys: null,
    projector: 'ai-gateway.t0', projector_version: 1, ...o,
  }
}

test('queryNeighbors reads node/edge through the query surface and walks (integration)', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-graph-query-'))
  try {
    const registry = createQueryRegistry()
    registry.registerDataset(graphDatasetRegistration('node'))
    registry.registerDataset(graphDatasetRegistration('edge'))

    await appendRowsToSourceTable(cacheRoot, 'node', ['source=a'], NODE_COLUMNS, [
      fullNode({ node_id: 'n-sess', node_type: 'Session', natural_key: 'conv-1', label: null }),
      fullNode({ node_id: 'n-tool', node_type: 'Tool', natural_key: 'Bash', label: 'Bash' }),
    ])
    await appendRowsToSourceTable(cacheRoot, 'edge', ['source=a'], EDGE_COLUMNS, [
      fullEdge({ edge_id: 'e-1', edge_type: 'used', src_id: 'n-sess', dst_id: 'n-tool', src_type: 'Session', dst_type: 'Tool' }),
    ])

    const storage = createQueryStorageService({ cacheRoot })

    // These traversal tests read with the LLP 0105 override: graph rows carry
    // no per-row provenance, so a bare caller context would get
    // natural_key/label suppressed (that path has its own test below).
    // Forward: from the Session (by natural key) to the Tool it used.
    const out = ok(await queryNeighbors({ query: registry, storage, seed: 'conv-1', depth: 1, direction: 'out', includeLocalOnly: true }))
    assert.equal(out.neighbors.length, 1)
    assert.equal(out.neighbors[0].node.node_id, 'n-tool')
    assert.equal(out.neighbors[0].edge_type, 'used')
    assert.equal(out.neighbors[0].direction, 'out')

    // Reverse: from the Tool back to the Sessions that used it.
    const back = ok(await queryNeighbors({ query: registry, storage, seed: 'Bash', depth: 1, direction: 'in', includeLocalOnly: true }))
    assert.deepEqual(idsOf(back.neighbors), new Set(['n-sess']))
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// @ref LLP 0105#graph-provenance [tests]: graph rows carry no per-row cwd, so
// a caller whose context is not provably private gets the structure (ids,
// types, edges) with content columns suppressed, a counted, never-silent
// degradation; a private (ignore-classed) caller context sees everything.
test('queryNeighbors suppresses graph content for an unknown caller and reports it', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-graph-query-'))
  try {
    const registry = createQueryRegistry()
    registry.registerDataset(graphDatasetRegistration('node'))
    registry.registerDataset(graphDatasetRegistration('edge'))

    await appendRowsToSourceTable(cacheRoot, 'node', ['source=a'], NODE_COLUMNS, [
      fullNode({ node_id: 'n-sess', node_type: 'Session', natural_key: 'conv-1', label: null }),
      fullNode({ node_id: 'n-tool', node_type: 'Tool', natural_key: 'Bash', label: 'Bash' }),
    ])
    await appendRowsToSourceTable(cacheRoot, 'edge', ['source=a'], EDGE_COLUMNS, [
      fullEdge({ edge_id: 'e-1', edge_type: 'used', src_id: 'n-sess', dst_id: 'n-tool', src_type: 'Session', dst_type: 'Tool' }),
    ])

    const storage = createQueryStorageService({ cacheRoot })

    // No callerCwd: the fail-closed backstop. The natural-key seed cannot
    // resolve (the key is suppressed), and the failure carries the report.
    const suppressed = await queryNeighbors({ query: registry, storage, seed: 'conv-1', depth: 1, direction: 'out' })
    assert.equal(suppressed.ok, false)
    assert.equal(suppressed.localOnly.filtered, true)
    assert.equal(suppressed.localOnly.callerClass, 'unknown')
    assert.ok(suppressed.localOnly.suppressedRows > 0, 'suppression is counted, never silent')

    // Structure stays walkable by content-addressed id.
    const byId = ok(await queryNeighbors({ query: registry, storage, seed: 'n-sess', depth: 1, direction: 'out' }))
    assert.equal(byId.neighbors.length, 1)
    assert.equal(byId.neighbors[0].node.node_id, 'n-tool')
    assert.equal(byId.neighbors[0].node.natural_key, '', 'suppressed key stays empty, never the string "null"')

    // A private caller context (an ignore-classed directory: its transcript
    // is never even recorded) is top-of-lattice and sees everything.
    const privateDir = path.join(cacheRoot, 'private-ctx')
    await fs.mkdir(privateDir, { recursive: true })
    await fs.writeFile(path.join(privateDir, '.hypignore'), '')
    const open = ok(await queryNeighbors({ query: registry, storage, seed: 'conv-1', depth: 1, direction: 'out', callerCwd: privateDir }))
    assert.equal(open.neighbors[0].node.natural_key, 'Bash')
    assert.equal(open.localOnly.filtered, false)
    assert.equal(open.localOnly.suppressedRows, 0)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('queryNeighbors folds pre-compaction duplicate rows so a natural-key seed still resolves', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-graph-query-'))
  try {
    const registry = createQueryRegistry()
    registry.registerDataset(graphDatasetRegistration('node'))
    registry.registerDataset(graphDatasetRegistration('edge'))

    // The same Session/Tool/edge committed twice in different source=
    // partitions: what a concurrent projection lands before `hyp graph
    // compact` runs. Without the identity fold, the duplicate node rows make
    // the natural-key seed read as "ambiguous" and the doubled edge inflates
    // the walk.
    for (const part of ['source=a', 'source=b']) {
      await appendRowsToSourceTable(cacheRoot, 'node', [part], NODE_COLUMNS, [
        fullNode({ node_id: 'n-sess', node_type: 'Session', natural_key: 'conv-1', label: null }),
        fullNode({ node_id: 'n-tool', node_type: 'Tool', natural_key: 'Bash', label: 'Bash' }),
      ])
      await appendRowsToSourceTable(cacheRoot, 'edge', [part], EDGE_COLUMNS, [
        fullEdge({ edge_id: 'e-1', edge_type: 'used', src_id: 'n-sess', dst_id: 'n-tool', src_type: 'Session', dst_type: 'Tool' }),
      ])
    }

    const storage = createQueryStorageService({ cacheRoot })

    // Natural-key seed resolves to the single semantic node (not ambiguous),
    // and the doubled edge is walked once.
    const out = ok(await queryNeighbors({ query: registry, storage, seed: 'conv-1', depth: 1, direction: 'out', includeLocalOnly: true }))
    assert.equal(out.neighbors.length, 1)
    assert.equal(out.neighbors[0].node.node_id, 'n-tool')
    assert.equal(out.reachable, 1)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})
