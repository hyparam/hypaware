// @ts-check

import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import {
  HERMES_CHANNEL_SOURCES,
  channelScopePath,
  hermesScopeId,
  mintHermesMessageId,
  mintHermesSessionEndId,
  normalizeHermesProvider,
  projectHermesSession,
} from '../../hypaware-core/plugins-workspace/hermes/src/projector.js'
import { createUsagePolicyResolver } from '../../src/core/usage-policy/index.js'

/**
 * @import { HermesMessageRow, HermesSessionRow } from '../../hypaware-core/plugins-workspace/hermes/src/types.js'
 */

/**
 * @ref LLP 0120 [tests]: golden projection of a hermes session into
 * `AiGatewayProjectedExchange`.
 * @ref LLP 0122#projection [tests]: the full hermes -> ai_gateway_messages
 * mapping table.
 * @ref LLP 0122#session-end-part [tests]: the synthetic session-end part.
 * @ref LLP 0124 [tests]: channel-session scope stamping and its governance
 * by the shared usage-policy resolver.
 *
 * Fixture rows mirror the T1 reader fixture
 * (`test/plugins/hermes-state-db.test.js` `buildFixtureStateDb`) exactly, so
 * this is a golden projection of the same data the reader is tested against
 * (spec R2's identity requirement holds across the reader/projector seam).
 */

const HOME_DIR = '/home/tester'

// ---------------------------------------------------------------------------
// T1 fixture mirror
// ---------------------------------------------------------------------------

/** @returns {HermesSessionRow} */
function openInteractiveSession() {
  return {
    id: 1,
    source: 'cli',
    model: 'gpt-4o',
    cwd: '/home/dev/project',
    parent_session_id: null,
    started_at: '2026-07-20T10:00:00Z',
    ended_at: null,
    end_reason: null,
    billing_provider: 'openai',
    billing_base_url: 'https://api.openai.com/v1',
    system_prompt: 'You are a helpful assistant.',
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    reasoning_tokens: null,
    estimated_cost_usd: null,
    actual_cost_usd: null,
    api_call_count: null,
  }
}

/** @returns {HermesMessageRow[]} */
function openInteractiveMessages() {
  return [
    {
      id: 1, session_id: 1, role: 'user', content: 'list the files here',
      tool_calls: null, tool_name: null, tool_call_id: null, reasoning: null,
      timestamp: '2026-07-20T10:00:01Z', token_count: null, finish_reason: null,
    },
    {
      id: 2, session_id: 1, role: 'assistant', content: null,
      tool_calls: JSON.stringify([{ id: 'call_1', name: 'list_files', arguments: '{"path":"."}' }]),
      tool_name: 'list_files', tool_call_id: 'call_1',
      reasoning: 'the user wants a directory listing, I should call list_files',
      timestamp: '2026-07-20T10:00:02Z', token_count: 42, finish_reason: 'tool_calls',
    },
    {
      id: 3, session_id: 1, role: 'tool', content: 'a.txt\nb.txt',
      tool_calls: null, tool_name: 'list_files', tool_call_id: 'call_1', reasoning: null,
      timestamp: '2026-07-20T10:00:03Z', token_count: null, finish_reason: null,
    },
  ]
}

/** @returns {HermesSessionRow} */
function endedSession() {
  return {
    id: 3,
    source: 'cli',
    model: 'o3',
    cwd: '/home/dev/other',
    parent_session_id: null,
    started_at: '2026-07-20T09:00:00Z',
    ended_at: '2026-07-20T09:05:00Z',
    end_reason: 'completed',
    billing_provider: 'openai',
    billing_base_url: 'https://api.openai.com/v1',
    system_prompt: null,
    input_tokens: 120,
    output_tokens: 80,
    cache_read_tokens: 10,
    cache_write_tokens: 0,
    reasoning_tokens: 200,
    estimated_cost_usd: 0.0041,
    actual_cost_usd: 0.0039,
    api_call_count: 2,
  }
}

