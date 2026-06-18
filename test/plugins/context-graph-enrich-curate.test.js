// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { validateEnrichConfig } from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/config.js'
import {
  chunkBySize,
  clusterByRecallRegion,
  cosine,
  greedyCosineClusters,
  routeDecision,
  runCurateTick,
} from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/curate.js'

/**
 * @import { EnrichConfig } from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/types.d.ts'
 */

const AT = '2026-06-15T00:00:00.000Z'

/** @param {Record<string, unknown>} [o] */
function prospect(o = {}) {
  return {
    prospect_id: 'pid-1',
    anchor_type: 'Session',
    anchor_key: 'conv-1',
    source_dataset: 'ai_gateway_messages',
    source_keys: { message_id: ['m1'] },
    ...o,
  }
}

const VIEW = { type: 'Decision', label: 'Use Redis', summary: 'cache layer', confidence: 0.6 }

// --- routeDecision -----------------------------------------------------------

test('routeDecision commit writes a committed row + a resolution, never rejected/merged', () => {
  const r = routeDecision(prospect(), VIEW, { index: 1, decision: 'commit', confidence: 0.9, note: 'good' }, AT)
  assert.equal(r.rejected, false)
  assert.equal(r.merged, false)
  assert.ok(r.committed)
  assert.equal(r.committed?.item_id, 'Use Redis') // falls back to the view label as the key
  assert.equal(r.committed?.item_type, 'Decision')
  assert.deepEqual(r.committed?.props, { summary: 'cache layer' })
  assert.equal(r.committed?.confidence, 0.9) // decision confidence wins over the view's
  assert.equal(r.committed?.anchor_key, 'conv-1')
  assert.deepEqual(r.committed?.source_keys, { message_id: ['m1'] })
  assert.equal(r.resolution?.decision, 'commit')
  assert.deepEqual(r.resolution?.committed_ids, ['Use Redis'])
  assert.equal(r.resolution?.note, 'good')
})

test('routeDecision commit reuses an explicit item_key (convergence) over the label', () => {
  const r = routeDecision(prospect(), VIEW, { index: 1, decision: 'commit', item_key: 'redis-decision', item_type: 'Decision' }, AT)
  assert.equal(r.committed?.item_id, 'redis-decision')
  assert.deepEqual(r.resolution?.committed_ids, ['redis-decision'])
})

test('routeDecision deepen also commits an item', () => {
  const r = routeDecision(prospect(), VIEW, { index: 1, decision: 'deepen', summary: 'better summary' }, AT)
  assert.equal(r.rejected, false)
  assert.ok(r.committed)
  assert.deepEqual(r.committed?.props, { summary: 'better summary' })
  assert.equal(r.resolution?.decision, 'deepen')
})

test('routeDecision reject commits nothing — a rejected prospect never reaches the graph', () => {
  const r = routeDecision(prospect(), VIEW, { index: 1, decision: 'reject', note: 'noise' }, AT)
  assert.equal(r.rejected, true)
  assert.equal(r.committed, null)
  assert.equal(r.resolution?.decision, 'reject')
  assert.equal(r.resolution?.committed_ids, null)
  assert.equal(r.resolution?.note, 'noise')
})

test('routeDecision treats an omitted decision as an implicit reject', () => {
  const r = routeDecision(prospect(), VIEW, undefined, AT)
  assert.equal(r.rejected, true)
  assert.equal(r.committed, null)
  assert.equal(r.resolution?.decision, 'reject')
  assert.equal(r.resolution?.note, 'omitted by curator')
})

test('routeDecision merge writes a committed row under the canonical key with the merging session anchor', () => {
  // The committed-only projection makes provenance-per-session fall out of this:
  // merge writes a committed row (target identity, this session's anchor), so the
  // content-addressed node id collapses while this session gets its produced edge.
  const r = routeDecision(prospect({ anchor_key: 'conv-B' }), VIEW, { index: 1, decision: 'merge', merge_into: 'redis-decision', item_type: 'Decision' }, AT)
  assert.equal(r.merged, true)
  assert.equal(r.rejected, false)
  assert.ok(r.committed)
  assert.equal(r.committed?.item_id, 'redis-decision')
  assert.equal(r.committed?.item_type, 'Decision')
  assert.equal(r.committed?.anchor_key, 'conv-B', 'the merging session, not the canonical')
  assert.equal(r.resolution?.decision, 'merge')
  assert.deepEqual(r.resolution?.committed_ids, ['redis-decision'])
})

