// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { createAnthropicCompletion, parseAnthropicMessageResponse } from '../../hypaware-core/plugins-workspace/completion-anthropic/src/client.js'
import { validateAnthropicCompletionConfig } from '../../hypaware-core/plugins-workspace/completion-anthropic/src/config.js'

/**
 * @import { AnthropicCompletionConfig, FetchLike } from '../../hypaware-core/plugins-workspace/completion-anthropic/src/types.d.ts'
 */

const SECRET = 'sk-ant-test-secret-value'

/** @returns {AnthropicCompletionConfig} */
function baseConfig(overrides = {}) {
  const result = validateAnthropicCompletionConfig({ api_key_env: 'TEST_ANT_KEY', ...overrides })
  if (!result.ok) throw new Error('test config invalid')
  return result.config
}

function noopLog() {
  return { debug() {}, info() {}, warn() {}, error() {} }
}

/**
 * Fake fetch for the Messages API. Records requests and replies with a
 * fixed assistant message (text + tool_use), or a configured error/refusal.
 *
 * @param {{ status?: number, body?: unknown, payload?: unknown }} [opts]
 */
function makeFakeFetch(opts = {}) {
  /** @type {Array<{ url: string, headers: Record<string, string>, body: any }>} */
  const requests = []
  /** @type {FetchLike} */
  const fetchImpl = async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body ?? '{}') })
    if (opts.status && opts.status !== 200) {
      return {
        ok: false,
        status: opts.status,
        json: async () => opts.body ?? {},
        text: async () => JSON.stringify(opts.body ?? { error: { message: 'denied' } }),
      }
    }
    const payload = opts.payload ?? {
      id: 'msg_1',
      model: 'claude-opus-4-8',
      role: 'assistant',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'tool_use', id: 'tu_1', name: 'emit', input: { ok: true } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 11, output_tokens: 7 },
    }
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    }
  }
  return { requests, fetchImpl }
}

/** @param {string[]} chunks */
function streamFetch(chunks) {
  /** @type {Array<{ url: string, body: any }>} */
  const requests = []
  /** @type {FetchLike} */
  const fetchImpl = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body ?? '{}') })
    async function* gen() {
      for (const c of chunks) yield c
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '', body: gen() }
  }
  return { requests, fetchImpl }
}

test('complete sends x-api-key + anthropic-version, lifts system, maps tools, parses blocks', async () => {
  const { requests, fetchImpl } = makeFakeFetch()
  const completion = createAnthropicCompletion({ config: baseConfig(), env: { TEST_ANT_KEY: SECRET }, log: noopLog(), fetchImpl })
  const result = await completion.complete({
    system: 'be terse',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 256,
    tools: [{ name: 'emit', input_schema: { type: 'object', properties: {} } }],
  })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://api.anthropic.com/v1/messages')
  assert.equal(requests[0].headers['x-api-key'], SECRET)
  assert.equal(requests[0].headers['anthropic-version'], '2023-06-01')
  assert.equal(requests[0].body.system, 'be terse')
  assert.equal(requests[0].body.model, 'claude-opus-4-8')
  assert.equal(requests[0].body.max_tokens, 256)
  assert.equal(requests[0].body.tools[0].name, 'emit')
  assert.equal(requests[0].body.messages[0].role, 'user')
  // Response parsing
  assert.equal(result.stopReason, 'tool_use')
  assert.equal(result.usage?.input_tokens, 11)
  assert.equal(result.usage?.output_tokens, 7)
  assert.ok(Array.isArray(result.message.content))
  const toolUse = result.message.content.find((b) => b.type === 'tool_use')
  assert.equal(toolUse?.name, 'emit')
  assert.deepEqual(toolUse?.input, { ok: true })
})

