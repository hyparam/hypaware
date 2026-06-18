// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { validateEnrichConfig } from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/config.js'
import {
  buildSessionAggregateQuery,
  buildSessionPartsQuery,
  buildTranscript,
  collectProspectRows,
  orderSessionParts,
  runProposeTick,
  selectSessions,
  sessionMark,
} from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/propose.js'
import { readState, writeState } from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/state.js'

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
 * epoch millis here (the engine surfaces TIMESTAMP as a Date, which the propose
 * helpers coerce to millis); part_id is the row-unique tiebreak; session_id is
 * the anchor (@ref LLP 0030#decision — the Session anchor moved off
 * conversation_id, which is null for Claude).
 * @param {{ ts: number, part: string, sid: string, msg?: string, text?: string }} r
 */
function srow({ ts, part, sid, msg = 'm', text = 'hello' }) {
  return { message_created_at: ts, part_id: part, session_id: sid, conversation_id: null, message_id: msg, content_text: text }
}

// --- buildSessionAggregateQuery (the cheap session selector) -----------------

test('buildSessionAggregateQuery groups by session and takes MAX(ts), applying the content filter', () => {
  const sql = buildSessionAggregateQuery(cfg())
  assert.match(sql, /SELECT session_id, MAX\(message_created_at\) AS last_ts FROM ai_gateway_messages/)
  assert.match(sql, /content_text IS NOT NULL AND content_text <> ''/)
  assert.match(sql, /part_type NOT IN \('tool_result'\)/)
  assert.match(sql, /GROUP BY session_id$/)
})

test('buildSessionAggregateQuery omits WHERE when both filters are off', () => {
  const sql = buildSessionAggregateQuery(cfg({ require_text: false, exclude_part_types: [] }))
  assert.doesNotMatch(sql, /WHERE/)
  assert.match(sql, /GROUP BY session_id$/)
})

// --- buildSessionPartsQuery (the full-session read) --------------------------

test('buildSessionPartsQuery selects all transcript columns for one session, with no LIMIT', () => {
  const sql = buildSessionPartsQuery(cfg(), 'sess-1')
  assert.match(sql, /SELECT session_id, message_created_at, part_id, message_id, content_text FROM ai_gateway_messages/)
  assert.match(sql, /WHERE session_id = 'sess-1' AND/)
  assert.match(sql, /content_text IS NOT NULL AND content_text <> ''/)
  assert.match(sql, /part_type NOT IN \('tool_result'\)/)
  assert.doesNotMatch(sql, /LIMIT/) // full session — the whole point
})

test("buildSessionPartsQuery escapes a single quote in the session id (no injection surface)", () => {
  const sql = buildSessionPartsQuery(cfg(), "a'b")
  assert.match(sql, /WHERE session_id = 'a''b' AND/)
})

test('buildSessionPartsQuery for a custom source is the bare anchor predicate (no part_type column)', () => {
  const c = cfg({ source_dataset: 'my_logs', text_column: 'body', id_column: 'row_id', anchor_key_column: 'thread', require_text: false })
  const sql = buildSessionPartsQuery(c, 'T1')
  assert.match(sql, /SELECT thread, message_created_at, part_id, row_id, body FROM my_logs/)
  assert.match(sql, /WHERE thread = 'T1'$/)
  assert.doesNotMatch(sql, /part_type/)
  assert.doesNotMatch(sql, /IS NOT NULL/)
})

// --- orderSessionParts / buildTranscript / sessionMark ----------------------

