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
import { runGraphProject } from '../../hypaware-core/plugins-workspace/context-graph/src/command.js'
import { graphNeighborsVerb } from '../../hypaware-core/plugins-workspace/context-graph/src/verb.js'
import { verbToCommand } from '../../src/core/cli/verb_command.js'
import { setGraphRuntime } from '../../hypaware-core/plugins-workspace/context-graph/src/runtime.js'

// `graph neighbors` migrated to a verb (LLP 0034); exercise it through the
// kernel projection exactly as dispatch would.
const runGraphNeighbors = (/** @type {string[]} */ argv, /** @type {any} */ ctx) =>
  verbToCommand(graphNeighborsVerb).run(argv, ctx)

/**
 * A ctx whose stdout/stderr capture into arrays. `storage`/`query` are only
 * touched once parsing succeeds, so usage-error cases can pass stubs.
 * @param {{ query?: any, storage?: any }} [opts]
 */
function mkCtx(opts = {}) {
  /** @type {string[]} */ const out = []
  /** @type {string[]} */ const errs = []
  const ctx = /** @type {any} */ ({
    query: opts.query,
    storage: opts.storage,
    stdout: { write: (/** @type {string} */ s) => out.push(s) },
    stderr: { write: (/** @type {string} */ s) => errs.push(s) },
  })
  return { ctx, out, errs }
}

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

// A Session (conv-1) with four out-neighbors, plus a second File that collides
// with the first on the `index.js` basename so a bare-basename seed is ambiguous.
const NODES = [
  fullNode({ node_id: 'n-sess', node_type: 'Session', natural_key: 'conv-1', label: null }),
  fullNode({ node_id: 'n-app', node_type: 'App', natural_key: 'claude-code', label: 'claude-code' }),
  fullNode({ node_id: 'n-model', node_type: 'Model', natural_key: 'sonnet', label: 'sonnet' }),
  fullNode({ node_id: 'n-tool', node_type: 'Tool', natural_key: 'Bash', label: 'Bash' }),
  fullNode({ node_id: 'n-f1', node_type: 'File', natural_key: '/repo/index.js', label: 'index.js' }),
  fullNode({ node_id: 'n-f2', node_type: 'File', natural_key: '/other/index.js', label: 'index.js' }),
]

const EDGES = [
  fullEdge({ edge_id: 'e-via', edge_type: 'via', src_id: 'n-sess', dst_id: 'n-app', dst_type: 'App' }),
  fullEdge({ edge_id: 'e-mod', edge_type: 'used_model', src_id: 'n-sess', dst_id: 'n-model', dst_type: 'Model' }),
  fullEdge({ edge_id: 'e-use', edge_type: 'used', src_id: 'n-sess', dst_id: 'n-tool', dst_type: 'Tool' }),
  fullEdge({ edge_id: 'e-touch', edge_type: 'touched', src_id: 'n-sess', dst_id: 'n-f1', dst_type: 'File' }),
]