test('complete picks per-request model over the provider default (tiering)', async () => {
  const { requests, fetchImpl } = makeFakeFetch()
  const completion = createAnthropicCompletion({ config: baseConfig(), env: { TEST_ANT_KEY: SECRET }, log: noopLog(), fetchImpl })
  await completion.complete({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'x' }], max_tokens: 64 })
  assert.equal(requests[0].body.model, 'claude-haiku-4-5')
})

test('complete merges params (thinking/output_config) and lifts betas to the anthropic-beta header', async () => {
  const { requests, fetchImpl } = makeFakeFetch()
  const completion = createAnthropicCompletion({ config: baseConfig(), env: { TEST_ANT_KEY: SECRET }, log: noopLog(), fetchImpl })
  await completion.complete({
    messages: [{ role: 'user', content: 'x' }],
    max_tokens: 64,
    responseFormat: { type: 'json_schema', schema: { type: 'object' } },
    params: { thinking: { type: 'adaptive' }, output_config: { effort: 'high' }, betas: ['beta-a', 'beta-b'] },
  })
  assert.deepEqual(requests[0].body.thinking, { type: 'adaptive' })
  assert.equal(requests[0].body.output_config.effort, 'high')
  assert.deepEqual(requests[0].body.output_config.format, { type: 'json_schema', schema: { type: 'object' } })
  assert.equal(requests[0].headers['anthropic-beta'], 'beta-a,beta-b')
  assert.equal('betas' in requests[0].body, false)
})

test('complete returns a refusal as stopReason without throwing (HTTP 200)', async () => {
  const { fetchImpl } = makeFakeFetch({
    payload: { id: 'msg_2', model: 'claude-opus-4-8', role: 'assistant', content: [], stop_reason: 'refusal', usage: { input_tokens: 5, output_tokens: 0 } },
  })
  const completion = createAnthropicCompletion({ config: baseConfig(), env: { TEST_ANT_KEY: SECRET }, log: noopLog(), fetchImpl })
  const result = await completion.complete({ messages: [{ role: 'user', content: 'x' }], max_tokens: 64 })
  assert.equal(result.stopReason, 'refusal')
  assert.deepEqual(result.message.content, [])
})

test('complete translates the neutral toolChoice to the Anthropic shape', async () => {
  const { requests, fetchImpl } = makeFakeFetch()
  const completion = createAnthropicCompletion({ config: baseConfig(), env: { TEST_ANT_KEY: SECRET }, log: noopLog(), fetchImpl })
  await completion.complete({ messages: [{ role: 'user', content: 'x' }], max_tokens: 64, toolChoice: { name: 'emit' } })
  assert.deepEqual(requests[0].body.tool_choice, { type: 'tool', name: 'emit' })

  const any = makeFakeFetch()
  const c2 = createAnthropicCompletion({ config: baseConfig(), env: { TEST_ANT_KEY: SECRET }, log: noopLog(), fetchImpl: any.fetchImpl })
  await c2.complete({ messages: [{ role: 'user', content: 'x' }], max_tokens: 64, toolChoice: 'required' })
  assert.deepEqual(any.requests[0].body.tool_choice, { type: 'any' })
})

test('complete without the env var sends no x-api-key (localhost proxies)', async () => {
  const { requests, fetchImpl } = makeFakeFetch()
  const completion = createAnthropicCompletion({ config: baseConfig(), env: {}, log: noopLog(), fetchImpl })
  await completion.complete({ messages: [{ role: 'user', content: 'x' }], max_tokens: 64 })
  assert.equal('x-api-key' in requests[0].headers, false)
})

test('complete maps a 401 without a key to a hint and never leaks the key or provider body', async () => {
  const echoed = 'PROVIDER_ECHOED_PROMPT sk-leaked'
  const { fetchImpl } = makeFakeFetch({ status: 401, body: { error: { message: echoed } } })
  const completion = createAnthropicCompletion({ config: baseConfig(), env: {}, log: noopLog(), fetchImpl })
  await assert.rejects(
    () => completion.complete({ messages: [{ role: 'user', content: 'x' }], max_tokens: 64 }),
    (/** @type {Error & { hypErrorKind?: string, status?: number }} */ err) => {
      assert.equal(err.hypErrorKind, 'completion_http_401')
      assert.equal(err.status, 401)
      assert.ok(!err.message.includes('PROVIDER_ECHOED'), 'provider body must not reach the error message')
      assert.match(err.message, /x-api-key is unset/)
      return true
    }
  )
})

