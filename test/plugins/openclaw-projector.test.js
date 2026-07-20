// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  anthropicUpstreamPreset,
  createOpenclawExchangeProjector,
  openclawSessionId,
} from '../../hypaware-core/plugins-workspace/openclaw/src/projector.js'
import {
  anthropicUpstreamPreset as claudeAnthropicUpstreamPreset,
  createClaudeExchangeProjector,
} from '../../hypaware-core/plugins-workspace/claude/src/projector.js'

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
    path: '/v1/messages',
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

const REQUEST = {
  model: 'claude-sonnet-4-5',
  system: 'You are OpenClaw, a personal AI assistant. Config digest: abc.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
}

const RESPONSE = {
  id: 'msg_01',
  role: 'assistant',
  model: 'claude-sonnet-4-5',
  content: [{ type: 'text', text: 'hello' }],
  stop_reason: 'end_turn',
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 100,
    cache_creation_input_tokens: 20,
  },
}

// @ref LLP 0109#gateway-capture [tests]: deterministic header gate, no
// user-agent sniffing.
test('match() is true iff the x-hypaware-client header says openclaw', () => {
  const projector = createOpenclawExchangeProjector()
  assert.equal(projector.match(exchange()), true)
  // Header lookup is case-insensitive and tolerates array values.
  assert.equal(projector.match(exchange({
    request_headers: JSON.stringify({ 'X-HypAware-Client': ['openclaw'] }),
  })), true)
  // No header: an ordinary Claude Code /v1/messages exchange never matches.
  assert.equal(projector.match(exchange({
    request_headers: JSON.stringify({ 'anthropic-version': '2023-06-01' }),
  })), false)
  assert.equal(projector.match(exchange({ request_headers: null })), false)
  // A different client value never matches.
  assert.equal(projector.match(exchange({
    request_headers: JSON.stringify({ 'x-hypaware-client': 'someone-else' }),
  })), false)
})

// @ref LLP 0109#gateway-capture [tests]: OpenClaw shares /v1/messages with
// Claude, so the openclaw projector must outrank the claude projector or
// its traffic would be misattributed.
test('openclaw projector priority is above the claude projector', () => {
  const openclaw = createOpenclawExchangeProjector()
  const claude = createClaudeExchangeProjector({ homeDir: '/nonexistent', stateFile: '/nonexistent/s.jsonl' })
  assert.ok(
    (openclaw.priority ?? 0) > (claude.priority ?? 0),
    `expected openclaw priority ${openclaw.priority} > claude priority ${claude.priority}`
  )
  // The claude projector would also match this exchange (Anthropic path),
  // which is exactly why the priority ordering matters.
  const input = exchange({ request_body: JSON.stringify(REQUEST) })
  assert.equal(claude.match(input), true)
})

test('project() maps a JSON exchange: model, usage, stop_reason, client identity', async () => {
  const projector = createOpenclawExchangeProjector()
  const projection = /** @type {any} */ (await projector.project(exchange({
    request_body: JSON.stringify(REQUEST),
    response_body: JSON.stringify(RESPONSE),
  }), context()))

  assert.ok(projection)
  assert.equal(projection.provider, 'anthropic')
  assert.equal(projection.client_name, 'openclaw')
  assert.equal(projection.conversation_source, 'openclaw')
  assert.equal(projection.model, 'claude-sonnet-4-5')
  assert.equal(projection.system_text, REQUEST.system)

  assert.deepEqual(projection.messages.map((/** @type {any} */ m) => m.role), ['user', 'assistant'])
  const assistant = projection.messages[1]
  assert.equal(assistant.stop_reason, 'end_turn')
  // Cache fields are normalized to the gateway-wide names (LLP 0035).
  assert.deepEqual(assistant.attributes.usage, {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_tokens: 100,
    cache_write_tokens: 20,
  })
  // No message_id: identity is the gateway's fallback hash convention.
  assert.equal(assistant.message_id, undefined)
})

