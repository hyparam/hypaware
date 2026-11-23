// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { maintainCache } from '../../src/core/cache/maintenance.js'
import { readCursorSync } from '../../src/core/cache/partition.js'
import { createQueryStorageService } from '../../src/core/cache/storage.js'
import { AI_GATEWAY_SCHEMA_COLUMNS, aiGatewayDatasetRegistration, DATASET_NAME, PARTITION_LABEL } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import { createAiGatewayApi, createGatewayState } from '../../hypaware-core/plugins-workspace/ai-gateway/src/api.js'
import { createClaudeSettlementEnricher } from '../../hypaware-core/plugins-workspace/claude/src/settle.js'

/**
 * One Claude tool call the OTEL lane stored under a fallback hash (its
 * transcript lookup missed) and the transcript sweep stored under the native
 * uuid. The re-settle rewrite merges the two by their tool key, without the
 * transcript, keeping the native identity and the response's usage once.
 *
 * @ref LLP 0620#local [tests]: pass 1 claims the key; pass 2 holds, merges or defers
 * @ref LLP 0620#survivor [tests]: native identity, the carrier's usage, the live lane
 * @ref LLP 0027#re-settle-sweep [tests]: a second pass is a no-op; an unclaimed row is never dropped
 */

const SESSION = '0f3c2a8e-5b1d-4c7e-9a20-6d4e8f1b2c3a'
const COLUMNS = [...AI_GATEWAY_SCHEMA_COLUMNS]

/** The schema's required columns every fixture row carries. */
const REQUIRED = Object.freeze({
  gateway_id: 'gw-test',
  schema_version: 6,
  conversation_started_at: new Date('2026-11-20T09:59:00.000Z'),
  message_index: 1,
})

/**
 * @param {string} toolId
 * @param {Record<string, unknown>} [over]
 * @returns {Record<string, unknown>}
 */
function liveCall(toolId, over = {}) {
  const id = `f${toolId.slice(-15).padStart(15, '0')}`
  return {
    ...REQUIRED,
    session_id: SESSION,
    cwd: '/repo',
    date: '2026-11-20',
    client_name: 'claude',
    conversation_source: 'claude_code',
    provider: 'anthropic',
    role: 'assistant',
    part_type: 'tool_call',
    tool_call_id: toolId,
    tool_name: 'Bash',
    tool_args: { command: 'ls -la' },
    message_id: id,
    part_id: `${id}#0`,
    part_index: 0,
    message_created_at: new Date('2026-11-20T10:00:00.400Z'),
    request_id: `req_${toolId}`,
    system_text: 'system prompt',
    output_tokens: 34,
    input_tokens: 12,
    attributes: {
      usage: { input_tokens: 12, output_tokens: 34 },
      gateway: { identity_source: 'gateway_fallback' },
      claude: { match_key: 'k' },
    },
    raw_frame: { type: 'api_response_body', request_id: `req_${toolId}` },
    ...over,
  }
}

/**
 * @param {string} toolId
 * @param {string} uuid
 * @param {Record<string, unknown>} [over]
 * @returns {Record<string, unknown>}
 */
function nativeCall(toolId, uuid, over = {}) {
  return {
    ...REQUIRED,
    session_id: SESSION,
    cwd: '/repo',
    date: '2026-11-20',
    client_name: 'claude',
    conversation_source: 'claude',
    provider: 'anthropic',
    role: 'assistant',
    part_type: 'tool_call',
    tool_call_id: toolId,
    tool_name: 'Bash',
    tool_args: { command: 'ls -la' },
    message_id: uuid,
    provider_uuid: uuid,
    part_id: `${uuid}#0`,
    part_index: 0,
    message_created_at: new Date('2026-11-20T10:00:00.500Z'),
    request_id: `req_${toolId}`,
    attributes: { client: { version: '2.1.322' } },
    raw_frame: { uuid, type: 'assistant' },
    ...over,
  }
}

/** @returns {Promise<{ homeDir: string, cacheRoot: string, stateFile: string, cleanup: () => Promise<void> }>} */
async function stageEnv() {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-tool-pairs-'))
  const cacheRoot = path.join(homeDir, 'cache')
  await fs.mkdir(path.join(homeDir, 'state'), { recursive: true })
  await fs.mkdir(cacheRoot, { recursive: true })
  return {
    homeDir,
    cacheRoot,
    stateFile: path.join(homeDir, 'state', 'session-context.jsonl'),
    cleanup: () => fs.rm(homeDir, { recursive: true, force: true }),
  }
}

/**
 * The gateway as the daemon wires it, with no transcript on disk: the flush
 * cannot settle the fallback rows, and the re-settle hook cannot either.
 *
 * @param {{ homeDir: string, cacheRoot: string, stateFile: string }} env
 */
