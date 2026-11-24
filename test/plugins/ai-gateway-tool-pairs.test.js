// @ts-check

/**
 * One Claude tool call that both capture lanes stored, once under the OTEL
 * lane's fallback hash and once under the transcript sweep's native uuid,
 * merges into one row by its tool key (LLP 0620). These pin the pure match
 * and survivor function the client's maintenance and the server's merge pass
 * share, and the flush-only settle-miss count.
 *
 * @ref LLP 0620#tool-identity [tests]: session, tool call id and part kind
 * @ref LLP 0620#unambiguous [tests]: exactly one native part_id merges
 * @ref LLP 0620#survivor [tests]: identity native, content earliest, usage once as stored
 * @ref LLP 0620#why-the-lookup-misses [tests]: the flush counts each miss by reason; probes stay silent
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { aiGatewayDatasetRegistration, claudeToolPairKey, mergeClaudeToolPair } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import { createAiGatewayApi, createGatewayState } from '../../hypaware-core/plugins-workspace/ai-gateway/src/api.js'
import { createClaudeSettlementEnricher } from '../../hypaware-core/plugins-workspace/claude/src/settle.js'
import { LoggerProvider, logs } from '../../src/core/observability/runtime.js'

/** @import { LogRecord } from '../../src/core/observability/types.js' */

const SESSION = '0f3c2a8e-5b1d-4c7e-9a20-6d4e8f1b2c3a'
const NATIVE_UUID = '5233b3fa-fd52-4c1e-9a44-6c0e8c0f1a2b'
const TOOL_ID = 'toolu_01PairsFixture'
const USAGE = Object.freeze({ input_tokens: 12, output_tokens: 34 })

/**
 * @param {Record<string, unknown>} [over]
 * @returns {Record<string, unknown>}
 */
function liveRow(over = {}) {
  return {
    session_id: SESSION,
    client_name: 'claude',
    provider: 'anthropic',
    conversation_source: 'claude_code',
    role: 'assistant',
    part_type: 'tool_call',
    tool_call_id: TOOL_ID,
    tool_name: 'Bash',
    tool_args: '{"command":"ls -la"}',
    message_id: '3a39d0e53ae68dc0',
    part_id: '3a39d0e53ae68dc0#0',
    part_index: 0,
    message_created_at: '2026-11-20T10:00:01.000Z',
    date: '2026-11-20',
    system_text: 'system prompt',
    client_version: '2.1.322',
    agent_id: 'general-purpose',
    raw_frame: { type: 'api_response_body', request_id: 'req_1' },
    request_id: 'req_1',
    input_tokens: 12,
    output_tokens: 34,
    attributes: {
      usage: { ...USAGE },
      gateway: { identity_source: 'gateway_fallback', recorder: 'otel' },
      claude: { match_key: 'abc', query_source: 'repl_main_thread' },
    },
    ...over,
  }
}

/**
 * @param {Record<string, unknown>} [over]
 * @returns {Record<string, unknown>}
 */
function nativeRow(over = {}) {
  return {
    session_id: SESSION,
    client_name: 'claude',
    provider: 'anthropic',
    conversation_source: 'claude',
    role: 'assistant',
    part_type: 'tool_call',
    tool_call_id: TOOL_ID,
    tool_name: 'Bash',
    tool_args: '{"command":"ls -la"}',
    message_id: NATIVE_UUID,
    provider_uuid: NATIVE_UUID,
    part_id: `${NATIVE_UUID}#0`,
    part_index: 0,
    message_index: 7,
    previous_message_id: ['prev-uuid'],
    message_created_at: '2026-11-20T10:00:00.500Z',
    date: '2026-11-20',
    agent_id: null,
    is_sidechain: false,
    raw_frame: { uuid: NATIVE_UUID, type: 'assistant' },
    request_id: 'req_1',
    input_tokens: null,
    output_tokens: null,
    attributes: { client: { version: '2.1.322' }, tool_use_result: { stdout: 'x' } },
    ...over,
  }
}

/** @param {Record<string, unknown>} row */
function attrs(row) {
  const value = row.attributes
  return /** @type {Record<string, any>} */ (typeof value === 'string' ? JSON.parse(value) : value)
}

