// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AI_GATEWAY_SCHEMA_COLUMNS,
  aiGatewayBackfillMaterializer,
} from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import { createAiGatewayMessageProjector } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'

/**
 * @import { AiGatewayProjectedExchange } from '../../collectivus-plugin-kernel-types.js'
 */

const materializer = aiGatewayBackfillMaterializer()
const MAT_CTX = /** @type {any} */ ({ log: { debug() {}, info() {}, warn() {}, error() {} }, env: {}, storage: {} })

/**
 * Expand the same projection through the live streaming projector so we
 * can prove the backfill materializer produces an identical row shape.
 * The projection carries explicit timestamps, so neither path falls back
 * to a wall-clock `tsStart` and the rows stay comparable.
 *
 * @param {AiGatewayProjectedExchange} projection
 */
async function liveRows(projection) {
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'hypaware-local',
    projectors: [{ name: 'fixture', priority: 0, match: () => true, project: () => projection, _seq: 0 }],
  })
  return projector.projectExchange(liveExchange())
}

function liveExchange() {
  return {
    exchange_id: 'ex', ts_start: '2026-05-01T00:00:00.000Z', ts_end: null, duration_ms: null,
    upstream: 'u', provider: null, method: 'POST', path: '/x', status_code: 200,
    request_bytes: null, response_bytes: null, is_sse: false, stream_event_count: 0,
    request_headers: null, request_body: null, response_headers: null, response_body: null,
    error: null, metadata: null, stream_events: [],
  }
}

/** @param {any} value @param {Record<string, unknown>} [provenance] */
function item(value, provenance) {
  return /** @type {any} */ ({
    dataset: 'ai_gateway_messages',
    kind: 'ai_gateway.projected_exchange',
    value,
    ...(provenance ? { provenance } : {}),
  })
}

