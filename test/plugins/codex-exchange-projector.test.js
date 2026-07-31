// @ts-check

import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import {
  createCodexExchangeProjector,
} from '../../hypaware-core/plugins-workspace/codex/src/exchange-projector.js'
import { createAiGatewayMessageProjector } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
import { createUsagePolicyResolver, USAGE_POLICY_DROP } from '../../src/core/usage-policy/index.js'

/**
 * A real usage-policy resolver wired to an injected fs that reports exactly one
 * governing `.hypignore` (class `ignore`) at `ignoredDir`. Mirrors how the
 * @hypaware/claude projector's drop is tested (T2): exercise the actual shared
 * matcher, not a hand-rolled stub.
 * @ref LLP 0050 [tests]: the codex live projector's capture-seam drop
 *
 * @param {string} ignoredDir
 */
function ignoringResolver(ignoredDir) {
  const hypignore = path.join(ignoredDir, '.hypignore')
  return createUsagePolicyResolver({
    existsSync: (p) => p === hypignore,
    readFileSync: () => 'ignore\n',
  })
}

/**
 * Like `ignoringResolver`, but the governing `.hypignore` declares a class
 * the running version does not implement, so the matcher fail-safe clamps it
 * to `ignore` and carries a `warn` (R3). Used to assert the drop escalates to
 * warn level with the declared token. `local-only` is no longer a fixture for
 * this — it is implemented (LLP 0070/0080) and no longer clamps.
 *
 * @param {string} ignoredDir
 */
function clampingResolver(ignoredDir) {
  const hypignore = path.join(ignoredDir, '.hypignore')
  return createUsagePolicyResolver({
    existsSync: (p) => p === hypignore,
    readFileSync: () => 'some-future-class\n',
  })
}

// @ref LLP 0050 [tests]: capture-seam drop: an ignored cwd yields no rows so
// the gateway write guard persists nothing; a clean cwd is unaffected (R1/R2).
test('project() returns no projection when the exchange cwd is .hypignore-ignored', () => {
  const projector = createCodexExchangeProjector({
    resolver: ignoringResolver('/work/ignored'),
  })
  const projection = projector.project(exchange({
    path: '/v1/chat/completions',
    request_body: JSON.stringify({
      cwd: '/work/ignored/sub',
      messages: [{ role: 'user', content: 'secret' }],
    }),
    response_body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
  }), context())
  // The drop returns the terminal USAGE_POLICY_DROP sentinel (not a bare
  // `undefined` decline), so the dispatcher stops the projector walk and logs
  // it as a drop. Either way the gateway write guard persists nothing.
  assert.equal(projection, USAGE_POLICY_DROP)
})

test('project() is unaffected when the exchange cwd is not ignored', () => {
  const projector = createCodexExchangeProjector({
    resolver: ignoringResolver('/work/ignored'),
  })
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/v1/chat/completions',
    request_body: JSON.stringify({
      cwd: '/work/clean',
      messages: [{ role: 'user', content: 'hi' }],
    }),
    response_body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
  }), context()))
  assert.ok(projection)
  assert.deepEqual(projection.messages.map((/** @type {any} */ m) => m.role), ['user', 'assistant'])
})

test('project() emits a usage_policy_drop log on an ignored cwd', () => {
  /** @type {Array<{ message: string, fields?: Record<string, unknown> }>} */
  const infos = []
  const projector = createCodexExchangeProjector({
    resolver: ignoringResolver('/work/ignored'),
  })
  const log = {
    debug() {},
    warn() {},
    error() {},
    /** @param {string} message @param {Record<string, unknown>=} fields */
    info: (message, fields) => { infos.push({ message, fields }) },
  }
  projector.project(exchange({
    path: '/v1/chat/completions',
    request_body: JSON.stringify({
      cwd: '/work/ignored',
      messages: [{ role: 'user', content: 'secret' }],
    }),
  }), { log })
  const drop = infos.find((e) => e.message === 'plugin.codex.usage_policy_drop')
  assert.ok(drop, 'expected a usage_policy_drop log entry')
  assert.equal(drop.fields?.operation, 'usage_policy_drop')
  assert.equal(drop.fields?.governed_by, '/work/ignored/.hypignore')
  assert.equal(drop.fields?.declared, 'ignore', 'an intended ignore carries declared=ignore')
})

test('project() escalates a fail-safe clamp to a warn-level drop with the declared token (R3)', () => {
  /** @type {Array<{ message: string, fields?: Record<string, unknown> }>} */
  const infos = []
  /** @type {Array<{ message: string, fields?: Record<string, unknown> }>} */
  const warns = []
  const projector = createCodexExchangeProjector({
    resolver: clampingResolver('/work/ignored'),
  })
  const log = {
    debug() {},
    error() {},
    /** @param {string} message @param {Record<string, unknown>=} fields */
    info: (message, fields) => { infos.push({ message, fields }) },
    /** @param {string} message @param {Record<string, unknown>=} fields */
    warn: (message, fields) => { warns.push({ message, fields }) },
  }
  const projection = projector.project(exchange({
    path: '/v1/chat/completions',
    request_body: JSON.stringify({
      cwd: '/work/ignored',
      messages: [{ role: 'user', content: 'secret' }],
    }),
  }), { log })

  // Still dropped (privacy fail-safe) via the terminal sentinel, but now
  // observable as a clamp.
  assert.equal(projection, USAGE_POLICY_DROP)
  assert.equal(infos.length, 0, 'a fail-safe clamp does not log at info level')
  const drop = warns.find((e) => e.message === 'plugin.codex.usage_policy_drop')
  assert.ok(drop, 'a fail-safe clamp emits a warn-level usage_policy_drop')
  assert.equal(drop.fields?.declared, 'some-future-class', 'the declared token is carried for diagnosis')
  assert.match(String(drop.fields?.warn), /some-future-class/)
})