/** Build a temp cache with the standard graph and a storage/registry over it. */
async function withGraph(/** @type {(deps: { ctx: any, out: string[], errs: string[] }) => Promise<void>} */ body) {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-graph-cmd-'))
  try {
    const registry = createQueryRegistry()
    registry.registerDataset(graphDatasetRegistration('node'))
    registry.registerDataset(graphDatasetRegistration('edge'))
    await appendRowsToSourceTable(cacheRoot, 'node', ['source=a'], NODE_COLUMNS, NODES)
    await appendRowsToSourceTable(cacheRoot, 'edge', ['source=a'], EDGE_COLUMNS, EDGES)
    const storage = createQueryStorageService({ cacheRoot })
    const { ctx, out, errs } = mkCtx({ query: registry, storage })
    await body({ ctx, out, errs })
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
}

// --- graph project: the registry-driven guard ------------------------------

test('graph project with no contracts registered reports cleanly and exits 0', async () => {
  setGraphRuntime({ registry: /** @type {any} */ ({ list: () => [] }) })
  const { ctx, out, errs } = mkCtx()
  const code = await runGraphProject([], ctx)
  assert.equal(code, 0)
  assert.match(out.join(''), /no contracts registered/)
  assert.equal(errs.join(''), '', 'an empty registry is not an error')
})

test('graph project --source with no matching contract reports cleanly and exits 0', async () => {
  setGraphRuntime({
    registry: /** @type {any} */ ({
      list: () => [{ name: 'ai-gateway-t0', plugin: '@x', sourceDataset: 'ai_gateway_messages', projector: 'p', projectorVersion: 1, rules: [] }],
    }),
  })
  const { ctx, out, errs } = mkCtx()
  const code = await runGraphProject(['--source', 'imessage_messages'], ctx)
  assert.equal(code, 0)
  assert.match(out.join(''), /no contract registered for source 'imessage_messages'/)
  assert.equal(errs.join(''), '')
})

test('graph project --source=<ds> (equals form) parses and filters', async () => {
  setGraphRuntime({
    registry: /** @type {any} */ ({
      list: () => [{ name: 'ai-gateway-t0', plugin: '@x', sourceDataset: 'ai_gateway_messages', projector: 'p', projectorVersion: 1, rules: [] }],
    }),
  })
  const { ctx, out, errs } = mkCtx()
  const code = await runGraphProject(['--source=imessage_messages'], ctx)
  assert.equal(code, 0)
  assert.match(out.join(''), /no contract registered for source 'imessage_messages'/)
  assert.equal(errs.join(''), '')
})

// A missing/empty/flag-shaped --source value must NOT silently fall back to
// projecting every contract (a broader write than asked for); reject it like
// `graph neighbors` rejects its value flags.
test('graph project usage errors exit 2 and report the offending argv on stderr', async () => {
  /** @type {[string[], RegExp][]} */
  const cases = [
    [['--source'], /--source expects a value/],
    [['--source='], /--source expects a value/],
    [['--source', ''], /--source expects a value/],
    [['--source', '--dry-run'], /--source expects a value/],
    [['--bogus'], /unknown flag --bogus/],
    [['ai_gateway_messages'], /unexpected argument ai_gateway_messages/],
  ]
  for (const [argv, pattern] of cases) {
    const { ctx, out, errs } = mkCtx()
    const code = await runGraphProject(argv, ctx)
    assert.equal(code, 2, `argv ${JSON.stringify(argv)} should be a usage error`)
    assert.match(errs.join(''), pattern)
    assert.match(errs.join(''), /^hyp graph project: /)
    assert.equal(out.join(''), '', 'usage errors write nothing to stdout')
  }
})

// --- Usage errors: exit 2, message on stderr, no IO touched -----------------

test('usage errors exit 2 and report the offending argv on stderr', async () => {
  /** @type {[string[], RegExp][]} */
  const cases = [
    [[], /usage: hyp graph neighbors <node>/],
    [['a', 'b'], /unexpected argument 'b' \(quote multi-word values\)/],
    [['x', '--bogus'], /unknown flag --bogus/],
    [['x', '--depth'], /--depth expects a value/],
    [['x', '--depth', '--json'], /--depth expects a value/],
    [['x', '--depth', '0'], /--depth expects a positive integer \(got 0\)/],
    [['x', '--depth', 'abc'], /--depth expects a positive integer \(got abc\)/],
    [['x', '--limit', '-1'], /--limit expects a positive integer \(got -1\)/],
    [['x', '--direction', 'sideways'], /--direction expects out\|in\|both \(got sideways\)/],
  ]
  for (const [argv, pattern] of cases) {
    const { ctx, out, errs } = mkCtx()
    const code = await runGraphNeighbors(argv, ctx)
    assert.equal(code, 2, `argv ${JSON.stringify(argv)} should be a usage error`)
    assert.match(errs.join(''), pattern)
    assert.match(errs.join(''), /^hyp graph neighbors: /)
    assert.equal(out.join(''), '', 'usage errors write nothing to stdout')
  }
})

// --- Resolution errors: exit 1 ----------------------------------------------

test('an unresolved seed exits 1 with a not-found note on stderr', async () => {
  await withGraph(async ({ ctx, out, errs }) => {
    const code = await runGraphNeighbors(['does-not-exist'], ctx)
    assert.equal(code, 1)
    assert.match(errs.join(''), /no node matches "does-not-exist"/)
    assert.equal(out.join(''), '')
  })
})

test('an ambiguous seed exits 1 and lists the candidates on stderr', async () => {
  await withGraph(async ({ ctx, out, errs }) => {
    const code = await runGraphNeighbors(['index.js'], ctx)
    assert.equal(code, 1)
    const stderr = errs.join('')
    assert.match(stderr, /ambiguous seed "index.js" — 2 nodes match by label/)
    // Both colliding Files are listed so the caller can pick the full key.
    assert.match(stderr, /\/repo\/index\.js/)
    assert.match(stderr, /\/other\/index\.js/)
    assert.equal(out.join(''), '')
  })
})

// --- Success: exit 0 --------------------------------------------------------

test('a resolved seed exits 0 and renders neighbors on stdout', async () => {
  await withGraph(async ({ ctx, out, errs }) => {
    const code = await runGraphNeighbors(['conv-1', '--direction', 'out'], ctx)
    assert.equal(code, 0)
    const stdout = out.join('')
    assert.match(stdout, /graph neighbors: conv-1 \(Session\)/)
    assert.match(stdout, /4 neighbor\(s\) within 1 hop\(s\)/)
    assert.equal(errs.join(''), '')
  })
})

test('--limit truncates and reports the true total on stdout (not stderr)', async () => {
  await withGraph(async ({ ctx, out, errs }) => {
    const code = await runGraphNeighbors(['conv-1', '--direction', 'out', '--limit', '1'], ctx)
    assert.equal(code, 0)
    assert.match(out.join(''), /1 of 4 neighbor\(s\) within 1 hop\(s\) — truncated; raise --limit/)
    assert.equal(errs.join(''), '', 'truncation is a result, not an error')
  })
})

test('--json emits the structured result on stdout', async () => {
  await withGraph(async ({ ctx, out, errs }) => {
    const code = await runGraphNeighbors(['conv-1', '--direction', 'out', '--json'], ctx)
    assert.equal(code, 0)
    const parsed = JSON.parse(out.join(''))
    assert.equal(parsed.ok, true)
    assert.equal(parsed.seed.node_id, 'n-sess')
    assert.equal(parsed.neighbors.length, 4)
    assert.equal(parsed.truncated, false)
    assert.equal(errs.join(''), '')
  })
})
