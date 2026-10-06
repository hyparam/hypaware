// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createOllamaExchangeProjector, ollamaUpstreamPreset } from '../../hypaware-core/plugins-workspace/ollama/src/projector.js'
import { AI_GATEWAY_MESSAGE_COLUMNS, createAiGatewayMessageProjector } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
import { createRecorder } from '../../hypaware-core/plugins-workspace/ai-gateway/src/recorder.js'
import { CAPTURE_BYTES } from '../../hypaware-core/plugins-workspace/ai-gateway/src/process_transport.js'
import { createCodexExchangeProjector } from '../../hypaware-core/plugins-workspace/codex/src/exchange-projector.js'
import { createClaudeExchangeProjector } from '../../hypaware-core/plugins-workspace/claude/src/projector.js'
import { createOpenclawExchangeProjector } from '../../hypaware-core/plugins-workspace/openclaw/src/projector.js'
import { USAGE_POLICY_DROP } from '../../src/core/usage-policy/index.js'
import { createCacheSpool, SPOOL_DIR } from '../../src/core/cache/spool.js'

/** @import { AiGatewayExchangeInput } from '../../hypaware-plugin-kernel-types.js' */

const terminal = (overrides = {}) => ({ model: 'gemma3:4b', message: { role: 'assistant', content: 'answer' }, done: true, done_reason: 'stop', created_at: '2026-10-06T07:00:01Z', ...overrides })
const request = (overrides = {}) => ({ model: 'gemma3:4b', messages: [{ role: 'user', content: 'hello' }], stream: false, ...overrides })
/** @param {Partial<AiGatewayExchangeInput>} [overrides] @returns {AiGatewayExchangeInput} */
function exchange(overrides = {}) {
  return { exchange_id: 'exchange-1', ts_start: '2026-10-06T07:00:00Z', ts_end: '2026-10-06T07:00:02Z', duration_ms: 2000, upstream: 'ollama', provider: 'ollama', method: 'POST', path: '/api/chat', status_code: 200, request_bytes: null, response_bytes: null, is_sse: false, stream_event_count: 0, request_headers: null, response_headers: null, error: null, metadata: null, stream_events: [], request_body: JSON.stringify(request()), response_body: JSON.stringify(terminal()), ...overrides }
}
function context() {
  /** @type {Array<{ event: string, fields?: Record<string, unknown> }>} */
  const logs = []
  const emit = (event, fields) => { logs.push({ event, fields }) }
  return { logs, log: { info: emit, warn: emit, error: emit, debug: emit } }
}
/** @param {AiGatewayExchangeInput} input */
async function rows(input) {
  const ctx = context()
  const writer = createAiGatewayMessageProjector({ gatewayId: 'ollama-test', projectors: [{ ...createOllamaExchangeProjector(), _seq: 0 }], log: ctx.log })
  return { rows: await writer.projectExchange(input), logs: ctx.logs }
}
/** @param {Record<string, unknown>} row */
const attrs = row => /** @type {Record<string, any>} */ (row.attributes)

test('route and projector claim only exact native Ollama POST chat including query strings', () => {
  const preset = ollamaUpstreamPreset()
  assert.equal(preset.base_url, 'http://127.0.0.1:11434')
  assert.equal(preset.provider, 'ollama')
  assert.equal(preset.path_prefix, '/api/chat')
  assert.equal(preset.match?.({ method: 'POST', path: '/api/chat', headers: {} }), true)
  const projector = createOllamaExchangeProjector()
  assert.equal(projector.match(exchange({ path: '/api/chat?private=value' })), true)
  for (const overrides of [{ method: 'GET' }, { path: '/api/chat/extra' }, { path: '/api/generate' }, { path: '/v1/chat/completions' }, { upstream: 'openai' }, { provider: 'openai' }]) {
    assert.equal(projector.match(exchange(overrides)), false)
  }
  assert.equal(preset.match?.({ method: 'GET', path: '/api/chat', headers: {} }), false)
  assert.equal(preset.match?.({ method: 'POST', path: '/api/chat/extra', headers: {} }), false)
  const input = exchange()
  assert.equal(createCodexExchangeProjector().match(input), false)
  assert.equal(createClaudeExchangeProjector({ homeDir: '/unused', stateFile: '/unused/state' }).match(input), false)
  assert.equal(createOpenclawExchangeProjector().match(input), false)
})