test('the key separates a call from its result, sessions from each other, and skips rows that do not take part', () => {
  const call = claudeToolPairKey(liveRow())
  const result = claudeToolPairKey(liveRow({ role: 'user', part_type: 'tool_result' }))
  assert.ok(call)
  assert.notEqual(call, result)
  assert.equal(claudeToolPairKey(nativeRow()), call, 'the two lanes share the key')
  assert.notEqual(claudeToolPairKey(liveRow({ session_id: 'other-session' })), call)
  assert.equal(claudeToolPairKey(liveRow({ client_name: 'codex' })), undefined)
  assert.equal(claudeToolPairKey(liveRow({ provider: 'openai' })), undefined)
  assert.equal(claudeToolPairKey(liveRow({ tool_call_id: null })), undefined)
  assert.equal(claudeToolPairKey(liveRow({ part_type: 'text' })), undefined)
  assert.ok(claudeToolPairKey(liveRow({ client_name: 'claude-desktop' })))
})

test('live first: native identity, the earliest copy\'s content, the live row\'s usage and lane', () => {
  const live = liveRow({ message_created_at: '2026-11-20T10:00:00.400Z' })
  const outcome = mergeClaudeToolPair([live, nativeRow()])
  assert.equal(outcome.status, 'merged')
  const survivor = /** @type {Record<string, unknown>} */ (outcome.survivor)
  assert.equal(survivor.message_id, NATIVE_UUID)
  assert.equal(survivor.part_id, `${NATIVE_UUID}#0`)
  assert.equal(survivor.provider_uuid, NATIVE_UUID)
  assert.equal(survivor.message_index, 7)
  assert.deepEqual(survivor.previous_message_id, ['prev-uuid'])
  assert.equal(survivor.agent_id, null, 'the native row decides attribution')
  assert.equal(survivor.message_created_at, '2026-11-20T10:00:00.400Z', 'the live copy is earliest here')
  assert.equal(survivor.conversation_source, 'claude_code')
  assert.equal(survivor.system_text, 'system prompt')
  assert.equal(survivor.client_version, '2.1.322')
  assert.equal(survivor.output_tokens, 34)
  const a = attrs(survivor)
  assert.deepEqual(a.usage, USAGE)
  assert.equal(a.gateway.identity_source, undefined, 'the fallback marker is removed')
  assert.equal(a.gateway.recorder, 'otel')
  assert.equal(a.claude.match_key, undefined)
  assert.equal(a.claude.query_source, 'repl_main_thread')
  assert.deepEqual(a.tool_use_result, { stdout: 'x' }, 'native-only attributes are kept')
  assert.deepEqual(outcome.discardedUsage, [])
})

test('native first: the native row carried the usage, so the survivor takes it', () => {
  const live = liveRow({ input_tokens: null, output_tokens: null, attributes: { gateway: { identity_source: 'gateway_fallback' } } })
  const native = nativeRow({ input_tokens: 12, output_tokens: 34, attributes: { usage: { ...USAGE } } })
  const outcome = mergeClaudeToolPair([native, live])
  const survivor = /** @type {Record<string, unknown>} */ (outcome.survivor)
  assert.deepEqual(attrs(survivor).usage, USAGE)
  assert.equal(survivor.input_tokens, 12)
  assert.equal(survivor.output_tokens, 34)
})

test('a replay never replaces the original content, even as the only live row left', () => {
  // The original live row settled at flush, so it is the native row now; a
  // replay after a restart re-emitted the block with a later stamp and
  // different content.
  const settledOriginal = nativeRow({ conversation_source: 'claude_code', tool_args: '{"command":"full"}' })
  const replay = liveRow({
    tool_args: '{"command":"cleared"}',
    message_created_at: '2026-11-21T09:00:00.000Z',
    date: '2026-11-21',
    input_tokens: null,
    output_tokens: null,
    attributes: { gateway: { identity_source: 'gateway_fallback' } },
  })
  const outcome = mergeClaudeToolPair([replay, settledOriginal])
  const survivor = /** @type {Record<string, unknown>} */ (outcome.survivor)
  assert.equal(survivor.tool_args, '{"command":"full"}')
  assert.equal(survivor.date, '2026-11-20')
  assert.equal(survivor.part_id, `${NATIVE_UUID}#0`)
})

