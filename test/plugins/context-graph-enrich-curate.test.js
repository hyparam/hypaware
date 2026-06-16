// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { validateEnrichConfig } from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/config.js'
import { routeDecision, runCurateTick } from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/curate.js'

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

test('routeDecision commit writes a committed row + a resolution, never rejected', () => {
  const r = routeDecision(prospect(), VIEW, { index: 1, decision: 'commit', confidence: 0.9, note: 'good' }, AT)
  assert.equal(r.rejected, false)
  assert.ok(r.committed)
  assert.equal(r.committed?.item_id, 'Use Redis') // falls back to the view label as the key
  assert.equal(r.committed?.item_type, 'Decision')
  assert.deepEqual(r.committed?.props, { summary: 'cache layer' })
  assert.equal(r.committed?.confidence, 0.9) // decision confidence wins over the view's
  assert.equal(r.committed?.anchor_key, 'conv-1')
  assert.deepEqual(r.committed?.source_keys, { message_id: ['m1'] })
  assert.equal(r.resolution.decision, 'commit')
  assert.deepEqual(r.resolution.committed_ids, ['Use Redis'])
  assert.equal(r.resolution.note, 'good')
})

test('routeDecision commit reuses an explicit item_key (convergence) over the label', () => {
  const r = routeDecision(prospect(), VIEW, { index: 1, decision: 'commit', item_key: 'redis-decision', item_type: 'Decision' }, AT)
  assert.equal(r.committed?.item_id, 'redis-decision')
  assert.deepEqual(r.resolution.committed_ids, ['redis-decision'])
})

test('routeDecision deepen also commits an item', () => {
  const r = routeDecision(prospect(), VIEW, { index: 1, decision: 'deepen', summary: 'better summary' }, AT)
  assert.equal(r.rejected, false)
  assert.ok(r.committed)
  assert.deepEqual(r.committed?.props, { summary: 'better summary' })
  assert.equal(r.resolution.decision, 'deepen')
})

test('routeDecision reject commits nothing — a rejected prospect never reaches the graph', () => {
  const r = routeDecision(prospect(), VIEW, { index: 1, decision: 'reject', note: 'noise' }, AT)
  assert.equal(r.rejected, true)
  assert.equal(r.committed, null)
  assert.equal(r.resolution.decision, 'reject')
  assert.equal(r.resolution.committed_ids, null)
  assert.equal(r.resolution.note, 'noise')
})

test('routeDecision treats an omitted decision as an implicit reject', () => {
  const r = routeDecision(prospect(), VIEW, undefined, AT)
  assert.equal(r.rejected, true)
  assert.equal(r.committed, null)
  assert.equal(r.resolution.decision, 'reject')
  assert.equal(r.resolution.note, 'omitted by curator')
})

test('routeDecision merge records the target and commits nothing', () => {
  const r = routeDecision(prospect(), VIEW, { index: 1, decision: 'merge', merge_into: 'existing-key' }, AT)
  assert.equal(r.rejected, false)
  assert.equal(r.committed, null)
  assert.equal(r.resolution.decision, 'merge')
  assert.deepEqual(r.resolution.committed_ids, ['existing-key'])
})

// --- runCurateTick (orchestration: pending → salience → group → curate → route → append) ---

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
 * completion returning a fixed `curate_decisions` call, and a stub vector
 * search. `appendRows` mutates `tables` so assertions can read committed /
 * resolution rows back.
 *
 * @param {{ cfg: EnrichConfig, prospects: Record<string, unknown>[], resolutions?: Record<string, unknown>[], decisions: Array<Record<string, unknown>>, vectorHits?: Array<{ id: string, score: number }>, providerThrows?: boolean }} args
 */
function curateRuntime({ cfg, prospects, resolutions = [], decisions, vectorHits, providerThrows = false }) {
  /** @type {Record<string, Record<string, unknown>[]>} */
  const tables = {
    enrichment_prospects: [...prospects],
    enrichment_resolutions: [...resolutions],
    enrichment_committed: [],
    edge: [],
    node: [],
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
    graph: { kit: { nodeId: (/** @type {string} */ t, /** @type {string} */ k) => `${t}:${k}` } },
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
  assert.equal(r.calls, 1, 'one curator call for the whole session group')
  assert.equal(getCalls(), 1)
  assert.equal(tables.enrichment_committed.length, 1)
  assert.equal(tables.enrichment_committed[0].item_id, 'Use Redis')
  assert.equal(tables.enrichment_resolutions.length, 3, 'p1 + p2 resolutions added to the pre-existing p3')
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

test('runCurateTick leaves a group pending (no resolution) when the curator returns no decisions', async () => {
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

test('runCurateTick deref drops the content filter when a custom source disables it', async () => {
  // A custom source defaults exclude_part_types to [] and can turn require_text
  // off, so the deref is the bare id predicate — no part_type column referenced.
  const prospects = [prospectRow({ prospect_id: 'p1', label: 'X', source_dataset: 'my_logs', source_keys: { row_id: ['r1'] } })]
  const c = cfg({ source_dataset: 'my_logs', text_column: 'body', id_column: 'row_id', require_text: false })
  const { runtime, queries } = curateRuntime({ cfg: c, prospects, decisions: [{ index: 1, decision: 'commit' }] })

  await runCurateTick(runtime)

  const deref = queries.find((q) => /SELECT body FROM my_logs/.test(q))
  assert.ok(deref, 'curate tick derefs the custom source')
  assert.match(deref, /WHERE row_id IN \('r1'\) LIMIT/)
  assert.doesNotMatch(deref, /part_type/)
  assert.doesNotMatch(deref, /IS NOT NULL/)
})
