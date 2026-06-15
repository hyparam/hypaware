// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { validateEnrichConfig } from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/config.js'
import {
  buildProposeQuery,
  collectProspectRows,
  groupSourceRows,
  nextProposeCursor,
} from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/propose.js'

/** @returns {import('../../hypaware-core/plugins-workspace/context-graph-enrich/src/types.d.ts').EnrichConfig} */
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
