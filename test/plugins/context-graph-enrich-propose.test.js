// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { validateEnrichConfig } from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/config.js'
import {
  buildProposeQuery,
  collectProspectRows,
  groupSourceRows,
  nextProposeCursor,
  runProposeTick,
} from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/propose.js'

/**
 * @import { EnrichConfig } from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/types.d.ts'
 */

/** @returns {EnrichConfig} */
function cfg(overrides = {}) {
  const result = validateEnrichConfig(overrides)
  if (!result.ok) throw new Error('test config invalid')
  return result.config
}

/**
 * Source row in the default `ai_gateway_messages` shape (part-level). `ts` is
 * epoch millis here (the engine surfaces TIMESTAMP as a Date, which
 * `groupSourceRows` coerces to millis); part_id is the row-unique tiebreak.
 * @param {{ ts: number, part: string, conv: string, msg?: string, text?: string }} r
 */
function row({ ts, part, conv, msg = 'm', text = 'hello' }) {
  return { message_created_at: ts, part_id: part, conversation_id: conv, message_id: msg, content_text: text }
}

// --- buildProposeQuery -------------------------------------------------------

test('buildProposeQuery with no cursor has no WHERE and orders by the keyset tuple', () => {
  const sql = buildProposeQuery(cfg(), null, 200)
  assert.doesNotMatch(sql, /WHERE/)
  assert.match(sql, /FROM ai_gateway_messages/)
  assert.match(sql, /ORDER BY message_created_at, part_id LIMIT 200/)
})

