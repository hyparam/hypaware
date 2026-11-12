// @ts-check

import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import {
  MASTRACODE_CLIENT_NAME,
  mastracodeScopeId,
  mintMastracodePartId,
  projectMastracodeThread,
  providerOfModel,
} from '../../hypaware-core/plugins-workspace/mastracode/src/projector.js'
import { createUsagePolicyResolver } from '../../src/core/usage-policy/index.js'
import { aiGatewayBackfillMaterializer } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import {
  assistantContent,
  sandboxExitPart,
  stepStartPart,
  textPart,
  toolInvocationPart,
  userContent,
  workspaceMetadataPart,
} from '../helpers/mastracode_db_fixture.js'

/**
 * @import { MastraMessageRow, MastraSkipCounts, MastraThreadRow } from '../../hypaware-core/plugins-workspace/mastracode/src/types.js'
 */

/**
 * @ref LLP 0586#projection [tests]: the Mastra Code -> ai_gateway_messages
 *   mapping, one part per `parts` entry, ids stable as a message is rewritten.
 * @ref LLP 0603#accounting [tests]: one normalized session snapshot, no per-turn usage.
 * @ref LLP 0586#owner-decisions [tests]: D6 workspace metadata dropped.
 * @ref LLP 0586#privacy [tests]: the usage-policy skip and its path-free log.
 *
 * Rows are synthetic copies of the part shapes the mastracode 0.49.0 probe
 * recorded (probe/sample-messages-a4.json), not captured content.
 */

const PROJECT_DIR = '/work/mastracode-fixture'
const WORKSPACE_DIR = '/work/mastracode-workspace-secret'
const THREAD = 'thread-fixture-0001'
const SOURCE = '/home/fixture/.local/share/mastracode/mastra.db'
const TOKEN_USAGE = {
  promptTokens: 306,
  completionTokens: 36,
  totalTokens: 342,
  cachedInputTokens: 128,
  cacheCreationInputTokens: 0,
  reasoningTokens: 12,
  raw: { input_tokens: 306, output_tokens: 36 },
}

/**
 * @param {Partial<MastraThreadRow>} [fields]
 * @param {Record<string, unknown>} [metadata]
 * @returns {MastraThreadRow}
 */
function thread(fields = {}, metadata = {}) {
  return {
    id: THREAD,
    title: 'Fixture thread',
    metadata: JSON.stringify({ projectPath: PROJECT_DIR, currentModelId: 'mastracode/openai/gpt-fixture', tokenUsage: TOKEN_USAGE, ...metadata }),
    createdAt: '2026-11-05T22:52:20.800Z',
    updatedAt: '2026-11-05T22:52:22.000Z',
    ...fields,
  }
}

let nextRowid = 1

/**
 * @param {string} id
 * @param {string} role
 * @param {string} type
 * @param {Record<string, unknown>} content
 * @returns {MastraMessageRow}
 */
function message(id, role, type, content) {
  return {
    row_id: nextRowid++,
    id,
    thread_id: THREAD,
    content: JSON.stringify(content),
    role,
    type,
    createdAt: '2026-11-05T22:52:20.831Z',
  }
}

/** One turn in the a4 sample's part order, then a second turn. */
function turns() {
  return [
    message('m-user-1', 'signal', 'user', userContent('sig-1', 'fixture prompt')),
    message('m-asst-1', 'assistant', 'v2', assistantContent([
      toolInvocationPart({ toolCallId: 'call-1', command: 'echo one', result: 'one' }),
      workspaceMetadataPart('call-1', WORKSPACE_DIR),
      sandboxExitPart('call-1'),
      stepStartPart('openai/gpt-step'),
      toolInvocationPart({ toolCallId: 'call-2', command: 'echo two', result: 'two' }),
      textPart('fixture answer'),
    ], { modelId: 'openai/gpt-message', provider: 'openai' })),
    message('m-user-2', 'signal', 'user', userContent('sig-2', 'fixture follow-up', 1793919150000)),
    message('m-asst-2', 'assistant', 'v2', assistantContent([textPart('fixture done', 1793919151000)], { modelId: 'openai/gpt-message', provider: 'openai' })),
  ]
}

