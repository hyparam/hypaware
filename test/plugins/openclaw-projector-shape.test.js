// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { createOpenclawExchangeProjector } from '../../hypaware-core/plugins-workspace/openclaw/src/projector.js'
import { sessionMatchKey, wireMatchKey } from '../../hypaware-core/plugins-workspace/openclaw/src/match_key.js'

/**
 * @param {Record<string, unknown>} [overrides]
 */
function exchange(overrides = {}) {
  return /** @type {any} */ ({
    exchange_id: 'ex-1',
    ts_start: '2026-07-15T10:00:00.000Z',
    ts_end: '2026-07-15T10:00:00.250Z',
    duration_ms: 250,
    upstream: 'anthropic',
    provider: 'anthropic',
    method: 'POST',
    path: '/v1/chat/completions',
    status_code: 200,
    request_bytes: 50,
    response_bytes: 100,
    is_sse: false,
    stream_event_count: 0,
    request_headers: JSON.stringify({ 'x-hypaware-client': 'openclaw' }),
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

/**
 * @param {string | undefined} upstream
 * @returns {string}
 */
function headers(upstream) {
  return JSON.stringify({
    'x-hypaware-client': 'openclaw',
    ...(upstream === undefined ? {} : { 'x-hypaware-upstream': upstream }),
  })
}

/**
 * @param {Array<Record<string, unknown>>} chunks
 */
function sseEvents(chunks) {
  return chunks.map((chunk, i) => ({
    kind: 'stream_event',
    exchange_id: 'ex-sse',
    t_ms: i,
    event: 'message',
    data: JSON.stringify(chunk),
  })).concat([/** @type {any} */ ({
    kind: 'stream_event',
    exchange_id: 'ex-sse',
    t_ms: chunks.length,
    event: 'message',
    data: '[DONE]',
  })])
}

const ANTHROPIC_REQUEST = {
  model: 'claude-sonnet-4-5',
  system: 'You are OpenClaw, a personal AI assistant.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
}

const ANTHROPIC_RESPONSE = {
  id: 'msg_01',
  role: 'assistant',
  model: 'claude-sonnet-4-5',
  content: [{ type: 'text', text: 'hello' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 5 },
}

const OPENAI_REQUEST = {
  model: 'gpt-5',
  messages: [
    { role: 'system', content: 'You are OpenClaw, a personal AI assistant.' },
    { role: 'user', content: 'hi' },
  ],
}

const OPENAI_RESPONSE = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  model: 'gpt-5',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: {
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    prompt_tokens_details: { cached_tokens: 40 },
    completion_tokens_details: { reasoning_tokens: 8 },
  },
}

/**
 * @param {Record<string, unknown>} overrides
 * @returns {Promise<any>}
 */
async function project(overrides) {
  const projector = createOpenclawExchangeProjector()
  return /** @type {any} */ (await projector.project(exchange(overrides), context()))
}

// @ref LLP 0161#projector-shape [tests]: the header picks the parse branch
// and the recorded provider; absent, both fall back to Anthropic so
// un-steered traffic still projects.
test('project() falls back to the anthropic shape and provider when the upstream header is absent', async () => {
  const projection = await project({
    request_headers: headers(undefined),
    request_body: JSON.stringify(ANTHROPIC_REQUEST),
    response_body: JSON.stringify(ANTHROPIC_RESPONSE),
  })

  assert.ok(projection)
  assert.equal(projection.provider, 'anthropic')
  assert.equal(projection.system_text, ANTHROPIC_REQUEST.system)
  assert.deepEqual(projection.messages.map((/** @type {any} */ m) => m.role), ['user', 'assistant'])
  assert.deepEqual(projection.messages[1].content, [{ type: 'text', text: 'hello' }])
})

test('project() reads the anthropic shape when the upstream header names anthropic', async () => {
  const projection = await project({
    request_headers: headers('anthropic'),
    request_body: JSON.stringify(ANTHROPIC_REQUEST),
    response_body: JSON.stringify(ANTHROPIC_RESPONSE),
  })

  assert.ok(projection)
  assert.equal(projection.provider, 'anthropic')
  assert.deepEqual(projection.messages[1].content, [{ type: 'text', text: 'hello' }])
})

// @ref LLP 0157#requirements [tests]: R6, the row records the true upstream.
// An unrecognized value is still recorded verbatim rather than rewritten,
// while its body is read as the Anthropic shape this adapter has always spoken.
test('project() records an unrecognized upstream verbatim and keeps the anthropic parse', async () => {
  const projection = await project({
    request_headers: headers('some-future-vendor'),
    request_body: JSON.stringify(ANTHROPIC_REQUEST),
    response_body: JSON.stringify(ANTHROPIC_RESPONSE),
  })

  assert.ok(projection)
  assert.equal(projection.provider, 'some-future-vendor')
  assert.deepEqual(projection.messages[1].content, [{ type: 'text', text: 'hello' }])
})

// @ref LLP 0161#projector-shape [tests]: the OpenAI Chat Completions branch,
// non-streamed.
test('project() maps a non-streamed OpenAI Chat Completions exchange', async () => {
  const projection = await project({
    request_headers: headers('openai'),
    request_body: JSON.stringify(OPENAI_REQUEST),
    response_body: JSON.stringify(OPENAI_RESPONSE),
  })

  assert.ok(projection)
  assert.equal(projection.provider, 'openai')
  assert.equal(projection.client_name, 'openclaw')
  assert.equal(projection.conversation_source, 'openclaw')
  assert.equal(projection.model, 'gpt-5')
  // The leading system message becomes system_text, not a row, so the same
  // conversation yields the same row set whichever wire carried it.
  assert.equal(projection.system_text, 'You are OpenClaw, a personal AI assistant.')
  assert.deepEqual(projection.messages.map((/** @type {any} */ m) => m.role), ['user', 'assistant'])

  assert.deepEqual(projection.messages[0].content, [{ type: 'text', text: 'hi' }])
  const assistant = projection.messages[1]
  assert.deepEqual(assistant.content, [{ type: 'text', text: 'hello' }])
  assert.equal(assistant.stop_reason, 'stop')
  // OpenAI prompt_tokens is gross: the stored input count is net of the
  // cached reads reported beside it (LLP 0035).
  assert.deepEqual(assistant.attributes.usage, {
    input_tokens: 60,
    output_tokens: 20,
    cache_read_tokens: 40,
    reasoning_tokens: 8,
  })
  // Identity stays the gateway's fallback hash convention on both shapes.
  assert.equal(assistant.message_id, undefined)
})

test('project() keys the OpenAI session on the system-prompt head, like the anthropic shape', async () => {
  const first = await project({
    exchange_id: 'ex-1',
    request_headers: headers('openai'),
    request_body: JSON.stringify(OPENAI_REQUEST),
    response_body: JSON.stringify(OPENAI_RESPONSE),
  })
  const secondTurn = await project({
    exchange_id: 'ex-2',
    request_headers: headers('openai'),
    request_body: JSON.stringify({
      ...OPENAI_REQUEST,
      messages: [
        ...OPENAI_REQUEST.messages,
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'more' },
      ],
    }),
    response_body: JSON.stringify(OPENAI_RESPONSE),
  })
  const otherAgent = await project({
    exchange_id: 'ex-3',
    request_headers: headers('openai'),
    request_body: JSON.stringify({
      ...OPENAI_REQUEST,
      messages: [{ role: 'system', content: 'A different agent persona.' }, { role: 'user', content: 'hi' }],
    }),
    response_body: JSON.stringify(OPENAI_RESPONSE),
  })

  assert.equal(first.session_id.length, 16)
  assert.equal(first.session_id, secondTurn.session_id, 'same system prompt = same session')
  assert.notEqual(first.session_id, otherAgent.session_id, 'different system prompt = different session')
})

// @ref LLP 0161#projector-shape [tests]: OpenAI tool_calls and role:"tool"
// envelopes normalize into the shared tool_use/tool_result block vocabulary,
// which is what lets one match key span both wire shapes.
test('project() normalizes OpenAI tool calls and tool results into shared blocks', async () => {
  const projection = await project({
    request_headers: headers('openai'),
    request_body: JSON.stringify({
      model: 'gpt-5',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'search please' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'search', arguments: '{"q":"hi"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'one result' },
      ],
    }),
    response_body: JSON.stringify(OPENAI_RESPONSE),
  })

  assert.ok(projection)
  assert.deepEqual(projection.messages.map((/** @type {any} */ m) => m.role), ['user', 'assistant', 'tool', 'assistant'])
  assert.deepEqual(projection.messages[1].content, [
    { type: 'tool_use', id: 'call_1', name: 'search', input: { q: 'hi' } },
  ])
  assert.deepEqual(projection.messages[2].content, [
    { type: 'tool_result', tool_use_id: 'call_1', content: 'one result' },
  ])
})

// @ref LLP 0161#projector-shape [tests]: the OpenAI branch, streamed.
test('project() assembles a streamed OpenAI assistant message from SSE chunks', async () => {
  const projection = await project({
    is_sse: true,
    request_headers: headers('openai'),
    request_body: JSON.stringify(OPENAI_REQUEST),
    response_body: null,
    stream_events: sseEvents([
      { id: 'chatcmpl-2', model: 'gpt-5', choices: [{ index: 0, delta: { role: 'assistant', content: 'hel' } }] },
      { id: 'chatcmpl-2', model: 'gpt-5', choices: [{ index: 0, delta: { content: 'lo' } }] },
      { id: 'chatcmpl-2', model: 'gpt-5', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { id: 'chatcmpl-2', model: 'gpt-5', choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } },
    ]),
  })

  assert.ok(projection)
  assert.equal(projection.provider, 'openai')
  const assistant = projection.messages.at(-1)
  assert.equal(assistant.role, 'assistant')
  assert.deepEqual(assistant.content, [{ type: 'text', text: 'hello' }])
  assert.equal(assistant.stop_reason, 'stop')
  assert.deepEqual(assistant.attributes.usage, { input_tokens: 7, output_tokens: 3 })
})

test('project() accumulates a streamed OpenAI tool call across chunks', async () => {
  const projection = await project({
    is_sse: true,
    request_headers: headers('openai'),
    request_body: JSON.stringify(OPENAI_REQUEST),
    response_body: null,
    stream_events: sseEvents([
      {
        id: 'chatcmpl-3',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{ index: 0, id: 'call_9', type: 'function', function: { name: 'search', arguments: '{"q":' } }],
          },
        }],
      },
      {
        id: 'chatcmpl-3',
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"hi"}' } }] } }],
      },
      { id: 'chatcmpl-3', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ]),
  })

  assert.ok(projection)
  const assistant = projection.messages.at(-1)
  assert.equal(assistant.stop_reason, 'tool_calls')
  assert.deepEqual(assistant.content, [
    { type: 'tool_use', id: 'call_9', name: 'search', input: { q: 'hi' } },
  ])
})