test('orderSessionParts sorts by (timestamp, tiebreak) and coerces Date/ISO timestamps', () => {
  const ms = Date.parse('2026-06-15T00:00:01.000Z')
  const rows = [
    srow({ ts: 2000, part: 'p3', sid: 'A', text: 'third' }),
    { message_created_at: new Date(ms), part_id: 'p2', session_id: 'A', message_id: 'm', content_text: 'date' },
    { message_created_at: '2026-06-15T00:00:01.000Z', part_id: 'p1', session_id: 'A', message_id: 'm', content_text: 'iso' },
    srow({ ts: 1000, part: 'p9', sid: 'A', text: 'first' }),
  ]
  const ordered = orderSessionParts(rows, cfg())
  // 1000 < 2000 < ms (2026-06-15 ≈ 1.78e12); at ms the tiebreak p1 < p2.
  assert.deepEqual(ordered.map((r) => r.content_text), ['first', 'third', 'iso', 'date'])
})

test('buildTranscript stitches ordered text and dedups provenance ids, skipping empties', () => {
  const ordered = [
    srow({ ts: 1, part: 'p1', sid: 'A', msg: 'm1', text: 'one' }),
    srow({ ts: 2, part: 'p2', sid: 'A', msg: 'm1', text: '' }),     // empty — skipped
    srow({ ts: 3, part: 'p3', sid: 'A', msg: 'm2', text: 'two' }),
  ]
  const { text, keys } = buildTranscript(ordered, cfg())
  assert.equal(text, 'one\ntwo')
  assert.deepEqual(keys, ['m1', 'm2'], 'message ids deduped across parts')
})

test('sessionMark returns the latest ordered part tuple', () => {
  const ordered = orderSessionParts(
    [srow({ ts: 1000, part: 'p1', sid: 'A' }), srow({ ts: 3000, part: 'p9', sid: 'A' }), srow({ ts: 3000, part: 'p2', sid: 'A' })],
    cfg()
  )
  assert.deepEqual(sessionMark(ordered, cfg()), { ts: 3000, id: 'p9' })
})

// --- selectSessions (the two-regime selector) -------------------------------

/**
 * A runtime whose `execSql` returns a fixed aggregate result (one row per
 * session: { session_id, last_ts }) — the shape buildSessionAggregateQuery
 * yields. Lets us drive selectSessions without a SQL engine.
 * @param {{ cfg: EnrichConfig, aggregate: Array<{ session_id: string, last_ts: number }> }} args
 */
function selectorRuntime({ cfg, aggregate }) {
  return /** @type {any} */ ({
    config: cfg,
    execSql: async () => ({ rows: aggregate }),
  })
}

const NOW = Date.parse('2026-06-18T12:00:00.000Z')
const HOUR = 60 * 60_000

test('selectSessions ongoing keeps only settled, past-watermark sessions, oldest first, capped', () => {
  const aggregate = [
    { session_id: 'fresh', last_ts: NOW - 5 * 60_000 },   // 5m old — not settled
    { session_id: 'old1', last_ts: NOW - 3 * HOUR },      // settled
    { session_id: 'old2', last_ts: NOW - 2 * HOUR },      // settled
    { session_id: 'done', last_ts: NOW - 4 * HOUR },      // settled but already enriched-through
  ]
  const runtime = selectorRuntime({ cfg: cfg({ propose: { max_sessions_per_tick: 2 } }), aggregate })
  const marks = { done: { ts: NOW - 4 * HOUR, id: 'z' } } // last_ts <= mark.ts → excluded
  const ids = /** @type {Promise<string[]>} */ (selectSessions(runtime, { regime: 'ongoing', nowMs: NOW, marks }))
  return ids.then((res) => {
    assert.deepEqual(res, ['old1', 'old2'], 'fresh not settled; done already covered; oldest-settled first; capped at 2')
  })
})

test('selectSessions backfill returns every session, ignoring settle + watermark + cap', async () => {
  const aggregate = [
    { session_id: 'fresh', last_ts: NOW - 1 * 60_000 },
    { session_id: 'old', last_ts: NOW - 5 * HOUR },
    { session_id: 'done', last_ts: NOW - 4 * HOUR },
  ]
  const runtime = selectorRuntime({ cfg: cfg({ propose: { max_sessions_per_tick: 1 } }), aggregate })
  const ids = await selectSessions(runtime, { regime: 'backfill', nowMs: NOW, marks: { done: { ts: NOW, id: 'z' } } })
  assert.deepEqual(ids.sort(), ['done', 'fresh', 'old'])
})