/** @returns {HermesMessageRow[]} */
function endedSessionMessages() {
  return [
    {
      id: 4, session_id: 3, role: 'user', content: 'why is the sky blue',
      tool_calls: null, tool_name: null, tool_call_id: null, reasoning: null,
      timestamp: '2026-07-20T09:00:01Z', token_count: null, finish_reason: null,
    },
    {
      id: 5, session_id: 3, role: 'assistant', content: 'Rayleigh scattering.',
      tool_calls: null, tool_name: null, tool_call_id: null,
      reasoning: 'the user is asking a physics question, keep it short',
      timestamp: '2026-07-20T09:04:59Z', token_count: 200, finish_reason: 'stop',
    },
  ]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A resolver with no real filesystem access: every `.hypignore` lookup is
 * answered from an in-memory map of governed roots, so tests never touch
 * disk and never depend on what happens to exist above `os.tmpdir()`.
 *
 * @param {string[]} ignoredRoots
 */
function fakeResolver(ignoredRoots = []) {
  const markers = new Set(ignoredRoots.map((root) => path.join(root, '.hypignore')))
  return createUsagePolicyResolver({
    existsSync: (p) => markers.has(p),
    readFileSync: () => 'ignore\n',
  })
}

/** @returns {(cwd: string | undefined) => Promise<{ git_remote?: string, repo_root?: string }>} */
function noopDeriveRepo() {
  return async () => ({})
}

/**
 * @returns {(cwd: string | undefined) => Promise<{ git_remote?: string, repo_root?: string }>}
 */
function throwingDeriveRepo() {
  return async () => { throw new Error('deriveRepo must not be called for this session') }
}

// ---------------------------------------------------------------------------
// Golden projection (T1 fixture, open interactive session)
// ---------------------------------------------------------------------------

test('golden projection: open interactive session with tool call and reasoning', async () => {
  const item = await projectHermesSession({
    session: openInteractiveSession(),
    messages: openInteractiveMessages(),
    sourcePath: '/home/tester/.hermes/state.db',
    homeDir: HOME_DIR,
    deriveRepo: noopDeriveRepo(),
    resolver: fakeResolver(),
  })

  assert.ok(item, 'session with messages must project')
  const exchange = /** @type {any} */ (item).value
  assert.equal(item?.dataset, 'ai_gateway_messages')
  assert.equal(item?.kind, 'ai_gateway.projected_exchange')
  assert.deepEqual(item?.provenance, { client_name: 'hermes', native_id: '1', source_path: '/home/tester/.hermes/state.db' })

  assert.equal(exchange.provider, 'openai')
  assert.equal(exchange.session_id, 'hermes-1')
  assert.equal(exchange.conversation_source, 'hermes')
  assert.equal(exchange.client_name, 'hermes')
  assert.equal(exchange.entrypoint, 'cli')
  assert.equal(exchange.conversation_started_at, '2026-07-20T10:00:00Z')
  assert.equal(exchange.model, 'gpt-4o')
  assert.equal(exchange.system_text, 'You are a helpful assistant.')
  assert.equal(exchange.cwd, '/home/dev/project')
  assert.equal(exchange.parent_thread_id, undefined)
  assert.deepEqual(exchange.attributes, { hermes: { source: 'cli' } })
  assert.equal(exchange.git_remote, undefined)
  assert.equal(exchange.repo_root, undefined)

  assert.equal(exchange.messages.length, 4, 'text + (thinking, tool_use) + tool_result')
  assert.deepEqual(exchange.messages[0], {
    role: 'user',
    content: [{ type: 'text', text: 'list the files here' }],
    message_id: 'hermes-1-1-0',
    provider_uuid: '1',
    message_created_at: '2026-07-20T10:00:01Z',
  })
  assert.deepEqual(exchange.messages[1], {
    role: 'assistant',
    content: [{ type: 'thinking', thinking: 'the user wants a directory listing, I should call list_files' }],
    message_id: 'hermes-1-2-0',
    provider_uuid: '2',
    message_created_at: '2026-07-20T10:00:02Z',
  })
  assert.deepEqual(exchange.messages[2], {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'call_1', name: 'list_files', input: { path: '.' } }],
    message_id: 'hermes-1-2-1',
    provider_uuid: '2',
    message_created_at: '2026-07-20T10:00:02Z',
    attributes: { usage: { total_tokens: 42 } },
    stop_reason: 'tool_calls',
  })
  assert.deepEqual(exchange.messages[3], {
    role: 'tool',
    content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'a.txt\nb.txt' }],
    message_id: 'hermes-1-3-0',
    provider_uuid: '3',
    message_created_at: '2026-07-20T10:00:03Z',
  })
})

