// @ts-check

// The fastask warm index (LLP 0481 T6, LLP 0480#index): built from the
// pinned graph-snapshot fixture after the ported verifier accepts it, with
// placeholders for missing endpoints, CSR in both directions, the File
// lookups, the byte ceiling, abort, and cooperative slicing.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

import { EDGE_COLUMNS, NODE_COLUMNS, encodeLine, verifyManifest } from '../../hypaware-core/plugins-workspace/fastask/src/contract.js'
import {
  IndexBuildError,
  MAX_INDEX_BYTES,
  PLACEHOLDER,
  buildIndexFromSnapshot,
  createIndexBuilder,
  minimumIndexBytes,
} from '../../hypaware-core/plugins-workspace/fastask/src/index_builder.js'

/**
 * @import { GraphIndex } from '../../hypaware-core/plugins-workspace/fastask/src/types.js'
 */

const GRAPH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'contracts', 'graph-snapshot', 'v1')
const manifest = JSON.parse(fs.readFileSync(path.join(GRAPH, 'manifest.json'), 'utf8'))
const nodesGz = fs.readFileSync(path.join(GRAPH, 'nodes.ndjson.gz'))
const edgesGz = fs.readFileSync(path.join(GRAPH, 'edges.ndjson.gz'))

/**
 * @param {Array<Record<string, unknown>>} rows
 * @param {ReadonlyArray<string>} columns
 */
function gz(rows, columns) {
  return gzipSync(rows.map((row) => `${encodeLine(row, columns)}\n`).join(''))
}

/**
 * @param {Uint8Array} bytes
 * @param {number} size
 */
function* chunked(bytes, size) {
  for (let i = 0; i < bytes.byteLength; i += size) yield bytes.subarray(i, i + size)
}

/**
 * Every edge appears once in its source's out list and once in its
 * destination's in list, and each list is newest first.
 *
 * @param {GraphIndex} index
 */
function assertCsr(index) {
  for (const [offsets, edges, end] of /** @type {const} */ ([
    [index.outOffsets, index.outEdges, index.edgeSrc],
    [index.inOffsets, index.inEdges, index.edgeDst],
  ])) {
    assert.equal(offsets.length, index.nodeCount + 1)
    assert.equal(offsets[index.nodeCount], index.edgeCount)
    const seen = new Uint8Array(index.edgeCount)
    for (let i = 0; i < index.nodeCount; i++) {
      for (let p = offsets[i]; p < offsets[i + 1]; p++) {
        const e = edges[p]
        assert.equal(end[e], i)
        seen[e]++
        if (p > offsets[i]) {
          const before = index.edgeFirstSeen[edges[p - 1]]
          const at = index.edgeFirstSeen[e]
          assert.ok(Number.isNaN(at) || before >= at, 'newest first, absent times last')
        }
      }
    }
    assert.ok(seen.every((n) => n === 1))
  }
}

test('the pinned graph fixture verifies, then indexes with placeholders matching the manifest', async () => {
  const verified = await verifyManifest({ manifest, nodes: nodesGz, edges: edgesGz })
  assert.equal(verified.ok, true, verified.problems.join('; '))

  const index = await buildIndexFromSnapshot({ manifest, nodes: nodesGz, edges: edgesGz })
  assert.equal(index.edgeCount, manifest.files.edges.rows)
  assert.equal(index.nodeCount, manifest.files.nodes.rows + manifest.unresolved.endpoint_ids)
  assert.equal(index.placeholderCount, manifest.unresolved.endpoint_ids)
  assert.equal(index.unresolvedEdges, manifest.unresolved.edges)
  assertCsr(index)

  const placeholder = index.nodeIds.get('2f49c3d790ffd21bfb84b047')
  assert.ok(placeholder !== undefined)
  assert.equal(index.nodeFlags[placeholder] & PLACEHOLDER, PLACEHOLDER)
  assert.equal(index.nodeTypes[index.nodeType[placeholder]], 'File', 'type taken from the edge')
  assert.equal(index.naturalKey[placeholder], null)
  // Two edges share that missing endpoint.
  assert.equal(index.inOffsets[placeholder + 1] - index.inOffsets[placeholder], 2)

  // Non-ASCII (outside the BMP) File keys reach the lookups.
  assert.ok(index.fileByBasename.has('café-日本-🚀.md'))
  assert.ok(index.fileByStem.has('café-日本-🚀'))
  assert.ok(index.fileBySuffix.has('fx-repo/docs/café-日本-🚀.md'))
  assert.equal(index.fileByRepo.size, 0, 'absolute-path keys name no repository')

  // Exemplars come from object source_keys; the array form on a node is ignored.
  const edited = index.exemplars.get(0)
  assert.deepEqual(edited, { message_id: 'fx-msg-0002', part_id: null })
  assert.equal(index.exemplars.size, 3)
  assert.ok(index.bytes > 0 && index.bytes < MAX_INDEX_BYTES)
})

