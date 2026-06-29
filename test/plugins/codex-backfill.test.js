// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  AI_GATEWAY_PROJECTED_EXCHANGE_KIND,
  DATASET_NAME,
  aiGatewayBackfillMaterializer,
} from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import { createCodexBackfillProvider } from '../../hypaware-core/plugins-workspace/codex/src/backfill.js'

/**
 * End-to-end tests for the `@hypaware/codex` backfill provider. They run the
 * real provider against on-disk Codex rollout files and feed the yielded
 * items through the real `@hypaware/ai-gateway`
 * `ai_gateway.projected_exchange` materializer, so the assertions cover the
 * exact path `hyp backfill codex` exercises in production.
 *
 * @import { BackfillEvent, BackfillItem, BackfillRunContext } from '../../collectivus-plugin-kernel-types.d.ts'
 */

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function stageEnv() {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-backfill-'))
  return {
    homeDir,
    sessionsDir: path.join(homeDir, '.codex', 'sessions'),
    cleanup: () => fs.rm(homeDir, { recursive: true, force: true }),
  }
}

/**
 * Write a modern line-delimited rollout under `.codex/sessions/<relPath>`.
 *
 * @param {{ homeDir: string }} env
 * @param {string} relPath  path under the sessions dir (may include subdirs)
 * Each item's envelope `type` defaults to `response_item`; pass an explicit
 * `type` (e.g. `event_msg`) to interleave non-message records like
 * `token_count` in stream order.
 *
 * @param {{
 *   meta: Record<string, unknown>,
 *   turns?: Array<Record<string, unknown>>,
 *   items: Array<{ type?: string, timestamp?: string, payload: Record<string, unknown> }>,
 * }} doc
 */
async function writeModernRollout(env, relPath, doc) {
  const filePath = path.join(env.homeDir, '.codex', 'sessions', relPath)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  /** @type {string[]} */
  const lines = []
  lines.push(JSON.stringify({ type: 'session_meta', timestamp: doc.meta.timestamp, payload: doc.meta }))
  for (const turn of doc.turns ?? []) {
    lines.push(JSON.stringify({ type: 'turn_context', timestamp: doc.meta.timestamp, payload: turn }))
  }
  for (const item of doc.items) {
    lines.push(JSON.stringify({ type: item.type ?? 'response_item', timestamp: item.timestamp, payload: item.payload }))
  }
  await fs.writeFile(filePath, lines.join('\n') + '\n', 'utf8')
  return filePath
}

/**
 * Write a legacy single-document rollout `{ session, items }`.
 *
 * @param {{ homeDir: string }} env
 * @param {string} relPath
 * @param {{ session: Record<string, unknown>, items: Array<Record<string, unknown>> }} doc
 */
async function writeLegacyRollout(env, relPath, doc) {
  const filePath = path.join(env.homeDir, '.codex', 'sessions', relPath)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  // Pretty-printed, like the real legacy files (whole-file JSON object).
  await fs.writeFile(filePath, JSON.stringify(doc, null, 2) + '\n', 'utf8')
  return filePath
}

function captureLog() {
  /** @type {Array<{ level: string, message: string, fields?: Record<string, unknown> }>} */
  const entries = []
  /** @param {string} level */
  const at = (level) => (/** @type {string} */ message, /** @type {Record<string, unknown>=} */ fields) => {
    entries.push({ level, message, fields })
  }
  return {
    entries,
    log: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') },
  }
}

/**
 * @param {{ since?: string, until?: string, retentionDays?: number, log?: any }} [overrides]
 * @returns {{ ctx: BackfillRunContext, entries: any[] }}
 */
function runContext(overrides = {}) {
  const { entries, log } = captureLog()
  /** @type {BackfillRunContext} */
  const ctx = {
    env: {},
    cacheRoot: path.join(os.tmpdir(), 'codex-backfill-cache-unused'),
    dryRun: false,
    log: overrides.log ?? log,
    storage: /** @type {any} */ ({}),
    ...(overrides.since !== undefined ? { since: overrides.since } : {}),
    ...(overrides.until !== undefined ? { until: overrides.until } : {}),
    ...(overrides.retentionDays !== undefined ? { retentionDays: overrides.retentionDays } : {}),
  }
  return { ctx, entries }
}

/**
 * @param {AsyncIterable<BackfillItem | BackfillEvent>} iterable
 * @returns {Promise<{ items: BackfillItem[], events: BackfillEvent[] }>}
 */
