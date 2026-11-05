// @ts-check

import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import {
  GOOSE_CLIENT_NAME,
  gooseScopeId,
  gooseTimestampToIso,
  mintGooseMessageId,
  projectGooseSession,
} from '../../hypaware-core/plugins-workspace/goose/src/projector.js'
import { createUsagePolicyResolver } from '../../src/core/usage-policy/index.js'

/**
 * @import { GooseMessageRow, GooseSessionRow } from '../../hypaware-core/plugins-workspace/goose/src/types.js'
 */

/**
 * @ref LLP 0570#projection [tests]: the Goose -> ai_gateway_messages mapping,
 *   deterministic part ids under a rewrite, D2 and D3.
 * @ref LLP 0570#privacy [tests]: the usage-policy skip and its path-free log.
 *
 * Rows are synthetic copies of the shapes the Goose v1.57.0 probe recorded
 * (probe/messages.sample.json), not captured content.
 */

const WORK_DIR = '/work/fixture'

/** @returns {GooseSessionRow} */
function fixtureSession() {
  return {
    id: '20261102_1',
    name: 'Fixture session',
    session_type: 'user',
    working_dir: WORK_DIR,
    created_at: '2026-11-02 22:19:51',
    updated_at: '2026-11-02 22:20:10',
    provider_name: 'openai',
    model_config_json: '{"model_name":"fixture-model"}',
    parent_session_id: null,
  }
}

/**
 * @param {number} id
 * @param {Partial<GooseMessageRow> & { content: unknown[], metadata?: unknown }} fields
 * @returns {GooseMessageRow}
 */
function row(id, fields) {
  const { content, metadata, ...rest } = fields
  return {
    id,
    message_id: null,
    session_id: '20261102_1',
    role: 'user',
    created_timestamp: 1793744391 + id,
    ...rest,
    content_json: JSON.stringify(content),
    metadata_json: JSON.stringify(metadata ?? { userVisible: true, agentVisible: true }),
  }
}

/**
 * One turn: a user prompt, Goose's turn-context injection, an assistant
 * tool call, its tool result and the assistant's closing text.
 *
 * @param {number} [firstId]
 * @returns {GooseMessageRow[]}
 */
function fixtureMessages(firstId = 1) {
  const inference = { provider: 'openai', requestedModel: 'fixture-model' }
  return [
    row(firstId, { message_id: 'msg_fixture-1', content: [{ type: 'text', text: 'fixture prompt' }] }),
    row(firstId + 1, { message_id: 'msg_fixture-2', content: [{ type: 'text', text: 'fixture turn context' }], metadata: { userVisible: false, turnContext: true } }),
    row(firstId + 2, {
      role: 'assistant',
      message_id: 'chatcmpl-fixture-3',
      content: [
        { type: 'text', text: 'running the command' },
        { type: 'toolRequest', id: 'call_fixture_3', toolCall: { status: 'success', value: { name: 'shell', arguments: { command: 'echo fixture' } } } },
      ],
      metadata: { userVisible: true, agentVisible: true, inference, usage: { inputTokens: 103, outputTokens: 13, totalTokens: 116 } },
    }),
    row(firstId + 3, {
      message_id: 'msg_fixture-4',
      content: [{
        type: 'toolResponse',
        id: 'call_fixture_3',
        toolResult: { status: 'success', value: { content: [{ type: 'text', text: 'fixture\n' }], structuredContent: { stdout: 'fixture\n', stderr: '', exit_code: 0 }, isError: false } },
      }],
    }),
    row(firstId + 4, {
      role: 'assistant',
      message_id: 'chatcmpl-fixture-4',
      content: [{ type: 'text', text: 'fixture done' }],
      metadata: { userVisible: true, agentVisible: true, inference, usage: { inputTokens: 140, outputTokens: 5, totalTokens: 145 } },
    }),
  ]
}

/** @param {string[]} [ignoredRoots] */
function fakeResolver(ignoredRoots = []) {
  // Resolved: the matcher hands the fs the resolved spelling, which on win32
  // gains a drive letter and backslashes over a POSIX-written fixture.
  const markers = new Set(ignoredRoots.map((root) => path.resolve(root, '.hypignore')))
  return createUsagePolicyResolver({
    existsSync: (p) => markers.has(path.resolve(p)),
    readFileSync: () => 'ignore\n',
  })
}