function buildGateway(env) {
  const state = createGatewayState()
  createAiGatewayApi(state).registerSettlementEnricher(createClaudeSettlementEnricher({ homeDir: env.homeDir, stateFile: env.stateFile }))
  const registration = aiGatewayDatasetRegistration(state)
  const storage = createQueryStorageService({
    cacheRoot: env.cacheRoot,
    getDeclaration: (dataset) => dataset === DATASET_NAME ? registration.cachePartitioning : undefined,
    getSettleHook: (dataset) => dataset === DATASET_NAME ? registration.settleBatch : undefined,
  })
  const tablePath = storage.cacheTablePath(DATASET_NAME, [PARTITION_LABEL])
  return {
    storage,
    tablePath,
    getSettleHook: (/** @type {string} */ dataset) => dataset === DATASET_NAME ? registration.resettleBatch : undefined,
    getResettlePairs: (/** @type {string} */ dataset) => dataset === DATASET_NAME ? registration.resettlePairs : undefined,
  }
}

/**
 * @param {ReturnType<typeof buildGateway>} gw
 * @param {Record<string, unknown>[]} rows
 */
async function commit(gw, rows) {
  await gw.storage.appendRows(gw.tablePath, COLUMNS, rows)
  await gw.storage.flushTable(gw.tablePath, { force: true })
}

/**
 * @param {ReturnType<typeof buildGateway>} gw
 * @param {{ pairs?: boolean, config?: Record<string, number> }} [opts]
 */
async function maintain(gw, opts = {}) {
  return maintainCache({
    cacheRoot: gw.storage.cacheRoot,
    force: true,
    compactOnly: true,
    storage: gw.storage,
    getSettleHook: gw.getSettleHook,
    ...(opts.pairs === false ? {} : { getResettlePairs: gw.getResettlePairs }),
    ...(opts.config ? { config: opts.config } : {}),
  })
}

/** @param {ReturnType<typeof buildGateway>} gw */
async function readToolRows(gw) {
  /** @type {Record<string, unknown>[]} */
  const rows = []
  for (const part of await gw.storage.discoverCachePartitions({ datasets: [DATASET_NAME] })) {
    if (typeof part.rowCount === 'number' && part.rowCount === 0) continue
    const columns = ['part_id', 'tool_call_id', 'part_type', 'conversation_source', 'system_text', 'output_tokens', 'date', 'attributes']
    for await (const row of gw.storage.readRows(part.path, columns)) rows.push(row)
  }
  return rows.sort((a, b) => String(a.part_id).localeCompare(String(b.part_id)))
}

/** @param {unknown} attributes */
function attrs(attributes) {
  return /** @type {Record<string, any>} */ (typeof attributes === 'string' ? JSON.parse(attributes) : attributes ?? {})
}

/** @param {ReturnType<typeof buildGateway>} gw */
async function pendingFallbacks(gw) {
  const parts = await gw.storage.discoverCachePartitions({ datasets: [DATASET_NAME] })
  let total = 0
  for (const dir of new Set(parts.map((part) => part.path))) {
    const pending = readCursorSync(dir).pendingFallbacks
    assert.equal(typeof pending, 'number', 'a settle-bearing rewrite records the count')
    total += Number(pending)
  }
  return total
}

test('live first: the pair merges into one row with native identity and the response\'s usage', async () => {
  const env = await stageEnv()
  try {
    const gw = buildGateway(env)
    await commit(gw, [liveCall('toolu_live_first')])
    await commit(gw, [nativeCall('toolu_live_first', '5233b3fa-fd52-4c1e-9a44-6c0e8c0f1a2b')])

    const before = await readToolRows(gw)
    assert.equal(before.length, 2, 'both lanes committed a copy')
    assert.equal(before.filter((row) => attrs(row.attributes).usage).length, 1, 'the flush kept one carrier, the fallback')

    await maintain(gw)
    const after = await readToolRows(gw)
    assert.equal(after.length, 1)
    assert.equal(after[0].part_id, '5233b3fa-fd52-4c1e-9a44-6c0e8c0f1a2b#0')
    assert.equal(after[0].conversation_source, 'claude_code')
    assert.equal(after[0].system_text, 'system prompt')
    assert.equal(Number(after[0].output_tokens), 34)
    assert.deepEqual(attrs(after[0].attributes).usage, { input_tokens: 12, output_tokens: 34 })
    assert.equal(attrs(after[0].attributes).gateway?.identity_source, undefined)
    assert.equal(await pendingFallbacks(gw), 0, 'the rewrite records the exact remainder')

    await maintain(gw)
    assert.deepEqual(await readToolRows(gw), after, 'a second pass is a no-op')
  } finally {
    await env.cleanup()
  }
})