async function collect(iterable) {
  /** @type {BackfillItem[]} */
  const items = []
  /** @type {BackfillEvent[]} */
  const events = []
  for await (const yielded of iterable) {
    if (yielded.type === 'event') events.push(/** @type {BackfillEvent} */ (yielded))
    else items.push(/** @type {BackfillItem} */ (yielded))
  }
  return { items, events }
}

/** @param {BackfillItem} item */
function value(item) {
  return /** @type {any} */ (item.value)
}

/**
 * @param {BackfillItem} item
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function materialize(item) {
  const materializer = aiGatewayBackfillMaterializer()
  const ctx = /** @type {any} */ ({ log: captureLog().log, env: {}, storage: {} })
  return materializer.materialize(item, ctx)
}

/** @param {Record<string, unknown>[]} rows @param {unknown} role */
function rowsByRole(rows, role) {
  return rows.filter((r) => r.role === role)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A four-item session: a user turn, an assistant tool call, the tool's
 * output, and an assistant reply. No native ids → deterministic identity.
 *
 * @param {string} sessionId
 * @param {{ git?: Record<string, unknown> }} [overrides]
 */
function modernConversation(sessionId, overrides = {}) {
  return {
    meta: {
      id: sessionId,
      timestamp: '2026-05-25T19:56:38.942Z',
      cwd: '/work/repo',
      originator: 'Codex Desktop',
      cli_version: '0.133.0',
      source: 'vscode',
      thread_source: 'user',
      model_provider: 'hypaware',
      git: overrides.git ?? { commit_hash: 'abc123def', repository_url: 'https://github.com/acme/repo.git', dirty: true },
    },
    turns: [
      { turn_id: 't-1', cwd: '/work/repo', model: 'gpt-5.5', sandbox_policy: { type: 'workspace-write' } },
    ],
    items: [
      {
        timestamp: '2026-05-25T19:56:40.000Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list the files' }] },
      },
      {
        timestamp: '2026-05-25T19:56:41.000Z',
        payload: { type: 'function_call', name: 'shell', call_id: 'call-1', arguments: '{"command":"ls"}' },
      },
      {
        timestamp: '2026-05-25T19:56:42.000Z',
        payload: { type: 'function_call_output', call_id: 'call-1', output: 'file-a\nfile-b' },
      },
      {
        timestamp: '2026-05-25T19:56:43.000Z',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Here are the files.' }] },
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('provider advertises a stable contribution shape', async () => {
  const provider = createCodexBackfillProvider({ homeDir: '/tmp/nope' })
  assert.equal(provider.name, 'codex')
  assert.equal(provider.plugin, '@hypaware/codex')
  assert.deepEqual(provider.datasets, ['ai_gateway_messages'])
  assert.equal(typeof provider.run, 'function')
})

test('modern rollout projects into canonical ai_gateway_messages rows', async () => {
  const env = await stageEnv()
  try {
    const filePath = await writeModernRollout(env, '2026/05/25/rollout-1.jsonl', modernConversation('sess-1'))

    const provider = createCodexBackfillProvider({ homeDir: env.homeDir })
    const { ctx, entries: logs } = runContext()
    const { items } = await collect(provider.run(ctx))

    // One item per session, addressed to the projected-exchange materializer.
    assert.equal(items.length, 1)
    const item = items[0]
    assert.ok(item)
    assert.equal(item.dataset, DATASET_NAME)
    assert.equal(item.kind, AI_GATEWAY_PROJECTED_EXCHANGE_KIND)
    assert.equal(item.provenance?.client_name, 'codex')
    assert.equal(item.provenance?.source_path, filePath)
    assert.equal(item.provenance?.native_id, 'sess-1')

    // Projection carries the bead-mandated conversation envelope.
    const exchange = value(item)
    assert.equal(exchange.provider, 'openai')
    assert.equal(exchange.conversation_id, 'sess-1')
    assert.equal(exchange.conversation_source, 'codex')
    assert.equal(exchange.client_name, 'codex')
    assert.equal(exchange.cwd, '/work/repo')
    assert.equal(exchange.client_version, '0.133.0')
    assert.equal(exchange.entrypoint, 'Codex Desktop')
    assert.equal(exchange.user_type, 'user')
    assert.equal(exchange.permission_mode, 'workspace-write')
    assert.equal(exchange.is_sidechain, false)
    assert.equal(exchange.model, 'gpt-5.5')
    assert.equal(exchange.conversation_started_at, '2026-05-25T19:56:38.942Z')

    // LLP 0032: repo identity promoted to first-class fields from session_meta.git
    // (git_remote ← repository_url, head_sha ← commit_hash). The clean URL passes
    // through redaction unchanged; the credential case is pinned by 'backfill
    // redacts credential userinfo …' below.
    assert.equal(exchange.git_remote, 'https://github.com/acme/repo.git')
    assert.equal(exchange.head_sha, 'abc123def')
    // repo_root stays null: the rollout cwd is NOT a verified git toplevel (may
    // be a repo subdir), so Codex File keys fall back to absolute rather than
    // mis-relativizing. @ref LLP 0032#codex-repo-root
    assert.equal(exchange.repo_root, undefined)

    // Codex provenance lives under attributes.codex, including identity_source.
    assert.equal(exchange.attributes.codex.identity_source, 'gateway_fallback')
    assert.equal(exchange.attributes.codex.git_origin_url, 'https://github.com/acme/repo.git')
    assert.equal(exchange.attributes.codex.git_commit, 'abc123def')
    assert.equal(exchange.attributes.codex.has_changes, true)
    assert.equal(exchange.attributes.codex.sandbox, 'workspace-write')
    assert.equal(exchange.attributes.codex.workspace, '/work/repo')
    assert.equal(exchange.attributes.codex.thread_source, 'user')
    assert.equal(exchange.attributes.codex.session_id, 'sess-1')

    // Lifecycle telemetry proves the intended path ran.
    const scanStart = logs.find((e) => e.message === 'codex.backfill.scan_started')
    const scanDone = logs.find((e) => e.message === 'codex.backfill.scan_complete')
    assert.ok(scanStart, 'scan_started log emitted')
    assert.equal(scanDone?.fields?.sessions_projected, 1)
    assert.equal(scanDone?.fields?.messages_projected, 4)

    // Materialize through the REAL gateway materializer.
    const rows = await materialize(item)
    // user(text) + assistant(tool_use) + tool(tool_result) + assistant(text) = 4 part rows.
    assert.equal(rows.length, 4)
    for (const row of rows) {
      assert.equal(row.conversation_id, 'sess-1')
      assert.equal(row.provider, 'openai')
      assert.equal(row.conversation_source, 'codex')
      assert.equal(row.client_name, 'codex')
      assert.equal(row.cwd, '/work/repo')
      // First-class repo-identity columns survive materialization (LLP 0032).
      // repo_root is null for Codex (no verified toplevel: see §codex-repo-root).
      assert.equal(row.git_remote, 'https://github.com/acme/repo.git')
      assert.equal(row.head_sha, 'abc123def')
      assert.equal(row.repo_root, undefined)
      const attributes = /** @type {any} */ (row.attributes)
      assert.equal(attributes.gateway.source, 'backfill')
      assert.equal(typeof attributes.gateway.source_path_hash, 'string')
      assert.equal(attributes.gateway.native_id, 'sess-1')
      // Provider-side identity_source survives materialization.
      assert.equal(attributes.codex.identity_source, 'gateway_fallback')
    }

    const userRow = rowsByRole(rows, 'user')[0]
    assert.equal(userRow.content_text, 'list the files')
    assert.equal(userRow.part_type, 'text')

    // function_call → tool_call part; function_call_output → tool_result.
    const toolRow = rows.find((r) => r.part_type === 'tool_call')
    assert.ok(toolRow, 'function_call became a tool_call part')
    assert.equal(toolRow.tool_name, 'shell')
    assert.equal(toolRow.tool_call_id, 'call-1')
    assert.deepEqual(toolRow.tool_args, { command: 'ls' })

    const resultRow = rows.find((r) => r.part_type === 'tool_result')
    assert.ok(resultRow, 'function_call_output became a tool_result part')
    assert.equal(resultRow.tool_result_for, 'call-1')
    assert.equal(resultRow.content_text, 'file-a\nfile-b')
    // Tool name is back-filled from the earlier call within the conversation.
    assert.equal(resultRow.tool_name, 'shell')
  } finally {
    await env.cleanup()
  }
})

test('token_count event folds per-turn usage (net of cache) onto the turn assistant message', async () => {
  const env = await stageEnv()
  try {
    // One turn: reasoning, assistant text, a tool call + its output, then the
    // turn's token_count event_msg. The per-turn delta is `last_token_usage`;
    // `total_token_usage` is the session's cumulative running total. They are
    // set to DIFFERENT (and deliberately larger) values here so a regression
    // that read the cumulative total (the multiply-count trap) would fail the
    // net-input assertion below instead of passing by coincidence.
    // @ref LLP 0035#per-turn
    const lastUsage = {
      input_tokens: 13761, // gross (includes the 9600 cached)
      cached_input_tokens: 9600,
      output_tokens: 484,
      reasoning_output_tokens: 189,
      total_tokens: 14245,
    }
    // Cumulative total (as if prior turns were folded in). NOT the stamped value.
    const cumulativeUsage = {
      input_tokens: 90000,
      cached_input_tokens: 50000,
      output_tokens: 4000,
      reasoning_output_tokens: 1200,
      total_tokens: 99999,
    }
    await writeModernRollout(env, '2026/06/23/rollout-usage.jsonl', {
      meta: { id: 'sess-usage', timestamp: '2026-06-23T00:00:00.000Z' },
      items: [
        { timestamp: '2026-06-23T00:00:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] } },
        { timestamp: '2026-06-23T00:00:02.000Z', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }] } },
        { timestamp: '2026-06-23T00:00:03.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'on it' }] } },
        { timestamp: '2026-06-23T00:00:04.000Z', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{"command":"ls"}' } },
        { timestamp: '2026-06-23T00:00:05.000Z', payload: { type: 'function_call_output', call_id: 'c1', output: 'a' } },
        {
          type: 'event_msg',
          timestamp: '2026-06-23T00:00:06.000Z',
          payload: { type: 'token_count', info: { total_token_usage: cumulativeUsage, last_token_usage: lastUsage } },
        },
      ],
    })

    const provider = createCodexBackfillProvider({ homeDir: env.homeDir })
    const { items } = await collect(provider.run(runContext().ctx))
    assert.equal(items.length, 1)
    const item = items[0]
    assert.ok(item)
    const exchange = value(item)

    // The token_count marker does NOT add a message: user, reasoning, assistant
    // text, assistant tool_use, tool result = 5.
    assert.equal(exchange.messages.length, 5)

    // Usage lands on the LAST text/tool_use assistant message of the turn (the
    // function_call here), one carrier per response (same row Claude uses).
    // Derived from `last_token_usage` (NOT the cumulative `total_token_usage`):
    // NET of cache 13761 − 9600 = 4161; 4161 + 9600 + 484 == 14245 total. Were
    // the cumulative read instead, input would be 90000 − 50000 = 40000 here.
    // @ref LLP 0035#one-carrier @ref LLP 0035#per-turn
    const toolUseMsg = exchange.messages.find(
      (/** @type {any} */ m) => m.role === 'assistant' && m.content[0].type === 'tool_use'
    )
    assert.deepEqual(toolUseMsg.attributes, {
      usage: {
        input_tokens: 4161,
        cache_read_tokens: 9600,
        output_tokens: 484,
        reasoning_tokens: 189,
        total_tokens: 14245,
      },
    })

    // The earlier assistant text and the reasoning (thinking) message carry no usage.
    const textMsg = exchange.messages.find((/** @type {any} */ m) => m.role === 'assistant' && m.content[0].type === 'text')
    assert.equal(textMsg.attributes, undefined)
    const thinkingMsg = exchange.messages.find((/** @type {any} */ m) => m.content[0].type === 'thinking')
    assert.equal(thinkingMsg.attributes, undefined)

    // Usage survives materialization onto the assistant tool_call row.
    const rows = await materialize(item)
    const toolRow = rows.find((r) => r.part_type === 'tool_call' && r.role === 'assistant')
    assert.ok(toolRow)
    assert.deepEqual(/** @type {any} */ (toolRow.attributes).usage, {
      input_tokens: 4161,
      cache_read_tokens: 9600,
      output_tokens: 484,
      reasoning_tokens: 189,
      total_tokens: 14245,
    })
  } finally {
    await env.cleanup()
  }
})

test('multi-turn token_count: each turn stamps its own per-turn delta on its own last assistant row', async () => {
  const env = await stageEnv()
  try {
    // Three turns in one session, each closed by a token_count marker. The
    // turnStartIndex advance is what stops a later turn's usage from being
    // stamped onto (or summed into) an earlier turn's row. Each token_count
    // carries a distinct per-turn `last_token_usage` delta and a cumulative
    // `total_token_usage` running total; the projector must read the delta.
    // @ref LLP 0035#per-turn @ref LLP 0035#one-carrier
    const turn1Delta = { input_tokens: 13761, cached_input_tokens: 9600, output_tokens: 484, reasoning_output_tokens: 189, total_tokens: 14245 }
    const turn2Delta = { input_tokens: 5000, cached_input_tokens: 1000, output_tokens: 200, reasoning_output_tokens: 50, total_tokens: 5200 }
    const turn3Delta = { input_tokens: 7000, cached_input_tokens: 2000, output_tokens: 300, reasoning_output_tokens: 80, total_tokens: 7600 }
    // Cumulative running totals (what `total_token_usage` actually carries).
    // Set so that reading them instead of the delta would yield wrong numbers:
    // e.g. turn 2 cumulative net input is 18761 − 10600 = 8161, never 4000.
    const turn1Total = turn1Delta
    const turn2Total = { input_tokens: 18761, cached_input_tokens: 10600, output_tokens: 684, reasoning_output_tokens: 239, total_tokens: 19445 }
    const turn3Total = { input_tokens: 25761, cached_input_tokens: 12600, output_tokens: 984, reasoning_output_tokens: 319, total_tokens: 27045 }

    await writeModernRollout(env, '2026/06/24/rollout-multiturn.jsonl', {
      meta: { id: 'sess-multi', timestamp: '2026-06-24T00:00:00.000Z' },
      items: [
        // Turn 1: reasoning + assistant text + a tool call; last eligible = tool_use.
        { timestamp: '2026-06-24T00:00:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'turn one' }] } },
        { timestamp: '2026-06-24T00:00:02.000Z', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking 1' }] } },
        { timestamp: '2026-06-24T00:00:03.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'on it' }] } },
        { timestamp: '2026-06-24T00:00:04.000Z', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{"command":"ls"}' } },
        { timestamp: '2026-06-24T00:00:05.000Z', payload: { type: 'function_call_output', call_id: 'c1', output: 'a' } },
        { type: 'event_msg', timestamp: '2026-06-24T00:00:06.000Z', payload: { type: 'token_count', info: { total_token_usage: turn1Total, last_token_usage: turn1Delta } } },
        // A non-token_count event_msg must be skipped entirely (no row, no usage).
        { type: 'event_msg', timestamp: '2026-06-24T00:00:07.000Z', payload: { type: 'agent_reasoning', text: 'internal note' } },
        // Turn 2: a single assistant text reply; last eligible = that text.
        { timestamp: '2026-06-24T00:00:08.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'turn two' }] } },
        { timestamp: '2026-06-24T00:00:09.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'final answer' }] } },
        { type: 'event_msg', timestamp: '2026-06-24T00:00:10.000Z', payload: { type: 'token_count', info: { total_token_usage: turn2Total, last_token_usage: turn2Delta } } },
        // Turn 3: reasoning ONLY (no text/tool_use assistant in range), so its
        // usage is DROPPED rather than mis-attributed to an earlier turn's row.
        { timestamp: '2026-06-24T00:00:11.000Z', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking 3' }] } },
        { type: 'event_msg', timestamp: '2026-06-24T00:00:12.000Z', payload: { type: 'token_count', info: { total_token_usage: turn3Total, last_token_usage: turn3Delta } } },
      ],
    })

    const provider = createCodexBackfillProvider({ homeDir: env.homeDir })
    const { items } = await collect(provider.run(runContext().ctx))
    assert.equal(items.length, 1)
    const item = items[0]
    assert.ok(item)
    const exchange = value(item)

    // Messages: u1, think1, asst"on it", tool_use, tool_result, u2,
    // asst"final answer", think3 = 8. The three token_count markers and the
    // stray agent_reasoning event_msg add no messages.
    assert.equal(exchange.messages.length, 8)

    const findMsg = (/** @type {(m: any) => boolean} */ pred) => exchange.messages.find(pred)

    // Turn 1's usage rides its tool_use (last eligible), net of cache.
    const turn1Carrier = findMsg((m) => m.role === 'assistant' && m.content[0].type === 'tool_use')
    assert.deepEqual(turn1Carrier.attributes, {
      usage: { input_tokens: 4161, cache_read_tokens: 9600, output_tokens: 484, reasoning_tokens: 189, total_tokens: 14245 },
    })

    // Turn 2's usage rides its own text reply: its own delta, NOT turn 1's and
    // NOT the cumulative total (which would give input 8161, output 684).
    const turn2Carrier = findMsg((m) => m.role === 'assistant' && m.content[0].type === 'text' && m.content[0].text === 'final answer')
    assert.deepEqual(turn2Carrier.attributes, {
      usage: { input_tokens: 4000, cache_read_tokens: 1000, output_tokens: 200, reasoning_tokens: 50, total_tokens: 5200 },
    })

    // Turn 1's earlier text ("on it") and both reasoning messages carry NO usage.
    // Crucially, turn 1's carrier was NOT overwritten by turn 2 or turn 3 (asserted
    // above), and turn 3's dropped usage never leaked onto an earlier row.
    const turn1Text = findMsg((m) => m.role === 'assistant' && m.content[0].type === 'text' && m.content[0].text === 'on it')
    assert.equal(turn1Text.attributes, undefined)
    for (const m of exchange.messages.filter((/** @type {any} */ x) => x.content[0].type === 'thinking')) {
      assert.equal(m.attributes, undefined)
    }

    // No row anywhere carries turn 3's delta (it was dropped, not mis-stamped).
    const stamped = exchange.messages.filter((/** @type {any} */ m) => m.attributes?.usage)
    assert.equal(stamped.length, 2, 'exactly two carrier rows - turns 1 and 2')
    for (const m of stamped) {
      assert.notEqual(/** @type {any} */ (m.attributes).usage.total_tokens, 7600, 'turn 3 usage never stamped')
    }

    // Survives materialization: exactly two assistant rows carry usage.
    const rows = await materialize(item)
    const usageRows = rows.filter((r) => /** @type {any} */ (r.attributes)?.usage)
    assert.equal(usageRows.length, 2)
  } finally {
    await env.cleanup()
  }
})

test('backfill redacts credential userinfo from the git remote (LLP 0032)', async () => {
  const env = await stageEnv()
  try {
    // A token-bearing HTTPS remote, exactly as `gh`/CI writes into remote.origin.url.
    await writeModernRollout(env, '2026/05/27/rollout-cred.jsonl', modernConversation('sess-cred', {
      git: {
        commit_hash: 'abc123def',
        repository_url: 'https://x-access-token:ghp_SUPERSECRET@github.com/acme/repo.git',
        dirty: true,
      },
    }))

    const provider = createCodexBackfillProvider({ homeDir: env.homeDir })
    const { ctx } = runContext()
    const { items } = await collect(provider.run(ctx))
    const item = items[0]
    assert.ok(item)

    const exchange = value(item)
    // The token is stripped at ingress: neither the first-class column nor the
    // provenance mirror ever holds the secret; the owner/repo is preserved.
    assert.equal(exchange.git_remote, 'https://github.com/acme/repo.git')
    assert.equal(exchange.attributes.codex.git_origin_url, 'https://github.com/acme/repo.git')
    assert.ok(!JSON.stringify(exchange).includes('ghp_SUPERSECRET'), 'no token anywhere in the projected exchange')

    const rows = await materialize(item)
    for (const row of rows) {
      assert.equal(row.git_remote, 'https://github.com/acme/repo.git')
      assert.ok(!JSON.stringify(row).includes('ghp_SUPERSECRET'), 'no token anywhere in a materialized row')
    }
  } finally {
    await env.cleanup()
  }
})

test('native ids are preserved verbatim; sidechain inferred from thread_source', async () => {
  const env = await stageEnv()
  try {
    await writeModernRollout(env, '2026/05/26/rollout-native.jsonl', {
      meta: {
        id: 'sess-native',
        timestamp: '2026-05-26T10:00:00.000Z',
        cwd: '/work/sub',
        thread_source: 'subagent',
        parent_thread_id: 'thread-parent-1',
        cli_version: '0.133.0',
      },
      items: [
        {
          timestamp: '2026-05-26T10:00:01.000Z',
          payload: { type: 'message', id: 'msg-user-1', role: 'user', content: [{ type: 'input_text', text: 'native id user' }] },
        },
        {
          timestamp: '2026-05-26T10:00:02.000Z',
          payload: { type: 'message', id: 'msg-asst-1', role: 'assistant', content: [{ type: 'output_text', text: 'native id assistant' }] },
        },
      ],
    })

    const provider = createCodexBackfillProvider({ homeDir: env.homeDir })
    const { items } = await collect(provider.run(runContext().ctx))
    assert.equal(items.length, 1)
    const item = items[0]
    assert.ok(item)
    const exchange = value(item)

    // Native ids → message_id verbatim and identity_source 'native'.
    assert.equal(exchange.messages[0].message_id, 'msg-user-1')
    assert.equal(exchange.messages[1].message_id, 'msg-asst-1')
    assert.equal(exchange.attributes.codex.identity_source, 'native')
    // thread_source = subagent → sidechain signal.
    assert.equal(exchange.is_sidechain, true)
    assert.equal(exchange.user_type, 'subagent')
    // parent_thread_id from session_meta → subagent lineage column.
    assert.equal(exchange.parent_thread_id, 'thread-parent-1')

    const rows = await materialize(item)
    const userRow = rowsByRole(rows, 'user')[0]
    assert.equal(userRow.message_id, 'msg-user-1')
    assert.equal(userRow.is_sidechain, true)
    assert.equal(userRow.parent_thread_id, 'thread-parent-1')
    // Native identity → gateway does NOT stamp a fallback identity_source.
    const attributes = /** @type {any} */ (userRow.attributes)
    assert.equal(attributes.gateway.identity_source, undefined)
    assert.equal(attributes.codex.identity_source, 'native')
  } finally {
    await env.cleanup()
  }
})

test('sessions are grouped one-per-file across nested date partitions', async () => {
  const env = await stageEnv()
  try {
    await writeModernRollout(env, '2026/05/25/rollout-a.jsonl', modernConversation('sess-a'))
    await writeModernRollout(env, '2026/05/27/rollout-b.jsonl', {
      meta: { id: 'sess-b', timestamp: '2026-05-27T08:00:00.000Z' },
      items: [
        {
          timestamp: '2026-05-27T08:00:01.000Z',
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'just one turn' }] },
        },
      ],
    })

    const provider = createCodexBackfillProvider({ homeDir: env.homeDir })
    const { items } = await collect(provider.run(runContext().ctx))
    assert.equal(items.length, 2)

    const byId = new Map(items.map((i) => [value(i).conversation_id, i]))
    assert.deepEqual([...byId.keys()].sort(), ['sess-a', 'sess-b'])
    const itemA = byId.get('sess-a')
    const itemB = byId.get('sess-b')
    assert.ok(itemA)
    assert.ok(itemB)
    assert.equal(value(itemA).messages.length, 4)
    assert.equal(value(itemB).messages.length, 1)
  } finally {
    await env.cleanup()
  }
})

test('legacy single-document rollouts parse version-defensively', async () => {
  const env = await stageEnv()
  try {
    const filePath = await writeLegacyRollout(env, 'rollout-2025-06-19-legacy.json', {
      session: { id: 'legacy-1', timestamp: '2025-06-19T17:01:23.018Z', instructions: '' },
      items: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'legacy hello' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'legacy hi' }] },
      ],
    })

    const provider = createCodexBackfillProvider({ homeDir: env.homeDir })
    const { items } = await collect(provider.run(runContext().ctx))
    assert.equal(items.length, 1)
    const item = items[0]
    assert.ok(item)
    assert.equal(item.provenance?.source_path, filePath)
    const exchange = value(item)
    assert.equal(exchange.conversation_id, 'legacy-1')
    assert.equal(exchange.provider, 'openai')
    assert.equal(exchange.conversation_source, 'codex')
    assert.equal(exchange.messages.length, 2)

    const rows = await materialize(item)
    assert.equal(rows.length, 2)
    assert.equal(rowsByRole(rows, 'user')[0].content_text, 'legacy hello')
  } finally {
    await env.cleanup()
  }
})

test('app/browser storage is flagged via unsupported_location, never parsed', async () => {
  const env = await stageEnv()
  try {
    // Stage a path-faithful ChatGPT desktop app container under the temp home.
    const appDir = path.join(env.homeDir, 'Library', 'Application Support', 'ChatGPT')
    await fs.mkdir(appDir, { recursive: true })
    await fs.writeFile(path.join(appDir, 'leveldb.ldb'), 'opaque', 'utf8')
    // And a real session so the run still produces canonical rows.
    await writeModernRollout(env, '2026/05/25/rollout-a.jsonl', modernConversation('sess-a'))

    const provider = createCodexBackfillProvider({ homeDir: env.homeDir })
    const { ctx, entries: logs } = runContext()
    const { items, events } = await collect(provider.run(ctx))

    const unsupported = events.filter((e) => e.event === 'unsupported_location')
    assert.equal(unsupported.length, 1, 'one unsupported_location event')
    assert.equal(unsupported[0].attributes?.location_kind, 'chatgpt_desktop_app')
    assert.equal(unsupported[0].attributes?.client_name, 'codex')

    const logged = logs.find((e) => e.message === 'codex.backfill.unsupported_location')
    assert.ok(logged, 'unsupported_location logged')
    assert.equal(logged?.fields?.status, 'skipped')

    // The app storage is NOT parsed, but the real session still imports.
    assert.equal(items.length, 1)
    assert.equal(value(items[0]).conversation_id, 'sess-a')
  } finally {
    await env.cleanup()
  }
})

test('encrypted reasoning is never projected; only plaintext summary is kept', async () => {
  const env = await stageEnv()
  try {
    const secret = 'ENCRYPTED-REASONING-MUST-NOT-LEAK'
    await writeModernRollout(env, '2026/05/25/rollout-reason.jsonl', {
      meta: { id: 'sess-r', timestamp: '2026-05-25T12:00:00.000Z' },
      items: [
        {
          timestamp: '2026-05-25T12:00:01.000Z',
          payload: {
            type: 'reasoning',
            summary: [{ type: 'summary_text', text: 'Considering the options' }],
            encrypted_content: secret,
          },
        },
        {
          // Encrypted-only reasoning yields no projectable content.
          timestamp: '2026-05-25T12:00:02.000Z',
          payload: { type: 'reasoning', summary: [], encrypted_content: secret },
        },
        {
          timestamp: '2026-05-25T12:00:03.000Z',
          payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] },
        },
      ],
    })

    const provider = createCodexBackfillProvider({ homeDir: env.homeDir })
    const { items } = await collect(provider.run(runContext().ctx))
    assert.equal(items.length, 1)
    const item = items[0]
    assert.ok(item)
    const exchange = value(item)
    // reasoning(with summary) + assistant message = 2 messages; the empty one is dropped.
    assert.equal(exchange.messages.length, 2)
    assert.ok(!JSON.stringify(exchange).includes(secret), 'encrypted_content not copied anywhere')

    const rows = await materialize(item)
    const reasoningRow = rows.find((r) => r.part_type === 'reasoning')
    assert.ok(reasoningRow, 'reasoning summary became a reasoning part')
    assert.equal(reasoningRow.content_text, 'Considering the options')
    assert.ok(!JSON.stringify(rows).includes(secret), 'encrypted_content absent from rows')
  } finally {
    await env.cleanup()
  }
})

