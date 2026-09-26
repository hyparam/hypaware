// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { asyncRow } from 'squirreling'

import { appendRowsToSourceTable } from '../../src/core/cache/partition.js'
import { createQueryStorageService } from '../../src/core/cache/storage.js'
import { createQueryRegistry } from '../../src/core/registry/datasets.js'
import { EDGE_COLUMNS, graphDatasetRegistration, NODE_COLUMNS } from '../../hypaware-core/plugins-workspace/context-graph/src/datasets.js'
import { queryNeighbors, resolveSeed } from '../../hypaware-core/plugins-workspace/context-graph/src/query.js'
import { graphNeighborsVerb } from '../../hypaware-core/plugins-workspace/context-graph/src/verb.js'

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
 * Exercise the real SQL engine, including residual filtering on an unindexed
 * source. Noise is generated lazily so the fixture itself is not a large heap.
 * @param {any[]} nodes
 * @param {any[]} edges
 * @param {number} noise
 */
function memoryGraph(nodes = NODES, edges = EDGES, noise = 0) {
  const scans = []
  const registry = /** @type {any} */ ({
    getDataset: name => ({
      discoverPartitions: async () => [],
      createDataSource: async () => ({
        columns: (name === 'node' ? NODE_COLUMNS : EDGE_COLUMNS).map(c => c.name),
        numRows: noise + (name === 'node' ? nodes.length : edges.length),
        // Large sources use the engine's real vector filter, as Iceberg does.
        // The fixture leaves WHERE and LIMIT residual: it never guesses what
        // the graph query meant or filters by its own copy of that logic.
        ...(noise ? {
          schema: { fields: (name === 'node' ? NODE_COLUMNS : EDGE_COLUMNS).map((c, id) => ({ id, name: c.name, dataType: { type: 'unknown' }, nullable: true })) },
          prepareScan(request) {
            const fields = request.columns.map(c => ({ id: c.field, name: (name === 'node' ? NODE_COLUMNS : EDGE_COLUMNS)[c.field].name, dataType: { type: 'unknown' }, nullable: true }))
            scans.push({ dataset: name, where: request.filter, columns: fields.map(f => f.name) })
            return {
              schema: { fields }, residual: { filter: request.filter, limit: request.limit, offset: request.offset }, properties: {},
              async *batches({ signal }) {
                const rows = name === 'node' ? nodes.map(fullNode) : edges.map((row, i) => fullEdge({ edge_id: `e-${i}`, ...row }))
                for (let at = 0; at < noise + rows.length; at += 1024) {
                  signal?.throwIfAborted()
                  const length = Math.min(1024, noise + rows.length - at)
                  const values = fields.map(() => [])
                  for (let i = at; i < at + length; i++) {
                    const row = i >= noise ? rows[i - noise] : name === 'node'
                      ? fullNode({ node_id: `noise-${i}`, natural_key: `noise-${i}` })
                      : fullEdge({ edge_id: `noise-${i}`, src_id: `noise-${i}`, dst_id: `noise-${i + 1}` })
                    fields.forEach((f, j) => values[j].push(row[f.name]))
                  }
                  yield { selection: { type: 'all', length }, columns: values.map(values => ({ type: 'values', values, length })) }
                }
              },
            }
          },
        } : {}),
        scan(options) {
          scans.push({ dataset: name, ...options })
          return {
            appliedWhere: false, appliedLimitOffset: false,
            async *rows() {
              for (let i = 0; i < noise; i++) {
                const row = name === 'node'
                  ? fullNode({ node_id: `noise-${i}`, natural_key: `noise-${i}` })
                  : fullEdge({ edge_id: `noise-${i}`, src_id: `noise-${i}`, dst_id: `noise-${i + 1}` })
                yield asyncRow(row, options.columns)
              }
              const rows = name === 'node' ? nodes.map(fullNode)
                : edges.map((row, i) => fullEdge({ edge_id: `e-${i}`, ...row }))
              for (const row of rows) yield asyncRow(row, options.columns)
            },
          }
        },
      }),
    }),
    listDatasets: () => [],
  })
  const storage = /** @type {any} */ ({ cacheRoot: '/tmp/graph-query-test', pendingInfo: async () => ({ pending: false }) })
  return { query: registry, storage, scans, includeLocalOnly: true }
}

test('a small neighborhood remains queryable beyond 100000 unrelated nodes and edges', async () => {
  const fixture = memoryGraph(NODES, EDGES, 100_010)
  const result = ok(await queryNeighbors({ ...fixture, seed: 'conv-1', direction: 'out', limit: 1 }))
  assert.equal(result.neighbors.length, 1)
  assert.equal(result.reachable, 4)
  assert.equal(result.truncated, true)
  assert.equal(result.neighbors[0].node.node_id, 'a1')
  assert.ok(fixture.scans.every(scan => scan.where), 'every nonempty-graph read is narrowed in SQL')
})