/** @param {Record<string, unknown>[]} rows */
function withoutAttributes(rows) {
  return rows.map((row) => {
    const copy = { ...row }
    delete copy.attributes
    return copy
  })
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** @param {Record<string, unknown>} row */
function gateway(row) {
  const a = row.attributes
  return isPlainObject(a) && isPlainObject(a.gateway) ? a.gateway : undefined
}

/** @param {Record<string, unknown>} row */
function clientAttrs(row) {
  const a = row.attributes
  return isPlainObject(a) ? a.client : undefined
}

test('materializer parity with live projector: native message ids', async () => {
  /** @type {AiGatewayProjectedExchange} */
  const projection = {
    provider: 'anthropic',
    // @ref LLP 0030#decision: Claude carries session_id (conversation_id null).
    session_id: 'conv-native',
    conversation_source: 'claude',
    client_name: 'claude',
    client_version: '1.2.3',
    conversation_started_at: '2026-05-01T00:00:00.000Z',
    messages: [
      { role: 'user', content: 'hi', message_id: 'm1', previous_message_id: [], message_created_at: '2026-05-01T00:00:01.000Z' },
      { role: 'assistant', content: 'yo', message_id: 'm2', previous_message_id: ['m1'], message_created_at: '2026-05-01T00:00:02.000Z' },
    ],
  }
  const live = await liveRows(projection)
  const back = await materializer.materialize(item(projection), MAT_CTX)

  assert.ok(back.length > 0)
  assert.equal(back.length, live.length)
  // Row expansion is identical except for the gateway-provenance attrs.
  assert.deepEqual(withoutAttributes(back), withoutAttributes(live))
  // Client attributes are derived from the projection identically.
  for (let i = 0; i < back.length; i++) {
    assert.deepEqual(clientAttrs(back[i]), clientAttrs(live[i]))
  }
  // Gateway provenance differs by design: backfill marks its origin,
  // live carries the HTTP exchange envelope.
  assert.equal(gateway(back[0])?.source, 'backfill')
  assert.equal(gateway(live[0])?.exchange_id, 'ex')
})

test('materializer parity with live projector: fallback identity and chain', async () => {
  /** @type {AiGatewayProjectedExchange} */
  const projection = {
    provider: 'anthropic',
    session_id: 'conv-fallback',
    conversation_source: 'claude',
    client_name: 'claude',
    conversation_started_at: '2026-05-01T00:00:00.000Z',
    messages: [
      { role: 'user', content: 'first', message_created_at: '2026-05-01T00:00:01.000Z' },
      { role: 'assistant', content: 'second', message_created_at: '2026-05-01T00:00:02.000Z' },
    ],
  }
  const live = await liveRows(projection)
  const back = await materializer.materialize(item(projection), MAT_CTX)

  // Fallback ids are deterministic hashes of session/role/content,
  // so the synthesized identity and chain match across both paths.
  assert.deepEqual(back.map((r) => r.message_id), live.map((r) => r.message_id))
  assert.deepEqual(back.map((r) => r.previous_message_id), live.map((r) => r.previous_message_id))
  assert.deepEqual(withoutAttributes(back), withoutAttributes(live))
  assert.equal(gateway(back[0])?.identity_source, 'gateway_fallback')
  assert.equal(gateway(live[0])?.identity_source, 'gateway_fallback')
})

test('materializer ignores malformed payloads and yields no rows', async () => {
  assert.deepEqual(await materializer.materialize(item(null), MAT_CTX), [])
  assert.deepEqual(await materializer.materialize(item({ provider: 'x', conversation_id: 'c' }), MAT_CTX), [])
  assert.deepEqual(await materializer.materialize(item({ conversation_id: 'c', messages: [] }), MAT_CTX), [])
})

test('materializer stamps hashed source-path provenance (raw path not stored)', async () => {
  /** @type {AiGatewayProjectedExchange} */
  const projection = {
    provider: 'anthropic',
    session_id: 'c',
    client_name: 'claude',
    conversation_started_at: '2026-05-01T00:00:00.000Z',
    messages: [{ role: 'user', content: 'hi', message_created_at: '2026-05-01T00:00:01.000Z' }],
  }
  const rawPath = '/home/u/.claude/projects/p/s.jsonl'
  const rows = await materializer.materialize(
    item(projection, { client_name: 'claude', source_path: rawPath, native_id: 'uuid-1' }),
    MAT_CTX,
  )
  assert.ok(rows.length > 0)
  const g = gateway(rows[0])
  assert.equal(g?.source, 'backfill')
  assert.equal(g?.native_id, 'uuid-1')
  assert.equal(String(g?.source_path_hash).length, 16)
  assert.notEqual(g?.source_path_hash, rawPath)
})

test('materialized rows are stripped to the gateway schema columns', async () => {
  /** @type {AiGatewayProjectedExchange} */
  const projection = {
    provider: 'anthropic',
    session_id: 'c',
    conversation_started_at: '2026-05-01T00:00:00.000Z',
    messages: [{ role: 'user', content: 'hi', message_created_at: '2026-05-01T00:00:01.000Z' }],
  }
  const rows = await materializer.materialize(item(projection), MAT_CTX)
  const names = new Set(AI_GATEWAY_SCHEMA_COLUMNS.map((c) => c.name))
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      assert.ok(names.has(key), `unexpected column not in schema: ${key}`)
    }
  }
})

/* ------------------------- pre-write dedupe (V1) -------------------------- */

/**
 * A projection with native message ids, so its expanded rows carry the
 * predictable part_ids `m1#0` (user) and `m2#0` (assistant).
 *
 * @returns {AiGatewayProjectedExchange}
 */
function nativeProjection() {
  return {
    provider: 'anthropic',
    session_id: 'conv-dedupe',
    conversation_source: 'claude',
    client_name: 'claude',
    conversation_started_at: '2026-05-01T00:00:00.000Z',
    messages: [
      { role: 'user', content: 'hi', message_id: 'm1', previous_message_id: [], message_created_at: '2026-05-01T00:00:01.000Z' },
      { role: 'assistant', content: 'yo', message_id: 'm2', previous_message_id: ['m1'], message_created_at: '2026-05-01T00:00:02.000Z' },
    ],
  }
}

/**
 * Minimal `QueryStorageService` double exposing only the partition-read
 * surface the dedupe feature-detects: one partition holding whatever has
 * been "committed". `commit()` mimics the runner appending + flushing a
 * batch; `failReads()` makes the partition unreadable.
 *
 * @param {Record<string, unknown>[]} [initial]
 */