test('buildProposeQuery filters with a numeric ts >= floor that includes the boundary instant', () => {
  // The engine compares a TIMESTAMP (Date) column correctly only against a
  // numeric literal, and `>=` (not `>`) keeps same-ts parts; the exact tuple
  // boundary is dropped in JS, not SQL.
  const sql = buildProposeQuery(cfg(), { ts: 1750000000000, id: 'p2' }, 50)
  assert.match(sql, /WHERE message_created_at >= 1750000000000 /)
  assert.doesNotMatch(sql, /'/) // numeric literal — no quoted value, no injection surface
  assert.match(sql, /ORDER BY message_created_at, part_id LIMIT 50/)
})

// --- groupSourceRows ---------------------------------------------------------

test('groupSourceRows groups by anchor, concatenates text, and collects provenance keys', () => {
  const rows = [
    row({ ts: 1000, part: 'p1', conv: 'A', msg: 'm1', text: 'one' }),
    row({ ts: 1000, part: 'p2', conv: 'A', msg: 'm1', text: 'two' }),
    row({ ts: 2000, part: 'p3', conv: 'B', msg: 'm2', text: 'three' }),
  ]
  const { groups, rowMeta } = groupSourceRows(rows, cfg())
  assert.equal(groups.size, 2)
  assert.equal(groups.get('A')?.text, 'one\ntwo')
  assert.deepEqual(groups.get('A')?.keys, ['m1', 'm1'])
  assert.equal(groups.get('B')?.text, 'three')
  assert.deepEqual(rowMeta, [
    { ts: 1000, id: 'p1', anchorKey: 'A' },
    { ts: 1000, id: 'p2', anchorKey: 'A' },
    { ts: 2000, id: 'p3', anchorKey: 'B' },
  ])
})

test('groupSourceRows drops rows at or before the cursor tuple (boundary re-fetch)', () => {
  // The `ts >= cursorMs` query re-includes the boundary millisecond (1000);
  // p1/p2 were already processed, p3 (same ts, id > p2) and p4 are new.
  const rows = [
    row({ ts: 1000, part: 'p1', conv: 'A', text: 'a' }),
    row({ ts: 1000, part: 'p2', conv: 'A', text: 'b' }),
    row({ ts: 1000, part: 'p3', conv: 'A', text: 'c' }),
    row({ ts: 2000, part: 'p4', conv: 'B', text: 'd' }),
  ]
  const { groups, rowMeta } = groupSourceRows(rows, cfg(), { ts: 1000, id: 'p2' })
  assert.deepEqual(rowMeta.map((m) => m.id), ['p3', 'p4'], 'same-ts boundary part p3 is NOT skipped')
  assert.equal(groups.get('A')?.text, 'c')
  assert.equal(groups.get('B')?.text, 'd')
})

test('groupSourceRows tags rows with no anchor or no text as non-blocking (anchorKey null)', () => {
  const rows = [
    row({ ts: 1000, part: 'p1', conv: '', text: 'x' }),     // no anchor
    row({ ts: 2000, part: 'p2', conv: 'A', text: '' }),     // no text
    row({ ts: 3000, part: 'p3', conv: 'A', text: 'real' }), // real
  ]
  const { groups, rowMeta } = groupSourceRows(rows, cfg())
  assert.equal(groups.size, 1)
  assert.equal(groups.get('A')?.text, 'real')
  assert.deepEqual(rowMeta.map((m) => m.anchorKey), [null, null, 'A'])
})

test('groupSourceRows coerces Date and ISO-string timestamps to epoch millis', () => {
  const ms = Date.parse('2026-06-15T00:00:01.000Z')
  const rows = [
    { message_created_at: new Date(ms), part_id: 'p1', conversation_id: 'A', message_id: 'm1', content_text: 'd' },
    { message_created_at: '2026-06-15T00:00:01.000Z', part_id: 'p2', conversation_id: 'A', message_id: 'm1', content_text: 's' },
  ]
  const { rowMeta } = groupSourceRows(rows, cfg())
  assert.deepEqual(rowMeta.map((m) => m.ts), [ms, ms])
})

// --- nextProposeCursor (the watermark) --------------------------------------

const RM = [
  { ts: 1000, id: 'p1', anchorKey: 'A' },
  { ts: 1000, id: 'p2', anchorKey: 'A' },
  { ts: 2000, id: 'p3', anchorKey: 'B' },
  { ts: 3000, id: 'p4', anchorKey: 'B' },
]

test('nextProposeCursor advances to the global max tuple when every group was processed', () => {
  assert.deepEqual(nextProposeCursor(RM, new Set(['A', 'B']), null), { ts: 3000, id: 'p4' })
})

test('nextProposeCursor advances only over the processed prefix on an early deadline break', () => {
  // A processed, B not (deadline broke before B) → cursor stops just before
  // B's first row, so B is NOT skipped: it is re-read next tick.
  assert.deepEqual(nextProposeCursor(RM, new Set(['A']), null), { ts: 1000, id: 'p2' })
})

test('nextProposeCursor does not advance when the very first group is unprocessed', () => {
  const prior = { ts: 500, id: 'z' }
  assert.deepEqual(nextProposeCursor(RM, new Set(['B']), prior), prior)
})

test('nextProposeCursor is order-independent — a later processed group cannot skip an earlier unprocessed one', () => {
  // Interleaved timestamps across anchors: A at 1000+3000, B at 2000.
  const interleaved = [
    { ts: 1000, id: 'p1', anchorKey: 'A' },
    { ts: 2000, id: 'p2', anchorKey: 'B' },
    { ts: 3000, id: 'p3', anchorKey: 'A' },
  ]
  // A processed, B not. A's t=3000 row must NOT pull the cursor past B's t=2000 row.
  assert.deepEqual(nextProposeCursor(interleaved, new Set(['A']), null), { ts: 1000, id: 'p1' })
})

test('nextProposeCursor advances past non-blocking (no-anchor) rows', () => {
  const rm = [
    { ts: 1000, id: 'p1', anchorKey: null },
    { ts: 2000, id: 'p2', anchorKey: 'A' },
  ]
  assert.deepEqual(nextProposeCursor(rm, new Set(['A']), null), { ts: 2000, id: 'p2' })
})

// --- collectProspectRows (dedup + row shape) --------------------------------

test('collectProspectRows dedups identical (type,label) within an anchor and shapes the row', () => {
  const perGroup = [
    {
      anchorKey: 'A',
      keys: ['m1', 'm2'],
      candidates: [
        { type: 'Decision', label: 'Use Redis', summary: 'cache', confidence: 0.7, evidence: 'e' },
        { type: 'Decision', label: 'Use Redis', summary: 'dup' },
      ],
    },
  ]
  const out = collectProspectRows(perGroup, cfg(), '2026-06-15T00:00:00.000Z')
  assert.equal(out.size, 1, 'same type+label+anchor collapses to one prospect')
  const r = [...out.values()][0]
  assert.equal(r.prospect_type, 'Decision')
  assert.equal(r.label, 'Use Redis')
  assert.deepEqual(r.props, { summary: 'cache' })
  assert.equal(r.confidence, 0.7)
  assert.equal(r.anchor_type, 'Session')
  assert.equal(r.anchor_key, 'A')
  assert.equal(r.source_dataset, 'ai_gateway_messages')
  assert.deepEqual(r.source_keys, { message_id: ['m1', 'm2'] })
  assert.equal(r.extractor, 'enrich.t1')
})

test('collectProspectRows keeps the same label under different anchors as distinct prospects', () => {
  const perGroup = [
    { anchorKey: 'A', keys: ['m1'], candidates: [{ type: 'Concept', label: 'X' }] },
    { anchorKey: 'B', keys: ['m2'], candidates: [{ type: 'Concept', label: 'X' }] },
  ]
  const out = collectProspectRows(perGroup, cfg(), 'now')
  assert.equal(out.size, 2, 'prospect id includes the anchor, so different sessions do not collide')
})

// --- runProposeTick (orchestration: read → propose → dedup → append → watermark) ---

/**
 * A fake EnrichRuntime backed by in-memory tables + the injected `execSql`
 * seam. `complete` returns the same emit_prospects tool call for every group.
 * `appendRows` mutates `tables`, so the cross-tick idempotency filter (which
 * reads back enrichment_prospects) sees prior writes.
 *
 * @param {{ cfg: EnrichConfig, stateDir: string, source: Record<string, unknown>[], prospects?: Record<string, unknown>[], candidates: Array<Record<string, unknown>> }} args
 */
function proposeRuntime({ cfg, stateDir, source, prospects = [], candidates }) {
  /** @type {Record<string, Record<string, unknown>[]>} */
  const tables = {
    [cfg.source_dataset]: source,
    enrichment_prospects: [...prospects],
    enrichment_resolutions: [],
    enrichment_committed: [],
  }
  const completion = {
    provider: 'anthropic',
    async complete() {
      return {
        stopReason: 'end_turn',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'emit_prospects', input: { prospects: candidates } }] },
      }
    },
  }
  const runtime = /** @type {any} */ ({
    config: cfg,
    stateDir,
    _completion: completion,
    storage: {
      cacheTablePath: (/** @type {string} */ dataset) => dataset,
      appendRows: async (/** @type {string} */ p, /** @type {unknown} */ _cols, /** @type {Record<string, unknown>[]} */ rows) => {
        ;(tables[p] ??= []).push(...rows)
      },
    },
    execSql: async (/** @type {{ query: string }} */ { query }) => ({ rows: fakeQuery(query, tables) }),
  })
  return { runtime, tables }
}