/** @param {string[]} [ignoredRoots] */
function fakeResolver(ignoredRoots = []) {
  const markers = new Set(ignoredRoots.map((root) => path.resolve(root, '.hypignore')))
  return createUsagePolicyResolver({
    existsSync: (p) => markers.has(path.resolve(p)),
    readFileSync: () => 'ignore\n',
  })
}

/**
 * @param {Partial<Parameters<typeof projectMastracodeThread>[0]>} [overrides]
 */
async function project(overrides = {}) {
  const item = await projectMastracodeThread({
    thread: thread(),
    messages: turns(),
    sourcePath: SOURCE,
    resolver: fakeResolver(),
    deriveRepo: async () => ({ git_remote: 'https://fixture.invalid/repo.git', repo_root: 'fixture-root' }),
    ...overrides,
  })
  return /** @type {any} */ (item)
}

/** @param {any} item */
function contentParts(item) {
  return item.value.messages.filter((/** @type {any} */ m) => m.role !== 'system')
}

test('exchange identity: scoped session id, client, entrypoint, repo, provenance and reconcile scope', async () => {
  const item = await project()
  const exchange = item.value
  assert.equal(exchange.session_id, mastracodeScopeId(THREAD))
  assert.equal(exchange.client_name, MASTRACODE_CLIENT_NAME)
  assert.equal(exchange.conversation_source, MASTRACODE_CLIENT_NAME)
  assert.equal(exchange.entrypoint, 'mastracode')
  assert.equal(exchange.provider, 'openai')
  assert.equal(exchange.model, 'openai/gpt-message')
  assert.equal(exchange.conversation_started_at, '2026-11-05T22:52:20.800Z')
  assert.equal(exchange.cwd, PROJECT_DIR)
  assert.equal(exchange.git_remote, 'https://fixture.invalid/repo.git')
  assert.equal(exchange.repo_root, 'fixture-root')
  assert.deepEqual(item.reconcile, { where: { client_name: 'mastracode', session_id: `mastracode-${THREAD}` }, key: 'part_id' })
  assert.deepEqual(item.provenance, { client_name: 'mastracode', native_id: THREAD, source_path: SOURCE })
})

test('a multi-step assistant row yields its parts in content order, a result after each call', async () => {
  const parts = contentParts(await project())
  assert.deepEqual(parts.map((/** @type {any} */ p) => [p.role, p.content[0].type, p.message_id]), [
    ['user', 'text', mintMastracodePartId(THREAD, 'm-user-1', 0)],
    ['assistant', 'tool_use', mintMastracodePartId(THREAD, 'm-asst-1', 0)],
    ['tool', 'tool_result', mintMastracodePartId(THREAD, 'm-asst-1', 0, 'result')],
    ['assistant', 'tool_use', mintMastracodePartId(THREAD, 'm-asst-1', 4)],
    ['tool', 'tool_result', mintMastracodePartId(THREAD, 'm-asst-1', 4, 'result')],
    ['assistant', 'text', mintMastracodePartId(THREAD, 'm-asst-1', 5)],
    ['user', 'text', mintMastracodePartId(THREAD, 'm-user-2', 0)],
    ['assistant', 'text', mintMastracodePartId(THREAD, 'm-asst-2', 0)],
  ])
  const call = parts[1].content[0]
  assert.deepEqual(call, { type: 'tool_use', id: 'call-1', name: 'execute_command', input: { description: 'fixture command', command: 'echo one' } })
  assert.deepEqual(parts[2].content[0], { type: 'tool_result', tool_use_id: 'call-1', content: 'one' })
  assert.equal(parts[0].content[0].text, 'fixture prompt')
  assert.equal(parts[1].provider_uuid, 'm-asst-1')
})