test('streamed in tiny chunks, lines split across chunks index identically', async () => {
  const whole = await buildIndexFromSnapshot({ manifest, nodes: nodesGz, edges: edgesGz })
  const split = await buildIndexFromSnapshot({ manifest, nodes: chunked(nodesGz, 7), edges: chunked(edgesGz, 5) })
  assert.deepEqual(split.naturalKey, whole.naturalKey)
  assert.deepEqual(split.inEdges, whole.inEdges)
  assert.deepEqual(split.outEdges, whole.outEdges)
  assert.equal(split.unresolvedEdges, whole.unresolvedEdges)
})

test('Session props are kept for the fields fastask shows, interned across sessions', async () => {
  const nodes = gz([0, 1, 2].map((n) => ({
    node_id: `s${n}`, node_type: 'Session', natural_key: `sess-${n}`, label: `sess-${n}`,
    props: { cwd: '/repo', git_branch: 'main', client_name: 'claude-code', user_id: `u-${n % 2}`, ignored: 'x' },
    first_seen: Date.UTC(2026, 9, 1, n),
  })), NODE_COLUMNS)
  const index = await buildIndexFromSnapshot({ nodes, edges: gz([], EDGE_COLUMNS) })
  const s1 = index.nodeIds.get('s1')
  assert.ok(s1 !== undefined)
  assert.deepEqual(index.sessionProps.get(s1), { cwd: '/repo', git_branch: 'main', client_name: 'claude-code', user_id: 'u-1' })
  assert.equal(index.label[s1], null, 'a label equal to the key is not stored twice')
  assert.equal(index.nodeFirstSeen[s1], Date.UTC(2026, 9, 1, 1))
})

test('bridged File keys index basename, stem and repository; a root-level path keeps its own basename', async () => {
  const builder = createIndexBuilder()
  builder.addNode({ node_id: 'f1', node_type: 'File', natural_key: 'acme/app:src/Login.js', label: 'Login.js' })
  builder.addNode({ node_id: 'f2', node_type: 'File', natural_key: 'acme/app:README.md', label: 'README.md' })
  const index = await builder.finish()
  assert.deepEqual(index.fileByBasename.get('login.js'), 0)
  assert.deepEqual(index.fileByStem.get('login'), 0)
  assert.deepEqual(index.fileByBasename.get('readme.md'), 1)
  assert.deepEqual(index.fileByRepo.get('acme/app'), [0, 1])
  assert.equal(index.fileBySuffix.size, 0)
})

test('a node arriving after its edge fills the placeholder in (interleaved local rows)', async () => {
  const builder = createIndexBuilder()
  builder.addEdge({ edge_type: 'touched', src_id: 's', dst_id: 'f', src_type: 'Session', dst_type: 'File', first_seen: '2026-10-01T00:00:00Z' })
  builder.addNode({ node_id: 'f', node_type: 'File', natural_key: 'acme/app:a.js', label: 'a.js' })
  builder.addNode({ node_id: 's', node_type: 'Session', natural_key: 'sess', props: JSON.stringify({ cwd: '/w' }) })
  const index = await builder.finish()
  assert.equal(index.nodeCount, 2)
  assert.equal(index.placeholderCount, 0)
  assert.equal(index.unresolvedEdges, 0)
  assert.equal(index.sessionProps.get(/** @type {number} */ (index.nodeIds.get('s')))?.cwd, '/w', 'a stored JSON string is parsed')
  assert.ok(index.fileByBasename.has('a.js'))
})

test('a manifest whose row counts pass the ceiling is refused before anything is read', async () => {
  const huge = { files: { nodes: { rows: 10_000_000 }, edges: { rows: 40_000_000 } } }
  assert.ok(minimumIndexBytes(10_000_000, 40_000_000) > MAX_INDEX_BYTES)
  const untouchable = {
    [Symbol.asyncIterator]() { throw new Error('the source must not be read') },
  }
  await assert.rejects(buildIndexFromSnapshot({ manifest: huge, nodes: untouchable, edges: untouchable }),
    (err) => err instanceof IndexBuildError && err.code === 'replica_too_large')
})

