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
  assert.deepEqual(rows[0].previous_message_id, [])
  assert.equal(rows[1].role, 'assistant')
  assert.equal(rows[1].content_text, 'hi there')
  assert.deepEqual(rows[1].previous_message_id, [rows[0].message_id])
  assert.deepEqual(rows[1].status, { finish_reason: 'stop' })
  assert.equal(rows[1].attributes.usage.input_tokens, 4)
  assert.equal(rows[1].attributes.dev_run_id, 'run-1')
  assert.equal(rows[1].attributes.gateway.status_code, 200)
  assert.equal(rows[1].date, '2026-05-20')
  assert.equal(Object.hasOwn(rows[0], 'metadata'), false)
})

test('previous_message_id is an ordered array of all prior message ids', async () => {
  const projector = createAiGatewayMessageProjector({ gatewayId: 'gw-test' })
  const rows = await projector.projectExchange(exchange({
    provider: 'anthropic',
    path: '/v1/messages',
    request_body: {
      model: 'claude-test',
      metadata: { user_id: JSON.stringify({ session_id: 'sess-previous' }) },
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'second' },
        { role: 'user', content: 'third' },
      ],
    },
    response_body: {
      role: 'assistant',
      content: [{ type: 'text', text: 'fourth' }],
      stop_reason: 'end_turn',
    },
  }))

  assert.equal(rows.length, 4)
  assert.deepEqual(rows.map((row) => row.previous_message_id), [
    [],
    [rows[0].message_id],
    [rows[0].message_id, rows[1].message_id],
    [rows[0].message_id, rows[1].message_id, rows[2].message_id],
  ])
})

test('previous_message_id carries conversation history across exchanges', async () => {
  const projector = createAiGatewayMessageProjector({ gatewayId: 'gw-test' })
  const firstRows = await projector.projectExchange(exchange({
    provider: 'anthropic',
    path: '/v1/messages',
    request_body: {
      model: 'claude-test',
      metadata: { user_id: JSON.stringify({ session_id: 'sess-history' }) },
      messages: [{ role: 'user', content: 'first' }],
    },
    response_body: {
      role: 'assistant',
      content: [{ type: 'text', text: 'second' }],
      stop_reason: 'end_turn',
    },
  }))
  const nextRows = await projector.projectExchange(exchange({
    provider: 'anthropic',
    path: '/v1/messages',
    request_body: {
      model: 'claude-test',
      metadata: { user_id: JSON.stringify({ session_id: 'sess-history' }) },
      messages: [{ role: 'user', content: 'third' }],
    },
    response_body: {
      role: 'assistant',
      content: [{ type: 'text', text: 'fourth' }],
      stop_reason: 'end_turn',
    },
  }))

  assert.equal(firstRows.length, 2)
  assert.equal(nextRows.length, 2)
  assert.deepEqual(nextRows.map((row) => row.previous_message_id), [
    [firstRows[0].message_id, firstRows[1].message_id],
    [firstRows[0].message_id, firstRows[1].message_id, nextRows[0].message_id],
  ])
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

test('projects Codex turn metadata from ChatGPT gateway headers', async () => {
  const projector = createAiGatewayMessageProjector({ gatewayId: 'gw-test' })
  const turnMetadata = {
    session_id: 'codex-session-1',
    thread_id: 'codex-thread-1',
    thread_source: 'user',
    turn_id: 'codex-turn-1',
    workspaces: {
      '/Users/phil/workspace/hypaware': {
        associated_remote_urls: { origin: 'https://github.com/hyparam/hypaware.git' },
        latest_git_commit_hash: '072b240f2c82e15de26022a8b9bb29e13be826a9',
        has_changes: true,
      },
    },
    sandbox: 'seatbelt',
    turn_started_at_unix_ms: 1779476507669,
  }
  const rows = await projector.projectExchange(exchange({
    provider: 'chatgpt',
    path: '/backend-api/codex/responses',
    request_headers: {
      'thread-id': 'codex-thread-header',
      'session-id': 'codex-session-header',
      'x-client-request-id': 'client-request-1',
      originator: 'Codex Desktop',
      'user-agent': 'Codex Desktop/0.133.0-alpha.1',
      'x-codex-window-id': 'window-1',
      'x-codex-turn-metadata': JSON.stringify(turnMetadata),
    },
    request_body: {
      model: 'gpt-5-codex',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'help refactor' }] }],
      stream: false,
    },
    response_headers: {
      'x-oai-request-id': 'oai-request-1',
    },
    response_body: {
      output_text: 'ok',
      usage: { input_tokens: 8, output_tokens: 1 },
    },
  }))

  assert.equal(rows.length, 2)
  assert.ok(rows.every((row) => row.provider === 'chatgpt'))
  assert.ok(rows.every((row) => row.conversation_id === 'codex-thread-1'))
  assert.ok(rows.every((row) => row.cwd === '/Users/phil/workspace/hypaware'))
  assert.ok(rows.every((row) => row.git_branch === undefined))
  assert.ok(rows.every((row) => row.client_version === '0.133.0-alpha.1'))
  assert.ok(rows.every((row) => row.entrypoint === 'Codex Desktop'))
  assert.ok(rows.every((row) => row.user_type === 'user'))
  assert.ok(rows.every((row) => row.permission_mode === 'seatbelt'))
  assert.ok(rows.every((row) => row.is_sidechain === false))
  assert.ok(rows.every((row) => row.request_id === 'oai-request-1'))
  assert.ok(rows.every((row) => row.prompt_id === 'codex-turn-1'))
  assert.equal(rows[0].attributes.codex.thread_id, 'codex-thread-1')
  assert.equal(rows[0].attributes.codex.session_id, 'codex-session-1')
  assert.equal(rows[0].attributes.codex.turn_id, 'codex-turn-1')
  assert.equal(rows[0].attributes.codex.thread_source, 'user')
  assert.equal(rows[0].attributes.codex.originator, 'Codex Desktop')
  assert.equal(rows[0].attributes.codex.window_id, 'window-1')
  assert.equal(rows[0].attributes.codex.sandbox, 'seatbelt')
  assert.equal(rows[0].attributes.codex.turn_started_at_unix_ms, 1779476507669)
  assert.equal(rows[0].attributes.codex.workspace, '/Users/phil/workspace/hypaware')
  assert.equal(rows[0].attributes.codex.git_origin_url, 'https://github.com/hyparam/hypaware.git')
  assert.equal(rows[0].attributes.codex.git_commit, '072b240f2c82e15de26022a8b9bb29e13be826a9')
  assert.equal(rows[0].attributes.codex.has_changes, true)
})