test('with several live rows the earliest supplies the content and the live-only columns', () => {
  const original = liveRow({ message_created_at: '2026-11-20T10:00:00.100Z', tool_args: '{"command":"full"}' })
  const replay = liveRow({
    message_id: 'ffff0000ffff0000', part_id: 'ffff0000ffff0000#0',
    message_created_at: '2026-11-21T09:00:00.000Z', tool_args: '{"command":"cleared"}', system_text: 'later',
    input_tokens: null, output_tokens: null, attributes: { gateway: { identity_source: 'gateway_fallback' } },
  })
  const outcome = mergeClaudeToolPair([replay, nativeRow(), original])
  const survivor = /** @type {Record<string, unknown>} */ (outcome.survivor)
  assert.equal(outcome.status, 'merged')
  assert.equal(survivor.tool_args, '{"command":"full"}')
  assert.equal(survivor.system_text, 'system prompt')
  assert.deepEqual(attrs(survivor).usage, USAGE)
})

test('more than one carrier: the earliest live copy is kept, never summed, and the rest come back', () => {
  const native = nativeRow({ input_tokens: 50, output_tokens: 60, attributes: { usage: { input_tokens: 50, output_tokens: 60 } } })
  const outcome = mergeClaudeToolPair([liveRow(), native])
  const survivor = /** @type {Record<string, unknown>} */ (outcome.survivor)
  assert.equal(survivor.input_tokens, 12)
  assert.deepEqual(attrs(survivor).usage, USAGE)
  assert.deepEqual(outcome.discardedUsage, [{ input_tokens: 50, output_tokens: 60 }])
})

test('the carrier\'s token columns are copied as stored, never re-derived from its usage', () => {
  // A row from a client before the token columns, stored before the server
  // filled them: usage in attributes, columns null.
  const live = liveRow({ input_tokens: null, output_tokens: null })
  const survivor = /** @type {Record<string, unknown>} */ (mergeClaudeToolPair([live, nativeRow()]).survivor)
  assert.equal(survivor.input_tokens, null)
  assert.equal(survivor.output_tokens, null)
  assert.deepEqual(attrs(survivor).usage, USAGE)
})

test('two native part_ids are ambiguous, and a key with one side only has no pair', () => {
  const forkCopy = nativeRow({ message_id: 'aaaa', part_id: 'aaaa#0', agent_id: 'fork' })
  assert.equal(mergeClaudeToolPair([liveRow(), nativeRow(), forkCopy]).status, 'ambiguous')
  assert.equal(mergeClaudeToolPair([nativeRow(), forkCopy]).status, 'ambiguous')
  assert.equal(mergeClaudeToolPair([nativeRow()]).status, 'no_pair')
  assert.equal(mergeClaudeToolPair([liveRow()]).status, 'no_pair')
  assert.equal(mergeClaudeToolPair([liveRow(), nativeRow(), nativeRow()]).status, 'merged', 'the same native part_id twice is one native row')
})

test('attributes stored as a JSON string stay a string', () => {
  const live = liveRow({ attributes: JSON.stringify(liveRow().attributes) })
  const native = nativeRow({ attributes: JSON.stringify(nativeRow().attributes) })
  const survivor = /** @type {Record<string, unknown>} */ (mergeClaudeToolPair([live, native]).survivor)
  assert.equal(typeof survivor.attributes, 'string')
  assert.deepEqual(attrs(survivor).usage, USAGE)
  assert.equal(attrs(survivor).gateway.identity_source, undefined)
})

test('the merge is pure: the rows it is given are not changed', () => {
  const live = liveRow()
  const native = nativeRow()
  const before = JSON.stringify([live, native])
  mergeClaudeToolPair([live, native])
  assert.equal(JSON.stringify([live, native]), before)
})

// ---------------------------------------------------------------------
// The settle-miss count.
// ---------------------------------------------------------------------

