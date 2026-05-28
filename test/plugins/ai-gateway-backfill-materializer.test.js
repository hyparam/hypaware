// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AI_GATEWAY_SCHEMA_COLUMNS,
  aiGatewayBackfillMaterializer,
} from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import { createAiGatewayMessageProjector } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'

/**
 * @import { AiGatewayProjectedExchange } from '../../collectivus-plugin-kernel-types.d.ts'
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
    conversation_id: 'conv-native',
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
    conversation_id: 'conv-fallback',
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

  // Fallback ids are deterministic hashes of conversation/role/content,
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
    conversation_id: 'c',
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
    conversation_id: 'c',
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
