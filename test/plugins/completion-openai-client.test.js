// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { createOpenAiCompletion, parseOpenAiChatResponse } from '../../hypaware-core/plugins-workspace/completion-openai/src/client.js'
import { validateOpenAiCompletionConfig } from '../../hypaware-core/plugins-workspace/completion-openai/src/config.js'

/**
 * @import { FetchLike, OpenAiCompletionConfig } from '../../hypaware-core/plugins-workspace/completion-openai/src/types.d.ts'
 */

const SECRET = 'sk-openai-test-secret'

/** @returns {OpenAiCompletionConfig} */
function baseConfig(overrides = {}) {
  const result = validateOpenAiCompletionConfig({ api_key_env: 'TEST_OAI_KEY', ...overrides })
  if (!result.ok) throw new Error('test config invalid')
  return result.config
}

function noopLog() {
  return { debug() {}, info() {}, warn() {}, error() {} }
}

/**
 * @param {{ status?: number, body?: unknown, payload?: unknown }} [opts]
 */
function makeFakeFetch(opts = {}) {
  /** @type {Array<{ url: string, headers: Record<string, string>, body: any }>} */
  const requests = []
  /** @type {FetchLike} */
  const fetchImpl = async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) })
    if (opts.status && opts.status !== 200) {
      return {
        ok: false,
        status: opts.status,
        json: async () => opts.body ?? {},
        text: async () => JSON.stringify(opts.body ?? { error: { message: 'denied' } }),
      }
    }
    const payload = opts.payload ?? {
      id: 'cmpl_1',
      model: 'gpt-4o-mini',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'hi there',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'emit', arguments: '{"ok":true}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 5 },
    }
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) }
  }
  return { requests, fetchImpl }
}

/** @param {string[]} chunks */
function streamFetch(chunks) {
  /** @type {FetchLike} */
  const fetchImpl = async () => {
    async function* gen() {
      for (const c of chunks) yield c
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '', body: gen() }
  }
  return { fetchImpl }
}

test('complete sends Bearer key, leading system message, function tools; parses content + tool_calls', async () => {
  const { requests, fetchImpl } = makeFakeFetch()
  const completion = createOpenAiCompletion({ config: baseConfig(), env: { TEST_OAI_KEY: SECRET }, log: noopLog(), fetchImpl })
  const result = await completion.complete({
    system: 'be terse',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 128,
    tools: [{ name: 'emit', description: 'emit', input_schema: { type: 'object', properties: {} } }],
  })
  assert.equal(requests[0].url, 'https://api.openai.com/v1/chat/completions')
  assert.equal(requests[0].headers.authorization, `Bearer ${SECRET}`)
  assert.equal(requests[0].body.messages[0].role, 'system')
  assert.equal(requests[0].body.messages[0].content, 'be terse')
  assert.equal(requests[0].body.messages[1].role, 'user')
  assert.equal(requests[0].body.tools[0].type, 'function')
  assert.equal(requests[0].body.tools[0].function.name, 'emit')
  // parsing
  assert.equal(result.stopReason, 'tool_calls')
  assert.equal(result.usage?.input_tokens, 12)
  assert.equal(result.usage?.output_tokens, 5)
  assert.ok(Array.isArray(result.message.content))
  const toolUse = result.message.content.find((b) => b.type === 'tool_use')
  assert.equal(toolUse?.name, 'emit')
  assert.deepEqual(toolUse?.input, { ok: true })
})

test('complete uses the per-request model over the default (tiering)', async () => {
  const { requests, fetchImpl } = makeFakeFetch()
  const completion = createOpenAiCompletion({ config: baseConfig(), env: { TEST_OAI_KEY: SECRET }, log: noopLog(), fetchImpl })
  await completion.complete({ model: 'llama3.1', messages: [{ role: 'user', content: 'x' }], max_tokens: 64 })
  assert.equal(requests[0].body.model, 'llama3.1')
})