test('the running estimate refuses mid-build, without reading the rest', async () => {
  const rows = 20_000
  const nodes = gz(Array.from({ length: rows }, (_, n) => ({
    node_id: `n${n}`, node_type: 'File', natural_key: `acme/app:src/dir${n % 50}/file${n}.js`, label: `file${n}.js`,
  })), NODE_COLUMNS)
  let edgesRead = false
  const edges = (async function* () { edgesRead = true; yield gz([], EDGE_COLUMNS) })()
  const maxBytes = 1_000_000
  await assert.rejects(buildIndexFromSnapshot({ nodes, edges, maxBytes }), (err) => {
    assert.ok(err instanceof IndexBuildError)
    assert.equal(err.code, 'replica_too_large')
    const at = Number(/at (\d+) nodes/.exec(err.message)?.[1])
    assert.ok(at > 0 && at < rows, `stopped at ${at} of ${rows} nodes`)
    return true
  })
  assert.equal(edgesRead, false)
})

test('the adjacency still to come counts from the first edge, so an edge-heavy graph is refused while it parses', async () => {
  const rows = 20_000
  const edges = gz(Array.from({ length: rows }, (_, n) => ({
    edge_id: `e${n}`, edge_type: 'touched', src_id: 's', dst_id: 'f', src_type: 'Session', dst_type: 'File',
  })), EDGE_COLUMNS)
  const nodes = gz([{ node_id: 's', node_type: 'Session', natural_key: 's' }, { node_id: 'f', node_type: 'File', natural_key: 'acme/app:f.js' }], NODE_COLUMNS)
  // The edge arrays alone (17 bytes per slot, 32,768 slots once grown) fit
  // under this ceiling; with both directions' adjacency (8 bytes per edge) they do not.
  const maxBytes = 650_000
  await assert.rejects(buildIndexFromSnapshot({ nodes, edges, maxBytes }), (err) => {
    assert.ok(err instanceof IndexBuildError)
    const at = Number(/and (\d+) edges/.exec(err.message)?.[1])
    assert.ok(at > 0 && at < rows, `refused at ${at} of ${rows} edges`)
    return true
  })
})

test('a single line longer than the ceiling is refused while still partial', async () => {
  const big = gz([{ node_id: 'n', node_type: 'Session', natural_key: 'k', props: { blob: 'x'.repeat(300_000) } }], NODE_COLUMNS)
  await assert.rejects(buildIndexFromSnapshot({ nodes: chunked(big, 64), edges: gz([], EDGE_COLUMNS), maxBytes: 100_000 }),
    (err) => err instanceof IndexBuildError && err.code === 'replica_too_large')
})

test('a line that is not JSON fails the build with invalid_line', async () => {
  await assert.rejects(buildIndexFromSnapshot({ nodes: gzipSync('{"node_id":"a"}\nnot json\n'), edges: gz([], EDGE_COLUMNS) }),
    (err) => err instanceof IndexBuildError && err.code === 'invalid_line' && /nodes line 2/.test(err.message))
})

test('a truncated gzip stream fails the build instead of yielding a partial index', async () => {
  await assert.rejects(buildIndexFromSnapshot({ manifest, nodes: nodesGz.subarray(0, nodesGz.byteLength - 20), edges: edgesGz }))
})

test('abort stops the build at a slice boundary with the signal reason', async () => {
  const rows = 50_000
  const edges = gz(Array.from({ length: rows }, (_, n) => ({
    edge_id: `e${n}`, edge_type: 'touched', src_id: `s${n % 997}`, dst_id: `f${n % 1013}`, src_type: 'Session', dst_type: 'File',
    first_seen: Date.UTC(2026, 0, 1) + n,
  })), EDGE_COLUMNS)
  const controller = new AbortController()
  const reason = new Error('source stopping')
  setImmediate(() => controller.abort(reason))
  await assert.rejects(buildIndexFromSnapshot({ nodes: gz([], NODE_COLUMNS), edges, signal: controller.signal, duty: 1 }),
    (err) => err === reason)
})

test('a large build yields to the event loop while it runs (cooperative slices)', async () => {
  const rows = 60_000
  const edges = gz(Array.from({ length: rows }, (_, n) => ({
    edge_id: `e${n}`, edge_type: 'touched', src_id: `s${n % 4001}`, dst_id: `f${n % 3001}`, src_type: 'Session', dst_type: 'File',
    first_seen: Date.UTC(2026, 0, 1) + (n * 7919) % rows,
  })), EDGE_COLUMNS)
  let turns = 0
  const timer = setInterval(() => { turns++ }, 0)
  try {
    const index = await buildIndexFromSnapshot({ nodes: gz([], NODE_COLUMNS), edges, duty: 1 })
    assert.equal(index.edgeCount, rows)
    assert.equal(index.placeholderCount, 4001 + 3001)
    assertCsr(index)
  } finally {
    clearInterval(timer)
  }
  assert.ok(turns > 0, 'timers ran during the build')
})
