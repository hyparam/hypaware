import assert from 'node:assert/strict'
import test from 'node:test'

import { AI_GATEWAY_SCHEMA_COLUMNS } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import { createAiGatewayMessageProjector } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'

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
  ['previous_message_id', 'STRING', true],
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

test('ai_gateway_messages schema exactly matches proxy_messages columns', () => {
  assert.deepEqual(
    AI_GATEWAY_SCHEMA_COLUMNS.map((column) => [column.name, column.type, column.nullable]),
    EXPECTED_COLUMNS,
  )
})

test('projects Anthropic exchanges into proxy-compatible message part rows', async () => {
  const projector = createAiGatewayMessageProjector({ gatewayId: 'gw-test' })
  const rows = await projector.projectExchange(exchange({
    provider: 'anthropic',
    path: '/v1/messages',
    request_body: {
      model: 'claude-test',
      metadata: { user_id: JSON.stringify({ session_id: 'sess-1', account_uuid: 'acct-1' }) },
      messages: [{ role: 'user', content: 'hello' }],
    },
    response_body: {
      role: 'assistant',
      content: [{ type: 'text', text: 'hi there' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 4, output_tokens: 2 },
    },
  }))

  assert.equal(rows.length, 2)
  assert.equal(rows[0].gateway_id, 'gw-test')
  assert.equal(rows[0].conversation_id, 'sess-1')
  assert.equal(rows[0].user_id, 'acct-1')
  assert.equal(rows[0].role, 'user')
  assert.equal(rows[0].part_type, 'text')
  assert.equal(rows[0].content_text, 'hello')
  assert.equal(rows[1].role, 'assistant')
  assert.equal(rows[1].content_text, 'hi there')
  assert.deepEqual(rows[1].status, { finish_reason: 'stop' })
  assert.equal(rows[1].attributes.usage.input_tokens, 4)
  assert.equal(rows[1].attributes.dev_run_id, 'run-1')
  assert.equal(rows[1].attributes.gateway.status_code, 200)
  assert.equal(rows[1].date, '2026-05-20')
  assert.equal(Object.hasOwn(rows[0], 'metadata'), false)
})

test('projects OpenAI chat completions into the same role and part columns', async () => {
  const projector = createAiGatewayMessageProjector({ gatewayId: 'gw-test' })
  const rows = await projector.projectExchange(exchange({
    provider: 'openai',
    path: '/v1/chat/completions',
    request_body: {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
    },
    response_body: {
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    },
  }))

  assert.equal(rows.length, 2)
  assert.equal(rows[0].provider, 'openai')
  assert.equal(rows[0].model, 'gpt-test')
  assert.equal(rows[0].role, 'user')
  assert.equal(rows[1].role, 'assistant')
  assert.equal(rows[1].content_text, 'ok')
  assert.deepEqual(rows[1].status, { finish_reason: 'stop' })
})

test('reconstructs OpenAI Responses SSE text into an assistant part row', async () => {
  const projector = createAiGatewayMessageProjector({ gatewayId: 'gw-test' })
  const rows = await projector.projectExchange(exchange({
    provider: 'openai',
    path: '/v1/responses',
    is_sse: true,
    request_body: {
      model: 'gpt-5-codex',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'help' }] }],
      stream: true,
    },
    response_body: null,
    stream_events: [
      { kind: 'stream_event', exchange_id: 'ex-1', t_ms: 1, event: 'response.output_text.delta', data: '{"type":"response.output_text.delta","delta":"o"}' },
      { kind: 'stream_event', exchange_id: 'ex-1', t_ms: 2, event: 'response.output_text.delta', data: '{"type":"response.output_text.delta","delta":"k"}' },
      { kind: 'stream_event', exchange_id: 'ex-1', t_ms: 3, event: 'response.completed', data: '{"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":1}}}' },
    ],
  }))

  assert.equal(rows.length, 2)
  assert.equal(rows[0].content_text, 'help')
  assert.equal(rows[1].role, 'assistant')
  assert.equal(rows[1].content_text, 'ok')
  assert.equal(rows[1].attributes.usage.input_tokens, 3)
  assert.equal(rows[1].attributes.gateway.is_sse, true)
})

test('applies enrichers before stripping non-schema draft fields', async () => {
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    enrichers: [{
      name: 'test',
      enrich(row) {
        return { ...row, provider_uuid: 'uuid-1', internal_only: 'drop-me' }
      },
    }],
  })
  const rows = await projector.projectExchange(exchange({
    request_body: { messages: [{ role: 'user', content: 'hello' }] },
    response_body: null,
  }))

  assert.equal(rows[0].provider_uuid, 'uuid-1')
  assert.equal(Object.hasOwn(rows[0], 'internal_only'), false)
  assert.equal(Object.hasOwn(rows[0], 'content'), false)
  assert.equal(Object.hasOwn(rows[0], 'session_id'), false)
})

function exchange(overrides = {}) {
  return {
    exchange_id: 'ex-1',
    ts_start: '2026-05-20T10:00:00.000Z',
    ts_end: '2026-05-20T10:00:00.250Z',
    duration_ms: 250,
    upstream: overrides.provider ?? 'anthropic',
    provider: overrides.provider ?? 'anthropic',
    method: 'POST',
    path: overrides.path ?? '/v1/messages',
    status_code: 200,
    request_bytes: 10,
    response_bytes: 20,
    is_sse: overrides.is_sse ?? false,
    stream_event_count: overrides.stream_events?.length ?? 0,
    request_headers: JSON.stringify({ 'x-hyp-dev-run-id': 'run-1' }),
    request_body: JSON.stringify(overrides.request_body),
    response_headers: JSON.stringify({ 'content-type': 'application/json' }),
    response_body: overrides.response_body === null ? null : JSON.stringify(overrides.response_body),
    error: null,
    metadata: JSON.stringify({ dev_run_id: 'run-1' }),
    stream_events: overrides.stream_events ?? [],
  }
}