test('SQL neighborhoods preserve BFS, cycles, dangling endpoints and exact reachable totals', async () => {
  const edges = [...EDGES, e('s2', 'missing', 'touched'), e('missing', 's1', 'used'), EDGES[0]]
  // From f1: incoming sessions at hop 1, then missing via its edge to s1.
  // Walking both ways also reaches a1, m1 and t1. Cycles and duplicate
  // edges add no new nodes, and f1 has no outgoing edges.
  const reachable = { in: [2, 3, 3], out: [0, 0, 0], both: [2, 6, 6] }
  for (const direction of /** @type {const} */ (['in', 'out', 'both'])) {
    for (const [index, depth] of [1, 2, 4].entries()) {
      const actual = ok(await queryNeighbors({ ...memoryGraph(NODES, edges), seed: 'f1', direction, depth, limit: 2 }))
      assert.equal(actual.reachable, reachable[direction][index])
      assert.equal(actual.truncated, reachable[direction][index] > 2)
      assert.deepEqual(actual.neighbors.map(({ hop, direction, from, node, edge_type }) =>
        ({ hop, direction, from, node, edge_type })), direction === 'out' ? [] : [
        { hop: 1, direction: 'in', from: 'f1', node: NODES[0], edge_type: 'touched' },
        { hop: 1, direction: 'in', from: 'f1', node: NODES[1], edge_type: 'touched' },
      ])
    }
  }
  const all = ok(await queryNeighbors({ ...memoryGraph(NODES, edges), seed: 'f1', direction: 'both', depth: 4 }))
  assert.deepEqual(all.neighbors.map(({ hop, node }) => [hop, node.node_id]),
    [[1, 's1'], [1, 's2'], [2, 'a1'], [2, 'm1'], [2, 't1'], [2, 'missing']])
  assert.equal(all.neighbors.at(-1).node.node_type, '?', 'a dangling endpoint keeps its placeholder')
})

test('SQL seed resolution escapes literals and preserves tier precedence and ambiguity', async () => {
  const nodes = [...NODES, n("id'quoted", 'File', "key'quoted", "label'quoted"), n('other', 'Tool', 's1', null)]
  const fixture = memoryGraph(nodes, [])
  for (const seed of ["id'quoted", "key'quoted", "label'quoted"])
    assert.equal(ok(await queryNeighbors({ ...fixture, seed })).seed.node_id, "id'quoted")
  assert.equal(ok(await queryNeighbors({ ...fixture, seed: 's1' })).seed.node_id, 's1')
  assert.equal(ok(await queryNeighbors({ ...fixture, seed: 's1', type: 'Tool' })).seed.node_id, 'other')
  const ambiguous = await queryNeighbors({ ...fixture, seed: 'index.js' })
  assert.equal(ambiguous.ok, false)
  assert.deepEqual(!ambiguous.ok && ambiguous.candidates?.map(n => n.node_id), ['f1', 'f2'])
})

test('wide frontiers cross query batches without losing reachability or fetching hidden output payloads', async () => {
  const nodes = [n('root', 'Session', 'root', null)]
  const edges = []
  for (let i = 0; i < 300; i++) {
    nodes.push(n(`child-${i}`, 'File', `child-${i}`, null))
    edges.push(e('root', `child-${i}`, 'touched'), e(`child-${i}`, 'leaf', 'touched'))
  }
  const fixture = memoryGraph(nodes, edges)
  const result = ok(await queryNeighbors({ ...fixture, seed: 'root', depth: 2, direction: 'out', limit: 1 }))
  assert.equal(result.reachable, 301)
  assert.equal(result.neighbors.length, 1)
  assert.equal(result.totalEdges, 600)
  const topology = fixture.scans.filter(s => s.dataset === 'edge' && !s.columns.includes('props'))
  assert.equal(topology.length, 3, 'root plus two frontier batches')
  const payload = fixture.scans.filter(s => s.dataset === 'edge' && s.columns.includes('props'))
  assert.equal(payload.length, 1, 'evidence is fetched only for the returned neighbor')
})

test('the shared deadline allows traversal within thirty seconds', async t => {
  const fixture = memoryGraph()
  const started = Date.now()
  let now = started
  t.mock.method(Date, 'now', () => now)
  const get = fixture.query.getDataset
  t.mock.method(fixture.query, 'getDataset', name => {
    if (name === 'edge') now = started + 29_999
    return get(name)
  })
  assert.equal(ok(await queryNeighbors({ ...fixture, seed: 's1', depth: 3 })).reachable, 5)
})