// @ref LLP 0083#decision [tests]: an in-band cwd that names no findable
// directory counts as a miss, not as a path for the matcher to resolve against
// whatever directory the daemon happens to run in (#471).
test('project() computes no .hypignore verdict from a RELATIVE in-band cwd', () => {
  // The matcher's first act is `path.resolve(cwd)`, so a relative value is
  // measured against the DAEMON's process cwd. Putting the only governing
  // `.hypignore` at exactly that mistaken base makes the wrong verdict visible:
  // if `sub` reaches the matcher this exchange drops, though nothing here says
  // the session ran anywhere near the daemon.
  const projector = createCodexExchangeProjector({
    resolver: ignoringResolver(path.resolve('sub')),
  })
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/v1/chat/completions',
    request_body: JSON.stringify({
      cwd: 'sub',
      messages: [{ role: 'user', content: 'hi' }],
    }),
    response_body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
  }), context()))
  assert.notEqual(projection, USAGE_POLICY_DROP, 'a relative cwd must not yield a verdict computed against the daemon cwd')
  assert.equal(projection.cwd, undefined, 'and it is not stamped on the row as if it were the session container')
})

test('project() computes no .hypignore verdict from a BLANK in-band cwd', () => {
  /** @type {Array<{ message: string, fields?: Record<string, unknown> }>} */
  const warns = []
  const projector = createCodexExchangeProjector({
    resolver: ignoringResolver(path.resolve('   ')),
  })
  const log = {
    debug() {},
    info() {},
    error() {},
    /** @param {string} message @param {Record<string, unknown>=} fields */
    warn: (message, fields) => { warns.push({ message, fields }) },
  }
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/v1/chat/completions',
    request_body: JSON.stringify({
      cwd: '   ',
      messages: [{ role: 'user', content: 'hi' }],
    }),
    response_body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
  }), { log }))
  assert.notEqual(projection, USAGE_POLICY_DROP, 'a whitespace-only cwd is no directory to match')
  assert.equal(projection.cwd, undefined, 'a blank cwd is absent, not a blank path stamped on the row')
  const refused = warns.find((e) => e.message === 'plugin.codex.usage_policy_cwd_unusable')
  assert.equal(refused?.fields?.error_kind, 'cwd_blank', 'blank is reported as blank, not as a relative path')
})

test('project() logs an unusable in-band cwd rather than skipping the gate silently', () => {
  /** @type {Array<{ message: string, fields?: Record<string, unknown> }>} */
  const warns = []
  const projector = createCodexExchangeProjector({
    resolver: ignoringResolver('/work/ignored'),
  })
  const log = {
    debug() {},
    info() {},
    error() {},
    /** @param {string} message @param {Record<string, unknown>=} fields */
    warn: (message, fields) => { warns.push({ message, fields }) },
  }
  projector.project(exchange({
    path: '/v1/chat/completions',
    request_body: JSON.stringify({
      cwd: '../elsewhere',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  }), { log })
  const refused = warns.find((e) => e.message === 'plugin.codex.usage_policy_cwd_unusable')
  assert.ok(refused, 'a refused cwd is observable: the row records cwd = NULL and no verdict was computed')
  assert.equal(refused.fields?.operation, 'usage_policy_cwd')
  assert.equal(refused.fields?.status, 'refused')
  assert.equal(refused.fields?.error_kind, 'cwd_not_absolute')
  assert.ok(
    !JSON.stringify(refused.fields).includes('elsewhere'),
    'the refused value is hashed, never logged raw',
  )
})

// ---------------------------------------------------------------------
// Session opt-out (LLP 0066): a second, independent match key at the same
// USAGE_POLICY_DROP seam, keyed on the STAMPED session_id
// (metadata.session_id ?? thread id) rather than cwd.
// ---------------------------------------------------------------------

test('project() drops every conversation_id thread under one ignored session_id (documents the over-drop, R8)', () => {
  const projector = createCodexExchangeProjector()
  const ignoredSessionId = 'session-optout'
  const ctx = {
    log: { debug() {}, info() {}, warn() {}, error() {} },
    isSessionIgnored: (/** @type {string} */ id) => id === ignoredSessionId,
  }

  // Two DIFFERENT conversation_id threads (thread-a, thread-b) share ONE
  // session_id. A Codex session_id is a container of many threads
  // (LLP 0066#scope), so an ignored session suppresses ALL of them: per-
  // thread granularity is a spec non-goal.
  const threadA = projector.project(exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    request_headers: JSON.stringify({
      'x-codex-turn-metadata': JSON.stringify({ session_id: ignoredSessionId, thread_id: 'thread-a' }),
    }),
    request_body: JSON.stringify({ model: 'gpt-5-codex', input: 'go' }),
    response_body: JSON.stringify({ output_text: 'done' }),
  }), ctx)
  const threadB = projector.project(exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    request_headers: JSON.stringify({
      'x-codex-turn-metadata': JSON.stringify({ session_id: ignoredSessionId, thread_id: 'thread-b' }),
    }),
    request_body: JSON.stringify({ model: 'gpt-5-codex', input: 'go again' }),
    response_body: JSON.stringify({ output_text: 'done' }),
  }), ctx)

  assert.equal(threadA, USAGE_POLICY_DROP)
  assert.equal(threadB, USAGE_POLICY_DROP)
})

test('project() leaves a different session in the same run unaffected', () => {
  const projector = createCodexExchangeProjector()
  const ignoredSessionId = 'session-optout-2'
  const ctx = {
    log: { debug() {}, info() {}, warn() {}, error() {} },
    isSessionIgnored: (/** @type {string} */ id) => id === ignoredSessionId,
  }

  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    request_headers: JSON.stringify({
      'x-codex-turn-metadata': JSON.stringify({ session_id: 'session-clean', thread_id: 'thread-c' }),
    }),
    request_body: JSON.stringify({ model: 'gpt-5-codex', input: 'go' }),
    response_body: JSON.stringify({ output_text: 'done' }),
  }), ctx))

  assert.ok(projection && projection !== USAGE_POLICY_DROP, 'an unignored session is projected normally')
  assert.equal(projection.session_id, 'session-clean')
})