// A tool call that streams no argument bytes is a valid empty-input call:
// its input must be {}, never the empty string parseMaybeJson('') yields.
// Same guarantee the Anthropic branch already makes for input_json_delta.
test('project() preserves an argument-less streamed OpenAI tool call as empty input', async () => {
  const projection = await project({
    is_sse: true,
    request_headers: headers('openai'),
    request_body: JSON.stringify(OPENAI_REQUEST),
    response_body: null,
    stream_events: sseEvents([
      {
        id: 'chatcmpl-4',
        choices: [{
          index: 0,
          delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_0', function: { name: 'now' } }] },
        }],
      },
      { id: 'chatcmpl-4', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ]),
  })

  const assistant = projection.messages.at(-1)
  assert.deepEqual(assistant.content, [{ type: 'tool_use', id: 'call_0', name: 'now', input: {} }])
  assert.notEqual(assistant.content[0].input, '')
})

test('project() marks a truncated OpenAI stream stop_reason=error', async () => {
  const projection = await project({
    is_sse: true,
    request_headers: headers('openai'),
    request_body: JSON.stringify(OPENAI_REQUEST),
    response_body: null,
    stream_events: sseEvents([
      { id: 'chatcmpl-5', choices: [{ index: 0, delta: { role: 'assistant', content: 'par' } }] },
    ]),
  })

  const assistant = projection.messages.at(-1)
  assert.deepEqual(assistant.content, [{ type: 'text', text: 'par' }])
  assert.equal(assistant.stop_reason, 'error')
})

/**
 * The one match key every content-free assistant row hashes to, whichever
 * wire shape produced it. Named here because it is the collision the
 * cut-stream floor exists to prevent: three decoders converging on one key
 * means an empty row from one shape can settle against an empty row from
 * another.
 */
const EMPTY_ASSISTANT_MATCH_KEY = wireMatchKey('assistant', [])

/**
 * @param {any} projection
 */
function matchKeys(projection) {
  return projection.messages.map((/** @type {any} */ m) => m.attributes?.openclaw?.match_key)
}

// A stream cut before anything finished has no content to record. The row
// this used to emit carried an empty content array, a live message_index and
// the canonical empty-assistant match key, so it stayed eligible for the
// ordinal settlement fallback and could acquire a native message_id it had no
// content for.
test('project() emits no assistant row for a cut OpenAI stream that carried no content', async () => {
  const projection = await project({
    is_sse: true,
    request_headers: headers('openai'),
    request_body: JSON.stringify(OPENAI_REQUEST),
    response_body: null,
    stream_events: sseEvents([
      { id: 'chatcmpl-7', model: 'gpt-5', choices: [{ index: 0, delta: { role: 'assistant' } }] },
    ]),
  })

  assert.ok(projection)
  assert.deepEqual(projection.messages.map((/** @type {any} */ m) => m.role), ['user'])
  assert.ok(!matchKeys(projection).includes(EMPTY_ASSISTANT_MATCH_KEY))
})

test('project() emits no assistant row for a cut Anthropic stream that carried no content', async () => {
  const projection = await project({
    is_sse: true,
    request_headers: headers(undefined),
    request_body: JSON.stringify(ANTHROPIC_REQUEST),
    response_body: null,
    stream_events: sseEvents([
      {
        type: 'message_start',
        message: {
          id: 'msg_02',
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          content: [],
          usage: { input_tokens: 3, output_tokens: 0 },
        },
      },
    ]),
  })

  assert.ok(projection)
  assert.deepEqual(projection.messages.map((/** @type {any} */ m) => m.role), ['user'])
  assert.ok(!matchKeys(projection).includes(EMPTY_ASSISTANT_MATCH_KEY))
})

// The floor is "cut AND empty", not "empty": a response that reached its
// terminal event and genuinely produced nothing is a real answer the row set
// must keep, on either wire.
test('project() still records a terminal Anthropic stream whose content is genuinely empty', async () => {
  const projection = await project({
    is_sse: true,
    request_headers: headers(undefined),
    request_body: JSON.stringify(ANTHROPIC_REQUEST),
    response_body: null,
    stream_events: sseEvents([
      { type: 'message_start', message: { id: 'msg_03', role: 'assistant', model: 'claude-sonnet-4-5', content: [] } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } },
      { type: 'message_stop' },
    ]),
  })

  const assistant = projection.messages.at(-1)
  assert.equal(assistant.role, 'assistant')
  assert.deepEqual(assistant.content, [])
  assert.equal(assistant.stop_reason, 'end_turn')
})