test('the shared deadline rejects a read at thirty seconds before starting another hop', async t => {
  const fixture = memoryGraph()
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const get = fixture.query.getDataset
  t.mock.method(fixture.query, 'getDataset', name => {
    if (name === 'edge') now += 30_000
    return get(name)
  })
  await assert.rejects(queryNeighbors({ ...fixture, seed: 's1', depth: 3 }), /thirty-second time budget/)
  assert.equal(fixture.scans.filter(s => s.dataset === 'edge').length, 1)
})

test('large labels are subject to the cumulative payload budget', async () => {
  // A repeated string stays cheap to allocate in the fixture but represents
  // a large decoded payload; one cell cannot evade a row-count-only guard.
  const fixture = memoryGraph([n('root', 'Session', 'root', 'x'.repeat(65 * 1024 * 1024))], [])
  const result = await queryNeighbors({ ...fixture, seed: 'root' })
  assert.equal(result.ok, false)
  assert.match(!result.ok && result.error || '', /payload budget/)
  assert.equal(fixture.scans.filter(s => s.dataset === 'edge').length, 0)
})

/**
 * Assert a traversal succeeded and return it as a plain object for field access.
 * @param {Awaited<ReturnType<typeof queryNeighbors>>} r
 * @returns {any}
 */
function ok(r) {
  assert.equal(r.ok, true, r.ok ? '' : `expected ok, got error: ${r.error}`)
  return r
}

/** @param {any[]} neighbors */
const idsOf = (neighbors) => new Set(neighbors.map((x) => x.node.node_id))

