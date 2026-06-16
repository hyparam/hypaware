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
import { createClaudeBackfillProvider } from '../../hypaware-core/plugins-workspace/claude/src/backfill.js'
import { appendSessionContext } from '../../hypaware-core/plugins-workspace/claude/src/session_context.js'

/**
 * End-to-end tests for the `@hypaware/claude` backfill provider. They
 * run the real provider against on-disk JSONL transcripts and feed the
 * yielded items through the real `@hypaware/ai-gateway`
 * `ai_gateway.projected_exchange` materializer, so the assertions cover
 * the exact path `hyp backfill claude` exercises in production.
 *
 * @import { BackfillEvent, BackfillItem, BackfillRunContext } from '../../collectivus-plugin-kernel-types.d.ts'
 */

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function stageEnv() {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-backfill-'))
  const stateDir = path.join(homeDir, 'state')
  await fs.mkdir(stateDir, { recursive: true })
  const stateFile = path.join(stateDir, 'session-context.jsonl')
  return {
    homeDir,
    stateFile,
    cleanup: () => fs.rm(homeDir, { recursive: true, force: true }),
  }
}

/**
 * Write a transcript file named `<sessionId>.jsonl` under a repo dir and
 * return its absolute path.
 *
 * @param {{ homeDir: string }} env
 * @param {string} repo
 * @param {string} sessionId
 * @param {Record<string, unknown>[]} rows
 */
async function writeTranscript(env, repo, sessionId, rows) {
  const dir = path.join(env.homeDir, '.claude', 'projects', repo)
  await fs.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `${sessionId}.jsonl`)
  await fs.writeFile(filePath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  return filePath
}

/**
 * Write an arbitrarily-named transcript file (used to prove grouping is
 * keyed on the entry's session id, not the file name).
 *
 * @param {{ homeDir: string }} env
 * @param {string} repo
 * @param {string} fileName
 * @param {Record<string, unknown>[]} rows
 */
async function writeRawTranscript(env, repo, fileName, rows) {
  const dir = path.join(env.homeDir, '.claude', 'projects', repo)
  await fs.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, fileName)
  await fs.writeFile(filePath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  return filePath
}

/**
 * Write a subagent transcript and its `.meta.json` sidecar under the
 * session's `subagents/` directory, mirroring Claude Code's on-disk
 * layout (`<projects>/<repo>/<sessionId>/subagents/agent-<id>.jsonl`).
 *
 * @param {{ homeDir: string }} env
 * @param {string} repo
 * @param {string} sessionId
 * @param {string} agentId
 * @param {Record<string, unknown>[]} rows
 * @param {Record<string, unknown>} meta
 */
async function writeSubagent(env, repo, sessionId, agentId, rows, meta) {
  const dir = path.join(env.homeDir, '.claude', 'projects', repo, sessionId, 'subagents')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, `agent-${agentId}.jsonl`),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8'
  )
  await fs.writeFile(path.join(dir, `agent-${agentId}.meta.json`), JSON.stringify(meta), 'utf8')
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
    cacheRoot: path.join(os.tmpdir(), 'claude-backfill-cache-unused'),
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
 * @returns {Promise<BackfillItem[]>}
 */
