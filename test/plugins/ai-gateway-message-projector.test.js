// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { AI_GATEWAY_SCHEMA_COLUMNS } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import { createAiGatewayMessageProjector } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'

/**
 * @import { AiGatewayExchangeInput, AiGatewayExchangeProjectorContext, AiGatewayProjectedExchange } from '../../collectivus-plugin-kernel-types.d.ts'
 */

const EXPECTED_COLUMNS = [
  ['gateway_id', 'STRING', false],
  ['schema_version', 'INT32', false],
  ['conversation_id', 'STRING', false],
  ['user_id', 'STRING', true],
  ['provider', 'STRING', false],
  ['model', 'STRING', true],
  ['system_text', 'STRING', true],
  ['tools', 'JSON', true],
  ['conversation_started_at', 'TIMESTAMP', false],
  ['conversation_source', 'STRING', true],
  ['cwd', 'STRING', true],
  ['git_branch', 'STRING', true],
  ['client_version', 'STRING', true],
  ['entrypoint', 'STRING', true],
  ['user_type', 'STRING', true],
  ['permission_mode', 'STRING', true],
  ['is_sidechain', 'BOOLEAN', true],
  ['message_id', 'STRING', false],
  ['previous_message_id', 'JSON', true],
  ['provider_uuid', 'STRING', true],
  ['parent_uuid', 'STRING', true],
  ['logical_parent_uuid', 'STRING', true],
  ['source_tool_assistant_uuid', 'STRING', true],
  ['request_id', 'STRING', true],
  ['prompt_id', 'STRING', true],
  ['message_index', 'INT32', false],
  ['message_created_at', 'TIMESTAMP', false],
  ['role', 'STRING', false],
  ['part_id', 'STRING', false],
  ['part_index', 'INT32', false],
  ['part_type', 'STRING', false],
  ['provider_type', 'STRING', true],
  ['provider_subtype', 'STRING', true],
  ['content_text', 'STRING', true],
  ['tool_name', 'STRING', true],
  ['tool_call_id', 'STRING', true],
  ['tool_args', 'JSON', true],
  ['caller_type', 'STRING', true],
  ['tool_result_for', 'STRING', true],
  ['thinking_signature', 'STRING', true],
  ['attachment_type', 'STRING', true],
  ['hook_event', 'STRING', true],
  ['is_error', 'BOOLEAN', true],
  ['is_compact_summary', 'BOOLEAN', true],
  ['compact_metadata', 'JSON', true],
  ['status', 'JSON', true],
  ['attributes', 'JSON', true],
  ['raw_frame', 'JSON', true],
  ['date', 'STRING', false],
]

test('ai_gateway_messages schema exposes the gateway message columns', () => {
  assert.deepEqual(
    AI_GATEWAY_SCHEMA_COLUMNS.map((column) => [column.name, column.type, column.nullable]),
    EXPECTED_COLUMNS,
  )
})

test('projectExchange returns zero rows when no projector is registered', async () => {
  const projector = createAiGatewayMessageProjector({ gatewayId: 'gw-test', projectors: [] })
  const rows = await projector.projectExchange(exchange())
  assert.equal(rows.length, 0)
})

test('projectExchange returns zero rows when no projector matches', async () => {
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [registered('never', { match: () => false, project: () => undefined })],
  })
  const rows = await projector.projectExchange(exchange())
  assert.equal(rows.length, 0)
})

test('first successful projector wins, sorted by descending priority then registration order', async () => {
  /** @type {string[]} */
  const calls = []
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [
      registered('low', {
        priority: 0,
        project: () => {
          calls.push('low')
          return projection('low')
        },
      }),
      registered('high', {
        priority: 5,
        project: () => {
          calls.push('high')
          return projection('high')
        },
      }),
      registered('higher-but-late', {
        priority: 5,
        project: () => {
          calls.push('higher-but-late')
          return projection('higher-but-late')
        },
      }),
    ],
  })
  const rows = await projector.projectExchange(exchange())
  assert.deepEqual(calls, ['high'])
  assert.ok(rows.length > 0)
  assert.equal(rows[0].provider, 'high')
})