test('project() emits a usage_policy_drop log with policy_source: session_opt_out and the matched session_id', () => {
  /** @type {Array<{ message: string, fields?: Record<string, unknown> }>} */
  const infos = []
  const projector = createCodexExchangeProjector()
  const log = {
    debug() {},
    warn() {},
    error() {},
    /** @param {string} message @param {Record<string, unknown>=} fields */
    info: (message, fields) => { infos.push({ message, fields }) },
  }
  const ignoredSessionId = 'session-optout-log'
  const projection = projector.project(exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    request_headers: JSON.stringify({
      'x-codex-turn-metadata': JSON.stringify({ session_id: ignoredSessionId, thread_id: 'thread-x' }),
    }),
    request_body: JSON.stringify({ model: 'gpt-5-codex', input: 'go' }),
    response_body: JSON.stringify({ output_text: 'done' }),
  }), { log, isSessionIgnored: (/** @type {string} */ id) => id === ignoredSessionId })

  assert.equal(projection, USAGE_POLICY_DROP)
  const drop = infos.find((e) => e.message === 'plugin.codex.usage_policy_drop')
  assert.ok(drop, 'expected a usage_policy_drop log entry')
  assert.equal(drop.fields?.policy_source, 'session_opt_out')
  assert.equal(drop.fields?.session_id, ignoredSessionId)
})

test('the session opt-out drop is also visible through the gateway message-projector dispatcher (parity with Claude)', async () => {
  // @ref LLP 0066#requirements [tests]: R8/parity: the Claude adapter proves
  // its ignored-session drop through createAiGatewayMessageProjector /
  // projectViaGateway returning `[]` (claude-usage-policy-drop.test.js). This
  // proves the same shape for Codex: the drop must be visible at the seam
  // callers actually use in production — the gateway dispatcher's
  // `projectExchange` — not just the adapter-level `USAGE_POLICY_DROP`
  // sentinel a direct `projector.project()` call returns.
  const ignoredSessionId = 'session-optout-gateway'
  const projector = createCodexExchangeProjector()
  const dispatcher = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [{ ...projector, _seq: 0 }],
    isSessionIgnored: (/** @type {string} */ id) => id === ignoredSessionId,
  })

  const rows = await dispatcher.projectExchange(exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    request_headers: JSON.stringify({
      'x-codex-turn-metadata': JSON.stringify({ session_id: ignoredSessionId, thread_id: 'thread-gw' }),
    }),
    request_body: JSON.stringify({ model: 'gpt-5-codex', input: 'go' }),
    response_body: JSON.stringify({ output_text: 'done' }),
  }))

  assert.deepEqual(
    rows,
    [],
    'the dispatcher must project nothing for an ignored Codex session, not just return USAGE_POLICY_DROP at the adapter seam'
  )
})

test('match() accepts the three transports it owns and rejects others', () => {
  const projector = createCodexExchangeProjector()
  assert.equal(projector.match(exchange({ path: '/v1/chat/completions' })), true)
  assert.equal(projector.match(exchange({ path: '/v1/responses' })), true)
  assert.equal(projector.match(exchange({ path: '/backend-api/codex/responses' })), true)
  assert.equal(projector.match(exchange({ path: '/backend-api/codex/models' })), true)
  assert.equal(projector.match(exchange({ path: '/v1/messages' })), false)
  assert.equal(projector.match(exchange({ path: '/v1/foo' })), false)
})

test('match() also accepts non-codex paths tagged with x-codex-turn-metadata', () => {
  const projector = createCodexExchangeProjector()
  assert.equal(
    projector.match(exchange({
      path: '/v1/foo',
      request_headers: JSON.stringify({ 'x-codex-turn-metadata': '{}' }),
    })),
    true
  )
})

test('OpenAI Chat projection: request+response messages roll up into user+assistant', () => {
  const projector = createCodexExchangeProjector()
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
  const projector = createCodexExchangeProjector()
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
  const projector = createCodexExchangeProjector()
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
  const projector = createCodexExchangeProjector()
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
  const projector = createCodexExchangeProjector()
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
  const projector = createCodexExchangeProjector()
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
  const projector = createCodexExchangeProjector()
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
  const projector = createCodexExchangeProjector()
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
  const projector = createCodexExchangeProjector()
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
  const projector = createCodexExchangeProjector()
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

test('OpenAI Responses bare-string content array entries project as text blocks', () => {
  // Backfill has always tolerated a bare string inside a content array
  // (older/leaner records); the live path used to silently drop it, so
  // the live row lost content and stopped hash-matching the backfilled
  // row for the same conversation.
  const projector = createCodexExchangeProjector()
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/v1/responses',
    provider: 'openai',
    request_body: JSON.stringify({
      model: 'gpt-5',
      input: [{ role: 'user', content: ['hello there'] }],
    }),
    response_body: JSON.stringify({ id: 'resp_1', output_text: 'hi' }),
  }), context()))

  assert.equal(projection.messages[0].role, 'user')
  assert.deepEqual(projection.messages[0].content, [{ type: 'text', text: 'hello there' }])
})

test('OpenAI Responses reasoning items in input replay project as assistant thinking', () => {
  // A replayed reasoning item carries no `role`; before the shared
  // projection core it fell into the generic branch and was emitted as a
  // `user` text message (its reasoning_text block carries a `text` key),
  // diverging from the backfill's assistant `thinking` shape.
  const projector = createCodexExchangeProjector()
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/v1/responses',
    provider: 'openai',
    request_body: JSON.stringify({
      model: 'gpt-5',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'why?' }] },
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking it through' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'because' }] },
      ],
    }),
    response_body: JSON.stringify({ id: 'resp_1', output_text: 'done' }),
  }), context()))

  assert.deepEqual(
    projection.messages.map((/** @type {any} */ m) => m.role),
    ['user', 'assistant', 'assistant', 'assistant']
  )
  assert.deepEqual(projection.messages[1].content, [{ type: 'thinking', thinking: 'thinking it through' }])

  // Encrypted-only reasoning still projects nothing.
  const encryptedOnly = /** @type {any} */ (projector.project(exchange({
    path: '/v1/responses',
    provider: 'openai',
    request_body: JSON.stringify({
      model: 'gpt-5',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'why?' }] },
        { type: 'reasoning', encrypted_content: 'opaque-blob' },
      ],
    }),
    response_body: JSON.stringify({ id: 'resp_2', output_text: 'done' }),
  }), context()))
  assert.deepEqual(encryptedOnly.messages.map((/** @type {any} */ m) => m.role), ['user', 'assistant'])
})