// ---------------------------------------------------------------------------
// Session-end part: present exactly once for an ended session, absent for
// an open one (LLP 0122#session-end-part)
// ---------------------------------------------------------------------------

test('an open session never carries a session-end part', async () => {
  const item = await projectHermesSession({
    session: openInteractiveSession(),
    messages: openInteractiveMessages(),
    deriveRepo: noopDeriveRepo(),
    resolver: fakeResolver(),
  })
  const exchange = /** @type {any} */ (item).value
  assert.equal(exchange.messages.some((/** @type {any} */ m) => m.message_id === 'hermes-1-session_end'), false)
})

test('an ended session carries exactly one session-end part with final totals and costs', async () => {
  const item = await projectHermesSession({
    session: endedSession(),
    messages: endedSessionMessages(),
    deriveRepo: noopDeriveRepo(),
    resolver: fakeResolver(),
  })
  const exchange = /** @type {any} */ (item).value

  const endParts = exchange.messages.filter((/** @type {any} */ m) => m.message_id === 'hermes-3-session_end')
  assert.equal(endParts.length, 1, 'exactly one session-end part')
  assert.deepEqual(endParts[0], {
    role: 'system',
    content: [{ type: 'status', status: 'session_end' }],
    message_id: 'hermes-3-session_end',
    message_created_at: '2026-07-20T09:05:00Z',
    attributes: {
      hermes: {
        session_end: true,
        end_reason: 'completed',
        estimated_cost_usd: 0.0041,
        actual_cost_usd: 0.0039,
        api_call_count: 2,
      },
      usage: {
        input_tokens: 120,
        output_tokens: 80,
        cache_read_tokens: 10,
        cache_write_tokens: 0,
        reasoning_tokens: 200,
      },
    },
  })
  assert.equal(mintHermesSessionEndId(3), 'hermes-3-session_end')

  // Two message rows (one text part, one reasoning+text pair) plus the one
  // synthetic end part, no more.
  assert.equal(exchange.messages.length, 4)
})

// ---------------------------------------------------------------------------
// Identity determinism across re-runs (spec R2)
// ---------------------------------------------------------------------------

test('projecting the same session twice yields byte-identical identity', async () => {
  const args = () => ({
    session: endedSession(),
    messages: endedSessionMessages(),
    deriveRepo: noopDeriveRepo(),
    resolver: fakeResolver(),
  })
  const first = await projectHermesSession(args())
  const second = await projectHermesSession(args())
  assert.deepEqual(first, second)

  const ids = /** @type {any} */ (first).value.messages.map((/** @type {any} */ m) => m.message_id)
  assert.deepEqual(ids, ['hermes-3-4-0', 'hermes-3-5-0', 'hermes-3-5-1', 'hermes-3-session_end'])
})

// ---------------------------------------------------------------------------
// Usage-policy skip (spec R3, LLP 0050)
// ---------------------------------------------------------------------------

test('a session under an ignored cwd is skipped before any row is built', async () => {
  const session = openInteractiveSession()
  session.cwd = '/home/dev/ignored/project'
  const item = await projectHermesSession({
    session,
    messages: openInteractiveMessages(),
    deriveRepo: throwingDeriveRepo(),
    resolver: fakeResolver(['/home/dev/ignored']),
  })
  assert.equal(item, undefined)
})

// ---------------------------------------------------------------------------
// Channel-session scope stamping (LLP 0124, spec R10)
// ---------------------------------------------------------------------------

test('a channel session is stamped with the canonical channel scope path, real cwd preserved', async () => {
  /** @type {HermesSessionRow} */
  const session = {
    ...openInteractiveSession(),
    id: 2,
    source: 'telegram',
    cwd: '/var/hermes-bot/workdir',
  }
  /** @type {HermesMessageRow[]} */
  const messages = [{
    id: 10, session_id: 2, role: 'user', content: 'hi from telegram',
    tool_calls: null, tool_name: null, tool_call_id: null, reasoning: null,
    timestamp: '2026-07-20T11:00:01Z', token_count: null, finish_reason: null,
  }]

  const item = await projectHermesSession({
    session,
    messages,
    homeDir: HOME_DIR,
    deriveRepo: throwingDeriveRepo(),
    resolver: fakeResolver(),
  })
  assert.ok(item)
  const exchange = /** @type {any} */ (item).value
  assert.equal(exchange.cwd, channelScopePath('telegram', HOME_DIR))
  assert.equal(exchange.cwd, path.join(HOME_DIR, '.hermes', 'channels', 'telegram'))
  assert.equal(exchange.attributes.hermes.real_cwd, '/var/hermes-bot/workdir')
  assert.equal(exchange.attributes.hermes.source, 'telegram')
  assert.ok(HERMES_CHANNEL_SOURCES.has('telegram'))
})