/**
 * Minimal SQL stand-in: resolves the first `FROM <table>` and returns its rows.
 * The pure query helpers (buildProposeQuery/groupSourceRows) are tested above,
 * so here we only need rows to flow through the tick — WHERE/LIMIT are ignored.
 *
 * @param {string} query
 * @param {Record<string, Record<string, unknown>[]>} tables
 */
function fakeQuery(query, tables) {
  const m = /FROM\s+(\w+)/i.exec(query)
  const name = m ? m[1] : ''
  return tables[name] ? [...tables[name]] : []
}

function tmpStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-propose-'))
}

test('runProposeTick reads source, proposes, appends prospects, and advances the watermark', async () => {
  const stateDir = tmpStateDir()
  try {
    const source = [
      row({ ts: 1000, part: 'p1', conv: 'A', msg: 'm1', text: 'we will use redis' }),
      row({ ts: 2000, part: 'p2', conv: 'A', msg: 'm2', text: 'redis is the cache' }),
    ]
    const candidates = [
      { type: 'Decision', label: 'Use Redis', summary: 'cache', confidence: 0.9 },
      { type: 'Concept', label: 'Cache', summary: 'a cache', confidence: 0.8 },
    ]
    const { runtime, tables } = proposeRuntime({ cfg: cfg(), stateDir, source, candidates })

    const r = await runProposeTick(runtime)

    assert.equal(r.groups, 1, 'one anchor (session A)')
    assert.equal(r.prospects, 2, 'two distinct prospects appended')
    assert.deepEqual(r.cursor, { ts: 2000, id: 'p2' }, 'watermark advanced to the max tuple')
    assert.equal(tables.enrichment_prospects.length, 2)
    const persisted = JSON.parse(fs.readFileSync(path.join(stateDir, 'enrich-state.json'), 'utf8'))
    assert.deepEqual(persisted.propose_cursor, { ts: 2000, id: 'p2' })
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test('runProposeTick is idempotent across ticks — re-reading the same source appends no duplicate (Codex finding)', async () => {
  const stateDir = tmpStateDir()
  try {
    const source = [row({ ts: 1000, part: 'p1', conv: 'A', msg: 'm1', text: 'use redis' })]
    const candidates = [{ type: 'Decision', label: 'Use Redis', summary: 'cache', confidence: 0.9 }]
    const { runtime, tables } = proposeRuntime({ cfg: cfg(), stateDir, source, candidates })

    const first = await runProposeTick(runtime)
    assert.equal(first.prospects, 1)
    assert.equal(tables.enrichment_prospects.length, 1)

    // Simulate a tick that proposed then crashed before its watermark persisted:
    // the next tick re-reads the same source from a null cursor and re-derives
    // the same deterministic prospect id.
    fs.rmSync(path.join(stateDir, 'enrich-state.json'))
    const second = await runProposeTick(runtime)

    assert.equal(second.prospects, 0, 're-derived id already persisted → filtered before append')
    assert.equal(tables.enrichment_prospects.length, 1, 'no duplicate prospect row appended')
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test('runProposeTick drops candidates below the confidence floor before appending', async () => {
  const stateDir = tmpStateDir()
  try {
    const source = [row({ ts: 1000, part: 'p1', conv: 'A', msg: 'm1', text: 'mixed' })]
    const candidates = [
      { type: 'Decision', label: 'Keep', confidence: 0.9 },
      { type: 'Concept', label: 'Drop', confidence: 0.05 },
    ]
    const { runtime, tables } = proposeRuntime({ cfg: cfg({ propose: { confidence_floor: 0.5 } }), stateDir, source, candidates })

    const r = await runProposeTick(runtime)

    assert.equal(r.prospects, 1)
    assert.equal(tables.enrichment_prospects.length, 1)
    assert.equal(tables.enrichment_prospects[0].label, 'Keep')
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})