/** @returns {(cwd: string | undefined) => Promise<{ git_remote?: string, repo_root?: string }>} */
function noopDeriveRepo() {
  return async () => ({})
}

/**
 * @param {Partial<Parameters<typeof projectGooseSession>[0]>} [overrides]
 */
async function project(overrides = {}) {
  const item = await projectGooseSession({
    session: fixtureSession(),
    messages: fixtureMessages(),
    resolver: fakeResolver(),
    deriveRepo: noopDeriveRepo(),
    ...overrides,
  })
  return /** @type {any} */ (item)
}

test('each message shape projects to its part, turnContext rows are skipped', async () => {
  const item = await project()
  const exchange = item.value
  const parts = exchange.messages.filter((/** @type {any} */ m) => m.role !== 'system')
  assert.deepEqual(parts.map((/** @type {any} */ m) => [m.role, m.content[0].type]), [
    ['user', 'text'],
    ['assistant', 'text'],
    ['assistant', 'tool_use'],
    ['tool', 'tool_result'],
    ['assistant', 'text'],
  ])
  assert.ok(!JSON.stringify(parts).includes('fixture turn context'))
  assert.deepEqual(parts[2].content[0], { type: 'tool_use', id: 'call_fixture_3', name: 'shell', input: { command: 'echo fixture' } })
  assert.deepEqual(parts[3].content[0], { type: 'tool_result', tool_use_id: 'call_fixture_3', content: { stdout: 'fixture\n', stderr: '', exit_code: 0 } })
  assert.equal(parts[0].message_created_at, new Date((1793744391 + 1) * 1000).toISOString())
  assert.equal(parts[0].provider_uuid, '1')
  assert.equal(parts[1].model, 'fixture-model')
  assert.equal(parts[0].model, undefined)
})

test('usage rides only the last part of its assistant row', async () => {
  const parts = (await project()).value.messages
  const callRow = parts.filter((/** @type {any} */ m) => m.provider_uuid === '3')
  assert.equal(callRow.length, 2)
  assert.equal(callRow[0].attributes, undefined)
  assert.deepEqual(callRow[1].attributes, { usage: { input_tokens: 103, output_tokens: 13, total_tokens: 116 } })
})

test('part ids are deterministic: a replace_conversation rewrite with new row ids mints the same ids', async () => {
  const first = (await project()).value.messages.map((/** @type {any} */ m) => m.message_id)
  const rewritten = (await project({ messages: fixtureMessages(101) })).value.messages.map((/** @type {any} */ m) => m.message_id)
  assert.equal(new Set(first).size, first.length)
  assert.deepEqual(rewritten, first)
  assert.ok(first.includes(mintGooseMessageId('20261102_1', 'msg_fixture-1', 0, 0)))
  assert.ok(first.includes(mintGooseMessageId('20261102_1', 'chatcmpl-fixture-3', 0, 0)))
  assert.ok(first.includes(mintGooseMessageId('20261102_1', 'chatcmpl-fixture-3', 0, 1)))
})

test('a null message_id falls back to the row id, and a repeated message_id counts occurrences', async () => {
  const messages = [
    row(7, { content: [{ type: 'text', text: 'a' }] }),
    row(8, { role: 'assistant', message_id: 'chatcmpl-dup', content: [{ type: 'text', text: 'b' }] }),
    row(9, { role: 'assistant', message_id: 'chatcmpl-dup', content: [{ type: 'text', text: 'c' }] }),
  ]
  const ids = (await project({ messages })).value.messages
    .filter((/** @type {any} */ m) => m.role !== 'system')
    .map((/** @type {any} */ m) => m.message_id)
  assert.deepEqual(ids, [
    mintGooseMessageId('20261102_1', 'id7', 0, 0),
    mintGooseMessageId('20261102_1', 'chatcmpl-dup', 0, 0),
    mintGooseMessageId('20261102_1', 'chatcmpl-dup', 1, 0),
  ])
})

test('an item marked not user-visible is skipped and its siblings keep their content index', async () => {
  const messages = [row(1, {
    role: 'assistant',
    message_id: 'chatcmpl-vis',
    content: [{ type: 'text', text: 'hidden aside', userVisible: false }, { type: 'text', text: 'shown' }],
  })]
  const parts = (await project({ messages })).value.messages.filter((/** @type {any} */ m) => m.role !== 'system')
  assert.equal(parts.length, 1)
  assert.equal(parts[0].content[0].text, 'shown')
  assert.equal(parts[0].message_id, mintGooseMessageId('20261102_1', 'chatcmpl-vis', 0, 1))
})