/**
 * @param {string} homeDir
 * @param {Record<string, unknown>[]} lines
 */
async function writeTranscript(homeDir, lines) {
  const dir = path.join(homeDir, '.claude', 'projects', 'repo')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${SESSION}.jsonl`), lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
}

/** @param {string} homeDir */
function enricher(homeDir) {
  return createClaudeSettlementEnricher({ homeDir, stateFile: path.join(homeDir, 'state', 'session-context.jsonl') })
}

/** @param {Record<string, unknown>} [over] */
function fallbackTool(over = {}) {
  return liveRow({ cwd: '/repo', raw_frame: JSON.stringify({ type: 'api_response_body' }), ...over })
}

test('the Claude enricher names why each fallback kept its identity, only when asked', async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-pairs-miss-'))
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }))
  const storage = /** @type {any} */ ({})

  /** @type {string[]} */
  const reasons = []
  const missing = await enricher(homeDir).settle([fallbackTool()], { storage, onSettleMiss: (r) => reasons.push(r) })
  assert.deepEqual(reasons, ['no_transcript'])
  assert.equal(missing.length, 1)

  // A probe passes no callback and must not throw or report.
  const probed = await enricher(homeDir).settle([fallbackTool()], { storage })
  assert.equal(probed.length, 1)
})

test('a transcript without the tool id, and a multi-block line, are named apart', async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-pairs-reasons-'))
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }))
  await writeTranscript(homeDir, [
    { sessionId: SESSION, uuid: 'u-1', parentUuid: null, type: 'user', message: { role: 'user', content: 'go' }, timestamp: '2026-11-20T10:00:00.000Z' },
    {
      sessionId: SESSION, uuid: 'u-2', parentUuid: 'u-1', type: 'user', timestamp: '2026-11-20T10:00:02.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_multi', content: 'ok' }, { type: 'text', text: 'note' }] },
    },
  ])
  const storage = /** @type {any} */ ({})
  /** @type {string[]} */
  const reasons = []
  await enricher(homeDir).settle([
    fallbackTool(),
    fallbackTool({ role: 'user', part_type: 'tool_result', tool_call_id: 'toolu_multi', message_id: 'bbbb', part_id: 'bbbb#0' }),
    fallbackTool({ role: 'assistant', part_type: 'tool_result', tool_call_id: 'srvtoolu_1', message_id: 'cccc', part_id: 'cccc#0' }),
  ], { storage, onSettleMiss: (r) => reasons.push(r) })
  assert.deepEqual(reasons, ['tool_id_not_in_transcript', 'tool_line_multi_block', 'tool_kind_unmatched'])
})

test('the flush logs one aggregated miss event; the maintenance re-settle passes no callback', async (t) => {
  /** @type {LogRecord[]} */
  const records = []
  const provider = new LoggerProvider({
    resource: { attributes: { service_name: 'hypaware-test' } },
    exporters: [{ exportBatch: (batch) => { records.push(...batch) } }],
  })
  logs.setGlobalLoggerProvider(provider)
  t.after(() => provider.shutdown())

  /** @type {unknown[]} */
  const callbacks = []
  const state = createGatewayState()
  createAiGatewayApi(state).registerSettlementEnricher({
    name: 'stub',
    clientName: 'claude',
    async settle(rows, ctx) {
      callbacks.push(ctx.onSettleMiss)
      for (let i = 0; i < rows.length; i++) ctx.onSettleMiss?.('no_transcript')
      return rows
    },
  })
  const registration = /** @type {any} */ (aiGatewayDatasetRegistration(state))
  const storage = { discoverCachePartitions: async () => [], async *readRows() {} }
  await registration.settleBatch([fallbackTool(), fallbackTool({ part_id: 'dddd#0', message_id: 'dddd' })], { storage })
  await registration.resettleBatch([fallbackTool()], { storage })
  await provider.forceFlush()

  assert.equal(typeof callbacks[0], 'function', 'the flush passes the callback')
  assert.equal(callbacks[1], undefined, 'the re-settle does not')
  const misses = records.filter((record) => record.body === 'ai_gateway.settle_miss')
  assert.equal(misses.length, 1)
  assert.equal(misses[0].attributes?.miss_count, 2)
  assert.equal(misses[0].attributes?.miss_no_transcript, 2)
})

test('entrypoint follows flush settlement: the native value when it has one, else the live row\'s', () => {
  const live = liveRow({ entrypoint: 'sdk-ts' })
  const withNative = /** @type {Record<string, unknown>} */ (mergeClaudeToolPair([live, nativeRow({ entrypoint: 'cli' })]).survivor)
  assert.equal(withNative.entrypoint, 'cli')
  const withoutNative = /** @type {Record<string, unknown>} */ (mergeClaudeToolPair([live, nativeRow({ entrypoint: null })]).survivor)
  assert.equal(withoutNative.entrypoint, 'sdk-ts')
})

test('a tie on message_created_at goes to the live copy', () => {
  const at = '2026-11-20T10:00:00.500Z'
  const survivor = /** @type {Record<string, unknown>} */ (mergeClaudeToolPair([
    nativeRow({ message_created_at: at, tool_args: '{"command":"native"}' }),
    liveRow({ message_created_at: at, tool_args: '{"command":"live"}' }),
  ]).survivor)
  assert.equal(survivor.tool_args, '{"command":"live"}')
})

test('a row with no message_created_at is never the earliest, live or native', () => {
  const undatedNative = nativeRow({ message_created_at: null, tool_args: '{"command":"native"}' })
  const datedLive = liveRow({ message_created_at: '2026-11-20T10:00:01.000Z', tool_args: '{"command":"live"}' })
  const first = /** @type {Record<string, unknown>} */ (mergeClaudeToolPair([undatedNative, datedLive]).survivor)
  assert.equal(first.tool_args, '{"command":"live"}')

  const datedNative = nativeRow({ message_created_at: '2026-11-20T10:00:01.000Z', tool_args: '{"command":"native"}' })
  const undatedLive = liveRow({ message_created_at: null, tool_args: '{"command":"live"}' })
  const second = /** @type {Record<string, unknown>} */ (mergeClaudeToolPair([undatedLive, datedNative]).survivor)
  assert.equal(second.tool_args, '{"command":"native"}')
  assert.equal(second.message_created_at, '2026-11-20T10:00:01.000Z')
})

test('rows of different keys are never merged, whatever the caller grouped', () => {
  assert.equal(mergeClaudeToolPair([liveRow(), nativeRow({ part_type: 'tool_result', role: 'user' })]).status, 'no_pair')
  assert.equal(mergeClaudeToolPair([liveRow(), nativeRow({ session_id: 'other-session' })]).status, 'no_pair')
  assert.equal(mergeClaudeToolPair([liveRow(), nativeRow({ client_name: 'codex' })]).status, 'no_pair')
  assert.equal(mergeClaudeToolPair([]).status, 'no_pair')
})

test('an unreadable transcript and a proxy-lane row get their own reasons', async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-pairs-unreadable-'))
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }))
  const storage = /** @type {any} */ ({})
  /** @type {string[]} */
  const reasons = []
  const throwing = createClaudeSettlementEnricher({
    homeDir,
    stateFile: path.join(homeDir, 'state', 'session-context.jsonl'),
    transcriptLoader: /** @type {any} */ ({ load: async () => { throw new Error('EACCES') } }),
  })
  await throwing.settle([fallbackTool()], { storage, onSettleMiss: (r) => reasons.push(r) })
  assert.deepEqual(reasons, ['transcript_unreadable'])

  await writeTranscript(homeDir, [
    { sessionId: SESSION, uuid: 'u-1', parentUuid: null, type: 'user', message: { role: 'user', content: 'go' }, timestamp: '2026-11-20T10:00:00.000Z' },
  ])
  reasons.length = 0
  await enricher(homeDir).settle([fallbackTool({ conversation_source: 'claude-cli-proxy' })], { storage, onSettleMiss: (r) => reasons.push(r) })
  assert.deepEqual(reasons, ['content_no_match'], 'no tool lookup ran for this lane, so no tool reason is given')
})
