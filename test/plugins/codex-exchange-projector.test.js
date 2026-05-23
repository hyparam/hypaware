// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createCodexExchangeProjector,
} from '../../hypaware-core/plugins-workspace/codex/src/exchange-projector.js'

test('match() accepts the three transports it owns and rejects others', () => {
  const projector = createCodexExchangeProjector({ env: {} })
  assert.equal(projector.match(exchange({ path: '/v1/chat/completions' })), true)
  assert.equal(projector.match(exchange({ path: '/v1/responses' })), true)
  assert.equal(projector.match(exchange({ path: '/backend-api/codex/responses' })), true)
  assert.equal(projector.match(exchange({ path: '/backend-api/codex/models' })), true)
  assert.equal(projector.match(exchange({ path: '/v1/messages' })), false)
  assert.equal(projector.match(exchange({ path: '/v1/foo' })), false)
})

test('match() also accepts non-codex paths tagged with x-codex-turn-metadata', () => {
  const projector = createCodexExchangeProjector({ env: {} })
  assert.equal(
    projector.match(exchange({
      path: '/v1/foo',
      request_headers: JSON.stringify({ 'x-codex-turn-metadata': '{}' }),
    })),
    true
  )
})

test('OpenAI Chat projection: request+response messages roll up into user+assistant', () => {
  const projector = createCodexExchangeProjector({ env: {} })
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/v1/chat/completions',
    provider: 'openai',
    request_body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    }),
    response_body: JSON.stringify({
      choices: [{
        message: { role: 'assistant', content: 'ok' },
        finish_reason: 'stop',
      }],
    }),
  }), context()))

  assert.equal(projection.provider, 'openai')
  assert.equal(projection.model, 'gpt-4o-mini')
  assert.equal(projection.conversation_source, 'api')
  assert.deepEqual(
    projection.messages.map((/** @type {any} */ m) => m.role),
    ['user', 'assistant']
  )
  assert.deepEqual(projection.messages[0].content, [{ type: 'text', text: 'hi' }])
  assert.deepEqual(projection.messages[1].content, [{ type: 'text', text: 'ok' }])
})

test('OpenAI Chat tool messages map to tool_result blocks', () => {
  const projector = createCodexExchangeProjector({ env: {} })
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/v1/chat/completions',
    request_body: JSON.stringify({
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"key":"a"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'value-a' },
      ],
    }),
    response_body: JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'final' }, finish_reason: 'stop' }],
    }),
  }), context()))

  const toolCall = projection.messages[0].content[0]
  assert.equal(toolCall.type, 'tool_use')
  assert.equal(toolCall.id, 'call_1')
  assert.equal(toolCall.name, 'lookup')
  assert.deepEqual(toolCall.input, { key: 'a' })
  const toolResult = projection.messages[1].content[0]
  assert.equal(toolResult.type, 'tool_result')
  assert.equal(toolResult.tool_use_id, 'call_1')
  assert.equal(toolResult.content, 'value-a')
})

test('OpenAI Responses with output_text in the body produces an assistant message', () => {
  const projector = createCodexExchangeProjector({ env: {} })
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/v1/responses',
    provider: 'openai',
    request_body: JSON.stringify({
      model: 'gpt-5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'how' }] }],
    }),
    response_body: JSON.stringify({ id: 'resp_1', output_text: 'because' }),
  }), context()))

  assert.deepEqual(projection.messages.map((/** @type {any} */ m) => m.role), ['user', 'assistant'])
  assert.deepEqual(projection.messages[1].content, [{ type: 'text', text: 'because' }])
})

test('OpenAI Responses SSE deltas reconstruct the assistant body', () => {
  const projector = createCodexExchangeProjector({ env: {} })
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/v1/responses',
    is_sse: true,
    stream_event_count: 3,
    request_body: JSON.stringify({
      model: 'gpt-5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'why' }] }],
    }),
    response_body: '',
    stream_events: [
      { kind: 'stream_event', exchange_id: 'ex-1', t_ms: 0, event: 'response.created', data: JSON.stringify({ id: 'resp_2', type: 'response.created' }) },
      { kind: 'stream_event', exchange_id: 'ex-1', t_ms: 5, event: 'response.output_text.delta', data: JSON.stringify({ type: 'response.output_text.delta', delta: 'be' }) },
      { kind: 'stream_event', exchange_id: 'ex-1', t_ms: 6, event: 'response.output_text.delta', data: JSON.stringify({ type: 'response.output_text.delta', delta: 'cause' }) },
      { kind: 'stream_event', exchange_id: 'ex-1', t_ms: 9, event: 'response.completed', data: JSON.stringify({ type: 'response.completed', id: 'resp_2', status: 'completed' }) },
    ],
  }), context()))

  assert.equal(projection.messages.length, 2)
  assert.deepEqual(projection.messages[1].content, [{ type: 'text', text: 'because' }])
  assert.deepEqual(projection.messages[1].raw_frame, { response_id: 'resp_2' })
})