test('a rewritten assistant row keeps the ids of the parts it already had', async () => {
  const first = [
    message('m-user-1', 'signal', 'user', userContent('sig-1', 'fixture prompt')),
    message('m-asst-1', 'assistant', 'v2', assistantContent([
      toolInvocationPart({ toolCallId: 'call-1', command: 'echo one', state: 'call' }),
    ])),
  ]
  const grown = [
    first[0],
    { ...first[1], content: JSON.stringify(assistantContent([
      toolInvocationPart({ toolCallId: 'call-1', command: 'echo one', result: 'one' }),
      workspaceMetadataPart('call-1', WORKSPACE_DIR),
      textPart('fixture answer'),
    ])) },
  ]
  const before = contentParts(await project({ messages: first })).map((/** @type {any} */ p) => p.message_id)
  const after = contentParts(await project({ messages: grown })).map((/** @type {any} */ p) => p.message_id)
  assert.deepEqual(after.slice(0, before.length), before)
  assert.equal(after.length, 4)
})

test('a call not yet in the result state yields only the call, and no part carries an error flag', async () => {
  const messages = [message('m-asst-1', 'assistant', 'v2', assistantContent([
    toolInvocationPart({ toolCallId: 'call-1', command: 'echo one', state: 'call' }),
  ]))]
  const parts = contentParts(await project({ messages }))
  assert.equal(parts.length, 1)
  assert.equal(parts[0].content[0].type, 'tool_use')
  const all = contentParts(await project())
  for (const part of all) {
    for (const block of part.content) assert.equal(block.is_error, undefined)
  }
})

test('a signal that is not a user prompt is not a prompt, and is counted', async () => {
  /** @type {MastraSkipCounts} */
  const skipped = {}
  const messages = [
    message('m-sys', 'signal', 'system-reminder', userContent('sig-x', 'fixture reminder')),
    ...turns(),
  ]
  const parts = contentParts(await project({ messages, skipped }))
  assert.ok(!JSON.stringify(parts).includes('fixture reminder'))
  assert.equal(parts.filter((/** @type {any} */ p) => p.role === 'user').length, 2)
  assert.equal(skipped.signal_other, 1)
})

test('sandbox-exit, reasoning and unknown parts are counted, not projected', async () => {
  /** @type {MastraSkipCounts} */
  const skipped = {}
  const messages = [
    message('m-asst-1', 'assistant', 'v2', assistantContent([
      sandboxExitPart('call-1', 2),
      { type: 'reasoning', text: 'fixture thinking' },
      { type: 'data-future-part', data: { x: 1 } },
      textPart('fixture answer'),
    ])),
    message('m-odd', 'odd-role', 'v2', assistantContent([textPart('fixture odd')])),
  ]
  const parts = contentParts(await project({ messages, skipped }))
  assert.deepEqual(parts.map((/** @type {any} */ p) => p.content[0].text), ['fixture answer'])
  assert.deepEqual(skipped, { 'data-sandbox-exit': 1, reasoning: 1, unknown: 2 })
})

test('no workspace-metadata value reaches any row, and cwd and source_path are the only paths', async () => {
  const item = await project()
  const text = JSON.stringify(item)
  for (const needle of [WORKSPACE_DIR, 'basePath', 'allowedPaths', 'local-fs-fixture', 'Mastra Code Workspace', 'memoryMB', 'mastra_workspace_execute_command']) {
    assert.ok(!text.includes(needle), needle)
  }
  const parts = JSON.stringify(contentParts(item))
  assert.ok(!parts.includes(PROJECT_DIR), 'project path leaked into a part')
  assert.ok(!parts.includes(SOURCE), 'source path leaked into a part')
  assert.equal(item.value.cwd, PROJECT_DIR)
  assert.equal(item.provenance.source_path, SOURCE)
})

