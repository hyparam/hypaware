// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { createOpenAiEmbedder, parseEmbeddingsPayload } from '../../hypaware-core/plugins-workspace/embedder-openai/src/client.js'
import { validateEmbedderConfig } from '../../hypaware-core/plugins-workspace/embedder-openai/src/config.js'

/**
 * @import { EmbedderOpenAiConfig, FetchLike } from '../../hypaware-core/plugins-workspace/embedder-openai/src/types.js'
 */

const SECRET = 'sk-test-secret-value'

/** @returns {EmbedderOpenAiConfig} */
function baseConfig(overrides = {}) {
  const result = validateEmbedderConfig({ api_key_env: 'TEST_EMBED_KEY', ...overrides })
  if (!result.ok) throw new Error('test config invalid')
  return result.config
}

function noopLog() {
  return { debug() {}, info() {}, warn() {}, error() {} }
}

/**
 * Fake fetch that records requests and replies with index-aligned
 * embeddings derived from each input's length.
 *
 * @param {{ status?: number, body?: unknown, reverse?: boolean }} [opts]
 */
function makeFakeFetch(opts = {}) {
  /** @type {Array<{ url: string, headers: Record<string, string>, body: any }>} */
  const requests = []
  /** @type {FetchLike} */
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    requests.push({ url, headers: init.headers, body })
    if (opts.status && opts.status !== 200) {
      return {
        ok: false,
        status: opts.status,
        json: async () => opts.body ?? {},
        text: async () => JSON.stringify(opts.body ?? { error: { message: 'denied' } }),
      }
    }
    const inputs = /** @type {string[]} */ (body.input)
    const data = inputs.map((text, index) => ({ index, embedding: [text.length, 1, 0] }))
    if (opts.reverse) data.reverse()
    const payload = opts.body ?? { data, usage: { prompt_tokens: inputs.length * 3, total_tokens: inputs.length * 3 } }
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    }
  }
  return { requests, fetchImpl }
}

test('embed sends Bearer key from the configured env var and returns aligned vectors', async () => {
  const { requests, fetchImpl } = makeFakeFetch({ reverse: true })
  const embedder = createOpenAiEmbedder({
    config: baseConfig(),
    env: { TEST_EMBED_KEY: SECRET },
    log: noopLog(),
    fetchImpl,
  })
  const result = await embedder.embed(['a', 'bbb', 'cc'])
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://api.openai.com/v1/embeddings')
  assert.equal(requests[0].headers.authorization, `Bearer ${SECRET}`)
  assert.equal(requests[0].body.model, 'text-embedding-3-small')
  // Response entries arrived reversed; alignment must come from `index`.
  assert.deepEqual(Array.from(result.vectors[0]), [1, 1, 0])
  assert.deepEqual(Array.from(result.vectors[1]), [3, 1, 0])
  assert.deepEqual(Array.from(result.vectors[2]), [2, 1, 0])
  assert.equal(result.dimension, 3)
  assert.equal(result.model, 'text-embedding-3-small')
  assert.equal(result.usage?.prompt_tokens, 9)
})

test('embed chunks batches larger than max_batch and preserves order', async () => {
  const { requests, fetchImpl } = makeFakeFetch()
  const embedder = createOpenAiEmbedder({
    config: baseConfig({ max_batch: 2 }),
    env: { TEST_EMBED_KEY: SECRET },
    log: noopLog(),
    fetchImpl,
  })
  const result = await embedder.embed(['a', 'bb', 'ccc', 'dddd', 'eeeee'])
  assert.equal(requests.length, 3)
  assert.deepEqual(result.vectors.map((v) => v[0]), [1, 2, 3, 4, 5])
})

test('embed without the env var sends no Authorization header (localhost servers)', async () => {
  const { requests, fetchImpl } = makeFakeFetch()
  const embedder = createOpenAiEmbedder({
    config: baseConfig(),
    env: {},
    log: noopLog(),
    fetchImpl,
  })
  await embedder.embed(['a'])
  assert.equal(requests[0].headers.authorization, undefined)
})