test('Codex turn metadata + headers project into first-class columns and codex.* attributes', () => {
  const projector = createCodexExchangeProjector({ env: {} })
  const workspace = '/home/me/workspace'
  const turnMetadata = {
    session_id: 'session-x',
    thread_id: 'thread-x',
    thread_source: 'user',
    turn_id: 'turn-x',
    workspaces: {
      [workspace]: {
        associated_remote_urls: { origin: 'git@github.com:acme/repo.git' },
        latest_git_commit_hash: 'abc123',
        has_changes: true,
      },
    },
    sandbox: 'seatbelt',
    turn_started_at_unix_ms: 1779476507669,
  }
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    is_sse: true,
    request_headers: JSON.stringify({
      'thread-id': 'thread-x',
      'session-id': 'session-x',
      originator: 'Codex Desktop',
      'user-agent': 'Codex Desktop/1.2.3',
      'x-codex-window-id': 'window-x',
      'x-codex-turn-metadata': JSON.stringify(turnMetadata),
      'x-client-request-id': 'client-req-x',
    }),
    response_headers: JSON.stringify({ 'x-oai-request-id': 'oai-req-x' }),
    request_body: JSON.stringify({
      model: 'gpt-5-codex',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'go' }] }],
    }),
    response_body: '',
    stream_events: [
      { kind: 'stream_event', exchange_id: 'ex-1', t_ms: 0, event: 'response.completed', data: JSON.stringify({ type: 'response.completed', id: 'resp_x', output_text: 'done' }) },
    ],
  }), context()))

  assert.equal(projection.provider, 'chatgpt')
  assert.equal(projection.conversation_id, 'thread-x')
  assert.equal(projection.conversation_source, 'codex')
  assert.equal(projection.cwd, workspace)
  assert.equal(projection.client_version, '1.2.3')
  assert.equal(projection.client_name, 'codex')
  assert.equal(projection.entrypoint, 'Codex Desktop')
  assert.equal(projection.user_type, 'user')
  assert.equal(projection.permission_mode, 'seatbelt')
  assert.equal(projection.is_sidechain, false)
  assert.equal(projection.request_id, 'oai-req-x')
  assert.equal(projection.prompt_id, 'turn-x')

  assert.equal(projection.attributes.codex.thread_id, 'thread-x')
  assert.equal(projection.attributes.codex.session_id, 'session-x')
  assert.equal(projection.attributes.codex.turn_id, 'turn-x')
  assert.equal(projection.attributes.codex.workspace, workspace)
  assert.equal(projection.attributes.codex.git_origin_url, 'git@github.com:acme/repo.git')
  assert.equal(projection.attributes.codex.git_commit, 'abc123')
  assert.equal(projection.attributes.codex.has_changes, true)
  assert.equal(projection.attributes.codex.sandbox, 'seatbelt')
  assert.equal(projection.attributes.codex.identity_source, 'gateway_fallback')
})

test('thread_source=subagent flips is_sidechain to true', () => {
  const projector = createCodexExchangeProjector({ env: {} })
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    request_headers: JSON.stringify({
      'x-codex-turn-metadata': JSON.stringify({ thread_source: 'subagent', workspaces: { '/w': {} } }),
    }),
    request_body: JSON.stringify({
      model: 'gpt-5-codex',
      input: 'go',
    }),
    response_body: JSON.stringify({ output_text: 'done' }),
  }), context()))

  assert.equal(projection.is_sidechain, true)
  assert.equal(projection.user_type, 'subagent')
})

test('Codex workspace selection prefers recorded cwd over first metadata key', () => {
  const projector = createCodexExchangeProjector({ env: {} })
  const actualWorkspace = '/home/me/actual'
  const turnMetadata = {
    thread_id: 'thread-x',
    workspaces: {
      '/home/me/other': {
        associated_remote_urls: { origin: 'git@github.com:acme/other.git' },
      },
      [actualWorkspace]: {
        associated_remote_urls: { origin: 'git@github.com:acme/actual.git' },
        latest_git_commit_hash: 'abc123',
      },
    },
  }

  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    request_headers: JSON.stringify({
      'x-codex-turn-metadata': JSON.stringify(turnMetadata),
    }),
    request_body: JSON.stringify({
      cwd: actualWorkspace,
      input: 'go',
    }),
    response_body: JSON.stringify({ output_text: 'done' }),
  }), context()))

  assert.equal(projection.cwd, actualWorkspace)
  assert.equal(projection.attributes.codex.workspace, actualWorkspace)
  assert.equal(projection.attributes.codex.git_origin_url, 'git@github.com:acme/actual.git')
})