function dedupeStorage(initial = []) {
  /** @type {Record<string, unknown>[]} */
  const committed = [...initial]
  /** @type {Record<string, unknown>[]} */
  let spooled = []
  let readError = false
  let spoolError = false
  return {
    cacheRoot: '/tmp/fake-dedupe',
    /** @param {Record<string, unknown>[]} rows */
    commit(rows) { committed.push(...rows) },
    /** Rows captured live, sitting unflushed in the spool. @param {Record<string, unknown>[]} rows */
    spool(rows) { spooled = [...spooled, ...rows] },
    failReads() { readError = true },
    failSpoolReads() { spoolError = true },
    async discoverCachePartitions() {
      if (committed.length === 0) return []
      return [{ dataset: 'ai_gateway_messages', partition: {}, path: '/tmp/fake-dedupe/p', epoch: 1, rowCount: committed.length }]
    },
    async *readRows() {
      if (readError) throw new Error('partition unreadable')
      for (const row of committed) yield row
    },
    async *readSpooledRows() {
      if (spoolError) throw new Error('spool unreadable')
      for (const row of spooled) yield row
    },
  }
}

/** @param {any} storage @param {string} devRunId */
function matCtx(storage, devRunId) {
  return /** @type {any} */ ({ log: { debug() {}, info() {}, warn() {}, error() {} }, env: {}, storage, devRunId })
}

test('backfill dedupe: a clean rerun writes zero new rows', async () => {
  const m = aiGatewayBackfillMaterializer()
  const storage = dedupeStorage()
  const first = await m.materialize(item(nativeProjection()), matCtx(storage, 'run-1'))
  assert.equal(first.length, 2)
  // Simulate the runner writing + flushing the first run's rows.
  storage.commit(first)
  // A second run carries a fresh run id, so it re-scans and observes the
  // now-committed part_ids: every row is a duplicate and is skipped.
  const second = await m.materialize(item(nativeProjection()), matCtx(storage, 'run-2'))
  assert.deepEqual(second, [])
})

test('backfill dedupe: partial prior write only backfills the missing parts', async () => {
  const m = aiGatewayBackfillMaterializer()
  const storage = dedupeStorage()
  const all = await m.materialize(item(nativeProjection()), matCtx(storage, 'run-1'))
  const m1Row = all.find((r) => r.message_id === 'm1')
  assert.ok(m1Row)
  // Only the first message's row reached durable storage before the
  // interruption; the rerun must add m2 without re-emitting m1.
  storage.commit([m1Row])
  const rerun = await m.materialize(item(nativeProjection()), matCtx(storage, 'run-2'))
  assert.equal(rerun.length, 1)
  assert.equal(rerun[0].message_id, 'm2')
  assert.ok(!rerun.some((r) => r.message_id === 'm1'))
})

test('backfill dedupe: matches legacy committed rows that predate part_id via message_id + part_index', async () => {
  const m = aiGatewayBackfillMaterializer()
  // A row written before the schema carried part_id: only message_id +
  // part_index identify it. partIdKey must recompose `m1#0` from those.
  const storage = dedupeStorage([{ message_id: 'm1', part_index: 0 }])
  const rows = await m.materialize(item(nativeProjection()), matCtx(storage, 'run-x'))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].message_id, 'm2')
})

test('backfill dedupe: a re-yielded item within the same run is skipped without re-committing', async () => {
  const m = aiGatewayBackfillMaterializer()
  const storage = dedupeStorage() // stays empty. Nothing is committed between calls
  const first = await m.materialize(item(nativeProjection()), matCtx(storage, 'run-1'))
  assert.equal(first.length, 2)
  // Same run id → the in-run memo already holds these part_ids, so a
  // duplicate item in the same run dedupes against the earlier batch.
  const again = await m.materialize(item(nativeProjection()), matCtx(storage, 'run-1'))
  assert.deepEqual(again, [])
})