test('OpenAI Responses custom_tool_call uses payload.input when arguments is missing', () => {
  const projector = createCodexExchangeProjector()
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
  const projector = createCodexExchangeProjector()
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
  const projector = createCodexExchangeProjector()
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
  const projector = createCodexExchangeProjector()
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
  const projector = createCodexExchangeProjector()
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
  const projector = createCodexExchangeProjector()
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
  const projector = createCodexExchangeProjector()
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
  const projector = createCodexExchangeProjector()
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
  const projector = createCodexExchangeProjector()
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
  const projector = createCodexExchangeProjector()
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
  const projector = createCodexExchangeProjector()
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

// ---------------------------------------------------------------------
// A substituted workspace key must not decide a privacy verdict (#476)
//
// @ref LLP 0083#decision [tests]: `selectCodexWorkspace` falls back to the
// first `workspaces` key when none matches the request's cwd. That fallback is
// load-bearing on the subscription route (no in-band cwd at all), but when the
// request DOES state a cwd the substituted key is a guess about a directory the
// session never ran in, and it used to be the `.hypignore` gate's input.
// ---------------------------------------------------------------------

test('the .hypignore gate uses the request cwd, not a substituted workspace key (#476 case a)', () => {
  // The leak: the session really ran in an IGNORED tree, but the only declared
  // workspace is a clean one, so the verdict used to be computed for the clean
  // tree and the opted-out exchange was recorded.
  const projector = createCodexExchangeProjector({
    resolver: ignoringResolver('/work/ignored'),
  })
  const projection = projector.project(exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    request_headers: JSON.stringify({
      'x-codex-turn-metadata': JSON.stringify({
        thread_id: 'thread-476a',
        workspaces: { '/work/clean/proj': {} },
      }),
    }),
    request_body: JSON.stringify({ cwd: '/work/ignored/real', input: 'secret' }),
    response_body: JSON.stringify({ output_text: 'done' }),
  }), context())
  assert.equal(projection, USAGE_POLICY_DROP, 'the request cwd is ignored, so the exchange must drop')
})

test('an unrelated ignored workspace key does not drop a session it never covered (#476 case b)', () => {
  // The mirror failure: the session ran in a clean tree, the only declared
  // workspace is an ignored one, and the substitution used to force a drop.
  const projector = createCodexExchangeProjector({
    resolver: ignoringResolver('/work/ignored'),
  })
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    request_headers: JSON.stringify({
      'x-codex-turn-metadata': JSON.stringify({
        thread_id: 'thread-476b',
        workspaces: { '/work/ignored/proj': {} },
      }),
    }),
    request_body: JSON.stringify({ cwd: '/work/clean/real', input: 'go' }),
    response_body: JSON.stringify({ output_text: 'done' }),
  }), context()))
  assert.ok(projection && projection !== USAGE_POLICY_DROP, 'no .hypignore covers this session')
  assert.equal(projection.cwd, '/work/clean/real', 'the row records where the session actually ran')
})

test('a refused workspace substitution is logged with hashed paths, not silently applied (#476 case c)', () => {
  /** @type {Array<{ message: string, fields?: Record<string, unknown> }>} */
  const warns = []
  const projector = createCodexExchangeProjector({
    resolver: ignoringResolver('/work/ignored'),
  })
  const log = {
    debug() {},
    info() {},
    error() {},
    /** @param {string} message @param {Record<string, unknown>=} fields */
    warn: (message, fields) => { warns.push({ message, fields }) },
  }
  // A relative cwd cannot equal any absolute workspace key, so the
  // substitution used to run AHEAD of any in-band cwd check and drop on the
  // unrelated ignored key without a word in the log.
  const projection = projector.project(exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    request_headers: JSON.stringify({
      'x-codex-turn-metadata': JSON.stringify({
        thread_id: 'thread-476c',
        workspaces: { '/work/ignored/proj': {} },
      }),
    }),
    request_body: JSON.stringify({ cwd: 'sub', input: 'go' }),
    response_body: JSON.stringify({ output_text: 'done' }),
  }), { log })
  assert.ok(projection && projection !== USAGE_POLICY_DROP, 'the guessed workspace must not decide the verdict')
  const refused = warns.find((e) => e.message === 'plugin.codex.usage_policy_workspace_cwd_refused')
  assert.ok(refused, 'expected a usage_policy_workspace_cwd_refused warn')
  assert.equal(refused.fields?.error_kind, 'workspace_cwd_mismatch')
  assert.equal(refused.fields?.component, 'codex')
  // This repo captures LLM traffic: the signal carries hashes, never raw paths.
  assert.ok(
    !JSON.stringify(refused.fields).includes('/work/ignored/proj'),
    'the refused workspace path is hashed, never logged raw',
  )
})

test('a refused workspace substitution still enriches the row from the workspace key (#476)', () => {
  // The substitution keeps its ENRICHMENT role: only the gate/stamp cwd is
  // taken back from it. Losing `workspace` / git identity would be a separate
  // regression (LLP 0032#capture).
  const projector = createCodexExchangeProjector({
    resolver: ignoringResolver('/work/ignored'),
  })
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    request_headers: JSON.stringify({
      'x-codex-turn-metadata': JSON.stringify({
        thread_id: 'thread-476d',
        workspaces: {
          '/work/clean/proj': {
            associated_remote_urls: { origin: 'git@github.com:acme/clean.git' },
            latest_git_commit_hash: 'deadbeef',
          },
        },
      }),
    }),
    request_body: JSON.stringify({ cwd: '/work/clean/elsewhere', input: 'go' }),
    response_body: JSON.stringify({ output_text: 'done' }),
  }), context()))
  assert.equal(projection.cwd, '/work/clean/elsewhere')
  assert.equal(projection.attributes.codex.workspace, '/work/clean/proj')
  assert.equal(projection.git_remote, 'git@github.com:acme/clean.git')
  assert.equal(projection.head_sha, 'deadbeef')
})