test('non-codex provider has no codex turn metadata but still stamps identity_source for symmetry', () => {
  const projector = createCodexExchangeProjector({ env: {} })
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/v1/chat/completions',
    provider: 'openai',
    request_body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    response_body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
  }), context()))

  // No codex context: cwd/client_name/etc. stay unset.
  assert.equal(projection.cwd, undefined)
  assert.equal(projection.client_name, undefined)
  assert.equal(projection.prompt_id, undefined)
  assert.equal(projection.user_type, undefined)
  // But the projector still stamps identity_source so downstream
  // queries can rely on it being present whenever this projector ran.
  assert.deepEqual(projection.attributes, { codex: { identity_source: 'gateway_fallback' } })
})

test('project() returns undefined when the request body is missing or malformed', () => {
  const projector = createCodexExchangeProjector({ env: {} })
  assert.equal(projector.project(exchange({ request_body: null }), context()), undefined)
  assert.equal(projector.project(exchange({ request_body: 'not-json' }), context()), undefined)
  assert.equal(projector.project(exchange({ request_body: '[]' }), context()), undefined)
})

test('project() returns undefined when no messages can be extracted', () => {
  const projector = createCodexExchangeProjector({ env: {} })
  // request body parses but has no messages / input
  assert.equal(
    projector.project(exchange({
      path: '/v1/chat/completions',
      request_body: JSON.stringify({ model: 'gpt-4o-mini' }),
    }), context()),
    undefined
  )
})

test('log readers stay no-op without HYPAWARE_CODEX_SQLITE_READS=1', () => {
  let called = false
  const projector = createCodexExchangeProjector({
    env: {},
    logReaders: [{ name: 'fake', read: () => { called = true; return { codex_sqlite: { ok: true } } } }],
  })
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/v1/chat/completions',
    request_body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    response_body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
  }), context()))
  assert.equal(called, false)
  // identity_source still stamped, but no codex_sqlite augmentation arrives.
  assert.equal(projection.attributes.codex_sqlite, undefined)
})

test('log readers activate when HYPAWARE_CODEX_SQLITE_READS=1 and merge alongside codex.*', () => {
  const projector = createCodexExchangeProjector({
    env: { HYPAWARE_CODEX_SQLITE_READS: '1' },
    logReaders: [{ name: 'fake', read: () => ({ codex_sqlite: { ok: true } }) }],
  })
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/v1/chat/completions',
    request_body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    response_body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
  }), context()))
  assert.deepEqual(projection.attributes, {
    codex: { identity_source: 'gateway_fallback' },
    codex_sqlite: { ok: true },
  })
})

test('conversation_id falls back to a stable hash when no codex metadata or session id is present', () => {
  const projector = createCodexExchangeProjector({ env: {} })
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/v1/chat/completions',
    request_body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    response_body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
  }), context()))
  // sha256("hi") first 16 chars
  assert.equal(projection.conversation_id.length, 16)
  // Determinism: same input → same conversation_id
  const repeat = /** @type {any} */ (projector.project(exchange({
    path: '/v1/chat/completions',
    request_body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    response_body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
  }), context()))
  assert.equal(projection.conversation_id, repeat.conversation_id)
})

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

/** @param {Record<string, unknown>} overrides */
function exchange(overrides = {}) {
  return /** @type {any} */ ({
    exchange_id: 'ex-1',
    ts_start: '2026-05-20T10:00:00.000Z',
    ts_end: '2026-05-20T10:00:00.250Z',
    duration_ms: 250,
    upstream: 'local',
    provider: null,
    method: 'POST',
    path: '/v1/chat/completions',
    status_code: 200,
    request_bytes: 50,
    response_bytes: 100,
    is_sse: false,
    stream_event_count: 0,
    request_headers: JSON.stringify({}),
    request_body: '',
    response_headers: JSON.stringify({}),
    response_body: '',
    error: null,
    metadata: '',
    stream_events: [],
    ...overrides,
  })
}

function context() {
  return { log: { debug() {}, info() {}, warn() {}, error() {} } }
}
