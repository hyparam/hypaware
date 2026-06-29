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

test('OpenAI Chat projection normalizes usage onto the assistant response', () => {
  const projector = createCodexExchangeProjector({ env: {} })
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/v1/chat/completions',
    provider: 'openai',
    request_body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    }),
    response_body: JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 5,
        total_tokens: 17,
        prompt_tokens_details: { cached_tokens: 7, audio_tokens: 2 },
        completion_tokens_details: {
          reasoning_tokens: 3,
          accepted_prediction_tokens: 1,
          rejected_prediction_tokens: 4,
        },
      },
    }),
  }), context()))

  assert.deepEqual(projection.messages[1].attributes, {
    usage: {
      // input_tokens is stored NET of cache (12 gross − 7 cached = 5); the
      // 7 cached reads ride cache_read_tokens, so net + cache_read + output
      // (5 + 7 + 5) reconciles to total_tokens 17. @ref LLP 0035#net-input
      input_tokens: 5,
      output_tokens: 5,
      total_tokens: 17,
      cache_read_tokens: 7,
      input_audio_tokens: 2,
      reasoning_tokens: 3,
      accepted_prediction_tokens: 1,
      rejected_prediction_tokens: 4,
    },
  })
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

test('OpenAI Responses body usage is normalized onto one assistant response item', () => {
  const projector = createCodexExchangeProjector({ env: {} })
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/v1/responses',
    provider: 'openai',
    request_body: JSON.stringify({
      model: 'gpt-5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'list files' }] }],
    }),
    response_body: JSON.stringify({
      id: 'resp_3',
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'on it' }] },
        { type: 'function_call', call_id: 'call_42', name: 'exec_command', arguments: '{"cmd":"ls"}' },
      ],
      usage: {
        input_tokens: 30,
        output_tokens: 11,
        total_tokens: 41,
        input_tokens_details: { cached_tokens: 18 },
        output_tokens_details: { reasoning_tokens: 6 },
      },
    }),
  }), context()))

  assert.deepEqual(projection.messages.map((/** @type {any} */ m) => m.role), ['user', 'assistant', 'assistant'])
  // Response-level usage rides the LAST assistant output item (here the
  // function_call), not the first. One carrier per response, same row Claude
  // uses. @ref LLP 0035#one-carrier
  assert.equal(projection.messages[1].attributes, undefined)
  assert.deepEqual(projection.messages[2].attributes, {
    usage: {
      // 30 gross input − 18 cached = 12 net; 12 + 18 + 11 == 41 total.
      input_tokens: 12,
      output_tokens: 11,
      total_tokens: 41,
      cache_read_tokens: 18,
      reasoning_tokens: 6,
    },
  })
})

test('OpenAI Responses captures top-level instructions into system_text', () => {
  const projector = createCodexExchangeProjector({ env: {} })
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    request_body: JSON.stringify({
      model: 'gpt-5',
      instructions: 'You are Codex, a coding agent.',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'how' }] }],
    }),
    response_body: JSON.stringify({ id: 'resp_1', output_text: 'because' }),
  }), context()))

  assert.equal(projection.system_text, 'You are Codex, a coding agent.')
})

test('OpenAI Chat system field still wins over instructions', () => {
  const projector = createCodexExchangeProjector({ env: {} })
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/v1/chat/completions',
    provider: 'openai',
    request_body: JSON.stringify({
      model: 'gpt-5',
      system: 'chat-system',
      instructions: 'responses-instructions',
      messages: [{ role: 'user', content: 'hi' }],
    }),
    response_body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'yo' } }] }),
  }), context()))

  assert.equal(projection.system_text, 'chat-system')
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

test('OpenAI Responses SSE completed usage is normalized onto the assistant response', () => {
  const projector = createCodexExchangeProjector({ env: {} })
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/v1/responses',
    is_sse: true,
    request_body: JSON.stringify({
      model: 'gpt-5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'why' }] }],
    }),
    response_body: '',
    stream_events: [
      { kind: 'stream_event', exchange_id: 'ex-1', t_ms: 0, event: 'response.created', data: JSON.stringify({ id: 'resp_2', type: 'response.created' }) },
      { kind: 'stream_event', exchange_id: 'ex-1', t_ms: 5, event: 'response.output_text.delta', data: JSON.stringify({ type: 'response.output_text.delta', delta: 'be' }) },
      { kind: 'stream_event', exchange_id: 'ex-1', t_ms: 6, event: 'response.output_text.delta', data: JSON.stringify({ type: 'response.output_text.delta', delta: 'cause' }) },
      {
        kind: 'stream_event',
        exchange_id: 'ex-1',
        t_ms: 9,
        event: 'response.completed',
        data: JSON.stringify({
          type: 'response.completed',
          id: 'resp_2',
          status: 'completed',
          usage: {
            input_tokens: 8,
            output_tokens: 4,
            total_tokens: 12,
            input_tokens_details: { cached_tokens: 3 },
            output_tokens_details: { reasoning_tokens: 2 },
          },
        }),
      },
    ],
  }), context()))

  assert.deepEqual(projection.messages[1].attributes, {
    usage: {
      // 8 gross input − 3 cached = 5 net; 5 + 3 + 4 == 12 total.
      input_tokens: 5,
      output_tokens: 4,
      total_tokens: 12,
      cache_read_tokens: 3,
      reasoning_tokens: 2,
    },
  })
})