test('backfill dedupe: a storage stub without the read surface skips dedupe entirely', async () => {
  const m = aiGatewayBackfillMaterializer()
  const bare = /** @type {any} */ ({})
  const a = await m.materialize(item(nativeProjection()), matCtx(bare, 'run-1'))
  const b = await m.materialize(item(nativeProjection()), matCtx(bare, 'run-2'))
  assert.equal(a.length, 2)
  assert.equal(b.length, 2)
})

test('backfill dedupe: an unreadable partition degrades to no dedupe rather than dropping rows', async () => {
  const m = aiGatewayBackfillMaterializer()
  const storage = dedupeStorage([{ part_id: 'm1#0' }])
  storage.failReads()
  const rows = await m.materialize(item(nativeProjection()), matCtx(storage, 'run-1'))
  // The scan throws, the seen-set stays empty, so every row passes through
  // A dedupe miss is recoverable (compaction), dropping rows is not.
  assert.equal(rows.length, 2)
})

/* ----------------------- spool-aware dedupe (issue #107) ----------------- */

test('backfill dedupe: rows pending in the spool are not re-materialized', async () => {
  const m = aiGatewayBackfillMaterializer()
  // Nothing committed yet, but both messages were captured live and are
  // sitting unflushed in the spool. Backfill must see them and skip both,
  // or the spool's later flush would leave same-id duplicates.
  const storage = dedupeStorage()
  storage.spool([{ part_id: 'm1#0' }, { part_id: 'm2#0' }])
  const rows = await m.materialize(item(nativeProjection()), matCtx(storage, 'run-1'))
  assert.deepEqual(rows, [])
})

test('backfill dedupe: only the spool-overlapping parts are skipped', async () => {
  const m = aiGatewayBackfillMaterializer()
  // Only m1 is in the spool; m2 has never been captured, so backfill must
  // still materialize m2 while skipping the overlapping m1.
  const storage = dedupeStorage()
  storage.spool([{ part_id: 'm1#0' }])
  const rows = await m.materialize(item(nativeProjection()), matCtx(storage, 'run-1'))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].message_id, 'm2')
})

test('backfill dedupe: spool dedupe also matches legacy rows via message_id + part_index', async () => {
  const m = aiGatewayBackfillMaterializer()
  // A spooled row that predates part_id: partIdKey must recompose `m1#0`.
  const storage = dedupeStorage()
  storage.spool([{ message_id: 'm1', part_index: 0 }])
  const rows = await m.materialize(item(nativeProjection()), matCtx(storage, 'run-1'))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].message_id, 'm2')
})

test('backfill dedupe: committed and spooled part_ids are unioned into one seen-set', async () => {
  const m = aiGatewayBackfillMaterializer()
  // m1 already committed, m2 still in the spool. Together they cover the
  // whole conversation, so a backfill of the same conversation is a no-op.
  const storage = dedupeStorage([{ part_id: 'm1#0' }])
  storage.spool([{ part_id: 'm2#0' }])
  const rows = await m.materialize(item(nativeProjection()), matCtx(storage, 'run-1'))
  assert.deepEqual(rows, [])
})

test('backfill dedupe: an unreadable spool degrades to committed-only dedupe', async () => {
  const m = aiGatewayBackfillMaterializer()
  // m1 committed; the spool read throws. The committed scan still folds in
  // m1, and m2 (never seen) passes through. The spool failure is absorbed.
  const storage = dedupeStorage([{ part_id: 'm1#0' }])
  storage.failSpoolReads()
  const rows = await m.materialize(item(nativeProjection()), matCtx(storage, 'run-1'))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].message_id, 'm2')
})

test('backfill dedupe: a storage stub without readSpooledRows still dedupes against committed', async () => {
  const m = aiGatewayBackfillMaterializer()
  // Storage exposes the committed read surface but no spool surface; the
  // spool scan is feature-detected away and committed dedupe is unaffected.
  const storage = dedupeStorage([{ part_id: 'm1#0' }])
  // @ts-expect-error: intentionally drop the spool surface for this case
  delete storage.readSpooledRows
  const rows = await m.materialize(item(nativeProjection()), matCtx(storage, 'run-1'))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].message_id, 'm2')
})