test('--edge-type restricts which relations are walked', async () => {
  const r = ok(await queryNeighbors({ ...memoryGraph(), seed: 's1', depth: 1, direction: 'out', edgeTypes: ['used'] }))
  assert.deepEqual(idsOf(r.neighbors), new Set(['t1']))
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

test('queryNeighbors returns an error shape for an unresolved seed', async () => {
  const r = await queryNeighbors({ ...memoryGraph(), seed: 'does-not-exist' })
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

// --- an empty graph reports itself (LLP 0213 #d3) ----------------------------

// A graph that has never been projected fails every seed. "not found" sends
// the reader hunting for a better seed when the answer is a command, so the
// operation distinguishes the two. It rides the shared result rather than
// the CLI renderer, so MCP callers get the distinction too.
// @ref LLP 0213#empty-is-shared [tests]: emptiness is an operation fact, available to both surfaces
test('queryNeighbors reports an unprojected graph as empty, not as a missing node', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-graph-empty-'))
  try {
    const registry = createQueryRegistry()
    registry.registerDataset(graphDatasetRegistration('node'))
    registry.registerDataset(graphDatasetRegistration('edge'))
    const storage = createQueryStorageService({ cacheRoot })

    const result = await queryNeighbors({
      query: registry, storage, seed: 'anything', depth: 1, direction: 'out', includeLocalOnly: true,
    })
    assert.equal(result.ok, false)
    assert.equal(result.graphEmpty, true, 'an unprojected graph is flagged empty')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// The flag must mean "nothing projected", not "this seed missed". A populated
// graph with a bad seed is an ordinary not-found and must stay one, or the
// message would send people to re-project a graph that is already fine.
test('a populated graph with an unknown seed is not reported as empty', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-graph-empty-'))
  try {
    const registry = createQueryRegistry()
    registry.registerDataset(graphDatasetRegistration('node'))
    registry.registerDataset(graphDatasetRegistration('edge'))
    await appendRowsToSourceTable(cacheRoot, 'node', ['source=a'], NODE_COLUMNS, [
      fullNode({ node_id: 'n-sess', node_type: 'Session', natural_key: 'conv-1', label: null }),
    ])
    const storage = createQueryStorageService({ cacheRoot })

    const result = await queryNeighbors({
      query: registry, storage, seed: 'no-such-node', depth: 1, direction: 'out', includeLocalOnly: true,
    })
    assert.equal(result.ok, false)
    assert.equal(result.graphEmpty, undefined, 'a real miss is not an empty graph')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// The CLI half of the same decision: the renderer turns the fact into the
// command that fixes it, and does not print the generic seed error.
test('the renderer names `hyp graph project` when the graph is empty', () => {
  const rendered = graphNeighborsVerb.render(
    { ok: false, error: 'no node matched', graphEmpty: true },
    /** @type {any} */ ({}),
  )
  assert.equal(rendered.exitCode, 1)
  assert.match(rendered.stderr ?? '', /graph is empty/)
  assert.match(rendered.stderr ?? '', /hyp graph project/)
  assert.doesNotMatch(rendered.stderr ?? '', /no node matched/)
})

test('an ordinary not-found still renders its own error and candidates', () => {
  const rendered = graphNeighborsVerb.render(
    { ok: false, error: 'ambiguous seed', candidates: [{ node_id: 'abc123', node_type: 'File', natural_key: 'x.js', label: 'x.js' }] },
    /** @type {any} */ ({}),
  )
  assert.match(rendered.stderr ?? '', /ambiguous seed/)
  assert.match(rendered.stderr ?? '', /x\.js/)
  assert.doesNotMatch(rendered.stderr ?? '', /graph is empty/)
})

/**
 * A walk whose frontier and output both exceed the 256-id batch size, so the
 * traversal genuinely issues many reads per dataset rather than one.
 * @param {number} width
 */
function wideGraph(width) {
  const nodes = [n('root', 'Session', 'root', 'root-label')]
  const edges = []
  for (let i = 0; i < width; i++) {
    nodes.push(n(`m${i}`, 'Tool', `mid-${i}`, null), n(`l${i}`, 'File', `leaf-${i}`, null))
    edges.push(e('root', `m${i}`, 'used'), e(`m${i}`, `l${i}`, 'touched'))
  }
  return { nodes, edges }
}

/**
 * `memoryGraph` with the refresh path instrumented: each dataset reports one
 * partition and the declared no-op `refreshPartition` the graph datasets
 * register, and the storage models a spool a live writer keeps pending, so a
 * forced settle flushes on every read and a debounced one does not.
 * @param {any[]} nodes
 * @param {any[]} edges
 */
function refreshCountingGraph(nodes, edges) {
  const base = memoryGraph(nodes, edges)
  /** @type {{ refreshPartition: any[], flushTable: any[] }} */
  const calls = { refreshPartition: [], flushTable: [] }
  const tablePath = dataset => `${base.storage.cacheRoot}/datasets/${dataset}/label`
  const getDataset = base.query.getDataset
  const query = /** @type {any} */ ({
    ...base.query,
    getDataset: name => ({
      ...getDataset(name),
      discoverPartitions: async () => [{ dataset: name, partition: { partition: 'label' }, tablePath: tablePath(name) }],
      refreshPartition: async (_partition, ctx) => {
        calls.refreshPartition.push({ dataset: name, force: ctx.force === true })
        return { status: 'skipped', rows: 0 }
      },
    }),
  })
  /** @type {Map<string, number>} */
  const lastFlushAtMs = new Map()
  const storage = /** @type {any} */ ({
    ...base.storage,
    pendingInfo: async path => ({ pending: true, lastFlushAtMs: lastFlushAtMs.get(path) ?? null, flushFailedAtMs: null }),
    flushTable: async (path, options) => {
      calls.flushTable.push({ path, force: options?.force === true })
      lastFlushAtMs.set(path, Date.now())
    },
  })
  const dataset = name => ({
    forcedRefreshes: calls.refreshPartition.filter(c => c.dataset === name && c.force).length,
    forcedFlushes: calls.flushTable.filter(c => c.path === tablePath(name) && c.force).length,
    reads: base.scans.filter(s => s.dataset === name).length,
  })
  return { ...base, query, storage, dataset }
}

test('a depth-3 multi-batch traversal forces a refresh at most once per graph dataset', async () => {
  const { nodes, edges } = wideGraph(300)
  const fixture = refreshCountingGraph(nodes, edges)
  // Seeded by label, the tier that reads all three times: a fixture resolving
  // at the node_id tier cannot see a force reintroduced on the seed read.
  const result = ok(await queryNeighbors({ ...fixture, seed: 'root-label', depth: 3 }))

  // The walk itself, unchanged by the refresh mode: 300 mids at hop 1 and 300
  // leaves at hop 2, reached over multiple frontier and output batches.
  assert.equal(result.reachable, 600)
  assert.equal(result.totalNodes, 601)
  assert.equal(result.totalEdges, 600)
  assert.equal(result.neighbors.length, 600)
  assert.equal(result.truncated, false)
  assert.equal(result.neighbors.filter(x => x.hop === 1).length, 300)
  assert.equal(result.neighbors.filter(x => x.hop === 2).length, 300)
  assert.deepEqual(idsOf(result.neighbors.slice(0, 2)), new Set(['m0', 'm1']))
  assert.equal(result.neighbors[0].node.natural_key, 'mid-0')

  // Not vacuous: each dataset really is read many times over.
  const node = fixture.dataset('node'), edge = fixture.dataset('edge')
  assert.equal(node.reads, 6)
  assert.equal(edge.reads, 8)

  assert.equal(node.forcedRefreshes, 1, `node forced refreshes: want 1, got ${node.forcedRefreshes}`)
  assert.equal(edge.forcedRefreshes, 1, `edge forced refreshes: want 1, got ${edge.forcedRefreshes}`)
  assert.equal(node.forcedFlushes, 1, `node forced flushes: want 1, got ${node.forcedFlushes}`)
  assert.equal(edge.forcedFlushes, 1, `edge forced flushes: want 1, got ${edge.forcedFlushes}`)
})