test('routeDecision leaves an under-specified merge pending (no commit, no resolution) — avoids mis-routing the produced edge', () => {
  // merge_into present but item_type missing: the canonical node type is unknown,
  // so committing would derive the content-addressed id from the PROSPECT's own
  // type and attach the produced edge to the wrong node. Leave it pending.
  const r = routeDecision(prospect(), VIEW, { index: 1, decision: 'merge', merge_into: 'redis-decision' }, AT)
  assert.equal(r.committed, null)
  assert.equal(r.resolution, null, 'no resolution → stays in the pending queue for a later pass')
  assert.equal(r.merged, false)
  assert.equal(r.rejected, false)
})

test('routeDecision leaves a merge missing merge_into pending too', () => {
  const r = routeDecision(prospect(), VIEW, { index: 1, decision: 'merge', item_type: 'Decision' }, AT)
  assert.equal(r.committed, null)
  assert.equal(r.resolution, null)
})

// --- pure clustering helpers -------------------------------------------------

test('cosine: identical → 1, orthogonal → 0, zero vector → 0', () => {
  assert.equal(cosine([1, 0, 0], [1, 0, 0]), 1)
  assert.equal(cosine([1, 0], [0, 1]), 0)
  assert.equal(cosine([3, 4], [6, 8]), 1) // same direction, different magnitude
  assert.equal(cosine([0, 0], [1, 1]), 0)
})

test('greedyCosineClusters groups near-duplicates and separates distinct ones, deterministically', () => {
  const items = [
    { p: { prospect_id: 'b' }, v: [1, 0] },
    { p: { prospect_id: 'a' }, v: [0.99, 0.14] }, // ~same direction as [1,0]
    { p: { prospect_id: 'c' }, v: [0, 1] },       // orthogonal → its own cluster
  ]
  const clusters = greedyCosineClusters(items, 0.9)
  // Deterministic order is by prospect_id: a, b, c. a seeds; b joins a; c new.
  assert.equal(clusters.length, 2)
  assert.deepEqual(clusters[0].map((p) => p.prospect_id), ['a', 'b'])
  assert.deepEqual(clusters[1].map((p) => p.prospect_id), ['c'])
})

test('clusterByRecallRegion buckets warm prospects by their top recalled node id', () => {
  const recall = new Map([
    ['p1', [{ id: 'nodeX', score: 0.9 }]],
    ['p2', [{ id: 'nodeX', score: 0.8 }]],
    ['p3', [{ id: 'nodeY', score: 0.7 }]],
  ])
  const warm = [{ prospect_id: 'p1' }, { prospect_id: 'p2' }, { prospect_id: 'p3' }]
  const clusters = clusterByRecallRegion(warm, /** @type {any} */ (recall))
  assert.equal(clusters.length, 2)
  assert.deepEqual(clusters[0].map((p) => p.prospect_id), ['p1', 'p2'])
  assert.deepEqual(clusters[1].map((p) => p.prospect_id), ['p3'])
})

test('chunkBySize splits an oversized cluster and leaves a small one whole', () => {
  assert.deepEqual(chunkBySize([1, 2, 3], 5), [[1, 2, 3]])
  assert.deepEqual(chunkBySize([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
})

// --- runCurateTick (orchestration: pending → score → cluster → curate → route → append) ---

/** @returns {EnrichConfig} */
function cfg(overrides = {}) {
  const result = validateEnrichConfig(overrides)
  if (!result.ok) throw new Error('test config invalid')
  return result.config
}

/** @param {Record<string, unknown>} [o] */
function prospectRow(o = {}) {
  return {
    prospect_id: 'pid',
    prospect_type: 'Decision',
    label: 'X',
    props: null,
    confidence: null,
    anchor_type: 'Session',
    anchor_key: 'A',
    source_dataset: 'ai_gateway_messages',
    source_keys: { message_id: ['m1'] },
    ...o,
  }
}

/**
 * @param {string} query
 * @param {Record<string, Record<string, unknown>[]>} tables
 */
function fakeQuery(query, tables) {
  const m = /FROM\s+(\w+)/i.exec(query)
  const name = m ? m[1] : ''
  return tables[name] ? [...tables[name]] : []
}

/**
 * Fake EnrichRuntime backed by in-memory tables + injected execSql, a stub
 * completion returning a fixed `curate_decisions` call, a stub vector search,
 * and a stub embedder returning identical vectors (so the no-recall remainder
 * collapses into ONE cluster — deterministic). `appendRows` mutates `tables`.
 *
 * @param {{ cfg: EnrichConfig, prospects: Record<string, unknown>[], resolutions?: Record<string, unknown>[], decisions: Array<Record<string, unknown>>, vectorHits?: Array<{ id: string, score: number }>, providerThrows?: boolean }} args
 */
function curateRuntime({ cfg, prospects, resolutions = [], decisions, vectorHits, providerThrows = false }) {
  /** @type {Record<string, Record<string, unknown>[]>} */
  const tables = {
    enrichment_prospects: [...prospects],
    enrichment_resolutions: [...resolutions],
    enrichment_committed: [],
    [cfg.source_dataset]: [],
  }
  /** @type {string[]} */
  const queries = []
  let calls = 0
  const completion = {
    provider: 'anthropic',
    async complete() {
      calls++
      if (providerThrows) throw new Error('curator should not be called')
      return { stopReason: 'end_turn', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'curate_decisions', input: { decisions } }] } }
    },
  }
  const runtime = /** @type {any} */ ({
    config: cfg,
    _completion: completion,
    _vector: { async search() { return vectorHits ?? [] } },
    _embedder: { async embed(/** @type {string[]} */ texts) { return { vectors: texts.map(() => new Float32Array([1, 0, 0])), dimension: 3, model: 'fake' } } },
    log: { info() {}, warn() {}, error() {} },
    storage: {
      cacheTablePath: (/** @type {string} */ dataset) => dataset,
      appendRows: async (/** @type {string} */ p, /** @type {unknown} */ _cols, /** @type {Record<string, unknown>[]} */ rows) => {
        ;(tables[p] ??= []).push(...rows)
      },
    },
    execSql: async (/** @type {{ query: string }} */ { query }) => {
      queries.push(query)
      return { rows: fakeQuery(query, tables) }
    },
  })
  return { runtime, tables, queries, getCalls: () => calls }
}