test('complete rejects an empty messages array', async () => {
  const { fetchImpl } = makeFakeFetch()
  const completion = createAnthropicCompletion({ config: baseConfig(), env: {}, log: noopLog(), fetchImpl })
  await assert.rejects(
    () => completion.complete({ messages: [], max_tokens: 64 }),
    (/** @type {Error & { hypErrorKind?: string }} */ err) => err.hypErrorKind === 'completion_empty_messages'
  )
})

test('stream yields text deltas then a terminal stopReason + usage', async () => {
  const chunks = [
    'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-4-8","usage":{"input_tokens":9}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ]
  const { fetchImpl } = streamFetch(chunks)
  const completion = createAnthropicCompletion({ config: baseConfig(), env: { TEST_ANT_KEY: SECRET }, log: noopLog(), fetchImpl })
  /** @type {string[]} */
  const text = []
  /** @type {string | undefined} */
  let stopReason
  /** @type {{ input_tokens?: number, output_tokens?: number } | undefined} */
  let usage
  for await (const delta of completion.stream({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 64 })) {
    if (delta.text) text.push(delta.text)
    if (delta.stopReason) stopReason = delta.stopReason
    if (delta.usage) usage = delta.usage
  }
  assert.equal(text.join(''), 'Hello')
  assert.equal(stopReason, 'end_turn')
  assert.equal(usage?.input_tokens, 9)
  assert.equal(usage?.output_tokens, 4)
})

test('parseAnthropicMessageResponse rejects a payload with no content array', () => {
  assert.throws(
    () => parseAnthropicMessageResponse({ stop_reason: 'end_turn' }, { model: 'm', endpoint: 'x' }),
    (/** @type {Error & { hypErrorKind?: string }} */ err) => err.hypErrorKind === 'completion_bad_response'
  )
})

// --- Message Batches ---------------------------------------------------------

/**
 * Fake fetch routing the three batch endpoints: POST /batches (submit),
 * GET /batches/{id} (poll), and GET <results_url> (JSONL results).
 *
 * @param {{ jsonl: string, status?: string }} opts
 */
function batchFetch(opts) {
  const RESULTS_URL = 'https://api.anthropic.com/v1/messages/batches/batch_1/results'
  /** @type {Array<{ url: string, method: string, headers: Record<string, string>, body: any }>} */
  const requests = []
  /** @type {FetchLike} */
  const fetchImpl = async (url, init) => {
    requests.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined })
    const status = opts.status ?? 'ended'
    if (init.method === 'POST' && url.endsWith('/batches')) {
      return { ok: true, status: 200, json: async () => ({ id: 'batch_1', processing_status: 'in_progress', request_counts: { processing: 2 } }), text: async () => '' }
    }
    if (init.method === 'GET' && url.endsWith('/batches/batch_1')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'batch_1', processing_status: status, request_counts: { processing: 0, succeeded: 1, errored: 1 }, results_url: status === 'ended' ? RESULTS_URL : null }),
        text: async () => '',
      }
    }
    if (init.method === 'GET' && url === RESULTS_URL) {
      return { ok: true, status: 200, json: async () => ({}), text: async () => opts.jsonl }
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' }
  }
  return { requests, fetchImpl }
}

/** @param {FetchLike} fetchImpl */
function batchClient(fetchImpl) {
  return createAnthropicCompletion({ config: baseConfig(), env: { TEST_ANT_KEY: SECRET }, log: noopLog(), fetchImpl })
}