test('throwing projectors are skipped and the next matching projector wins', async () => {
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [
      registered('boom', {
        priority: 10,
        project: () => { throw new Error('boom') },
      }),
      registered('ok', {
        priority: 5,
        project: () => projection('ok'),
      }),
    ],
  })
  const rows = await projector.projectExchange(exchange())
  assert.ok(rows.length > 0)
  assert.equal(rows[0].provider, 'ok')
})

test('projector returning undefined or an empty messages array is skipped', async () => {
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [
      registered('undefined', { priority: 20, project: () => undefined }),
      registered('empty', { priority: 10, project: () => ({ provider: 'empty', conversation_id: 'c', messages: [] }) }),
      registered('ok', { priority: 5, project: () => projection('ok') }),
    ],
  })
  const rows = await projector.projectExchange(exchange())
  assert.ok(rows.length > 0)
  assert.equal(rows[0].provider, 'ok')
})

test('projector returning an invalid shape is skipped and the next one is tried', async () => {
  /** @type {Array<{ level: string, message: string, fields: Record<string, unknown> }>} */
  const logs = []
  const log = collectingLogger(logs)
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [
      registered('bad-shape', {
        priority: 20,
        project: () => /** @type {any} */ ({ provider: '', conversation_id: 'c', messages: [] }),
      }),
      registered('ok', { priority: 5, project: () => projection('ok') }),
    ],
    log,
  })
  const rows = await projector.projectExchange(exchange())
  assert.ok(rows.length > 0)
  assert.equal(rows[0].provider, 'ok')
  assert.ok(
    logs.some((entry) => entry.level === 'warn' && entry.message === 'aigw.projector_invalid_output'),
    'invalid-output projector should produce an aigw.projector_invalid_output warn',
  )
})

test('all projectors failing returns zero rows and warns once per failure', async () => {
  /** @type {Array<{ level: string, message: string, fields: Record<string, unknown> }>} */
  const logs = []
  const log = collectingLogger(logs)
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [
      registered('throws', { priority: 30, project: () => { throw new Error('boom') } }),
      registered('returns-invalid', {
        priority: 20,
        project: () => /** @type {any} */ ({ not: 'a projection' }),
      }),
      registered('returns-undefined', { priority: 10, project: () => undefined }),
    ],
    log,
  })
  const rows = await projector.projectExchange(exchange())
  assert.equal(rows.length, 0, 'no rows when every projector fails')
  const warnings = logs.filter((entry) => entry.level === 'warn').map((entry) => entry.message)
  assert.ok(warnings.includes('aigw.projector_error'), 'throwing projector logs aigw.projector_error')
  assert.ok(warnings.includes('aigw.projector_invalid_output'), 'invalid-shape projector logs aigw.projector_invalid_output')
  assert.ok(
    warnings.includes('aigw.message_projection_skipped'),
    'dispatcher logs aigw.message_projection_skipped when no projector succeeds',
  )
})

test('skipping a non-matching projector does not call its project()', async () => {
  let projectCalls = 0
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [
      registered('mismatch', {
        priority: 50,
        match: () => false,
        project: () => { projectCalls++; return projection('mismatch') },
      }),
      registered('ok', { priority: 5, project: () => projection('ok') }),
    ],
  })
  const rows = await projector.projectExchange(exchange())
  assert.ok(rows.length > 0)
  assert.equal(rows[0].provider, 'ok')
  assert.equal(projectCalls, 0)
})

test('projector-supplied message_id and previous_message_id are preserved', async () => {
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [
      registered('native', {
        project: () => ({
          provider: 'native',
          conversation_id: 'conv-1',
          messages: [
            { role: 'user', content: 'hi', message_id: 'msg-root', previous_message_id: [] },
            { role: 'assistant', content: 'ok', message_id: 'msg-2', previous_message_id: ['msg-root'] },
          ],
        }),
      }),
    ],
  })
  const rows = await projector.projectExchange(exchange())
  assert.equal(rows.length, 2)
  assert.equal(rows[0].message_id, 'msg-root')
  assert.deepEqual(rows[0].previous_message_id, [])
  assert.equal(rows[1].message_id, 'msg-2')
  assert.deepEqual(rows[1].previous_message_id, ['msg-root'])
  assert.equal(
    isPlainObject(rows[0].attributes) && isPlainObject(rows[0].attributes.gateway)
      ? rows[0].attributes.gateway.identity_source
      : undefined,
    undefined,
    'identity_source must NOT be stamped when the projector supplied a message_id'
  )
})