// @ref LLP 0109#gateway-capture [tests]: session_id is a stable hash of the
// system-prompt head - same system prompt, same session; different prompt,
// different session.
test('project() derives a stable session_id from the system-prompt head', async () => {
  const projector = createOpenclawExchangeProjector()
  /** @param {Record<string, unknown>} reqBody @param {string} id */
  const projectOne = async (reqBody, id) => /** @type {any} */ (await projector.project(exchange({
    exchange_id: id,
    request_body: JSON.stringify(reqBody),
    response_body: JSON.stringify(RESPONSE),
  }), context()))

  const first = await projectOne(REQUEST, 'ex-1')
  const secondTurn = await projectOne({
    ...REQUEST,
    messages: [
      ...REQUEST.messages,
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      { role: 'user', content: [{ type: 'text', text: 'more' }] },
    ],
  }, 'ex-2')
  const otherAgent = await projectOne({ ...REQUEST, system: 'A different agent persona.' }, 'ex-3')

  assert.equal(typeof first.session_id, 'string')
  assert.equal(first.session_id.length, 16)
  assert.equal(first.session_id, secondTurn.session_id, 'same system prompt = same session')
  assert.notEqual(first.session_id, otherAgent.session_id, 'different system prompt = different session')
})

test('project() assembles a streamed assistant message from SSE events', async () => {
  const projector = createOpenclawExchangeProjector()
  const events = [
    { type: 'message_start', message: { id: 'msg_02', model: 'claude-sonnet-4-5', usage: { input_tokens: 7 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hel' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ]
  const projection = /** @type {any} */ (await projector.project(exchange({
    is_sse: true,
    request_body: JSON.stringify(REQUEST),
    response_body: null,
    stream_events: events.map((event, i) => ({
      kind: 'stream_event',
      exchange_id: 'ex-sse',
      t_ms: i,
      event: event.type,
      data: JSON.stringify(event),
    })),
  }), context()))

  assert.ok(projection)
  const assistant = projection.messages.at(-1)
  assert.equal(assistant.role, 'assistant')
  assert.deepEqual(assistant.content, [{ type: 'text', text: 'hello' }])
  assert.equal(assistant.stop_reason, 'end_turn')
  assert.deepEqual(assistant.attributes.usage, { input_tokens: 7, output_tokens: 3 })
})

/**
 * Project an exchange whose assistant turn is streamed as the given SSE
 * event objects.
 *
 * @param {Array<Record<string, unknown>>} events
 * @returns {Promise<any>}
 */
async function projectStreamed(events) {
  const projector = createOpenclawExchangeProjector()
  return /** @type {any} */ (await projector.project(exchange({
    is_sse: true,
    request_body: JSON.stringify(REQUEST),
    response_body: null,
    stream_events: events.map((event, i) => ({
      kind: 'stream_event',
      exchange_id: 'ex-sse',
      t_ms: i,
      event: event.type,
      data: JSON.stringify(event),
    })),
  }), context()))
}

// @ref LLP 0109#gateway-capture [tests]: a streamed tool_use block with no
// input_json_delta is a valid empty-input call; its input must stay the {}
// the content_block_start seeded, never be clobbered to '' at finalize.
test('project() preserves an empty-input streamed tool_use call', async () => {
  const projection = await projectStreamed([
    { type: 'message_start', message: { id: 'msg_tu0', model: 'claude-sonnet-4-5', usage: { input_tokens: 4 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_0', name: 'now', input: {} } },
    // No content_block_delta: the tool takes no arguments.
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ])

  assert.ok(projection)
  const assistant = projection.messages.at(-1)
  assert.equal(assistant.stop_reason, 'tool_use')
  assert.deepEqual(assistant.content, [{ type: 'tool_use', id: 'tu_0', name: 'now', input: {} }])
  // Specifically not the empty string that parseMaybeJson('') yields.
  assert.notEqual(assistant.content[0].input, '')
})

// @ref LLP 0109#gateway-capture [tests]: a streamed tool_use with
// input_json_delta bytes is parsed into the accumulated JSON object.
test('project() parses a non-empty-input streamed tool_use call', async () => {
  const projection = await projectStreamed([
    { type: 'message_start', message: { id: 'msg_tu1', model: 'claude-sonnet-4-5', usage: { input_tokens: 4 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'search', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"hi"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ])

  assert.ok(projection)
  const assistant = projection.messages.at(-1)
  assert.deepEqual(assistant.content, [{ type: 'tool_use', id: 'tu_1', name: 'search', input: { q: 'hi' } }])
})

// @ref LLP 0109#gateway-capture [tests]: session-id fallback must degrade,
// not throw, when the first message has no content and there is no system
// prompt (JSON.stringify(undefined) is undefined, which sha256Hex cannot
// digest), so a content-less exchange still projects instead of dropping.
test('openclawSessionId falls back to the exchange id for a content-less first message', () => {
  const reqBody = { messages: [{ role: 'user' }] }
  const id = openclawSessionId(reqBody, undefined, 'ex-fallback')
  const idFromEmpty = openclawSessionId({ messages: [] }, undefined, 'ex-fallback')
  assert.equal(typeof id, 'string')
  assert.equal(id.length, 16)
  // With no hashable content it keys on the exchange id, same as no messages.
  assert.equal(id, idFromEmpty)
})

test('project() does not drop an exchange whose first message has no content', async () => {
  const projector = createOpenclawExchangeProjector()
  const projection = /** @type {any} */ (await projector.project(exchange({
    exchange_id: 'ex-nocontent',
    request_body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user' }] }),
    response_body: JSON.stringify(RESPONSE),
  }), context()))

  assert.ok(projection, 'exchange should project rather than throw/drop')
  assert.equal(projection.session_id, openclawSessionId({ messages: [{ role: 'user' }] }, undefined, 'ex-nocontent'))
})

test('project() declines an unparseable request body', async () => {
  const projector = createOpenclawExchangeProjector()
  const projection = await projector.project(exchange({ request_body: 'not json' }), context())
  assert.equal(projection, undefined)
})

// @ref LLP 0109#gateway-capture [tests]: the preset is identical to the
// Claude plugin's and the name must stay `anthropic` (LLP 0016), because
// registerUpstreamPreset is last-write-wins on the name and routing must
// not depend on plugin activation order.
test('the anthropic upstream preset is equivalent to the claude plugin preset', () => {
  const ours = anthropicUpstreamPreset()
  const theirs = claudeAnthropicUpstreamPreset()
  assert.equal(ours.name, theirs.name)
  assert.equal(ours.base_url, theirs.base_url)
  assert.equal(ours.provider, theirs.provider)
  assert.equal(ours.path_prefix, theirs.path_prefix)
  assert.equal(ours.priority, theirs.priority)
  // Same match surface: path anchor + Anthropic header signature.
  /** @type {Array<{ method: string, path: string, headers: Record<string, string[]> }>} */
  const inputs = [
    { method: 'POST', path: '/v1/messages', headers: {} },
    { method: 'POST', path: '/v1/messages/count_tokens', headers: {} },
    { method: 'POST', path: '/custom', headers: { 'anthropic-version': ['2023-06-01'] } },
    { method: 'POST', path: '/custom', headers: { 'x-api-key': ['k'] } },
    { method: 'POST', path: '/custom', headers: { authorization: ['Bearer sk-ant-abc'] } },
    { method: 'POST', path: '/v1/responses', headers: {} },
    { method: 'POST', path: '/custom', headers: { authorization: ['Bearer sk-proj-abc'] } },
  ]
  for (const input of inputs) {
    assert.equal(
      ours.match?.(input),
      theirs.match?.(input),
      `match divergence on ${input.path} ${JSON.stringify(input.headers)}`
    )
  }
})