async function collectItems(iterable) {
  /** @type {BackfillItem[]} */
  const items = []
  for await (const yielded of iterable) {
    if (yielded.type !== 'event') items.push(/** @type {BackfillItem} */ (yielded))
  }
  return items
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A two-message session: a user turn and an assistant turn whose
 * content carries a text block and a tool_use block. parentUuid wires
 * the assistant turn to the user turn (native DAG).
 *
 * @param {string} sessionId
 */
function conversationRows(sessionId) {
  return [
    {
      sessionId,
      uuid: 'u-user-1',
      parentUuid: null,
      type: 'user',
      version: '1.2.3',
      cwd: '/ignored-by-projector',
      message: { role: 'user', content: 'list the files' },
      timestamp: '2026-05-20T10:00:00.000Z',
    },
    {
      sessionId,
      uuid: 'u-asst-1',
      parentUuid: 'u-user-1',
      type: 'assistant',
      permissionMode: 'default',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Sure, running it now.' },
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
      timestamp: '2026-05-20T10:00:05.000Z',
    },
  ]
}

/** @param {Record<string, unknown>[]} rows @param {unknown} role */
function rowsByRole(rows, role) {
  return rows.filter((r) => r.role === role)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('provider advertises a stable contribution shape', async () => {
  const provider = createClaudeBackfillProvider({ homeDir: '/tmp/nope', stateFile: '/tmp/nope/sc.jsonl' })
  assert.equal(provider.name, 'claude')
  assert.equal(provider.plugin, '@hypaware/claude')
  assert.deepEqual(provider.datasets, ['ai_gateway_messages'])
  assert.equal(typeof provider.run, 'function')
})

test('fixture transcript projects into canonical ai_gateway_messages rows', async () => {
  const env = await stageEnv()
  try {
    const filePath = await writeTranscript(env, 'repo-a', 'sess-1', conversationRows('sess-1'))
    await appendSessionContext(env.stateFile, {
      session_id: 'sess-1',
      transcript_path: filePath,
      cwd: '/work/repo-a',
      git_branch: 'feature/x',
      ts: '2026-05-20T10:00:06.000Z',
    })

    const provider = createClaudeBackfillProvider({ homeDir: env.homeDir, stateFile: env.stateFile })
    const { ctx, entries: logs } = runContext()
    const items = await collectItems(provider.run(ctx))

    // One item per session, addressed to the projected-exchange materializer.
    assert.equal(items.length, 1)
    const item = items[0]
    assert.ok(item)
    assert.equal(item.dataset, DATASET_NAME)
    assert.equal(item.kind, AI_GATEWAY_PROJECTED_EXCHANGE_KIND)
    assert.equal(item.provenance?.client_name, 'claude')
    assert.equal(item.provenance?.source_path, filePath)
    assert.equal(item.provenance?.native_id, 'sess-1')

    // Projection carries the bead-mandated conversation envelope.
    // @ref LLP 0030#decision — the Claude session id is the session_id
    // partition key; conversation_id is null (no per-thread id).
    const exchange = value(item)
    assert.equal(exchange.provider, 'anthropic')
    assert.equal(exchange.session_id, 'sess-1')
    assert.equal(exchange.conversation_id, undefined)
    assert.equal(exchange.conversation_source, 'claude')
    assert.equal(exchange.client_name, 'claude')
    assert.equal(exchange.cwd, '/work/repo-a')
    assert.equal(exchange.git_branch, 'feature/x')
    assert.equal(exchange.client_version, '1.2.3')
    assert.equal(exchange.messages.length, 2)

    // Lifecycle telemetry proves the intended path ran.
    const scanStart = logs.find((e) => e.message === 'claude.backfill.scan_started')
    const scanDone = logs.find((e) => e.message === 'claude.backfill.scan_complete')
    assert.ok(scanStart, 'scan_started log emitted')
    assert.equal(scanDone?.fields?.sessions_projected, 1)
    assert.equal(scanDone?.fields?.messages_projected, 2)

    // Materialize through the REAL gateway materializer.
    const rows = await materialize(item)
    // user(text) + assistant(text + tool_use) = 3 part rows.
    assert.equal(rows.length, 3)
    for (const row of rows) {
      assert.equal(row.session_id, 'sess-1')
      // Claude has no per-thread conversation id; the projection omits it,
      // so the expanded row carries conversation_id undefined. @ref LLP 0030
      assert.equal(row.conversation_id, undefined)
      assert.equal(row.provider, 'anthropic')
      assert.equal(row.conversation_source, 'claude')
      assert.equal(row.client_name, 'claude')
      assert.equal(row.cwd, '/work/repo-a')
      assert.equal(row.git_branch, 'feature/x')
      const attributes = /** @type {any} */ (row.attributes)
      assert.equal(attributes.gateway.source, 'backfill')
      assert.equal(typeof attributes.gateway.source_path_hash, 'string')
      assert.equal(attributes.gateway.native_id, 'sess-1')
    }

    const userRow = rowsByRole(rows, 'user')[0]
    assert.equal(userRow.content_text, 'list the files')
    assert.equal(userRow.part_type, 'text')

    // The gateway maps a `tool_use` content block to part_type 'tool_call'.
    const toolRow = rows.find((r) => r.part_type === 'tool_call')
    assert.ok(toolRow, 'tool_use part preserved')
    assert.equal(toolRow.tool_name, 'Bash')
    assert.equal(toolRow.tool_call_id, 'tool-1')
    assert.deepEqual(toolRow.tool_args, { command: 'ls' })
  } finally {
    await env.cleanup()
  }
})

test('native DAG identity is preserved verbatim', async () => {
  const env = await stageEnv()
  try {
    await writeTranscript(env, 'repo-a', 'sess-1', conversationRows('sess-1'))
    const provider = createClaudeBackfillProvider({ homeDir: env.homeDir, stateFile: env.stateFile })
    const { ctx } = runContext()
    const [item] = await collectItems(provider.run(ctx))
    assert.ok(item)
    const [userMsg, asstMsg] = value(item).messages

    // uuid -> message_id / provider_uuid; parentUuid -> parent_uuid.
    // previous_message_id is left to the gateway expansion, which
    // fills the full prior-message chain on the materialized rows.
    assert.equal(userMsg.message_id, 'u-user-1')
    assert.equal(userMsg.provider_uuid, 'u-user-1')
    assert.equal(userMsg.previous_message_id, undefined)
    assert.equal(userMsg.parent_uuid, undefined)

    assert.equal(asstMsg.message_id, 'u-asst-1')
    assert.equal(asstMsg.provider_uuid, 'u-asst-1')
    assert.equal(asstMsg.previous_message_id, undefined)
    assert.equal(asstMsg.parent_uuid, 'u-user-1')

    // Identity survives materialization into canonical rows, and the
    // gateway stamps the immediate-predecessor previous_message_id.
    const rows = await materialize(item)
    const userRow = rowsByRole(rows, 'user')[0]
    assert.equal(userRow.message_id, 'u-user-1')
    assert.equal(userRow.provider_uuid, 'u-user-1')
    assert.deepEqual(userRow.previous_message_id, [])
    const asstRow = rowsByRole(rows, 'assistant')[0]
    assert.equal(asstRow.message_id, 'u-asst-1')
    assert.equal(asstRow.parent_uuid, 'u-user-1')
    assert.deepEqual(asstRow.previous_message_id, ['u-user-1'])
  } finally {
    await env.cleanup()
  }
})

test('raw_frame is minimized — never a full transcript copy', async () => {
  const env = await stageEnv()
  try {
    const secret = 'SENSITIVE-PROMPT-BODY-should-not-be-copied'
    await writeTranscript(env, 'repo-a', 'sess-1', [
      {
        sessionId: 'sess-1',
        uuid: 'u-user-1',
        parentUuid: null,
        type: 'user',
        subtype: 'plain',
        message: { role: 'user', content: secret },
        timestamp: '2026-05-20T10:00:00.000Z',
        // A large native-only field that must NOT be carried into raw_frame.
        toolUseResult: { stdout: 'x'.repeat(5000) },
      },
    ])
    const provider = createClaudeBackfillProvider({ homeDir: env.homeDir, stateFile: env.stateFile })
    const { ctx } = runContext()
    const [item] = await collectItems(provider.run(ctx))
    assert.ok(item)
    const [msg] = value(item).messages

    const rawFrame = msg.raw_frame
    assert.ok(rawFrame, 'raw_frame present')
    // Minimized identity stub only.
    assert.equal(rawFrame.uuid, 'u-user-1')
    assert.equal(rawFrame.type, 'user')
    assert.equal(rawFrame.subtype, 'plain')
    assert.equal(typeof rawFrame.timestamp, 'string')
    // No content, no nested message, no big native blobs.
    assert.equal(rawFrame.message, undefined)
    assert.equal(rawFrame.content, undefined)
    assert.equal(rawFrame.toolUseResult, undefined)
    const serialized = JSON.stringify(rawFrame)
    assert.ok(!serialized.includes(secret), 'prompt body not copied into raw_frame')
    assert.ok(serialized.length < 500, `raw_frame stays small (${serialized.length} bytes)`)
  } finally {
    await env.cleanup()
  }
})

test('reruns are deterministic (idempotent items and rows)', async () => {
  const env = await stageEnv()
  try {
    const filePath = await writeTranscript(env, 'repo-a', 'sess-1', conversationRows('sess-1'))
    await appendSessionContext(env.stateFile, {
      session_id: 'sess-1',
      transcript_path: filePath,
      cwd: '/work/repo-a',
      git_branch: 'main',
      ts: '2026-05-20T10:00:06.000Z',
    })
    const provider = createClaudeBackfillProvider({ homeDir: env.homeDir, stateFile: env.stateFile })

    const first = await collectItems(provider.run(runContext().ctx))
    const second = await collectItems(provider.run(runContext().ctx))
    assert.deepEqual(first, second, 'yielded items are identical across runs')

    const firstItem = first[0]
    const secondItem = second[0]
    assert.ok(firstItem)
    assert.ok(secondItem)
    const rowsFirst = await materialize(firstItem)
    const rowsSecond = await materialize(secondItem)
    assert.deepEqual(rowsFirst, rowsSecond, 'materialized rows are identical across runs')
  } finally {
    await env.cleanup()
  }
})

test('sessions are grouped into one item each, across multiple files', async () => {
  const env = await stageEnv()
  try {
    await writeTranscript(env, 'repo-a', 'sess-a', conversationRows('sess-a'))
    await writeTranscript(env, 'repo-b', 'sess-b', [
      {
        sessionId: 'sess-b',
        uuid: 'b-user-1',
        parentUuid: null,
        type: 'user',
        message: { role: 'user', content: 'just one turn' },
        timestamp: '2026-05-21T08:00:00.000Z',
      },
    ])

    const provider = createClaudeBackfillProvider({ homeDir: env.homeDir, stateFile: env.stateFile })
    const items = await collectItems(provider.run(runContext().ctx))
    assert.equal(items.length, 2)

    const byId = new Map(items.map((i) => [value(i).session_id, i]))
    assert.deepEqual([...byId.keys()].sort(), ['sess-a', 'sess-b'])
    const itemA = byId.get('sess-a')
    const itemB = byId.get('sess-b')
    assert.ok(itemA)
    assert.ok(itemB)
    assert.equal(value(itemA).messages.length, 2)
    assert.equal(value(itemB).messages.length, 1)
    // No message bleeds across sessions.
    for (const m of value(itemA).messages) {
      assert.ok(/** @type {string} */ (m.message_id).startsWith('u-'))
    }
    assert.equal(value(itemB).messages[0].message_id, 'b-user-1')
  } finally {
    await env.cleanup()
  }
})

test('grouping keys on the entry session id, not the file name', async () => {
  const env = await stageEnv()
  try {
    // One file, two interleaved sessions.
    await writeRawTranscript(env, 'repo-a', 'mixed.jsonl', [
      {
        sessionId: 'sess-x',
        uuid: 'x-1',
        parentUuid: null,
        type: 'user',
        message: { role: 'user', content: 'x hello' },
        timestamp: '2026-05-20T10:00:00.000Z',
      },
      {
        sessionId: 'sess-y',
        uuid: 'y-1',
        parentUuid: null,
        type: 'user',
        message: { role: 'user', content: 'y hello' },
        timestamp: '2026-05-20T10:00:01.000Z',
      },
    ])

    const provider = createClaudeBackfillProvider({ homeDir: env.homeDir, stateFile: env.stateFile })
    const items = await collectItems(provider.run(runContext().ctx))
    const ids = items.map((i) => value(i).session_id).sort()
    assert.deepEqual(ids, ['sess-x', 'sess-y'])
  } finally {
    await env.cleanup()
  }
})

test('since bound filters out messages older than the window', async () => {
  const env = await stageEnv()
  try {
    await writeTranscript(env, 'repo-a', 'sess-1', [
      {
        sessionId: 'sess-1',
        uuid: 'u-old',
        parentUuid: null,
        type: 'user',
        message: { role: 'user', content: 'old turn' },
        timestamp: '2026-05-01T00:00:00.000Z',
      },
      {
        sessionId: 'sess-1',
        uuid: 'u-new',
        parentUuid: 'u-old',
        type: 'assistant',
        message: { role: 'assistant', content: 'new turn' },
        timestamp: '2026-05-10T00:00:00.000Z',
      },
    ])
    const provider = createClaudeBackfillProvider({ homeDir: env.homeDir, stateFile: env.stateFile })
    const { ctx } = runContext({ since: '2026-05-05T00:00:00.000Z' })
    const [item] = await collectItems(provider.run(ctx))
    assert.ok(item)
    const messages = value(item).messages
    assert.equal(messages.length, 1)
    assert.equal(messages[0].message_id, 'u-new')
  } finally {
    await env.cleanup()
  }
})

test('subagent rows carry the spawning tool call from the meta sidecar', async () => {
  const env = await stageEnv()
  try {
    // Main session: an assistant turn that spawns the subagent via an
    // Agent tool_use whose id the sidecar records.
    await writeTranscript(env, 'repo-a', 'sess-1', [
      {
        sessionId: 'sess-1',
        uuid: 'u-asst-1',
        parentUuid: null,
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_spawn', name: 'Agent', input: { subagent_type: 'Explore' } }],
        },
        timestamp: '2026-05-20T10:00:00.000Z',
      },
    ])
    // Subagent transcript + sidecar under the session's subagents/ dir.
    await writeSubagent(env, 'repo-a', 'sess-1', 'a7325fc7bf7423540', [
      {
        sessionId: 'sess-1',
        uuid: 'sa-asst-1',
        parentUuid: null,
        type: 'assistant',
        isSidechain: true,
        agentId: 'a7325fc7bf7423540',
        message: { role: 'assistant', content: [{ type: 'text', text: 'on it' }] },
        timestamp: '2026-05-20T10:00:02.000Z',
      },
    ], { agentType: 'Explore', description: 'Find X', toolUseId: 'toolu_spawn' })

    const provider = createClaudeBackfillProvider({ homeDir: env.homeDir, stateFile: env.stateFile })
    const items = await collectItems(provider.run(runContext().ctx))
    // The main session file and the subagent file are walked separately,
    // so flatten rows across every yielded item before asserting.
    const rows = (await Promise.all(items.map(materialize))).flat()

    // The subagent's row points back at the spawning tool call; the
    // main-loop assistant row does not.
    const subagentRow = rows.find((r) => r.agent_id === 'a7325fc7bf7423540')
    assert.ok(subagentRow, 'subagent row present')
    assert.equal(
      /** @type {any} */ (subagentRow.attributes).claude.spawned_by_tool_use_id,
      'toolu_spawn'
    )
    const mainRow = rows.find((r) => r.tool_call_id === 'toolu_spawn')
    assert.ok(mainRow, 'main-loop spawning tool_call row present')
    assert.equal(mainRow.agent_id, undefined)
    assert.equal(/** @type {any} */ (mainRow.attributes)?.claude?.spawned_by_tool_use_id, undefined)
  } finally {
    await env.cleanup()
  }
})

test('missing transcript root yields nothing without throwing', async () => {
  const env = await stageEnv()
  try {
    const provider = createClaudeBackfillProvider({
      homeDir: path.join(env.homeDir, 'does-not-exist'),
      stateFile: env.stateFile,
    })
    const items = await collectItems(provider.run(runContext().ctx))
    assert.equal(items.length, 0)
  } finally {
    await env.cleanup()
  }
})