test('marks Codex subagent turns as sidechain rows without workspace metadata', async () => {
  const projector = createAiGatewayMessageProjector({ gatewayId: 'gw-test' })
  const rows = await projector.projectExchange(exchange({
    provider: 'chatgpt',
    path: '/backend-api/codex/responses',
    request_headers: {
      'thread-id': 'subagent-thread-header',
      'session-id': 'subagent-session-header',
      originator: 'Codex Desktop',
      'user-agent': 'Codex Desktop/0.133.0-alpha.1',
      'x-codex-turn-metadata': JSON.stringify({
        session_id: 'subagent-session-1',
        thread_id: 'subagent-thread-1',
        thread_source: 'subagent',
        turn_id: 'subagent-turn-1',
        sandbox: 'seatbelt',
      }),
    },
    request_body: {
      model: 'gpt-5-codex',
      input: [{ role: 'user', content: 'check status' }],
    },
    response_body: { output_text: 'ok' },
  }))

  assert.equal(rows.length, 2)
  assert.ok(rows.every((row) => row.conversation_id === 'subagent-thread-1'))
  assert.ok(rows.every((row) => row.cwd === undefined))
  assert.ok(rows.every((row) => row.is_sidechain === true))
  assert.ok(rows.every((row) => row.prompt_id === 'subagent-turn-1'))
})

test('falls back to Codex header identifiers when turn metadata is invalid', async () => {
  const projector = createAiGatewayMessageProjector({ gatewayId: 'gw-test' })
  const rows = await projector.projectExchange(exchange({
    provider: 'chatgpt',
    path: '/backend-api/codex/responses',
    request_headers: {
      'thread-id': 'fallback-thread',
      'session-id': 'fallback-session',
      'x-client-request-id': 'client-request-fallback',
      originator: 'Codex Desktop',
      'user-agent': 'Codex Desktop/0.133.0-alpha.1',
      'x-codex-turn-metadata': '{',
    },
    request_body: {
      model: 'gpt-5-codex',
      input: [{ role: 'user', content: 'hello' }],
    },
    response_body: { output_text: 'ok' },
  }))

  assert.equal(rows.length, 2)
  assert.ok(rows.every((row) => row.conversation_id === 'fallback-thread'))
  assert.ok(rows.every((row) => row.request_id === 'client-request-fallback'))
  assert.ok(rows.every((row) => row.prompt_id === undefined))
  assert.equal(rows[0].attributes.codex.thread_id, 'fallback-thread')
  assert.equal(rows[0].attributes.codex.session_id, 'fallback-session')
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
    request_headers: JSON.stringify({ 'x-hyp-dev-run-id': 'run-1', ...(overrides.request_headers ?? {}) }),
    request_body: JSON.stringify(overrides.request_body),
    response_headers: JSON.stringify({ 'content-type': 'application/json', ...(overrides.response_headers ?? {}) }),
    response_body: overrides.response_body === null ? null : JSON.stringify(overrides.response_body),
    error: null,
    metadata: JSON.stringify({ dev_run_id: 'run-1' }),
    stream_events: overrides.stream_events ?? [],
  }
}