test('the workspace key still supplies the gate cwd when the request states none (#476)', () => {
  // The subscription route often carries no cwd at all, and then the workspace
  // key is the ONLY in-band source of one. Refusing it outright would REMOVE
  // real `.hypignore` coverage, so the fallback must survive this fix.
  const projector = createCodexExchangeProjector({
    resolver: ignoringResolver('/work/ignored'),
  })
  const projection = projector.project(exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    request_headers: JSON.stringify({
      'x-codex-turn-metadata': JSON.stringify({
        thread_id: 'thread-476e',
        workspaces: { '/work/ignored/proj': {} },
      }),
    }),
    request_body: JSON.stringify({ input: 'secret' }),
    response_body: JSON.stringify({ output_text: 'done' }),
  }), context())
  assert.equal(projection, USAGE_POLICY_DROP, 'the workspace key is the only cwd there is, so it still gates')
})

test('no workspace-cwd refusal is logged when the key matches or the request states no cwd (#476)', () => {
  // Guards the refusal predicate from the other side: nothing was substituted
  // away, so nothing must be reported. Both negative branches at once - the
  // key matching the request cwd, and no in-band cwd to contradict it.
  /** @type {Array<{ message: string, fields?: Record<string, unknown> }>} */
  const warns = []
  const projector = createCodexExchangeProjector()
  const log = {
    debug() {},
    info() {},
    error() {},
    /** @param {string} message @param {Record<string, unknown>=} fields */
    warn: (message, fields) => { warns.push({ message, fields }) },
  }
  const turnMetadata = { thread_id: 'thread-476f', workspaces: { '/work/clean/proj': {} } }
  for (const body of [{ cwd: '/work/clean/proj', input: 'go' }, { input: 'go' }]) {
    projector.project(exchange({
      path: '/backend-api/codex/responses',
      provider: 'chatgpt',
      request_headers: JSON.stringify({ 'x-codex-turn-metadata': JSON.stringify(turnMetadata) }),
      request_body: JSON.stringify(body),
      response_body: JSON.stringify({ output_text: 'done' }),
    }), { log })
  }
  assert.deepEqual(
    warns.filter((e) => e.message === 'plugin.codex.usage_policy_workspace_cwd_refused'),
    [],
    'an uncontradicted workspace key is not a refusal',
  )
})

test('non-codex provider has no codex turn metadata but still stamps identity_source for symmetry', () => {
  const projector = createCodexExchangeProjector()
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
  const projector = createCodexExchangeProjector()
  assert.equal(projector.project(exchange({ request_body: null }), context()), undefined)
  assert.equal(projector.project(exchange({ request_body: 'not-json' }), context()), undefined)
  assert.equal(projector.project(exchange({ request_body: '[]' }), context()), undefined)
})

test('project() returns undefined when no messages can be extracted', () => {
  const projector = createCodexExchangeProjector()
  // request body parses but has no messages / input
  assert.equal(
    projector.project(exchange({
      path: '/v1/chat/completions',
      request_body: JSON.stringify({ model: 'gpt-4o-mini' }),
    }), context()),
    undefined
  )
})



test('conversation_id falls back to a stable hash when no codex metadata or session id is present', () => {
  const projector = createCodexExchangeProjector()
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
// Lineage surfaces (LLP 0151)
// ---------------------------------------------------------------------

// @ref LLP 0151#body-is-authority [tests]: the flat body `client_metadata` map
// is the only lineage surface Codex fills for every request kind, so a turn
// that carries no Codex header at all must still resolve its thread, session,
// turn and parent thread.
test('Codex lineage resolves from the durable body client_metadata when no lineage header is sent', () => {
  const projector = createCodexExchangeProjector()
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    request_headers: JSON.stringify({}),
    request_body: JSON.stringify({
      model: 'gpt-5-codex',
      input: 'go',
      client_metadata: {
        'x-codex-installation-id': 'install-body',
        session_id: 'session-body',
        thread_id: 'thread-body',
        turn_id: 'turn-body',
        'x-codex-window-id': 'window-body',
        'x-codex-parent-thread-id': 'thread-body-parent',
      },
    }),
    response_body: JSON.stringify({ output_text: 'done' }),
  }), context()))

  assert.equal(projection.conversation_id, 'thread-body')
  assert.equal(projection.session_id, 'session-body')
  assert.equal(projection.parent_thread_id, 'thread-body-parent')
  assert.equal(projection.prompt_id, 'turn-body')
  assert.equal(projection.attributes.codex.thread_id, 'thread-body')
  assert.equal(projection.attributes.codex.session_id, 'session-body')
  assert.equal(projection.attributes.codex.window_id, 'window-body')
  assert.equal(projection.attributes.codex.lineage_source, 'body_client_metadata')
})

