// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createOpenclawExchangeProjector,
  isOpenaiResponsesExchange,
  openaiResponsesAssistant,
  openaiResponsesMessages,
  openaiResponsesSystemText,
} from '../../hypaware-core/plugins-workspace/openclaw/src/projector.js'
import { sessionMatchKey, wireMatchKey } from '../../hypaware-core/plugins-workspace/openclaw/src/match_key.js'

// The OpenAI Responses API decoder (LLP 0176 fix 1). The observed failure
// mode it closes: OpenClaw's own OpenAI client speaks `/v1/responses`, the
// gateway proxied those exchanges faithfully, and the projector's OpenAI
// branch (Chat Completions only) projected zero messages, so every
// API-key OpenAI turn passed through unrecorded.
// @ref LLP 0176#fix-direction [tests]: fix 1, the Responses decoder

/**
 * @param {Record<string, unknown>} [overrides]
 */
function exchange(overrides = {}) {
  return /** @type {any} */ ({
    exchange_id: 'ex-resp-1',
    ts_start: '2026-08-03T22:00:00.000Z',
    ts_end: '2026-08-03T22:00:01.000Z',
    duration_ms: 1000,
    upstream: 'openai',
    provider: 'openai',
    method: 'POST',
    path: '/v1/responses',
    status_code: 200,
    request_bytes: 50,
    response_bytes: 100,
    is_sse: false,
    stream_event_count: 0,
    request_headers: JSON.stringify({
      'x-hypaware-client': 'openclaw',
      'x-hypaware-upstream': 'openai',
    }),
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
  return /** @type {any} */ ({ log: { debug() {}, info() {}, warn() {}, error() {} } })
}

/**
 * @param {Record<string, unknown>} overrides
 */
async function project(overrides) {
  const projector = createOpenclawExchangeProjector()
  return /** @type {any} */ (await projector.project(exchange(overrides), context()))
}

/**
 * @param {Array<Record<string, unknown>>} payloads
 */
function sseEvents(payloads) {
  return payloads.map((payload, i) => ({
    kind: 'stream_event',
    exchange_id: 'ex-resp-sse',
    t_ms: i,
    event: 'message',
    data: JSON.stringify(payload),
  }))
}

const RESPONSES_REQUEST = {
  model: 'gpt-5.6-sol',
  instructions: 'You are OpenClaw, a personal AI assistant.',
  input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'What is 25x25?' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '625' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'What is 30 x 30?' }] },
  ],
}

const RESPONSES_RESPONSE = {
  id: 'resp_001',
  object: 'response',
  model: 'gpt-5.6-sol',
  status: 'completed',
  output: [
    {
      type: 'reasoning',
      id: 'rs_001',
      summary: [{ type: 'summary_text', text: 'Simple arithmetic.' }],
      encrypted_content: 'opaque-signature',
    },
    {
      type: 'message',
      id: 'msg_001',
      role: 'assistant',
      content: [{ type: 'output_text', text: '900' }],
    },
  ],
  usage: {
    input_tokens: 100,
    output_tokens: 12,
    total_tokens: 112,
    input_tokens_details: { cached_tokens: 60 },
    output_tokens_details: { reasoning_tokens: 4 },
  },
}

test('shape detection: path, request body, and response body each suffice', () => {
  assert.equal(isOpenaiResponsesExchange('/v1/responses', {}, undefined), true)
  assert.equal(isOpenaiResponsesExchange('/v1/responses?stream=true', {}, undefined), true)
  assert.equal(isOpenaiResponsesExchange(null, { input: 'hi' }, undefined), true)
  assert.equal(isOpenaiResponsesExchange(null, {}, { object: 'response' }), true)
  assert.equal(isOpenaiResponsesExchange('/v1/chat/completions', { messages: [] }, undefined), false)
  assert.equal(isOpenaiResponsesExchange(null, { messages: [{ role: 'user', content: 'hi' }] }, undefined), false)
})

test('a full Responses exchange projects request turns plus the assistant', async () => {
  const projection = await project({
    request_body: JSON.stringify(RESPONSES_REQUEST),
    response_body: JSON.stringify(RESPONSES_RESPONSE),
  })
  assert.ok(projection)
  assert.equal(projection.provider, 'openai')
  assert.equal(projection.client_name, 'openclaw')
  assert.equal(projection.model, 'gpt-5.6-sol')
  assert.equal(projection.system_text, 'You are OpenClaw, a personal AI assistant.')
  assert.deepEqual(projection.messages.map((/** @type {any} */ m) => m.role), ['user', 'assistant', 'user', 'assistant'])
  const assistant = /** @type {any} */ (projection.messages.at(-1))
  assert.deepEqual(assistant.content.map((/** @type {any} */ b) => b.type), ['thinking', 'text'])
  assert.equal(assistant.content[1].text, '900')
  // Usage nets the cached read out of the gross Responses input count
  // (LLP 0035 net-input): 100 gross - 60 cached = 40 net. The match key
  // stamped alongside it is R8's fallback-identity contract, present on
  // every projected row.
  assert.deepEqual(assistant.attributes.usage, {
    input_tokens: 40, output_tokens: 12, cache_read_tokens: 60, reasoning_tokens: 4,
  })
  assert.ok(assistant.attributes.openclaw.match_key)
})