test('since bound filters out items older than the window', async () => {
  const env = await stageEnv()
  try {
    await writeModernRollout(env, '2026/05/10/rollout-win.jsonl', {
      meta: { id: 'sess-win', timestamp: '2026-05-01T00:00:00.000Z' },
      items: [
        {
          timestamp: '2026-05-01T00:00:00.000Z',
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'old turn' }] },
        },
        {
          timestamp: '2026-05-10T00:00:00.000Z',
          payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'new turn' }] },
        },
      ],
    })
    const provider = createCodexBackfillProvider({ homeDir: env.homeDir })
    const { ctx } = runContext({ since: '2026-05-05T00:00:00.000Z' })
    const { items } = await collect(provider.run(ctx))
    assert.equal(items.length, 1)
    const messages = value(items[0]).messages
    assert.equal(messages.length, 1)
    assert.equal(messages[0].content[0].text, 'new turn')
  } finally {
    await env.cleanup()
  }
})

test('reruns are deterministic (idempotent items and rows)', async () => {
  const env = await stageEnv()
  try {
    await writeModernRollout(env, '2026/05/25/rollout-a.jsonl', modernConversation('sess-a'))
    const provider = createCodexBackfillProvider({ homeDir: env.homeDir })

    const first = await collect(provider.run(runContext().ctx))
    const second = await collect(provider.run(runContext().ctx))
    assert.deepEqual(first.items, second.items, 'yielded items are identical across runs')

    const firstItem = first.items[0]
    const secondItem = second.items[0]
    assert.ok(firstItem)
    assert.ok(secondItem)
    const rowsFirst = await materialize(firstItem)
    const rowsSecond = await materialize(secondItem)
    assert.deepEqual(rowsFirst, rowsSecond, 'materialized rows identical')
  } finally {
    await env.cleanup()
  }
})