test('without the merge hook the same pair stays two rows, as before', async () => {
  const env = await stageEnv()
  try {
    const gw = buildGateway(env)
    await commit(gw, [liveCall('toolu_control')])
    await commit(gw, [nativeCall('toolu_control', 'aaaaaaaa-0000-4000-8000-000000000001')])
    await maintain(gw, { pairs: false })
    assert.equal((await readToolRows(gw)).length, 2)
  } finally {
    await env.cleanup()
  }
})

test('native first: the native row carried the usage, and the survivor keeps it', async () => {
  const env = await stageEnv()
  try {
    const gw = buildGateway(env)
    await commit(gw, [nativeCall('toolu_native_first', 'bbbbbbbb-0000-4000-8000-000000000002', {
      output_tokens: 34, input_tokens: 12, attributes: { usage: { input_tokens: 12, output_tokens: 34 } },
    })])
    await commit(gw, [liveCall('toolu_native_first')])
    const before = await readToolRows(gw)
    assert.equal(before.filter((row) => attrs(row.attributes).usage).length, 1, 'the flush stripped the later live copy')

    await maintain(gw)
    const after = await readToolRows(gw)
    assert.equal(after.length, 1)
    assert.equal(after[0].part_id, 'bbbbbbbb-0000-4000-8000-000000000002#0')
    assert.equal(Number(after[0].output_tokens), 34)
  } finally {
    await env.cleanup()
  }
})

test('copies on two dates merge in one rewrite, onto the earliest copy\'s date', async () => {
  const env = await stageEnv()
  try {
    const gw = buildGateway(env)
    await commit(gw, [nativeCall('toolu_dates', 'cccccccc-0000-4000-8000-000000000003')])
    await commit(gw, [liveCall('toolu_dates', {
      date: '2026-11-21', message_created_at: new Date('2026-11-21T09:00:00.000Z'),
      output_tokens: null, input_tokens: null, attributes: { gateway: { identity_source: 'gateway_fallback' } },
    })])
    await maintain(gw)
    const after = await readToolRows(gw)
    assert.equal(after.length, 1)
    assert.equal(after[0].date, '2026-11-20')
  } finally {
    await env.cleanup()
  }
})

test('an ambiguous key and an unpaired fallback are left as they are', async () => {
  const env = await stageEnv()
  try {
    const gw = buildGateway(env)
    await commit(gw, [
      liveCall('toolu_ambiguous'),
      liveCall('toolu_alone', { message_id: 'feedfeedfeedfeed', part_id: 'feedfeedfeedfeed#0' }),
    ])
    await commit(gw, [
      nativeCall('toolu_ambiguous', 'dddddddd-0000-4000-8000-000000000004'),
      nativeCall('toolu_ambiguous', 'eeeeeeee-0000-4000-8000-000000000005', { agent_id: 'fork' }),
    ])
    await maintain(gw)
    const after = await readToolRows(gw)
    assert.equal(after.length, 4, 'nothing merges and nothing is dropped')
    assert.equal(await pendingFallbacks(gw), 2)
  } finally {
    await env.cleanup()
  }
})

test('a key past the held-bytes cap is deferred unchanged and merges on the next rewrite', async () => {
  const env = await stageEnv()
  try {
    const gw = buildGateway(env)
    await commit(gw, [
      liveCall('toolu_cap_a', { message_id: 'a0a0a0a0a0a0a0a0', part_id: 'a0a0a0a0a0a0a0a0#0' }),
      liveCall('toolu_cap_b', { message_id: 'b0b0b0b0b0b0b0b0', part_id: 'b0b0b0b0b0b0b0b0#0' }),
    ])
    await commit(gw, [
      nativeCall('toolu_cap_a', 'a1a1a1a1-0000-4000-8000-000000000006'),
      nativeCall('toolu_cap_b', 'b1b1b1b1-0000-4000-8000-000000000007'),
    ])
    // A cap of one byte admits one key at a time: whichever key starts
    // second while the first is still held is deferred.
    await maintain(gw, { config: { compact_batch_bytes: 1 } })
    const once = await readToolRows(gw)
    assert.equal(once.length, 3, 'one key merged, the other was deferred')
    const remaining = once.length - 2
    assert.equal(await pendingFallbacks(gw), remaining, 'a deferred key keeps its fallback, counted exactly')

    await maintain(gw)
    const twice = await readToolRows(gw)
    assert.equal(twice.length, 2, 'the deferred key merges on the next rewrite')
    assert.equal(await pendingFallbacks(gw), 0)
    for (const row of twice) assert.equal(Number(row.output_tokens), 34, 'each merged call keeps its usage')
  } finally {
    await env.cleanup()
  }
})