test('a bare-string input is one user turn (the shorthand form)', () => {
  const messages = openaiResponsesMessages({ input: 'ping' }, undefined, [])
  assert.deepEqual(messages, [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }])
})

test('function_call and function_call_output items map to tool_use / tool_result turns', () => {
  const messages = openaiResponsesMessages({
    input: [
      { type: 'message', role: 'user', content: 'list files' },
      { type: 'function_call', call_id: 'call_9', name: 'bash', arguments: '{"command":"ls"}' },
      { type: 'function_call_output', call_id: 'call_9', output: 'a.txt\nb.txt' },
    ],
  }, undefined, [])
  assert.deepEqual(messages, [
    { role: 'user', content: [{ type: 'text', text: 'list files' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_9', name: 'bash', input: { command: 'ls' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_9', content: 'a.txt\nb.txt' }] },
  ])
})

test('request-side reasoning replay items project nothing', () => {
  const messages = openaiResponsesMessages({
    input: [
      { type: 'reasoning', id: 'rs_old', encrypted_content: 'opaque' },
      { type: 'message', role: 'user', content: 'hi' },
    ],
  }, undefined, [])
  assert.deepEqual(messages, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
})

test('instructions and the leading system items fold into system_text; mid-run ones stay turns', () => {
  const reqBody = {
    instructions: 'Global instructions.',
    input: [
      { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'Leading system.' }] },
      { type: 'message', role: 'user', content: 'hi' },
      { type: 'message', role: 'developer', content: 'mid-run steer' },
    ],
  }
  assert.equal(openaiResponsesSystemText(reqBody), 'Global instructions.\n\nLeading system.')
  const messages = openaiResponsesMessages(reqBody, undefined, [])
  assert.deepEqual(messages.map((m) => m.role), ['user', 'developer'])
})

test('a streamed exchange reconstructs from the terminal response.completed event', async () => {
  const projection = await project({
    request_body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'What is 30 x 30?' }),
    is_sse: true,
    stream_events: sseEvents([
      { type: 'response.created', response: { id: 'resp_002', object: 'response', status: 'in_progress' } },
      { type: 'response.output_text.delta', delta: '9' },
      { type: 'response.output_text.delta', delta: '00' },
      { type: 'response.completed', response: RESPONSES_RESPONSE },
    ]),
  })
  assert.ok(projection)
  const assistant = /** @type {any} */ (projection.messages.at(-1))
  assert.equal(assistant.role, 'assistant')
  assert.equal(assistant.content.at(-1).text, '900')
  assert.equal(assistant.attributes.usage.output_tokens, 12)
})

test('a stream cut before its terminal event degrades to finished items, marked error', async () => {
  const projection = await project({
    request_body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'hi' }),
    is_sse: true,
    stream_events: sseEvents([
      { type: 'response.created', response: { id: 'resp_003', object: 'response', status: 'in_progress' } },
      { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'partial' }] } },
      { type: 'response.output_text.delta', delta: ' never finished' },
    ]),
  })
  assert.ok(projection)
  const assistant = /** @type {any} */ (projection.messages.at(-1))
  assert.equal(assistant.content[0].text, 'partial')
  assert.equal(assistant.stop_reason, 'error')
})

test('an incomplete response records its incomplete reason as stop_reason', () => {
  const assistant = openaiResponsesAssistant({
    object: 'response',
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'trunca' }] }],
  })
  assert.ok(assistant)
  assert.equal(assistant.stop_reason, 'max_output_tokens')
})

// The decoder's output must reconcile with the session file at settlement:
// a Responses tool-call turn and the toolCall record OpenClaw's own file
// stores for it have to produce the same match key, or Lane A rows for
// OpenAI traffic would repeat LLP 0175's duplication on that path.
// @ref LLP 0176#fix-direction [tests]: sequencing with LLP 0175, decoder
// output settles under the same match keys the session file yields
test('Responses tool-call turns match the session file toolCall shape', () => {
  const messages = openaiResponsesMessages({
    input: [{ type: 'function_call', call_id: 'call_x', name: 'bash', arguments: '{"command":"ls"}' }],
  }, undefined, [])
  const wire = wireMatchKey('assistant', messages[0].content)
  const session = sessionMatchKey('assistant', [
    { type: 'toolCall', id: 'call_native', name: 'bash', arguments: { command: 'ls' } },
  ])
  assert.equal(wire, session)
})

test('a projected Responses text turn matches its bare session-file text', () => {
  const messages = openaiResponsesMessages({ input: 'What is 30 x 30?' }, undefined, [])
  assert.equal(
    wireMatchKey('user', messages[0].content),
    sessionMatchKey('user', 'What is 30 x 30?')
  )
})