test('batch.submit posts {requests:[{custom_id,params}]} to /v1/messages/batches with auth', async () => {
  const { requests, fetchImpl } = batchFetch({ jsonl: '' })
  const completion = batchClient(fetchImpl)
  const status = await /** @type {any} */ (completion).batch.submit([
    { customId: 'a', request: { messages: [{ role: 'user', content: 'hi' }], max_tokens: 100, model: 'claude-haiku-4-5', tools: [{ name: 'emit', input_schema: { type: 'object' } }], toolChoice: { name: 'emit' } } },
    { customId: 'b', request: { messages: [{ role: 'user', content: 'yo' }], max_tokens: 100 } },
  ])
  assert.equal(status.id, 'batch_1')
  assert.equal(status.status, 'in_progress')
  const submit = requests[0]
  assert.match(submit.url, /\/v1\/messages\/batches$/)
  assert.equal(submit.headers['x-api-key'], SECRET)
  assert.equal(submit.body.requests.length, 2)
  assert.equal(submit.body.requests[0].custom_id, 'a')
  assert.equal(submit.body.requests[0].params.model, 'claude-haiku-4-5', 'per-request model rides in params')
  assert.deepEqual(submit.body.requests[0].params.tool_choice, { type: 'tool', name: 'emit' }, 'neutral toolChoice translated into the batch params')
})

test('batch.poll returns the normalized status with counts', async () => {
  const { fetchImpl } = batchFetch({ jsonl: '' })
  const status = await /** @type {any} */ (batchClient(fetchImpl)).batch.poll('batch_1')
  assert.equal(status.status, 'ended')
  assert.deepEqual(status.counts, { processing: 0, succeeded: 1, errored: 1, canceled: undefined, expired: undefined })
})

test('batch.results normalizes succeeded (incl. refusal) and surfaces only the error category', async () => {
  const jsonl = [
    JSON.stringify({ custom_id: 'ok', result: { type: 'succeeded', message: { id: 'm', model: 'claude-opus-4-8', role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'curate_decisions', input: { decisions: [] } }], stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 3 } } } }),
    JSON.stringify({ custom_id: 'refused', result: { type: 'succeeded', message: { id: 'm2', model: 'claude-opus-4-8', role: 'assistant', content: [], stop_reason: 'refusal' } } }),
    JSON.stringify({ custom_id: 'bad', result: { type: 'errored', error: { type: 'invalid_request', message: 'SECRET PROMPT LEAK' } } }),
    JSON.stringify({ custom_id: 'gone', result: { type: 'expired' } }),
  ].join('\n')
  const { fetchImpl } = batchFetch({ jsonl })
  const results = await /** @type {any} */ (batchClient(fetchImpl)).batch.results('batch_1')
  const byId = Object.fromEntries(results.map((/** @type {any} */ r) => [r.customId, r]))
  assert.equal(byId.ok.result.message.content[0].name, 'curate_decisions')
  assert.equal(byId.refused.result.stopReason, 'refusal', 'a refusal is a successful result, not an error')
  assert.equal(byId.bad.error.type, 'invalid_request')
  assert.equal(byId.bad.error.message, undefined, 'provider error message is never surfaced (no prompt leak)')
  assert.equal(byId.gone.error.type, 'expired')
})

test('batch.results returns [] while the job is still in progress (caller polls again)', async () => {
  const { fetchImpl } = batchFetch({ jsonl: 'unused', status: 'in_progress' })
  const results = await /** @type {any} */ (batchClient(fetchImpl)).batch.results('batch_1')
  assert.deepEqual(results, [])
})

test('batch.submit rejects an empty request list', async () => {
  const { fetchImpl } = batchFetch({ jsonl: '' })
  await assert.rejects(
    () => /** @type {any} */ (batchClient(fetchImpl)).batch.submit([]),
    (/** @type {Error & { hypErrorKind?: string }} */ err) => err.hypErrorKind === 'completion_empty_messages'
  )
})
