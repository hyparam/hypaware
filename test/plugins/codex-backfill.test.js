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
 * @param {{
 *   meta: Record<string, unknown>,
 *   turns?: Array<Record<string, unknown>>,
 *   items: Array<{ timestamp?: string, payload: Record<string, unknown> }>,
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
    lines.push(JSON.stringify({ type: 'response_item', timestamp: item.timestamp, payload: item.payload }))
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
 */
function modernConversation(sessionId) {
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
      git: { commit_hash: 'abc123def', repository_url: 'https://github.com/acme/repo.git', dirty: true },
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

test('native ids are preserved verbatim; sidechain inferred from thread_source', async () => {
  const env = await stageEnv()
  try {
    await writeModernRollout(env, '2026/05/26/rollout-native.jsonl', {
      meta: {
        id: 'sess-native',
        timestamp: '2026-05-26T10:00:00.000Z',
        cwd: '/work/sub',
        thread_source: 'subagent',
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

    const rows = await materialize(item)
    const userRow = rowsByRole(rows, 'user')[0]
    assert.equal(userRow.message_id, 'msg-user-1')
    assert.equal(userRow.is_sidechain, true)
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