test('OpenAI Responses function_call in input becomes an assistant tool_use message', () => {
  const projector = createCodexExchangeProjector({ env: {} })
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/v1/responses',
    provider: 'openai',
    request_body: JSON.stringify({
      model: 'gpt-5',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'ls please' }] },
        {
          type: 'function_call',
          call_id: 'call_abc',
          name: 'exec_command',
          arguments: '{"cmd":"ls"}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_abc',
          output: 'a.txt\nb.txt',
        },
      ],
    }),
    response_body: JSON.stringify({ id: 'resp_1', output_text: 'done' }),
  }), context()))

  assert.deepEqual(
    projection.messages.map((/** @type {any} */ m) => m.role),
    ['user', 'assistant', 'tool', 'assistant']
  )
  const toolUse = projection.messages[1].content[0]
  assert.equal(toolUse.type, 'tool_use')
  assert.equal(toolUse.id, 'call_abc')
  assert.equal(toolUse.name, 'exec_command')
  assert.deepEqual(toolUse.input, { cmd: 'ls' })
  const toolResult = projection.messages[2].content[0]
  assert.equal(toolResult.type, 'tool_result')
  assert.equal(toolResult.tool_use_id, 'call_abc')
  assert.equal(toolResult.content, 'a.txt\nb.txt')
})

test('OpenAI Responses custom_tool_call uses payload.input when arguments is missing', () => {
  const projector = createCodexExchangeProjector({ env: {} })
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/v1/responses',
    provider: 'openai',
    request_body: JSON.stringify({
      model: 'gpt-5',
      input: [
        {
          type: 'custom_tool_call',
          call_id: 'call_x',
          name: 'spawn_agent',
          input: 'raw-string-input',
        },
      ],
    }),
    response_body: JSON.stringify({ id: 'resp_2', output_text: 'k' }),
  }), context()))

  const toolUse = projection.messages[0].content[0]
  assert.equal(toolUse.type, 'tool_use')
  assert.equal(toolUse.id, 'call_x')
  assert.equal(toolUse.name, 'spawn_agent')
  assert.equal(toolUse.input, 'raw-string-input')
})

test('OpenAI Responses fans out response.output items into per-item assistant messages', () => {
  const projector = createCodexExchangeProjector({ env: {} })
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/v1/responses',
    provider: 'openai',
    request_body: JSON.stringify({
      model: 'gpt-5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'list files' }] }],
    }),
    response_body: JSON.stringify({
      id: 'resp_3',
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'on it' }] },
        {
          type: 'function_call',
          call_id: 'call_42',
          name: 'exec_command',
          arguments: '{"cmd":"ls"}',
        },
      ],
    }),
  }), context()))

  // Each output[] item becomes its own assistant message so it hashes the
  // same as a turn-2 replay (where input items are fanned out too).
  assert.deepEqual(
    projection.messages.map((/** @type {any} */ m) => m.role),
    ['user', 'assistant', 'assistant']
  )
  assert.deepEqual(projection.messages[1].content, [{ type: 'text', text: 'on it' }])
  const toolUse = projection.messages[2].content[0]
  assert.equal(toolUse.type, 'tool_use')
  assert.equal(toolUse.id, 'call_42')
  assert.equal(toolUse.name, 'exec_command')
  assert.deepEqual(toolUse.input, { cmd: 'ls' })
})