// @ref LLP 0151#body-is-a-codex-signal [tests]: the API-key route posts to a
// generic `/v1/responses` with no Codex-namespaced header, so the body map is
// also what identifies the exchange as Codex at all.
test('body client_metadata alone identifies a Codex exchange on a generic responses path', () => {
  const projector = createCodexExchangeProjector()
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/v1/responses',
    request_headers: JSON.stringify({}),
    request_body: JSON.stringify({
      model: 'gpt-5-codex',
      input: 'go',
      client_metadata: {
        'x-codex-installation-id': 'install-api',
        session_id: 'session-api',
        thread_id: 'thread-api',
        'x-codex-window-id': 'window-api',
        'x-codex-turn-metadata': JSON.stringify({
          session_id: 'session-api',
          thread_id: 'thread-api',
          thread_source: 'subagent',
          parent_thread_id: 'thread-api-parent',
          sandbox: 'workspace-write',
          workspaces: { '/work/api': {} },
        }),
      },
    }),
    response_body: JSON.stringify({ output_text: 'done' }),
  }), context()))

  assert.equal(projection.client_name, 'codex')
  assert.equal(projection.conversation_id, 'thread-api')
  assert.equal(projection.session_id, 'session-api')
  // The turn-metadata blob also rides in the body map, so everything it
  // carries (thread_source, sandbox, workspaces) resolves without a header.
  assert.equal(projection.user_type, 'subagent')
  assert.equal(projection.is_sidechain, true)
  assert.equal(projection.parent_thread_id, 'thread-api-parent')
  assert.equal(projection.permission_mode, 'workspace-write')
  assert.equal(projection.cwd, '/work/api')
})

// @ref LLP 0151#real-header-names [tests]: the compatibility headers Codex
// really emits keep working, including `x-codex-parent-thread-id` (the name the
// projector previously got wrong).
test('Codex lineage resolves from the compatibility headers Codex actually sends', () => {
  const projector = createCodexExchangeProjector()
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    request_headers: JSON.stringify({
      'x-codex-window-id': 'window-hdr',
      'x-codex-parent-thread-id': 'thread-hdr-parent',
      'x-openai-subagent': 'collab_spawn',
      'x-codex-turn-metadata': JSON.stringify({
        session_id: 'session-hdr',
        thread_id: 'thread-hdr',
        turn_id: 'turn-hdr',
        thread_source: 'subagent',
        workspaces: { '/work/hdr': {} },
      }),
    }),
    request_body: JSON.stringify({ model: 'gpt-5-codex', input: 'go' }),
    response_body: JSON.stringify({ output_text: 'done' }),
  }), context()))

  assert.equal(projection.conversation_id, 'thread-hdr')
  assert.equal(projection.session_id, 'session-hdr')
  assert.equal(projection.prompt_id, 'turn-hdr')
  assert.equal(projection.is_sidechain, true)
  assert.equal(projection.parent_thread_id, 'thread-hdr-parent')
  assert.equal(projection.attributes.codex.window_id, 'window-hdr')
  assert.equal(projection.attributes.codex.lineage_source, 'turn_metadata')
})

// @ref LLP 0151#real-header-names [tests]: no Codex turn states its lineage
// under these bare names, so reading them only let an unrelated proxy hop or a
// hand-rolled client dictate `conversation_id`, which is the partition-adjacent
// row identity. They must therefore resolve to nothing.
// @ref LLP 0164#header-audit-correction [tests]: `parent-thread-id` is fictional
// outright, while `thread-id` and `session-id` are real on the compaction and
// websocket-handshake paths and still unread, since the turn-metadata blob
// states the same ids for the one request kind that carries them.
test('a bare lineage header name Codex never sends resolves to nothing, not a wrong value', () => {
  const projector = createCodexExchangeProjector()
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    request_headers: JSON.stringify({
      'thread-id': 'phantom-thread',
      'session-id': 'phantom-session',
      'parent-thread-id': 'phantom-parent',
    }),
    request_body: JSON.stringify({ model: 'gpt-5-codex', input: 'go' }),
    response_body: JSON.stringify({ output_text: 'done' }),
  }), context()))

  assert.equal(projection.attributes.codex.thread_id, undefined)
  assert.equal(projection.attributes.codex.session_id, undefined)
  assert.equal(projection.parent_thread_id, undefined)
  assert.equal(projection.attributes.codex.lineage_source, undefined)
  // No lineage was stated, so the row keeps the content-hash fallback identity
  // rather than adopting an id nothing in Codex produced.
  assert.equal(projection.conversation_id.length, 16)
  assert.notEqual(projection.conversation_id, 'phantom-thread')
  assert.equal(projection.session_id, projection.conversation_id)
})

// @ref LLP 0151#body-is-authority [tests]: body and blob are two projections of
// one Codex snapshot and cannot disagree in real traffic; pin which one wins so
// the tie-break is a decision rather than an accident of argument order.
test('body client_metadata wins over the turn-metadata blob when the two disagree', () => {
  const projector = createCodexExchangeProjector()
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    request_headers: JSON.stringify({
      'x-codex-turn-metadata': JSON.stringify({
        session_id: 'session-blob',
        thread_id: 'thread-blob',
        workspaces: { '/work/blob': {} },
      }),
    }),
    request_body: JSON.stringify({
      model: 'gpt-5-codex',
      input: 'go',
      client_metadata: { session_id: 'session-body', thread_id: 'thread-body' },
    }),
    response_body: JSON.stringify({ output_text: 'done' }),
  }), context()))

  assert.equal(projection.conversation_id, 'thread-body')
  assert.equal(projection.session_id, 'session-body')
  assert.equal(projection.attributes.codex.lineage_source, 'body_client_metadata')
  // @ref LLP 0151#lineage-conflict [tests]: the tie-break leaves evidence, so
  // the disagreement the body silently won is on the row and countable.
  assert.equal(projection.attributes.codex.lineage_conflict, 'thread_id,session_id')
})

// @ref LLP 0151#lineage-conflict [tests]: the signal must be absent, not merely
// falsy, for the agreeing traffic that is every turn Codex is known to send, or
// a nonzero conflict count stops being evidence of anything.
test('agreeing lineage surfaces record no lineage_conflict', () => {
  const projector = createCodexExchangeProjector()
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    request_headers: JSON.stringify({
      'x-codex-turn-metadata': JSON.stringify({
        session_id: 'session-agree',
        thread_id: 'thread-agree',
        turn_id: 'turn-agree',
        parent_thread_id: 'parent-agree',
      }),
    }),
    request_body: JSON.stringify({
      model: 'gpt-5-codex',
      input: 'go',
      client_metadata: {
        session_id: 'session-agree',
        thread_id: 'thread-agree',
        turn_id: 'turn-agree',
        'x-codex-parent-thread-id': 'parent-agree',
      },
    }),
    response_body: JSON.stringify({ output_text: 'done' }),
  }), context()))

  assert.equal(projection.conversation_id, 'thread-agree')
  assert.equal(projection.attributes.codex.lineage_source, 'body_client_metadata')
  assert.ok(!('lineage_conflict' in projection.attributes.codex))
})