test('the model is the step-start model, else the message modelId, else the thread currentModelId', async () => {
  const messages = [
    message('m-asst-1', 'assistant', 'v2', assistantContent([
      textPart('before the step'),
      stepStartPart('anthropic/claude-step'),
      textPart('after the step'),
    ], { modelId: 'openai/gpt-message' })),
    message('m-asst-2', 'assistant', 'v2', assistantContent([textPart('thread default')])),
  ]
  const parts = contentParts(await project({ messages }))
  assert.deepEqual(parts.map((/** @type {any} */ p) => p.model), ['openai/gpt-message', 'anthropic/claude-step', 'mastracode/openai/gpt-fixture'])
  assert.equal(providerOfModel('mastracode/openai/gpt-5.5'), 'openai')
  assert.equal(providerOfModel('openai/gpt-5.5'), 'openai')
  assert.equal(providerOfModel('gpt-5.5'), undefined)
  assert.equal(providerOfModel('mastracode/gpt-5.5'), undefined)
})

test('a prompt carries the provider of the assistant message that answered it', async () => {
  const parts = contentParts(await project())
  assert.equal(parts[0].provider, 'openai')
  assert.equal(parts[0].model, undefined, 'a user part names no model')
})

test('ordinary messages carry no per-turn usage and no provider raw payload', async () => {
  const exchange = (await project()).value
  assert.equal(exchange.usage, undefined)
  for (const part of exchange.messages) assert.equal(part.usage, undefined)
  const text = JSON.stringify(contentParts({ value: exchange }))
  for (const field of ['input_tokens', 'output_tokens', 'prompt_tokens', 'completion_tokens', '"raw"']) {
    assert.ok(!text.includes(field), field)
  }
})

test('the running counter rides only the last part of the latest assistant message, without raw', async () => {
  const parts = contentParts(await project())
  const carrying = parts.filter((/** @type {any} */ p) => p.attributes?.mastracode)
  assert.equal(carrying.length, 1)
  assert.equal(carrying[0].message_id, mintMastracodePartId(THREAD, 'm-asst-2', 0))
  const { raw, ...counters } = TOKEN_USAGE
  assert.deepEqual(carrying[0].attributes.mastracode.process_token_usage, counters)
})

test('a thread with no counter, or no assistant part, carries no usage attribute', async () => {
  const noUsage = contentParts(await project({ thread: thread({}, { tokenUsage: undefined }) }))
  assert.ok(noUsage.every((/** @type {any} */ p) => p.attributes === undefined))
  const promptOnly = contentParts(await project({ messages: [turns()[0]] }))
  assert.ok(promptOnly.every((/** @type {any} */ p) => p.attributes === undefined))
})

test('the title rides the session-title row', async () => {
  const titles = (await project()).value.messages.filter((/** @type {any} */ m) => m.attributes?.session)
  assert.equal(titles.length, 1)
  assert.equal(titles[0].attributes.session.title, 'Fixture thread')
  const untitled = (await project({ thread: thread({ title: '' }) })).value.messages.filter((/** @type {any} */ m) => m.attributes?.session)
  assert.equal(untitled.length, 0)
})