test('fallback identity stamps gateway.identity_source and a linear previous_message_id chain', async () => {
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [
      registered('partial', {
        project: () => ({
          provider: 'partial',
          conversation_id: 'conv-fallback',
          messages: [
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'second' },
          ],
        }),
      }),
    ],
  })
  const rows = await projector.projectExchange(exchange())
  assert.equal(rows.length, 2)
  assert.ok(rows.every((row) => typeof row.message_id === 'string' && row.message_id.length > 0))
  assert.deepEqual(rows[0].previous_message_id, [])
  assert.deepEqual(rows[1].previous_message_id, [rows[0].message_id])
  for (const row of rows) {
    assert.equal(
      isPlainObject(row.attributes) && isPlainObject(row.attributes.gateway)
        ? row.attributes.gateway.identity_source
        : undefined,
      'gateway_fallback',
      'fallback rows must mark attributes.gateway.identity_source'
    )
  }
})

test('attributes.gateway carries exchange provenance and dev_run_id', async () => {
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-fixed',
    projectors: [registered('any', { project: () => projection('any') })],
  })
  const rows = await projector.projectExchange(exchange())
  assert.ok(rows.length > 0)
  const attrs = rows[0].attributes
  assert.ok(isPlainObject(attrs))
  assert.equal(attrs.dev_run_id, 'run-1')
  const gateway = isPlainObject(attrs.gateway) ? attrs.gateway : undefined
  assert.ok(gateway)
  assert.equal(gateway.exchange_id, 'ex-1')
  assert.equal(gateway.upstream, 'echo')
  assert.equal(gateway.path, '/v1/echo')
  assert.equal(gateway.status_code, 200)
  assert.equal(gateway.is_sse, false)
  assert.equal(rows[0].gateway_id, 'gw-fixed')
})

test('row output is stripped to the schema (no extra fields leak)', async () => {
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [registered('any', { project: () => projection('any') })],
  })
  const rows = await projector.projectExchange(exchange())
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      assert.ok(
        AI_GATEWAY_SCHEMA_COLUMNS.some((col) => col.name === key),
        `unexpected row key not in schema: ${key}`
      )
    }
  }
})

/**
 * @param {string} provider
 */
function projection(provider) {
  return {
    provider,
    conversation_id: `${provider}-conv`,
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'ok' },
    ],
  }
}

/**
 * @param {string} name
 * @param {{
 *   priority?: number,
 *   match?: (input: AiGatewayExchangeInput) => boolean,
 *   project: (input: AiGatewayExchangeInput, ctx: AiGatewayExchangeProjectorContext) => AiGatewayProjectedExchange | Promise<AiGatewayProjectedExchange | undefined> | undefined,
 * }} body
 */
function registered(name, body) {
  return {
    name,
    priority: body.priority,
    match: body.match ?? (() => true),
    project: body.project,
    _seq: 0,
  }
}

function exchange(overrides = {}) {
  return {
    exchange_id: 'ex-1',
    ts_start: '2026-05-20T10:00:00.000Z',
    ts_end: '2026-05-20T10:00:00.250Z',
    duration_ms: 250,
    upstream: 'echo',
    provider: null,
    method: 'POST',
    path: '/v1/echo',
    status_code: 200,
    request_bytes: 10,
    response_bytes: 20,
    is_sse: false,
    stream_event_count: 0,
    request_headers: JSON.stringify({ 'x-hyp-dev-run-id': 'run-1' }),
    request_body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    response_headers: JSON.stringify({ 'content-type': 'application/json' }),
    response_body: JSON.stringify({ role: 'assistant', content: 'ok' }),
    error: null,
    metadata: JSON.stringify({ dev_run_id: 'run-1' }),
    stream_events: [],
    ...overrides,
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {Array<{ level: string, message: string, fields: Record<string, unknown> }>} sink
 */
function collectingLogger(sink) {
  /** @param {string} level */
  const make = (level) => (
    /** @type {string} */ message,
    /** @type {Record<string, unknown>=} */ fields,
  ) => {
    sink.push({ level, message, fields: fields ?? {} })
  }
  return {
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
  }
}