// --- collectProspectRows (dedup + row shape) --------------------------------

test('collectProspectRows dedups identical (type,label) within a session and shapes the row', () => {
  const perSession = [
    {
      anchorKey: 'A',
      keys: ['m1', 'm2'],
      candidates: [
        { type: 'Decision', label: 'Use Redis', summary: 'cache', confidence: 0.7, evidence: 'e' },
        { type: 'Decision', label: 'Use Redis', summary: 'dup' },
      ],
    },
  ]
  const out = collectProspectRows(perSession, cfg(), '2026-06-15T00:00:00.000Z')
  assert.equal(out.size, 1, 'same type+label+anchor collapses to one prospect')
  const r = [...out.values()][0]
  assert.equal(r.prospect_type, 'Decision')
  assert.equal(r.label, 'Use Redis')
  assert.deepEqual(r.props, { summary: 'cache' })
  assert.equal(r.anchor_type, 'Session')
  assert.equal(r.anchor_key, 'A')
  assert.deepEqual(r.source_keys, { message_id: ['m1', 'm2'] })
  assert.equal(r.extractor, 'enrich.t1')
})

test('collectProspectRows keeps the same label under different sessions as distinct prospects', () => {
  const perSession = [
    { anchorKey: 'A', keys: ['m1'], candidates: [{ type: 'Concept', label: 'X' }] },
    { anchorKey: 'B', keys: ['m2'], candidates: [{ type: 'Concept', label: 'X' }] },
  ]
  const out = collectProspectRows(perSession, cfg(), 'now')
  assert.equal(out.size, 2, 'prospect id includes the anchor, so different sessions do not collide')
})

// --- runProposeTick (orchestration: select → read → extract → dedup → append → mark) ---

/**
 * Minimal SQL stand-in: resolves the first `FROM <table>`, then honors a single
 * `<col> = '<val>'` equality (the per-session parts query) — enough for the tick
 * to read one session's parts and the idempotency filter to read prospects.
 *
 * @param {string} query
 * @param {Record<string, Record<string, unknown>[]>} tables
 */
function fakeQuery(query, tables) {
  const m = /FROM\s+(\w+)/i.exec(query)
  const name = m ? m[1] : ''
  let rows = tables[name] ? [...tables[name]] : []
  const eq = /WHERE\s+(\w+)\s*=\s*'((?:[^']|'')*)'/i.exec(query)
  if (eq) {
    const col = eq[1]
    const val = eq[2].replace(/''/g, "'")
    rows = rows.filter((r) => String(r[col]) === val)
  }
  return rows
}

/**
 * Fake EnrichRuntime backed by in-memory tables + the injected `execSql` seam.
 * `complete` returns the same emit_prospects tool call for every session.
 * `appendRows` mutates `tables`, so the cross-tick idempotency filter sees prior
 * writes.
 *
 * @param {{ cfg: EnrichConfig, stateDir: string, source: Record<string, unknown>[], prospects?: Record<string, unknown>[], candidates: Array<Record<string, unknown>> }} args
 */