// @ref LLP 0469#exchange-scope [tests]: empty and equal context positions remain real ordered linked rows
test('JSON rows preserve empty system/user/historical assistant and equal positions; usage only on new response', async () => {
  const messages = [{ role: 'system', content: '' }, { role: 'user', content: '' }, { role: 'assistant', content: '' }, { role: 'user', content: 'same' }, { role: 'user', content: 'same' }]
  const input = exchange({ request_body: JSON.stringify(request({ messages })), response_body: JSON.stringify(terminal({ message: { role: 'assistant', content: '' }, prompt_eval_count: 16, prompt_eval_cached_count: 11, eval_count: 0 })) })
  const first = (await rows(input)).rows
  assert.equal(first.length, 6)
  assert.deepEqual(first.map(row => row.role), ['system', 'user', 'assistant', 'user', 'user', 'assistant'])
  assert.deepEqual(first.map(row => row.message_index), [0, 1, 2, 3, 4, 5])
  assert.deepEqual(first.map(row => row.part_index), [0, 0, 0, 0, 0, 0])
  assert.deepEqual(first.map(row => row.content_text), [undefined, undefined, undefined, 'same', 'same', undefined])
  for (let index = 0; index < first.length; index++) {
    const row = first[index]
    assert.equal(row.message_id, `exchange-1:${index < 5 ? `request:${index}` : 'response'}`)
    assert.equal(row.part_id, `${row.message_id}#0`)
    assert.deepEqual(row.previous_message_id, index === 0 ? [] : [first[index - 1].message_id])
    assert.equal(row.session_id, 'exchange-1')
    assert.equal(row.request_id, 'exchange-1')
    assert.equal(row.conversation_id, undefined)
    assert.equal(row.cwd, undefined)
    assert.equal(row.repo_root, undefined)
    assert.equal(row.provider, 'ollama')
    assert.equal(row.model, 'gemma3:4b')
    assert.equal(row.client_name, 'ollama')
    assert.equal(row.entrypoint, 'ollama-api')
    assert.equal(attrs(row).gateway.exchange_id, 'exchange-1')
    if (index < 5) assert.equal(attrs(row).usage, undefined)
  }
  assert.deepEqual(attrs(first[5]).usage, { input_tokens: 5, cache_read_tokens: 11, output_tokens: 0 })
  assert.deepEqual(first[5].raw_frame, { done_reason: 'stop', prompt_eval_count: 16, prompt_eval_cached_count: 11, eval_count: 0 })
  const second = (await rows({ ...input, exchange_id: 'exchange-2' })).rows
  assert.equal(second.length, 6)
  assert.ok(second.every(row => !first.some(old => old.message_id === row.message_id)))
})