test('session usage materializes normalized columns without inheriting the last model', async () => {
  const tokenUsage = { promptTokens: 28026, completionTokens: 295, cachedInputTokens: 0,
    cacheCreationInputTokens: 28022, reasoningTokens: 292, totalTokens: 28321, raw: { secret: 'omit' } }
  const item = await project({ thread: thread({}, { tokenUsage }) })
  const rows = await aiGatewayBackfillMaterializer().materialize(item, /** @type {any} */ ({}))
  const snapshots = rows.filter(row => row.provider_subtype === 'session_usage')
  assert.equal(snapshots.length, 1)
  const row = snapshots[0]
  assert.equal(row.input_tokens, 4)
  assert.equal(row.output_tokens, 295)
  assert.equal(row.reasoning_tokens, 292)
  assert.equal(row.cache_read_tokens, 0)
  assert.equal(row.cache_write_tokens, 28022)
  assert.equal(row.total_tokens, 28321)
  assert.equal(row.role, 'system')
  assert.equal(row.model, 'unknown')
  assert.equal(row.provider, 'unknown')
  assert.equal(row.message_created_at, thread().createdAt)
  assert.ok(!JSON.stringify(rows).includes('secret'))
  assert.ok(rows.filter(r => r !== row).every(r => r.input_tokens == null && r.output_tokens == null))

  const revised = await project({ thread: thread({ updatedAt: '2026-11-06T00:00:00.000Z' }, {
    tokenUsage: { ...tokenUsage, promptTokens: 57091, cachedInputTokens: 29008, cacheCreationInputTokens: 28077 },
  }) })
  const next = (await aiGatewayBackfillMaterializer().materialize(revised, /** @type {any} */ ({}))).find(r => r.provider_subtype === 'session_usage')
  assert.ok(next)
  assert.notEqual(next.part_id, row.part_id)
  assert.ok(String(next.part_id).startsWith(`${next.message_id}#`))
  const repeat = (await aiGatewayBackfillMaterializer().materialize(await project({ thread: thread({}, { tokenUsage }) }), /** @type {any} */ ({}))).find(r => r.provider_subtype === 'session_usage')
  assert.equal(repeat?.part_id, row.part_id)
  assert.equal(next.input_tokens, 6)
  assert.equal(next.message_created_at, row.message_created_at)
  assert.equal(/** @type {any} */ (next.attributes).mastracode.usage_observed_at, '2026-11-06T00:00:00.000Z')
})

test('session usage rejects invalid counters and preserves missing measurements as unknown', async () => {
  for (const tokenUsage of [undefined, {}, { ...TOKEN_USAGE, promptTokens: -1 },
    { ...TOKEN_USAGE, completionTokens: 1.5 }, { ...TOKEN_USAGE, cachedInputTokens: 400 },
    { ...TOKEN_USAGE, totalTokens: Number.MAX_SAFE_INTEGER + 1 }]) {
    const item = await project({ thread: thread({}, { tokenUsage }) })
    assert.ok(!item.value.messages.some((/** @type {any} */ m) => m.provider_subtype === 'session_usage'))
  }
  const item = await project({ thread: thread({}, { tokenUsage: { promptTokens: 50, completionTokens: 0 } }) })
  const row = (await aiGatewayBackfillMaterializer().materialize(item, /** @type {any} */ ({}))).find(r => r.provider_subtype === 'session_usage')
  assert.ok(row)
  assert.equal(row.output_tokens, 0)
  assert.equal(row.input_tokens, null)
  assert.equal(row.cache_read_tokens, null)
  assert.equal(row.cache_write_tokens, null)
  assert.equal(row.total_tokens, null)
})

test('an ignored project drops the thread before any row is built, and the log names no path', async () => {
  /** @type {Array<[string, Record<string, unknown>]>} */
  const logged = []
  const log = /** @type {any} */ ({
    info: (/** @type {string} */ name, /** @type {Record<string, unknown>} */ attrs) => logged.push([name, attrs]),
    warn: (/** @type {string} */ name, /** @type {Record<string, unknown>} */ attrs) => logged.push([name, attrs]),
  })
  let derived = false
  const item = await projectMastracodeThread({
    thread: thread(),
    messages: turns(),
    sourcePath: SOURCE,
    resolver: fakeResolver([PROJECT_DIR]),
    deriveRepo: async () => { derived = true; return {} },
    log,
  })
  assert.equal(item, undefined)
  assert.equal(derived, false)
  assert.equal(logged.length, 1)
  assert.equal(logged[0][0], 'plugin.mastracode.usage_policy_drop')
  assert.equal(logged[0][1].session_id, THREAD)
  const text = JSON.stringify(logged)
  assert.ok(!text.includes(PROJECT_DIR))
  assert.ok(!text.includes(SOURCE))
  assert.ok(!text.includes('Fixture thread'), 'the title is content')
})

test('an empty transcript is still an item, so a pruned thread reconciles its parts away', async () => {
  const item = await project({ messages: [] })
  assert.ok(item)
  assert.deepEqual(contentParts(item), [])
})