// @ref LLP 0151#lineage-conflict [tests]: only a real disagreement counts. A
// field one surface omits is the normal per-request-kind shape, not a conflict.
test('a lineage field only one surface states is not a conflict', () => {
  const projector = createCodexExchangeProjector()
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    request_headers: JSON.stringify({
      'x-codex-turn-metadata': JSON.stringify({ thread_source: 'user' }),
    }),
    request_body: JSON.stringify({
      model: 'gpt-5-codex',
      input: 'go',
      client_metadata: { session_id: 'session-solo', thread_id: 'thread-solo' },
    }),
    response_body: JSON.stringify({ output_text: 'done' }),
  }), context()))

  assert.equal(projection.conversation_id, 'thread-solo')
  assert.ok(!('lineage_conflict' in projection.attributes.codex))
})

// @ref LLP 0151#lineage-source [tests]: the recorded name is the surface the
// identity came from. Here the body states only `session_id`, so `thread_id`,
// which is what `conversation_id` keys on, comes from the blob.
test('lineage_source names the surface the thread actually came from', () => {
  const projector = createCodexExchangeProjector()
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    request_headers: JSON.stringify({
      'x-codex-turn-metadata': JSON.stringify({ thread_id: 'thread-from-blob' }),
    }),
    request_body: JSON.stringify({
      model: 'gpt-5-codex',
      input: 'go',
      client_metadata: {
        'x-codex-installation-id': 'install-mixed',
        session_id: 'session-from-body',
      },
    }),
    response_body: JSON.stringify({ output_text: 'done' }),
  }), context()))

  assert.equal(projection.conversation_id, 'thread-from-blob')
  assert.equal(projection.attributes.codex.session_id, 'session-from-body')
  assert.equal(projection.attributes.codex.lineage_source, 'turn_metadata')
  assert.ok(!('lineage_conflict' in projection.attributes.codex))
})

// @ref LLP 0151#body-is-a-codex-signal [tests]: a flat `session_id` +
// `thread_id` pair is not a Codex-exclusive shape, and `/v1/responses` and
// `/v1/chat/completions` are generic matched paths that any OpenAI-compatible
// client posts to. Honouring the pair as evidence of Codex would reopen through
// the body exactly what removing the `thread-id` header closed: an unrelated
// client stamped `client_name: 'codex'` and dictating this row's
// `conversation_id` and `session_id` (the partition key, LLP 0030). So the row
// must come out exactly as if the map had not been sent at all.
test('a non-Codex client sending only a flat client_metadata identity pair is not treated as Codex', () => {
  const projector = createCodexExchangeProjector()
  const flatPair = { session_id: 'foreign-session', thread_id: 'foreign-thread' }
  const shapes = [
    {
      path: '/v1/responses',
      body: { model: 'gpt-5', input: 'go' },
      response_body: JSON.stringify({ output_text: 'done' }),
    },
    {
      path: '/v1/chat/completions',
      body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      response_body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
    },
  ]
  for (const shape of shapes) {
    /** @param {Record<string, unknown>} body */
    const project = (body) => /** @type {any} */ (projector.project(exchange({
      path: shape.path,
      // A user-agent no Codex build produces, and no Codex-namespaced header.
      request_headers: JSON.stringify({ 'user-agent': 'some-agent-framework/2.1' }),
      request_body: JSON.stringify(body),
      response_body: shape.response_body,
    }), context()))

    const projection = project({ ...shape.body, client_metadata: flatPair })
    assert.equal(projection.client_name, undefined, `${shape.path}: must not be stamped codex`)
    assert.notEqual(projection.conversation_id, 'foreign-thread')
    assert.notEqual(projection.session_id, 'foreign-session')
    // `identity_source` is stamped for every row; no lineage attribute is.
    assert.equal(projection.attributes.codex.thread_id, undefined)
    assert.equal(projection.attributes.codex.session_id, undefined)
    assert.equal(projection.attributes.codex.lineage_source, undefined)
    // Strongest form: the ambiguous map contributes nothing, so the row is
    // byte-identical to the same request without it.
    const control = project(shape.body)
    assert.equal(projection.conversation_id, control.conversation_id)
    assert.equal(projection.session_id, control.session_id)
  }
})

// @ref LLP 0151#body-is-a-codex-signal [tests]: corroboration is what makes the
// flat pair readable, not the pair itself, so the guard above must narrow only
// WHO may be called Codex and not WHAT a known Codex client's map carries. A
// Codex-namespaced header is corroboration on its own, so a Codex turn whose map
// states only the flat pair still resolves its lineage from the body.
test('a namespace-corroborated Codex request still resolves lineage from a flat-only client_metadata', () => {
  const projector = createCodexExchangeProjector()
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/v1/responses',
    request_headers: JSON.stringify({ 'x-codex-window-id': 'window-corr' }),
    request_body: JSON.stringify({
      model: 'gpt-5-codex',
      input: 'go',
      client_metadata: { session_id: 'session-corr', thread_id: 'thread-corr' },
    }),
    response_body: JSON.stringify({ output_text: 'done' }),
  }), context()))

  assert.equal(projection.client_name, 'codex')
  assert.equal(projection.conversation_id, 'thread-corr')
  assert.equal(projection.session_id, 'session-corr')
  assert.equal(projection.attributes.codex.lineage_source, 'body_client_metadata')
})