test('missing sessions root yields nothing without throwing', async () => {
  const env = await stageEnv()
  try {
    const provider = createCodexBackfillProvider({ homeDir: path.join(env.homeDir, 'does-not-exist') })
    const { items, events } = await collect(provider.run(runContext().ctx))
    assert.equal(items.length, 0)
    assert.equal(events.length, 0)
  } finally {
    await env.cleanup()
  }
})

test('diagnostic-only history source is detected but not used as canonical', async () => {
  const env = await stageEnv()
  try {
    const codexDir = path.join(env.homeDir, '.codex')
    await fs.mkdir(codexDir, { recursive: true })
    await fs.writeFile(path.join(codexDir, 'history.jsonl'), '{"command":"ls"}\n', 'utf8')
    await writeModernRollout(env, '2026/05/25/rollout-a.jsonl', modernConversation('sess-a'))

    const provider = createCodexBackfillProvider({ homeDir: env.homeDir })
    const { ctx, entries: logs } = runContext()
    const { items } = await collect(provider.run(ctx))

    const diag = logs.find((e) => e.message === 'codex.backfill.diagnostic_source_detected')
    assert.ok(diag, 'history detected as diagnostic source')
    assert.equal(diag?.fields?.source_kind, 'history')
    assert.equal(diag?.fields?.used_as_canonical, false)

    // Only the session rollout produced a canonical item; history did not.
    assert.equal(items.length, 1)
    assert.equal(value(items[0]).conversation_id, 'sess-a')
  } finally {
    await env.cleanup()
  }
})