test('OpenAI Responses turn-1 response shape matches turn-2 input replay shape (dedupe)', () => {
  const projector = createCodexExchangeProjector({ env: {} })
  // Turn 1: assistant emits text + a function_call as response output.
  const turn1 = /** @type {any} */ (projector.project(exchange({
    path: '/v1/responses',
    provider: 'openai',
    request_body: JSON.stringify({
      model: 'gpt-5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    }),
    response_body: JSON.stringify({
      id: 'resp_a',
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'on it' }] },
        { type: 'function_call', call_id: 'call_z', name: 'exec', arguments: '{"x":1}' },
      ],
    }),
  }), context()))

  // Turn 2: same output items now arrive as input replay (plus a tool result and follow-up).
  const turn2 = /** @type {any} */ (projector.project(exchange({
    path: '/v1/responses',
    provider: 'openai',
    request_body: JSON.stringify({
      model: 'gpt-5',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'on it' }] },
        { type: 'function_call', call_id: 'call_z', name: 'exec', arguments: '{"x":1}' },
        { type: 'function_call_output', call_id: 'call_z', output: 'ok' },
      ],
    }),
    response_body: JSON.stringify({ id: 'resp_b', output_text: 'done' }),
  }), context()))

  // Turn 1's assistant text + tool_use must match turn 2's replayed input items
  // block-for-block. That's what makes content-hash dedupe collapse them.
  assert.deepEqual(turn1.messages[1].content, turn2.messages[1].content)
  assert.deepEqual(turn1.messages[2].content, turn2.messages[2].content)
})

test('OpenAI Responses SSE captures tool_use from response.output_item.done', () => {
  const projector = createCodexExchangeProjector({ env: {} })
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/v1/responses',
    is_sse: true,
    request_body: JSON.stringify({
      model: 'gpt-5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'go' }] }],
    }),
    response_body: '',
    stream_events: [
      { kind: 'stream_event', exchange_id: 'ex-1', t_ms: 0, event: 'response.created', data: JSON.stringify({ id: 'resp_4', type: 'response.created' }) },
      { kind: 'stream_event', exchange_id: 'ex-1', t_ms: 1, event: 'response.output_text.delta', data: JSON.stringify({ type: 'response.output_text.delta', delta: 'sure' }) },
      { kind: 'stream_event', exchange_id: 'ex-1', t_ms: 2, event: 'response.output_item.done', data: JSON.stringify({
        type: 'response.output_item.done',
        item: { type: 'function_call', call_id: 'call_stream', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
      }) },
      { kind: 'stream_event', exchange_id: 'ex-1', t_ms: 3, event: 'response.completed', data: JSON.stringify({ type: 'response.completed', id: 'resp_4', status: 'completed' }) },
    ],
  }), context()))

  // No body in response.completed → use streamed accumulators, fanned out.
  assert.deepEqual(
    projection.messages.map((/** @type {any} */ m) => m.role),
    ['user', 'assistant', 'assistant']
  )
  assert.deepEqual(projection.messages[1].content, [{ type: 'text', text: 'sure' }])
  const toolUse = projection.messages[2].content[0]
  assert.equal(toolUse.type, 'tool_use')
  assert.equal(toolUse.id, 'call_stream')
  assert.equal(toolUse.name, 'exec_command')
  assert.deepEqual(toolUse.input, { cmd: 'pwd' })
  assert.deepEqual(projection.messages[1].raw_frame, { response_id: 'resp_4' })
  assert.deepEqual(projection.messages[2].raw_frame, { response_id: 'resp_4' })
})

test('OpenAI Responses SSE prefers full response.completed body when present', () => {
  const projector = createCodexExchangeProjector({ env: {} })
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/v1/responses',
    is_sse: true,
    request_body: JSON.stringify({
      model: 'gpt-5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'go' }] }],
    }),
    response_body: '',
    stream_events: [
      { kind: 'stream_event', exchange_id: 'ex-1', t_ms: 0, event: 'response.created', data: JSON.stringify({ id: 'resp_5', type: 'response.created' }) },
      { kind: 'stream_event', exchange_id: 'ex-1', t_ms: 1, event: 'response.output_text.delta', data: JSON.stringify({ type: 'response.output_text.delta', delta: 'ignored' }) },
      { kind: 'stream_event', exchange_id: 'ex-1', t_ms: 2, event: 'response.completed', data: JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_5',
          output: [
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'final' }] },
            { type: 'function_call', call_id: 'call_body', name: 'apply_patch', arguments: '{"path":"x"}' },
          ],
        },
      }) },
    ],
  }), context()))

  // Completed body is authoritative and is already fanned out per-item;
  // streamed 'ignored' text is dropped because the message item supplied text.
  assert.deepEqual(
    projection.messages.map((/** @type {any} */ m) => m.role),
    ['user', 'assistant', 'assistant']
  )
  assert.deepEqual(projection.messages[1].content, [{ type: 'text', text: 'final' }])
  const toolUse = projection.messages[2].content[0]
  assert.equal(toolUse.type, 'tool_use')
  assert.equal(toolUse.id, 'call_body')
  assert.equal(toolUse.name, 'apply_patch')
  assert.deepEqual(toolUse.input, { path: 'x' })
})