test('runCurateTick curates pending prospects, writes committed + resolution rows, and skips already-resolved', async () => {
  const prospects = [
    prospectRow({ prospect_id: 'p1', prospect_type: 'Decision', label: 'Use Redis', props: { summary: 'cache' }, confidence: 0.7, source_keys: { message_id: ['m1'] } }),
    prospectRow({ prospect_id: 'p2', prospect_type: 'Concept', label: 'Caching', source_keys: { message_id: ['m2'] } }),
    prospectRow({ prospect_id: 'p3', prospect_type: 'Fact', label: 'Old' }),
  ]
  const resolutions = [{ prospect_id: 'p3' }] // already resolved → not pending
  const decisions = [
    { index: 1, decision: 'commit', confidence: 0.9 },
    { index: 2, decision: 'reject', note: 'noise' },
  ]
  const { runtime, tables, getCalls } = curateRuntime({ cfg: cfg(), prospects, resolutions, decisions })

  const r = await runCurateTick(runtime)

  assert.equal(r.pending, 2, 'p3 already resolved, so two pending')
  assert.equal(r.processed, 2)
  assert.equal(r.committed, 1)
  assert.equal(r.rejected, 1)
  assert.equal(r.clusters, 1, 'identical embeddings collapse the no-recall remainder into one cluster')
  assert.equal(r.calls, 1, 'one curator call for the cluster')
  assert.equal(getCalls(), 1)
  assert.equal(tables.enrichment_committed.length, 1)
  assert.equal(tables.enrichment_committed[0].item_id, 'Use Redis')
  assert.equal(tables.enrichment_resolutions.length, 3, 'p1 + p2 resolutions added to the pre-existing p3')
})

test('runCurateTick merges cross-session duplicates — each contributing session gets a committed row (produced edge)', async () => {
  // Two sessions propose the same thing; the curator commits one and merges the
  // other into its key. Both write a committed row under the canonical item_id
  // (the node dedups by content-addressed id), each carrying its own session
  // anchor → a produced edge per contributing session.
  const prospects = [
    prospectRow({ prospect_id: 'p1', label: 'Use Redis', anchor_key: 'A', source_keys: { message_id: ['mA'] } }),
    prospectRow({ prospect_id: 'p2', label: 'Use Redis', anchor_key: 'B', source_keys: { message_id: ['mB'] } }),
  ]
  const decisions = [
    { index: 1, decision: 'commit', item_key: 'redis-key', item_type: 'Decision' },
    { index: 2, decision: 'merge', merge_into: 'redis-key', item_type: 'Decision' },
  ]
  const { runtime, tables } = curateRuntime({ cfg: cfg(), prospects, decisions })

  const r = await runCurateTick(runtime)

  assert.equal(r.committed, 2, 'commit + merge both write a committed row')
  assert.equal(r.merged, 1)
  assert.equal(tables.enrichment_committed.length, 2)
  assert.deepEqual(tables.enrichment_committed.map((c) => c.item_id).sort(), ['redis-key', 'redis-key'])
  assert.deepEqual(tables.enrichment_committed.map((c) => c.anchor_key).sort(), ['A', 'B'], 'one committed row per contributing session')
})