function proposeRuntime({ cfg, stateDir, source, prospects = [], candidates }) {
  /** @type {Record<string, Record<string, unknown>[]>} */
  const tables = {
    [cfg.source_dataset]: source,
    enrichment_prospects: [...prospects],
  }
  let calls = 0
  const completion = {
    provider: 'anthropic',
    async complete() {
      calls++
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
  return { runtime, tables, getCalls: () => calls }
}

function tmpStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-propose-'))
}

test('runProposeTick extracts a whole session in one call, appends prospects, and advances its mark', async () => {
  const stateDir = tmpStateDir()
  try {
    const source = [
      srow({ ts: 1000, part: 'p1', sid: 'A', msg: 'm1', text: 'we will use redis' }),
      srow({ ts: 2000, part: 'p2', sid: 'A', msg: 'm2', text: 'redis is the cache' }),
    ]
    const candidates = [
      { type: 'Decision', label: 'Use Redis', summary: 'cache', confidence: 0.9 },
      { type: 'Concept', label: 'Cache', summary: 'a cache', confidence: 0.8 },
    ]
    const { runtime, tables, getCalls } = proposeRuntime({ cfg: cfg(), stateDir, source, candidates })

    const r = await runProposeTick(runtime, { regime: 'backfill', sessionIds: ['A'] })

    assert.equal(r.sessions, 1)
    assert.equal(getCalls(), 1, 'one full-session extraction call (not one per part)')
    assert.equal(r.prospects, 2, 'two distinct prospects appended')
    assert.equal(tables.enrichment_prospects.length, 2)
    const marks = readState(stateDir).session_marks
    assert.deepEqual(marks.A, { ts: 2000, id: 'p2' }, 'mark advanced to the session latest part')
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test('runProposeTick is idempotent across ticks — re-extracting the same session appends no duplicate', async () => {
  const stateDir = tmpStateDir()
  try {
    const source = [srow({ ts: 1000, part: 'p1', sid: 'A', msg: 'm1', text: 'use redis' })]
    const candidates = [{ type: 'Decision', label: 'Use Redis', summary: 'cache', confidence: 0.9 }]
    const { runtime, tables } = proposeRuntime({ cfg: cfg(), stateDir, source, candidates })

    const first = await runProposeTick(runtime, { regime: 'backfill', sessionIds: ['A'] })
    assert.equal(first.prospects, 1)
    assert.equal(tables.enrichment_prospects.length, 1)

    // Re-run backfill over the same session (e.g. a later overlapping run): the
    // deterministic prospect id is already persisted → filtered before append.
    const second = await runProposeTick(runtime, { regime: 'backfill', sessionIds: ['A'] })
    assert.equal(second.prospects, 0, 're-derived id already persisted → nothing appended')
    assert.equal(tables.enrichment_prospects.length, 1, 'no duplicate prospect row')
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test('runProposeTick ongoing skips a session already enriched through its latest part', async () => {
  const stateDir = tmpStateDir()
  try {
    const source = [srow({ ts: 1000, part: 'p1', sid: 'A', msg: 'm1', text: 'use redis' })]
    const candidates = [{ type: 'Decision', label: 'Use Redis', confidence: 0.9 }]
    const { runtime, tables, getCalls } = proposeRuntime({ cfg: cfg(), stateDir, source, candidates })
    // Seed the mark at the session's current latest part → no new content.
    writeState(stateDir, { schema_version: 4, session_marks: { A: { ts: 1000, id: 'p1' } }, curate_job: null })

    const r = await runProposeTick(runtime, { regime: 'ongoing', sessionIds: ['A'] })

    assert.equal(r.sessions, 0, 'precise watermark check skips the already-enriched session')
    assert.equal(getCalls(), 0, 'no model call for a session with no new content')
    assert.equal(tables.enrichment_prospects.length, 0)
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test('runProposeTick drops candidates below the confidence floor before appending', async () => {
  const stateDir = tmpStateDir()
  try {
    const source = [srow({ ts: 1000, part: 'p1', sid: 'A', msg: 'm1', text: 'mixed' })]
    const candidates = [
      { type: 'Decision', label: 'Keep', confidence: 0.9 },
      { type: 'Concept', label: 'Drop', confidence: 0.05 },
    ]
    const { runtime, tables } = proposeRuntime({ cfg: cfg({ propose: { confidence_floor: 0.5 } }), stateDir, source, candidates })

    const r = await runProposeTick(runtime, { regime: 'backfill', sessionIds: ['A'] })

    assert.equal(r.prospects, 1)
    assert.equal(tables.enrichment_prospects.length, 1)
    assert.equal(tables.enrichment_prospects[0].label, 'Keep')
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})