test('OpenAI Responses SSE merges streamed text into a tool-only completed body', () => {
  const projector = createCodexExchangeProjector({ env: {} })
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/v1/responses',
    is_sse: true,
    request_body: JSON.stringify({
      model: 'gpt-5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'go' }] }],
    }),
    response_body: '',
    stream_events: [
      { kind: 'stream_event', exchange_id: 'ex-1', t_ms: 0, event: 'response.created', data: JSON.stringify({ id: 'resp_6', type: 'response.created' }) },
      { kind: 'stream_event', exchange_id: 'ex-1', t_ms: 1, event: 'response.output_text.delta', data: JSON.stringify({ type: 'response.output_text.delta', delta: 'thinking out loud' }) },
      { kind: 'stream_event', exchange_id: 'ex-1', t_ms: 2, event: 'response.completed', data: JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_6',
          output: [
            { type: 'function_call', call_id: 'call_only', name: 'apply_patch', arguments: '{"path":"x"}' },
          ],
        },
      }) },
    ],
  }), context()))

  // Completed body had only a function_call; streamed text is preserved as
  // its own message so dedupe matches a future replay.
  assert.deepEqual(
    projection.messages.map((/** @type {any} */ m) => m.role),
    ['user', 'assistant', 'assistant']
  )
  assert.deepEqual(projection.messages[1].content, [{ type: 'text', text: 'thinking out loud' }])
  assert.equal(projection.messages[2].content[0].type, 'tool_use')
  assert.equal(projection.messages[2].content[0].id, 'call_only')
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

  // LLP 0032: repo identity promoted to first-class projection fields (still
  // mirrored in attributes.codex.* for provenance). head_sha carries the raw
  // captured value. `abc123` here is abbreviated, so the graph's commitKey
  // guard mints no Commit node, but the column stays faithful to capture.
  assert.equal(projection.git_remote, 'git@github.com:acme/repo.git')
  assert.equal(projection.head_sha, 'abc123')
  // repo_root stays null: the workspace path is NOT a verified git toplevel
  // (it may be a repo subdir), so Codex File keys must not bridge against it.
  // They fall back to absolute. @ref LLP 0032#codex-repo-root
  assert.equal(projection.repo_root, undefined)

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

test('live projector redacts credential userinfo from the turn-metadata remote (LLP 0032)', () => {
  const projector = createCodexExchangeProjector({ env: {} })
  const workspace = '/home/me/workspace'
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    is_sse: true,
    request_headers: JSON.stringify({
      'x-codex-turn-metadata': JSON.stringify({
        session_id: 'session-x',
        workspaces: {
          // A token-bearing HTTPS remote in the turn metadata.
          [workspace]: { associated_remote_urls: { origin: 'https://x-access-token:ghp_SUPERSECRET@github.com/acme/repo.git' } },
        },
      }),
    }),
    request_body: JSON.stringify({ model: 'gpt-5-codex', input: 'go' }),
    response_body: '',
    stream_events: [
      { kind: 'stream_event', exchange_id: 'ex-1', t_ms: 0, event: 'response.completed', data: JSON.stringify({ type: 'response.completed', id: 'resp_x', output_text: 'done' }) },
    ],
  }), context()))

  // Stripped at ingress: neither the first-class field nor the provenance mirror holds the token.
  assert.equal(projection.git_remote, 'https://github.com/acme/repo.git')
  assert.equal(projection.attributes.codex.git_origin_url, 'https://github.com/acme/repo.git')
  assert.ok(!JSON.stringify(projection).includes('ghp_SUPERSECRET'), 'no token anywhere in the projection')
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

test('subagent turn metadata captures parent_thread_id (lineage)', () => {
  const projector = createCodexExchangeProjector({ env: {} })
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    request_headers: JSON.stringify({
      'x-codex-turn-metadata': JSON.stringify({
        session_id: 'sess-1',
        thread_id: 'thread-child',
        parent_thread_id: 'thread-parent',
        thread_source: 'subagent',
        workspaces: { '/w': {} },
      }),
    }),
    request_body: JSON.stringify({ model: 'gpt-5-codex', input: 'go' }),
    response_body: JSON.stringify({ output_text: 'done' }),
  }), context()))

  assert.equal(projection.conversation_id, 'thread-child')
  assert.equal(projection.parent_thread_id, 'thread-parent')
  assert.equal(projection.is_sidechain, true)
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