test('runCurateTick leaves an under-specified merge prospect pending while committing its clustermate', async () => {
  // Two sessions in one cluster: the curator commits p1 but returns a merge for
  // p2 with no item_type. The merge can't be routed to the right node, so p2 is
  // left pending (no resolution) for a later pass while p1 still commits.
  const prospects = [
    prospectRow({ prospect_id: 'p1', label: 'Use Redis', anchor_key: 'A', source_keys: { message_id: ['mA'] } }),
    prospectRow({ prospect_id: 'p2', label: 'Use Redis', anchor_key: 'B', source_keys: { message_id: ['mB'] } }),
  ]
  const decisions = [
    { index: 1, decision: 'commit', item_key: 'redis-key', item_type: 'Decision' },
    { index: 2, decision: 'merge', merge_into: 'redis-key' }, // missing item_type → pending
  ]
  const { runtime, tables } = curateRuntime({ cfg: cfg(), prospects, decisions })

  const r = await runCurateTick(runtime)

  assert.equal(r.committed, 1, 'only the valid commit writes a committed row')
  assert.equal(r.merged, 0)
  assert.equal(tables.enrichment_committed.length, 1)
  assert.deepEqual(
    tables.enrichment_resolutions.map((x) => x.prospect_id),
    ['p1'],
    'the under-specified merge gets no resolution → still pending',
  )
})

test('runCurateTick processes a duplicated prospect_id only once (idempotency defense-in-depth)', async () => {
  const dup = prospectRow({ prospect_id: 'p1', prospect_type: 'Decision', label: 'Use Redis' })
  const prospects = [dup, { ...dup }] // same id appears twice in the table
  const decisions = [{ index: 1, decision: 'commit' }]
  const { runtime, tables } = curateRuntime({ cfg: cfg(), prospects, decisions })

  const r = await runCurateTick(runtime)

  assert.equal(r.pending, 1, 'deduped to one pending prospect')
  assert.equal(r.processed, 1)
  assert.equal(tables.enrichment_committed.length, 1)
  assert.equal(tables.enrichment_resolutions.length, 1)
})

test('runCurateTick auto-skips below-salience prospects with a terminal resolution and no curator call', async () => {
  const prospects = [
    prospectRow({ prospect_id: 'p1', prospect_type: 'Decision', label: 'Known A' }),
    prospectRow({ prospect_id: 'p2', prospect_type: 'Concept', label: 'Known B' }),
  ]
  // recall finds a near-duplicate (high score → low novelty 0.05), below the 0.9 threshold.
  const { runtime, tables, getCalls } = curateRuntime({
    cfg: cfg({ recall_index: 'idx', curate: { salience_threshold: 0.9 } }),
    prospects,
    decisions: [],
    vectorHits: [{ id: 'x', score: 0.95 }],
    providerThrows: true,
  })

  const r = await runCurateTick(runtime)

  assert.equal(r.skipped, 2)
  assert.equal(r.processed, 0)
  assert.equal(r.committed, 0)
  assert.equal(r.calls, 0)
  assert.equal(getCalls(), 0, 'no curator call for auto-skipped prospects')
  assert.equal(tables.enrichment_resolutions.length, 2, 'skipped prospects get a terminal resolution so they drain')
  assert.equal(tables.enrichment_resolutions[0].decision, 'skip')
  assert.equal(tables.enrichment_resolutions[0].note, 'below salience threshold')
})

test('runCurateTick leaves a cluster pending (no resolution) when the curator returns no decisions', async () => {
  const prospects = [prospectRow({ prospect_id: 'p1', label: 'X' })]
  const { runtime, tables } = curateRuntime({ cfg: cfg(), prospects, decisions: [] })

  const r = await runCurateTick(runtime)

  assert.equal(r.processed, 0)
  assert.equal(tables.enrichment_resolutions.length, 0, 'no resolution written → stays pending for retry')
})

test('runCurateTick derefs the source with the shared content filter (T1/T2 parity)', async () => {
  // @ref LLP 0028#row-selection — safeDeref must AND the same content filter as
  // the T1 scan into the deref WHERE, so an excluded part (e.g. tool_result)
  // sharing a message_id with a kept text part is not re-admitted into the
  // curator excerpt. The fakeQuery ignores WHERE, so assert on the SQL itself.
  const prospects = [prospectRow({ prospect_id: 'p1', label: 'X', source_keys: { message_id: ['m1'] } })]
  const { runtime, queries } = curateRuntime({ cfg: cfg(), prospects, decisions: [{ index: 1, decision: 'commit' }] })

  await runCurateTick(runtime)

  const deref = queries.find((q) => /SELECT content_text FROM ai_gateway_messages/.test(q))
  assert.ok(deref, 'curate tick derefs the source dataset by message id')
  assert.match(deref, /message_id IN \('m1'\)/)
  assert.match(deref, /content_text IS NOT NULL AND content_text <> ''/)
  assert.match(deref, /part_type NOT IN \('tool_result'\)/)
})