// @ref LLP 0164#flat-pair-corroboration [tests]: the user-agent is a product-name
// convention any local process can copy, so it may name the client but must not
// promote an uncorroborated flat pair into the LLP 0030 partition key. The two
// halves are asserted together: the row is still called Codex (all four signals
// still answer "may be called Codex"), and the flat pair still contributes
// nothing (only the namespace signals answer "may have its flat pair trusted").
test('a Codex user-agent alone does not let a flat client_metadata pair dictate row identity', () => {
  const projector = createCodexExchangeProjector()
  /** @param {Record<string, unknown>} body */
  const project = (body) => /** @type {any} */ (projector.project(exchange({
    path: '/v1/responses',
    request_headers: JSON.stringify({ 'user-agent': 'codex_cli_rs/0.55.0' }),
    request_body: JSON.stringify({ model: 'gpt-5-codex', input: 'go', ...body }),
    response_body: JSON.stringify({ output_text: 'done' }),
  }), context()))

  const projection = project({ client_metadata: { session_id: 'session-ua', thread_id: 'thread-ua' } })
  // Loose half: the user-agent still identifies the client.
  assert.equal(projection.client_name, 'codex')
  assert.equal(projection.client_version, '0.55.0')
  // Strict half: nothing of the unproven pair reaches the row.
  assert.notEqual(projection.conversation_id, 'thread-ua')
  assert.notEqual(projection.session_id, 'session-ua')
  assert.equal(projection.attributes.codex.thread_id, undefined)
  assert.equal(projection.attributes.codex.session_id, undefined)
  assert.equal(projection.attributes.codex.lineage_source, undefined)
  // Strongest form: the row is identical to the same request without the map.
  const control = project({})
  assert.equal(projection.conversation_id, control.conversation_id)
  assert.equal(projection.session_id, control.session_id)
})

// @ref LLP 0164#flat-pair-corroboration [tests]: dropping the user-agent branch
// from the strict predicate must not cost a Codex build that still writes an
// `x-codex-*` entry into its map. That key names the client on its own, so a
// user-agent-only transport keeps full lineage whenever the map is self-naming.
test('a Codex user-agent request keeps its lineage when the map carries a Codex-owned key', () => {
  const projector = createCodexExchangeProjector()
  const projection = /** @type {any} */ (projector.project(exchange({
    path: '/v1/responses',
    request_headers: JSON.stringify({ 'user-agent': 'codex_cli_rs/0.55.0' }),
    request_body: JSON.stringify({
      model: 'gpt-5-codex',
      input: 'go',
      client_metadata: {
        'x-codex-installation-id': 'install-ua',
        session_id: 'session-ua-owned',
        thread_id: 'thread-ua-owned',
      },
    }),
    response_body: JSON.stringify({ output_text: 'done' }),
  }), context()))

  assert.equal(projection.client_name, 'codex')
  assert.equal(projection.conversation_id, 'thread-ua-owned')
  assert.equal(projection.session_id, 'session-ua-owned')
  assert.equal(projection.attributes.codex.lineage_source, 'body_client_metadata')
})

// @ref LLP 0151#body-is-a-codex-signal [tests]: `match` gates on the path (plus
// the turn-metadata header) and never reads the body, while codex-context
// resolution accepts a Codex-owned body map on its own. The two only stay
// consistent because the matched path set covers every route Codex posts to: a
// body-only Codex request on an unmatched path would be rejected at the gate
// before the body was read. Pin that covering assumption rather than widen
// `match` on a hypothetical, so a Codex route the set does not cover fails here
// instead of silently going unrecorded.
test('every route Codex posts to is matched, so a body-only Codex request is never dropped at the gate', () => {
  const projector = createCodexExchangeProjector()
  // The ChatGPT-subscription namespace and the API-key Responses path.
  for (const path of ['/backend-api/codex/responses', '/v1/responses']) {
    const input = exchange({
      path,
      request_headers: JSON.stringify({}),
      request_body: JSON.stringify({
        model: 'gpt-5-codex',
        input: 'go',
        client_metadata: {
          'x-codex-installation-id': 'install-gate',
          session_id: 'session-gate',
          thread_id: 'thread-gate',
        },
      }),
      response_body: JSON.stringify({ output_text: 'done' }),
    })
    assert.equal(projector.match(input), true, `${path} must pass the match gate`)
    const projection = /** @type {any} */ (projector.project(input, context()))
    assert.equal(projection.client_name, 'codex', `${path} must resolve a codex context`)
    assert.equal(projection.conversation_id, 'thread-gate')
  }
})

// @ref LLP 0151#row-identity [tests]: already-recorded shapes must not re-key.
// These literals were captured from the pre-change projector, so a drift in
// `conversation_id` resolution for a shape HypAware already recorded shows up
// here as a changed `message_id` / `part_id`.
test('part_id and message_id stay byte-identical for the turn-metadata shape already recorded', async () => {
  const projector = createCodexExchangeProjector()
  const dispatcher = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [{ ...projector, _seq: 0 }],
  })
  const rows = /** @type {any[]} */ (await dispatcher.projectExchange(exchange({
    path: '/backend-api/codex/responses',
    provider: 'chatgpt',
    request_headers: JSON.stringify({
      'x-codex-window-id': 'window-identity',
      'x-codex-turn-metadata': JSON.stringify({
        session_id: 'session-identity',
        thread_id: 'thread-identity',
        turn_id: 'turn-identity',
        thread_source: 'user',
        workspaces: { '/w': {} },
      }),
    }),
    request_body: JSON.stringify({ model: 'gpt-5-codex', input: 'go' }),
    response_body: JSON.stringify({ output_text: 'done' }),
  })))

  assert.deepEqual(
    rows.map((r) => ({ role: r.role, session_id: r.session_id, conversation_id: r.conversation_id, message_id: r.message_id, part_id: r.part_id })),
    [
      { role: 'user', session_id: 'session-identity', conversation_id: 'thread-identity', message_id: 'e1a2ff876074693f', part_id: 'e1a2ff876074693f#0' },
      { role: 'assistant', session_id: 'session-identity', conversation_id: 'thread-identity', message_id: '179fd16763044acd', part_id: '179fd16763044acd#0' },
    ]
  )
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