test('embed maps a 401 without a key to a hint naming the env var, never the value', async () => {
  const { fetchImpl } = makeFakeFetch({ status: 401 })
  const embedder = createOpenAiEmbedder({
    config: baseConfig(),
    env: {},
    log: noopLog(),
    fetchImpl,
  })
  await assert.rejects(
    () => embedder.embed(['a']),
    (/** @type {Error & { hypErrorKind?: string }} */ err) => {
      assert.equal(err.hypErrorKind, 'embedder_http_401')
      assert.match(err.message, /TEST_EMBED_KEY is unset/)
      return true
    }
  )
})

test('embed error messages never contain the API key', async () => {
  const { fetchImpl } = makeFakeFetch({ status: 500 })
  const embedder = createOpenAiEmbedder({
    config: baseConfig(),
    env: { TEST_EMBED_KEY: SECRET },
    log: noopLog(),
    fetchImpl,
  })
  await assert.rejects(
    () => embedder.embed(['a']),
    (/** @type {Error} */ err) => {
      assert.ok(!err.message.includes(SECRET), 'key must not leak into the error message')
      return true
    }
  )
})

test('embed errors and logs never contain the provider error body', async () => {
  // A provider/proxy may echo the input texts or credentials back in
  // its error detail; the client must not copy any of the body into
  // the thrown (and therefore logged) message.
  const echoed = 'PROVIDER_ECHOED_INPUT_TEXT sk-leaked-key'
  const { fetchImpl } = makeFakeFetch({ status: 400, body: { error: { message: echoed } } })
  /** @type {string[]} */
  const loggedMessages = []
  const log = {
    debug() {},
    info() {},
    warn() {},
    /** @param {string} _event @param {Record<string, unknown>} fields */
    error(_event, fields) { loggedMessages.push(JSON.stringify(fields)) },
  }
  const embedder = createOpenAiEmbedder({
    config: baseConfig(),
    env: { TEST_EMBED_KEY: SECRET },
    log,
    fetchImpl,
  })
  await assert.rejects(
    () => embedder.embed(['a']),
    (/** @type {Error & { hypErrorKind?: string, status?: number }} */ err) => {
      assert.equal(err.hypErrorKind, 'embedder_http_400')
      assert.equal(err.status, 400)
      assert.ok(!err.message.includes('PROVIDER_ECHOED'), 'provider body must not reach the error message')
      assert.match(err.message, /HTTP 400/)
      return true
    }
  )
  assert.equal(loggedMessages.length, 1)
  assert.ok(!loggedMessages[0].includes('PROVIDER_ECHOED'), 'provider body must not reach logs')
  assert.ok(!loggedMessages[0].includes(SECRET), 'key must not reach logs')
})

test('embed rejects an empty input batch', async () => {
  const { fetchImpl } = makeFakeFetch()
  const embedder = createOpenAiEmbedder({
    config: baseConfig(),
    env: {},
    log: noopLog(),
    fetchImpl,
  })
  await assert.rejects(
    () => embedder.embed([]),
    (/** @type {Error & { hypErrorKind?: string }} */ err) => err.hypErrorKind === 'embedder_empty_input'
  )
})

test('embed surfaces a count mismatch as embedder_bad_response', async () => {
  const { fetchImpl } = makeFakeFetch({ body: { data: [] } })
  const embedder = createOpenAiEmbedder({
    config: baseConfig(),
    env: {},
    log: noopLog(),
    fetchImpl,
  })
  await assert.rejects(
    () => embedder.embed(['a', 'b']),
    (/** @type {Error & { hypErrorKind?: string }} */ err) => err.hypErrorKind === 'embedder_bad_response'
  )
})

test('parseEmbeddingsPayload rejects a malformed entry and a missing index', () => {
  assert.throws(() => parseEmbeddingsPayload({ data: [{ index: 0, embedding: [] }] }, 1, 'x'))
  assert.throws(() => parseEmbeddingsPayload({ data: [{ index: 1, embedding: [1] }, { index: 1, embedding: [1] }] }, 2, 'x'))
})