test('complete passes responseFormat and params (tool_choice) through', async () => {
  const { requests, fetchImpl } = makeFakeFetch()
  const completion = createOpenAiCompletion({ config: baseConfig(), env: { TEST_OAI_KEY: SECRET }, log: noopLog(), fetchImpl })
  await completion.complete({
    messages: [{ role: 'user', content: 'x' }],
    max_tokens: 64,
    responseFormat: { type: 'json_schema', json_schema: { name: 's', schema: { type: 'object' } } },
    params: { tool_choice: { type: 'function', function: { name: 'emit' } }, temperature: 0 },
  })
  assert.equal(requests[0].body.response_format.type, 'json_schema')
  assert.deepEqual(requests[0].body.tool_choice, { type: 'function', function: { name: 'emit' } })
  assert.equal(requests[0].body.temperature, 0)
})

test('complete translates the neutral toolChoice to OpenAI shape (wins over params)', async () => {
  const { requests, fetchImpl } = makeFakeFetch()
  const completion = createOpenAiCompletion({ config: baseConfig(), env: { TEST_OAI_KEY: SECRET }, log: noopLog(), fetchImpl })
  await completion.complete({
    messages: [{ role: 'user', content: 'x' }],
    max_tokens: 64,
    toolChoice: { name: 'emit' },
    params: { tool_choice: 'auto' },
  })
  assert.deepEqual(requests[0].body.tool_choice, { type: 'function', function: { name: 'emit' } })

  const required = makeFakeFetch()
  const c2 = createOpenAiCompletion({ config: baseConfig(), env: { TEST_OAI_KEY: SECRET }, log: noopLog(), fetchImpl: required.fetchImpl })
  await c2.complete({ messages: [{ role: 'user', content: 'x' }], max_tokens: 64, toolChoice: 'required' })
  assert.equal(required.requests[0].body.tool_choice, 'required')
})

test('complete without the env var sends no Authorization (localhost servers)', async () => {
  const { requests, fetchImpl } = makeFakeFetch()
  const completion = createOpenAiCompletion({ config: baseConfig(), env: {}, log: noopLog(), fetchImpl })
  await completion.complete({ messages: [{ role: 'user', content: 'x' }], max_tokens: 64 })
  assert.equal(requests[0].headers.authorization, undefined)
})

test('complete maps a 401 without a key to a hint and never leaks key or provider body', async () => {
  const echoed = 'PROVIDER_ECHOED_PROMPT sk-leaked'
  const { fetchImpl } = makeFakeFetch({ status: 401, body: { error: { message: echoed } } })
  const completion = createOpenAiCompletion({ config: baseConfig(), env: {}, log: noopLog(), fetchImpl })
  await assert.rejects(
    () => completion.complete({ messages: [{ role: 'user', content: 'x' }], max_tokens: 64 }),
    (/** @type {Error & { hypErrorKind?: string }} */ err) => {
      assert.equal(err.hypErrorKind, 'completion_http_401')
      assert.match(err.message, /TEST_OAI_KEY is unset/)
      assert.ok(!err.message.includes('PROVIDER_ECHOED'))
      return true
    }
  )
})

test('complete rejects an empty messages array', async () => {
  const { fetchImpl } = makeFakeFetch()
  const completion = createOpenAiCompletion({ config: baseConfig(), env: {}, log: noopLog(), fetchImpl })
  await assert.rejects(
    () => completion.complete({ messages: [], max_tokens: 64 }),
    (/** @type {Error & { hypErrorKind?: string }} */ err) => err.hypErrorKind === 'completion_empty_messages'
  )
})

test('stream yields text deltas then a terminal stopReason + usage, stopping at [DONE]', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\n',
    'data: [DONE]\n\n',
  ]
  const { fetchImpl } = streamFetch(chunks)
  const completion = createOpenAiCompletion({ config: baseConfig(), env: { TEST_OAI_KEY: SECRET }, log: noopLog(), fetchImpl })
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
  assert.equal(stopReason, 'stop')
  assert.equal(usage?.input_tokens, 7)
  assert.equal(usage?.output_tokens, 2)
})

test('parseOpenAiChatResponse rejects a payload with no choices', () => {
  assert.throws(
    () => parseOpenAiChatResponse({ usage: {} }, { model: 'm', endpoint: 'x' }),
    (/** @type {Error & { hypErrorKind?: string }} */ err) => err.hypErrorKind === 'completion_bad_response'
  )
})