// @ref LLP 0469#resources-journey [tests]: serialized system content grows with input bytes, not system bytes times snapshot row count
test('system rows preserve empty/equal positions without multiplying spool bytes across context rows', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ollama-system-spool-'))
  const spool = createCacheSpool({ cacheRoot, appendChunk: async () => ({ bytesWritten: 0 }) })
  let previousBytes = 0
  try {
    for (const scale of [1, 2, 4]) {
      const system = 's'.repeat(16_384 * scale)
      const messages = [{ role: 'system', content: system }, { role: 'system', content: '' }, { role: 'system', content: system }, { role: 'assistant', content: '' }, ...Array.from({ length: 100 * scale }, () => ({ role: 'user', content: 'same' }))]
      const id = `system-scale-${scale}`
      const input = exchange({ exchange_id: id, request_body: JSON.stringify(request({ messages })) })
      const expanded = (await rows(input)).rows
      assert.equal(expanded.length, messages.length + 1)
      const table = path.join(cacheRoot, `scale-${scale}`)
      const appended = await spool.append(table, AI_GATEWAY_MESSAGE_COLUMNS, expanded)
      const serialized = await fs.readFile(path.join(table, SPOOL_DIR, 'active.jsonl'))
      assert.equal(appended.bytesWritten, serialized.byteLength)
      const envelope = JSON.parse(serialized.toString('utf8'))
      assert.equal(envelope.version, 1)
      assert.equal(envelope.rows.length, expanded.length)
      for (let index = 0; index < envelope.rows.length; index++) {
        const row = envelope.rows[index]
        const expected = index < messages.length ? messages[index] : { role: 'assistant', content: 'answer' }
        assert.equal(row.role, expected.role)
        assert.equal(row.content_text ?? '', expected.content)
        assert.equal(row.message_index, index)
        assert.equal(row.part_index, 0)
        assert.equal(row.message_id, `${id}:${index < messages.length ? `request:${index}` : 'response'}`)
        assert.equal(row.part_id, `${row.message_id}#0`)
        assert.deepEqual(row.previous_message_id, index ? [envelope.rows[index - 1].message_id] : [])
      }
      const captureBytes = Buffer.byteLength(input.request_body ?? '') + Buffer.byteLength(input.response_body ?? '')
      assert.ok(serialized.byteLength < captureBytes * 8, `${scale}: ${serialized.byteLength} spool bytes amplify ${captureBytes} capture bytes`)
      if (previousBytes) assert.ok(serialized.byteLength <= previousBytes * 2.1, 'doubling system bytes and row count must stay linear')
      assert.ok(envelope.rows.every(row => row.system_text === undefined), 'system content lives only in its ordered rows')
      previousBytes = serialized.byteLength
    }
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('reported model wins; request fallback only without reports; creation time and token-limit reason survive', async () => {
  const response = terminal({ model: 'gemma3:4b-latest', done_reason: 'length' })
  const result = (await rows(exchange({ response_body: JSON.stringify(response) }))).rows
  assert.ok(result.every(row => row.model === response.model))
  assert.equal(result[0].message_created_at, '2026-10-06T07:00:00Z')
  assert.equal(result[1].message_created_at, response.created_at)
  assert.equal(/** @type {any} */ (result[1].status).finish_reason, 'length')
  const { model, ...unreported } = response
  unreported.created_at = 'invalid'
  const fallback = (await rows(exchange({ response_body: JSON.stringify(unreported) }))).rows
  assert.equal(fallback[1].model, 'gemma3:4b')
  assert.equal(fallback[1].message_created_at, '2026-10-06T07:00:00Z')
})

for (const finalNewline of ['', '\n', '\r\n']) {
  for (const stream of [true, undefined]) {
    test(`NDJSON consumes terminal content and CRLF with stream=${stream} and ending=${JSON.stringify(finalNewline)}`, async () => {
      const { stream: ignored, ...noStream } = request()
      const req = stream === undefined ? noStream : { ...noStream, stream }
      const response = [{ model: 'gemma3:4b', message: { role: 'assistant', content: 'café ' }, done: false }, terminal({ message: { role: 'assistant', content: '🙂' }, eval_count: 2 })].map(frame => JSON.stringify(frame)).join('\r\n') + finalNewline
      const recorder = createRecorder()
      const captured = recorder.startExchange({ upstream: 'ollama', provider: 'ollama', method: 'POST', path: '/api/chat', requestHeaders: {} })
      const reqBytes = Buffer.from(JSON.stringify(req))
      for (const byte of reqBytes) captured.appendRequestChunk(Buffer.from([byte]))
      captured.setResponseStart({ status: 200, headers: { 'content-type': 'application/x-ndjson' } })
      // Every UTF-8 and JSON boundary is split; actual recorder reconstruction.
      for (const byte of Buffer.from(response)) captured.appendResponseChunk(Buffer.from([byte]))
      const result = (await rows(/** @type {AiGatewayExchangeInput} */ (captured.finalize()))).rows
      assert.equal(result.length, 2)
      assert.equal(result[1].content_text, 'café 🙂')
      assert.deepEqual(attrs(result[1]).usage, { output_tokens: 2 })
    })
  }
}

// @ref LLP 0469#usage-privacy [tests]: absent counts stay absent; invalid pairs never clamp or fabricate usage
for (const [label, counters, expected, reasons] of /** @type {Array<[string, Record<string, unknown>, Record<string, number> | undefined, number]>} */ ([
  ['missing', {}, undefined, 0],
  ['missing cache', { prompt_eval_count: 16, eval_count: 3 }, { output_tokens: 3 }, 0],
  ['zero', { prompt_eval_count: 0, prompt_eval_cached_count: 0, eval_count: 0 }, { input_tokens: 0, cache_read_tokens: 0, output_tokens: 0 }, 0],
  ['cache only', { prompt_eval_cached_count: 2 }, { cache_read_tokens: 2 }, 0],
  ['cache exceeds prompt', { prompt_eval_count: 2, prompt_eval_cached_count: 3, eval_count: 1 }, { output_tokens: 1 }, 1],
  ['invalid prompt', { prompt_eval_count: -1, prompt_eval_cached_count: 0, eval_count: 2 }, { cache_read_tokens: 0, output_tokens: 2 }, 1],
  ['invalid cache', { prompt_eval_count: 4, prompt_eval_cached_count: 1.5, eval_count: 2 }, { output_tokens: 2 }, 1],
  ['invalid output', { prompt_eval_count: 4, prompt_eval_cached_count: 1, eval_count: '3' }, { input_tokens: 3, cache_read_tokens: 1 }, 1],
  ['unsafe integer', { eval_count: Number.MAX_SAFE_INTEGER + 1 }, undefined, 1],
  ['null counter', { eval_count: null }, undefined, 1],
])) {
  test(`usage: ${label}`, async () => {
    const result = await rows(exchange({ response_body: JSON.stringify(terminal(counters)) }))
    assert.equal(result.rows.length, 2)
    assert.equal(attrs(result.rows[0]).usage, undefined)
    assert.deepEqual(attrs(result.rows[1]).usage, expected)
    assert.equal(result.logs.filter(log => log.event === 'plugin.ollama.invalid_usage').length, reasons)
    assert.deepEqual(result.rows[1].raw_frame, { done_reason: 'stop', ...counters })
  })
}

const invalid = [
  ['upstream refusal', { status_code: null, error: 'SECRET upstream refusal' }, 'transport_error'],
  ['non-2xx', { status_code: 503 }, 'http_error'],
  ['client abort', { error: 'SECRET client aborted' }, 'transport_error'],
  ['missing ID', { exchange_id: '' }, 'invalid_request'],
  ['malformed request', { request_body: '{broken' }, 'invalid_request'],
  ['no user', { request_body: JSON.stringify(request({ messages: [{ role: 'system', content: 'SECRET' }] })) }, 'invalid_request'],
  ['bad model', { request_body: JSON.stringify(request({ model: '' })) }, 'invalid_request'],
  ['bad stream', { request_body: JSON.stringify(request({ stream: 'false' })) }, 'invalid_request'],
  ['request tools', { request_body: JSON.stringify(request({ tools: [] })) }, 'unsupported_shape'],
  ['request thinking', { request_body: JSON.stringify(request({ think: true })) }, 'unsupported_shape'],
  ['unknown request field', { request_body: JSON.stringify(request({ secret_future_content: 'SECRET' })) }, 'unsupported_shape'],
  ...['images', 'audio', 'thinking', 'tool_calls'].map(field => [`message ${field}`, { request_body: JSON.stringify(request({ messages: [{ role: 'user', content: 'SECRET', [field]: 'SECRET' }] })) }, 'unsupported_shape']),
  ['array content', { request_body: JSON.stringify(request({ messages: [{ role: 'user', content: [] }] })) }, 'unsupported_shape'],
  ['tool role', { request_body: JSON.stringify(request({ messages: [{ role: 'user', content: 'SECRET' }, { role: 'tool', content: 'SECRET' }] })) }, 'unsupported_shape'],
  ['response tool', { response_body: JSON.stringify(terminal({ message: { role: 'assistant', content: 'SECRET', tool_calls: [] } })) }, 'unsupported_shape'],
  ['response thinking', { response_body: JSON.stringify(terminal({ message: { role: 'assistant', content: 'SECRET', thinking: 'SECRET' } })) }, 'unsupported_shape'],
  ['response error', { response_body: JSON.stringify({ error: 'SECRET' }) }, 'invalid_response'],
  ['response model null', { response_body: JSON.stringify(terminal({ model: null })) }, 'invalid_response'],
  ['response wrong role', { response_body: JSON.stringify(terminal({ message: { role: 'user', content: 'SECRET' } })) }, 'unsupported_shape'],
  ['response missing content', { response_body: JSON.stringify(terminal({ message: { role: 'assistant' } })) }, 'unsupported_shape'],
  ['missing terminal', { response_body: JSON.stringify(terminal({ done: false })) }, 'missing_terminal'],
  ['done truthy', { response_body: JSON.stringify(terminal({ done: 1 })) }, 'invalid_response'],
  ['malformed JSON', { response_body: '{SECRET' }, 'invalid_response'],
  ['truncated NDJSON terminal', { request_body: JSON.stringify(request({ stream: true })), response_body: JSON.stringify(terminal({ done: false })) + '\n{"done":true' }, 'malformed_stream'],
  ['NDJSON trailing record', { request_body: JSON.stringify(request({ stream: true })), response_body: JSON.stringify(terminal()) + '\n' + JSON.stringify(terminal()) }, 'trailing_record'],
  ['NDJSON error record', { request_body: JSON.stringify(request({ stream: true })), response_body: JSON.stringify(terminal({ done: false })) + '\n{"error":"SECRET"}' }, 'invalid_response'],
  ['NDJSON conflict', { request_body: JSON.stringify(request({ stream: true })), response_body: JSON.stringify(terminal({ done: false, model: 'other' })) + '\n' + JSON.stringify(terminal()) }, 'invalid_response'],
  ['byte ceiling', { request_body: ' '.repeat(CAPTURE_BYTES), response_body: '{}' }, 'capture_limit'],
]
for (const [label, overrides, reason] of invalid) {
  test(`whole-exchange drop: ${label} emits secret-safe ${reason} and zero rows`, async () => {
    const result = await rows(exchange(/** @type {Partial<AiGatewayExchangeInput>} */ (overrides)))
    assert.deepEqual(result.rows, [])
    const diagnostic = result.logs.find(log => log.event === 'plugin.ollama.capture_dropped')
    assert.ok(diagnostic)
    assert.equal(diagnostic.fields?.reason, reason)
    assert.equal(diagnostic.fields?.component, 'ollama')
    assert.equal(diagnostic.fields?.operation, 'project_exchange')
    assert.equal(diagnostic.fields?.status, 'dropped')
    assert.doesNotMatch(JSON.stringify(diagnostic), /SECRET|private=value/)
    assert.deepEqual(Object.keys(diagnostic.fields ?? {}).sort(), ['component', 'exchange_id', 'operation', 'reason', 'status'])
  })
}

test('session ignore returns terminal sentinel and suppresses later projectors', async () => {
  const input = exchange()
  const projector = createOllamaExchangeProjector()
  assert.equal(await projector.project(input, { ...context(), isSessionIgnored: id => id === input.exchange_id }), USAGE_POLICY_DROP)
  let later = false
  const writer = createAiGatewayMessageProjector({ gatewayId: 'ollama-test', projectors: [{ ...projector, _seq: 0 }, { name: 'later', _seq: 1, match: () => true, project: () => { later = true; return undefined } }], isSessionIgnored: () => true })
  assert.deepEqual(await writer.projectExchange(input), [])
  assert.equal(later, false)
})