test('exchange identity: scoped session id, client, entrypoint, model and started_at', async () => {
  const item = await project()
  const exchange = item.value
  assert.equal(exchange.session_id, gooseScopeId('20261102_1'))
  assert.equal(exchange.client_name, GOOSE_CLIENT_NAME)
  assert.equal(exchange.conversation_source, GOOSE_CLIENT_NAME)
  assert.equal(exchange.entrypoint, 'goose-user')
  assert.equal(exchange.provider, 'openai')
  assert.equal(exchange.model, 'fixture-model')
  assert.equal(exchange.conversation_started_at, '2026-11-02T22:19:51.000Z')
  assert.equal(exchange.cwd, WORK_DIR)
  assert.equal(exchange.parent_thread_id, undefined)
  assert.deepEqual(item.reconcile, { where: { client_name: 'goose', session_id: 'goose-20261102_1' }, key: 'part_id' })
  assert.deepEqual(item.provenance, { client_name: 'goose', native_id: '20261102_1' })
})

test('provider and model fall back to the session row, then to unknown', async () => {
  const messages = [row(1, { content: [{ type: 'text', text: 'only a prompt' }] })]
  const exchange = (await project({ messages })).value
  assert.equal(exchange.provider, 'openai')
  assert.equal(exchange.model, 'fixture-model')
  const bare = (await project({ messages, session: { ...fixtureSession(), provider_name: null, model_config_json: null } })).value
  assert.equal(bare.provider, 'unknown')
  assert.equal(bare.model, undefined)
})

test('a sub_agent session links to its parent (D2)', async () => {
  const session = { ...fixtureSession(), id: '20261102_3', session_type: 'sub_agent', parent_session_id: '20261102_1' }
  const exchange = (await project({ session })).value
  assert.equal(exchange.entrypoint, 'goose-sub_agent')
  assert.equal(exchange.parent_thread_id, 'goose-20261102_1')
})

test('the session name is captured as a title part, revisioned by the name (D3)', async () => {
  const titles = (await project()).value.messages.filter((/** @type {any} */ m) => m.role === 'system')
  assert.equal(titles.length, 1)
  assert.equal(titles[0].attributes.session.title, 'Fixture session')
  const moved = (await project({ session: { ...fixtureSession(), updated_at: '2026-11-02 22:30:00' } })).value.messages
    .filter((/** @type {any} */ m) => m.role === 'system')
  assert.equal(moved[0].message_id, titles[0].message_id)
  const empty = (await project({ messages: [] })).value
  assert.deepEqual(empty.messages, [])
})

test('an ignored working_dir drops the session and the log names no path', async () => {
  /** @type {Array<[string, Record<string, unknown>]>} */
  const logged = []
  const log = /** @type {any} */ ({
    info: (/** @type {string} */ name, /** @type {Record<string, unknown>} */ attrs) => logged.push([name, attrs]),
    warn: (/** @type {string} */ name, /** @type {Record<string, unknown>} */ attrs) => logged.push([name, attrs]),
  })
  let derived = false
  const item = await projectGooseSession({
    session: fixtureSession(),
    messages: fixtureMessages(),
    resolver: fakeResolver([WORK_DIR]),
    deriveRepo: async () => { derived = true; return {} },
    log,
  })
  assert.equal(item, undefined)
  assert.equal(derived, false)
  assert.equal(logged.length, 1)
  assert.equal(logged[0][0], 'plugin.goose.usage_policy_drop')
  assert.equal(logged[0][1].session_id, '20261102_1')
  assert.ok(!JSON.stringify(logged).includes(WORK_DIR))
})

test('gooseTimestampToIso reads Goose CURRENT_TIMESTAMP text as UTC', () => {
  assert.equal(gooseTimestampToIso('2026-11-02 22:19:51'), '2026-11-02T22:19:51.000Z')
  assert.equal(gooseTimestampToIso(''), undefined)
  assert.equal(gooseTimestampToIso('not a time'), undefined)
  assert.equal(gooseTimestampToIso(null), undefined)
})