test('a channel session is governed by a marked channel scope, same as any other cwd', async () => {
  /** @type {HermesSessionRow} */
  const session = {
    ...openInteractiveSession(),
    id: 2,
    source: 'telegram',
    cwd: null,
  }
  /** @type {HermesMessageRow[]} */
  const messages = [{
    id: 10, session_id: 2, role: 'user', content: 'hi from telegram',
    tool_calls: null, tool_name: null, tool_call_id: null, reasoning: null,
    timestamp: '2026-07-20T11:00:01Z', token_count: null, finish_reason: null,
  }]

  const item = await projectHermesSession({
    session,
    messages,
    homeDir: HOME_DIR,
    deriveRepo: throwingDeriveRepo(),
    resolver: fakeResolver([channelScopePath('telegram', HOME_DIR)]),
  })
  assert.equal(item, undefined, 'a marked-ignore channel scope drops the whole session')
})

// ---------------------------------------------------------------------------
// NULL-cwd interactive session (LLP 0122#usage-policy)
// ---------------------------------------------------------------------------

test('an interactive session with NULL cwd records unconditionally (no scope to match)', async () => {
  /** @type {HermesSessionRow} */
  const session = { ...openInteractiveSession(), cwd: null }
  const item = await projectHermesSession({
    session,
    messages: openInteractiveMessages(),
    deriveRepo: throwingDeriveRepo(),
    // Even a resolver that would ignore everything must never be consulted:
    // there is no scope to resolve against.
    resolver: fakeResolver(['/']),
  })
  assert.ok(item, 'NULL cwd has no scope to match, so the session records')
  const exchange = /** @type {any} */ (item).value
  assert.equal(exchange.cwd, undefined)
})

// ---------------------------------------------------------------------------
// A session with no messages and no end yields nothing to write
// ---------------------------------------------------------------------------

test('a session with no messages and no end yields undefined', async () => {
  const session = openInteractiveSession()
  const item = await projectHermesSession({
    session,
    messages: [],
    deriveRepo: noopDeriveRepo(),
    resolver: fakeResolver(),
  })
  assert.equal(item, undefined)
})

// ---------------------------------------------------------------------------
// Small pure-function coverage: id minting, provider normalization
// ---------------------------------------------------------------------------

test('hermesScopeId and mintHermesMessageId namespace hermes store-scoped integer ids', () => {
  assert.equal(hermesScopeId(42), 'hermes-42')
  assert.equal(mintHermesMessageId(1, 2, 0), 'hermes-1-2-0')
  assert.equal(mintHermesMessageId(1, 2, 1), 'hermes-1-2-1')
})

test('normalizeHermesProvider prefers a known base_url host, falls back to billing_provider, then unknown', () => {
  assert.equal(normalizeHermesProvider({
    ...openInteractiveSession(), billing_base_url: 'https://api.openai.com/v1', billing_provider: 'something-else',
  }), 'openai')
  assert.equal(normalizeHermesProvider({
    ...openInteractiveSession(), billing_base_url: 'https://openrouter.ai/api/v1', billing_provider: null,
  }), 'openrouter')
  assert.equal(normalizeHermesProvider({
    ...openInteractiveSession(), billing_base_url: 'https://my-custom-gateway.example.com/v1', billing_provider: null,
  }), 'my-custom-gateway.example.com')
  assert.equal(normalizeHermesProvider({
    ...openInteractiveSession(), billing_base_url: null, billing_provider: 'nous',
  }), 'nous')
  assert.equal(normalizeHermesProvider({
    ...openInteractiveSession(), billing_base_url: null, billing_provider: null,
  }), 'unknown')
})