test('project() still records a terminal OpenAI stream whose content is genuinely empty', async () => {
  const projection = await project({
    is_sse: true,
    request_headers: headers('openai'),
    request_body: JSON.stringify(OPENAI_REQUEST),
    response_body: null,
    stream_events: sseEvents([
      { id: 'chatcmpl-8', model: 'gpt-5', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: 'content_filter' }] },
    ]),
  })

  const assistant = projection.messages.at(-1)
  assert.equal(assistant.role, 'assistant')
  assert.deepEqual(assistant.content, [])
  assert.equal(assistant.stop_reason, 'content_filter')
})

test('project() still records a non-streamed OpenAI response whose content is empty', async () => {
  const projection = await project({
    request_headers: headers('openai'),
    request_body: JSON.stringify(OPENAI_REQUEST),
    response_body: JSON.stringify({
      id: 'chatcmpl-9',
      object: 'chat.completion',
      model: 'gpt-5',
      choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'content_filter' }],
    }),
  })

  const assistant = projection.messages.at(-1)
  assert.equal(assistant.role, 'assistant')
  assert.deepEqual(assistant.content, [])
  assert.equal(assistant.stop_reason, 'content_filter')
})

// @ref LLP 0157#requirements [tests]: R8, every fallback-identity row carries
// the LLP 0159 match key - on both shapes, streamed and not.
test('project() stamps openclaw.match_key on every row of both shapes', async () => {
  const projections = [
    await project({
      request_headers: headers(undefined),
      request_body: JSON.stringify(ANTHROPIC_REQUEST),
      response_body: JSON.stringify(ANTHROPIC_RESPONSE),
    }),
    await project({
      request_headers: headers('openai'),
      request_body: JSON.stringify(OPENAI_REQUEST),
      response_body: JSON.stringify(OPENAI_RESPONSE),
    }),
    await project({
      is_sse: true,
      request_headers: headers('openai'),
      request_body: JSON.stringify(OPENAI_REQUEST),
      response_body: null,
      stream_events: sseEvents([
        {
          id: 'chatcmpl-6',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        },
      ]),
    }),
  ]

  for (const projection of projections) {
    assert.ok(projection.messages.length > 0)
    for (const message of projection.messages) {
      assert.equal(
        message.attributes?.openclaw?.match_key,
        wireMatchKey(message.role, message.content),
        `match_key missing or wrong on a ${message.role} row`
      )
    }
    // Stamping the match key must not evict the usage namespace beside it.
    assert.ok(projection.messages.at(-1).attributes.usage)
  }
})

// The reason `openaiMessages()` normalizes into the Anthropic block
// vocabulary rather than passing OpenAI's own shape through: the settlement
// enricher looks the row up by a key built from the OpenClaw session file,
// which stores the same tool call as a `toolCall` block. Left in its native
// shape, an OpenAI-captured tool call would hash through wireMatchKey's
// generic fallback and never match.
// @ref LLP 0159#open-questions [tests]: the toolCall/tool_use divergence
test('an OpenAI-captured tool call carries the same match key as its session-file record', async () => {
  const projection = await project({
    request_headers: headers('openai'),
    request_body: JSON.stringify({
      model: 'gpt-5',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'search please' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"hi"}' } }],
        },
      ],
    }),
    response_body: JSON.stringify(OPENAI_RESPONSE),
  })

  const wireRow = projection.messages.find((/** @type {any} */ m) => m.role === 'assistant')
  // The same turn as OpenClaw's session file stores it.
  const fromSession = sessionMatchKey('assistant', [
    { type: 'toolCall', id: 'oc_local_1', name: 'search', arguments: { q: 'hi' } },
  ])
  assert.equal(wireRow.attributes.openclaw.match_key, fromSession)
})
