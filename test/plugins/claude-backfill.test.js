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
 * @import { BackfillEvent, BackfillItem, BackfillRunContext } from '../../hypaware-plugin-kernel-types.js'
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
      // @ref LLP 0032#capture: the hook also captures repo identity; backfill
      // must replay all three or re-imported Claude sessions drop out of the join.
      git_remote: 'git@github.com:acme/repo-a.git',
      head_sha: '0123456789abcdef0123456789abcdef01234567',
      repo_root: '/work/repo-a',
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
    // @ref LLP 0030#decision: the Claude session id is the session_id
    // partition key; conversation_id is null (no per-thread id).
    const exchange = value(item)
    assert.equal(exchange.provider, 'anthropic')
    assert.equal(exchange.session_id, 'sess-1')
    assert.equal(exchange.conversation_id, undefined)
    assert.equal(exchange.conversation_source, 'claude')
    assert.equal(exchange.client_name, 'claude')
    assert.equal(exchange.cwd, '/work/repo-a')
    assert.equal(exchange.git_branch, 'feature/x')
    // @ref LLP 0032#capture: repo identity rides the same record as cwd; the
    // live projector stamps these too, so backfilled rows converge with live.
    assert.equal(exchange.git_remote, 'git@github.com:acme/repo-a.git')
    assert.equal(exchange.head_sha, '0123456789abcdef0123456789abcdef01234567')
    assert.equal(exchange.repo_root, '/work/repo-a')
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
      // First-class repo-identity columns survive materialization (LLP 0032).
      assert.equal(row.git_remote, 'git@github.com:acme/repo-a.git')
      assert.equal(row.head_sha, '0123456789abcdef0123456789abcdef01234567')
      assert.equal(row.repo_root, '/work/repo-a')
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

test('assistant token usage is folded into attributes.usage like live capture', async () => {
  const env = await stageEnv()
  try {
    await writeTranscript(env, 'repo-a', 'sess-1', [
      {
        sessionId: 'sess-1',
        uuid: 'u-user-1',
        parentUuid: null,
        type: 'user',
        message: { role: 'user', content: 'list the files' },
        timestamp: '2026-05-20T10:00:00.000Z',
      },
      {
        sessionId: 'sess-1',
        uuid: 'u-asst-1',
        parentUuid: 'u-user-1',
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Sure.' }],
          // The usage block Claude Code stamps onto assistant transcript lines.
          usage: {
            input_tokens: 120,
            output_tokens: 45,
            cache_read_input_tokens: 1000,
            cache_creation_input_tokens: 30,
          },
        },
        timestamp: '2026-05-20T10:00:05.000Z',
      },
    ])
    const provider = createClaudeBackfillProvider({ homeDir: env.homeDir, stateFile: env.stateFile })
    const [item] = await collectItems(provider.run(runContext().ctx))
    assert.ok(item)

    const rows = await materialize(item)
    const asstRow = rowsByRole(rows, 'assistant')[0]
    // anthropic.js normalizes cache_read_input_tokens → cache_read_tokens and
    // cache_creation_input_tokens → cache_write_tokens; backfill matches live.
    assert.deepEqual(/** @type {any} */ (asstRow.attributes).usage, {
      input_tokens: 120,
      output_tokens: 45,
      cache_read_tokens: 1000,
      cache_write_tokens: 30,
    })
    // The user turn carries no usage block.
    const userRow = rowsByRole(rows, 'user')[0]
    assert.equal(/** @type {any} */ (userRow.attributes)?.usage, undefined)
  } finally {
    await env.cleanup()
  }
})

test('usage lands once - on the last block of a split assistant API message', async () => {
  const env = await stageEnv()
  try {
    // Claude Code writes one transcript line per content block; both lines of
    // one API response share message.id and repeat the usage envelope. Usage is
    // response-level, so it must land on exactly one row. @ref LLP 0035#one-carrier
    const usage = { input_tokens: 200, output_tokens: 60, cache_read_input_tokens: 500 }
    await writeTranscript(env, 'repo-split', 'sess-split', [
      {
        sessionId: 'sess-split', uuid: 'u-user', parentUuid: null, type: 'user',
        message: { role: 'user', content: 'do it' }, timestamp: '2026-05-20T10:00:00.000Z',
      },
      {
        sessionId: 'sess-split', uuid: 'u-text', parentUuid: 'u-user', type: 'assistant',
        message: { id: 'msg-split', role: 'assistant', content: [{ type: 'text', text: 'on it' }], usage },
        timestamp: '2026-05-20T10:00:05.000Z',
      },
      {
        sessionId: 'sess-split', uuid: 'u-tool', parentUuid: 'u-text', type: 'assistant',
        message: {
          id: 'msg-split', role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
          usage,
        },
        timestamp: '2026-05-20T10:00:06.000Z',
      },
    ])
    const provider = createClaudeBackfillProvider({ homeDir: env.homeDir, stateFile: env.stateFile })
    const [item] = await collectItems(provider.run(runContext().ctx))
    assert.ok(item)

    const rows = await materialize(item)
    // The two assistant blocks are distinct rows; usage rides only the last
    // (the tool_call), the earlier text block carries none.
    const textRow = rows.find((r) => r.role === 'assistant' && r.part_type === 'text')
    const toolRow = rows.find((r) => r.role === 'assistant' && r.part_type === 'tool_call')
    assert.ok(textRow)
    assert.ok(toolRow)
    assert.equal(/** @type {any} */ (textRow.attributes)?.usage, undefined)
    assert.deepEqual(/** @type {any} */ (toolRow.attributes).usage, {
      input_tokens: 200,
      output_tokens: 60,
      cache_read_tokens: 500,
    })
  } finally {
    await env.cleanup()
  }
})

test('assistant model is surfaced per message, switches mid-session, and drops <synthetic>', async () => {
  const env = await stageEnv()
  try {
    await writeTranscript(env, 'repo-a', 'sess-1', [
      {
        sessionId: 'sess-1',
        uuid: 'u-user-1',
        parentUuid: null,
        type: 'user',
        message: { role: 'user', content: 'hello' },
        timestamp: '2026-05-20T10:00:00.000Z',
      },
      {
        sessionId: 'sess-1',
        uuid: 'u-asst-1',
        parentUuid: 'u-user-1',
        type: 'assistant',
        // The model Claude Code stamps onto each assistant transcript line.
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], model: 'claude-opus-4-8' },
        timestamp: '2026-05-20T10:00:05.000Z',
      },
      {
        sessionId: 'sess-1',
        uuid: 'u-asst-2',
        parentUuid: 'u-asst-1',
        type: 'assistant',
        // A mid-session model switch must be preserved per message, not
        // collapsed to one value for the whole session.
        message: { role: 'assistant', content: [{ type: 'text', text: 'still here' }], model: 'claude-fable-5' },
        timestamp: '2026-05-20T10:00:06.000Z',
      },
      {
        sessionId: 'sess-1',
        uuid: 'u-asst-3',
        parentUuid: 'u-asst-2',
        type: 'assistant',
        // `<synthetic>` is a sentinel for locally-generated assistant lines
        // that never hit a model: it must not land in the model column.
        message: { role: 'assistant', content: [{ type: 'text', text: '[interrupted]' }], model: '<synthetic>' },
        timestamp: '2026-05-20T10:00:07.000Z',
      },
    ])
    const provider = createClaudeBackfillProvider({ homeDir: env.homeDir, stateFile: env.stateFile })
    const [item] = await collectItems(provider.run(runContext().ctx))
    assert.ok(item)

    const rows = await materialize(item)
    const asstRows = rowsByRole(rows, 'assistant')
    /** @param {string} text */
    const byText = (text) => {
      const row = asstRows.find((r) => r.content_text === text)
      assert.ok(row, `assistant row for "${text}" present`)
      return row
    }
    assert.equal(byText('hi').model, 'claude-opus-4-8')
    assert.equal(byText('still here').model, 'claude-fable-5')
    // The <synthetic> line records no model.
    assert.equal(byText('[interrupted]').model ?? null, null)
    // A user turn carries no model: the transcript records `message.model` on
    // assistant lines only, so backfill model fidelity is assistant-output-only
    // (LLP 0026 Consequences). Unlike live capture, backfilled user/tool_result
    // rows are intentionally model-less.
    assert.equal(rowsByRole(rows, 'user')[0].model ?? null, null)
  } finally {
    await env.cleanup()
  }
})

test('token usage merges with subagent spawn provenance', async () => {
  const env = await stageEnv()
  try {
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
    await writeSubagent(env, 'repo-a', 'sess-1', 'a7325fc7bf7423540', [
      {
        sessionId: 'sess-1',
        uuid: 'sa-asst-1',
        parentUuid: null,
        type: 'assistant',
        isSidechain: true,
        agentId: 'a7325fc7bf7423540',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'on it' }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        timestamp: '2026-05-20T10:00:02.000Z',
      },
    ], { agentType: 'Explore', description: 'Find X', toolUseId: 'toolu_spawn' })

    const provider = createClaudeBackfillProvider({ homeDir: env.homeDir, stateFile: env.stateFile })
    const items = await collectItems(provider.run(runContext().ctx))
    const rows = (await Promise.all(items.map(materialize))).flat()

    const subagentRow = rows.find((r) => r.agent_id === 'a7325fc7bf7423540')
    assert.ok(subagentRow, 'subagent row present')
    const attributes = /** @type {any} */ (subagentRow.attributes)
    // Both the spawn provenance and the token usage survive on one row.
    assert.equal(attributes.claude.spawned_by_tool_use_id, 'toolu_spawn')
    assert.deepEqual(attributes.usage, { input_tokens: 10, output_tokens: 5 })
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

test('raw_frame is minimized - never a full transcript copy', async () => {
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

// ---------------------------------------------------------------------------
// Repo recovery for pre-LLP-0032 sessions (deriveRepo fallback)
// ---------------------------------------------------------------------------

/**
 * A one-turn session whose transcript line carries a `cwd` (as Claude Code
 * stamps it) but for which no session-context record exists: the shape of a
 * session recorded before the hook captured git identity.
 *
 * @param {string} sessionId
 * @param {string} cwd
 */
function rowsWithCwd(sessionId, cwd) {
  return [
    {
      sessionId,
      uuid: `${sessionId}-u1`,
      parentUuid: null,
      type: 'user',
      cwd,
      message: { role: 'user', content: 'recover my repo' },
      timestamp: '2026-05-20T10:00:00.000Z',
    },
  ]
}

test('recovers git_remote/repo_root from the transcript cwd when the record predates git capture', async () => {
  const env = await stageEnv()
  try {
    // No session-context record at all: the historical shape.
    await writeTranscript(env, '-Users-phil-workspace-repo-z', 'sess-z', rowsWithCwd('sess-z', '/Users/phil/workspace/repo-z'))

    /** @type {string[]} */
    const derivedFor = []
    const provider = createClaudeBackfillProvider({
      homeDir: env.homeDir,
      stateFile: env.stateFile,
      deriveRepo: async (cwd) => {
        derivedFor.push(/** @type {string} */ (cwd))
        return cwd === '/Users/phil/workspace/repo-z'
          ? { git_remote: 'git@github.com:acme/repo-z.git', repo_root: '/Users/phil/workspace/repo-z' }
          : {}
      },
    })
    const [item] = await collectItems(provider.run(runContext().ctx))
    assert.ok(item)
    const exchange = value(item)

    // cwd recovered from the transcript line; remote + root derived from it.
    assert.equal(exchange.cwd, '/Users/phil/workspace/repo-z')
    assert.equal(exchange.git_remote, 'git@github.com:acme/repo-z.git')
    assert.equal(exchange.repo_root, '/Users/phil/workspace/repo-z')
    // head_sha is NEVER derived: current HEAD ≠ the session's HEAD.
    assert.equal(exchange.head_sha, undefined)
    assert.deepEqual(derivedFor, ['/Users/phil/workspace/repo-z'])

    // The recovered identity survives materialization into canonical rows.
    const rows = await materialize(item)
    for (const row of rows) {
      assert.equal(row.git_remote, 'git@github.com:acme/repo-z.git')
      assert.equal(row.repo_root, '/Users/phil/workspace/repo-z')
      assert.equal(row.head_sha, undefined)
    }
  } finally {
    await env.cleanup()
  }
})

test('record-provided remote wins; no derivation is attempted', async () => {
  const env = await stageEnv()
  try {
    const filePath = await writeTranscript(env, 'repo-a', 'sess-1', rowsWithCwd('sess-1', '/transcript/cwd'))
    await appendSessionContext(env.stateFile, {
      session_id: 'sess-1',
      transcript_path: filePath,
      cwd: '/work/repo-a',
      git_branch: 'main',
      git_remote: 'git@github.com:acme/repo-a.git',
      head_sha: '0123456789abcdef0123456789abcdef01234567',
      repo_root: '/work/repo-a',
      ts: '2026-05-20T10:00:06.000Z',
    })

    let derivations = 0
    const provider = createClaudeBackfillProvider({
      homeDir: env.homeDir,
      stateFile: env.stateFile,
      deriveRepo: async () => { derivations += 1; return {} },
    })
    const [item] = await collectItems(provider.run(runContext().ctx))
    assert.ok(item)
    const exchange = value(item)
    // The record won across the board; the transcript cwd was not consulted.
    assert.equal(exchange.cwd, '/work/repo-a')
    assert.equal(exchange.git_remote, 'git@github.com:acme/repo-a.git')
    assert.equal(exchange.repo_root, '/work/repo-a')
    assert.equal(exchange.head_sha, '0123456789abcdef0123456789abcdef01234567')
    assert.equal(derivations, 0, 'no git derivation when the record already has a remote')
  } finally {
    await env.cleanup()
  }
})

test('derivation is memoized per cwd across sessions', async () => {
  const env = await stageEnv()
  try {
    // Three sessions: two share a cwd, one is distinct.
    await writeTranscript(env, 'p1', 'sess-1', rowsWithCwd('sess-1', '/repo/one'))
    await writeTranscript(env, 'p1', 'sess-2', rowsWithCwd('sess-2', '/repo/one'))
    await writeTranscript(env, 'p2', 'sess-3', rowsWithCwd('sess-3', '/repo/two'))

    /** @type {string[]} */
    const derivedFor = []
    const provider = createClaudeBackfillProvider({
      homeDir: env.homeDir,
      stateFile: env.stateFile,
      deriveRepo: async (cwd) => {
        derivedFor.push(/** @type {string} */ (cwd))
        return { git_remote: `remote-for:${cwd}` }
      },
    })
    const items = await collectItems(provider.run(runContext().ctx))
    assert.equal(items.length, 3)
    // Two distinct cwds → exactly two derivations despite three sessions.
    assert.deepEqual(derivedFor.sort(), ['/repo/one', '/repo/two'])

    const byCwd = new Map(items.map((i) => [value(i).cwd, value(i).git_remote]))
    assert.equal(byCwd.get('/repo/one'), 'remote-for:/repo/one')
    assert.equal(byCwd.get('/repo/two'), 'remote-for:/repo/two')
  } finally {
    await env.cleanup()
  }
})

test('recovers git_remote from the record cwd when the record predates git capture', async () => {
  const env = await stageEnv()
  try {
    // The canonical pre-0032 shape (LLP 0032): a session-context record EXISTS
    // (cwd and git_branch were captured) but predates git-remote capture, so
    // it carries no git_remote/head_sha/repo_root. The record's cwd differs
    // from the transcript line's cwd to prove derivation keys on `record.cwd`
    // (the `record?.cwd ?? transcriptCwd` precedence), not the transcript line.
    const filePath = await writeTranscript(
      env,
      '-Users-phil-workspace-repo-canon',
      'sess-canon',
      rowsWithCwd('sess-canon', '/transcript/line/cwd')
    )
    await appendSessionContext(env.stateFile, {
      session_id: 'sess-canon',
      transcript_path: filePath,
      cwd: '/Users/phil/workspace/repo-canon',
      git_branch: 'feature/recover',
      // git_remote / head_sha / repo_root deliberately omitted (pre-0032).
      ts: '2026-05-20T10:00:06.000Z',
    })

    /** @type {string[]} */
    const derivedFor = []
    const provider = createClaudeBackfillProvider({
      homeDir: env.homeDir,
      stateFile: env.stateFile,
      deriveRepo: async (cwd) => {
        derivedFor.push(/** @type {string} */ (cwd))
        return cwd === '/Users/phil/workspace/repo-canon'
          ? { git_remote: 'git@github.com:acme/repo-canon.git', repo_root: '/Users/phil/workspace/repo-canon' }
          : {}
      },
    })
    const [item] = await collectItems(provider.run(runContext().ctx))
    assert.ok(item)
    const exchange = value(item)

    // Derivation keyed on the RECORD's cwd, not the transcript line's cwd.
    assert.deepEqual(derivedFor, ['/Users/phil/workspace/repo-canon'])
    assert.equal(exchange.cwd, '/Users/phil/workspace/repo-canon')
    // The record's captured fields survive and the recovered remote lands.
    assert.equal(exchange.git_branch, 'feature/recover')
    assert.equal(exchange.git_remote, 'git@github.com:acme/repo-canon.git')
    assert.equal(exchange.repo_root, '/Users/phil/workspace/repo-canon')
    // head_sha is NEVER derived: current HEAD ≠ the session's HEAD.
    assert.equal(exchange.head_sha, undefined)

    // The recovered identity survives materialization into canonical rows.
    const rows = await materialize(item)
    for (const row of rows) {
      assert.equal(row.git_remote, 'git@github.com:acme/repo-canon.git')
      assert.equal(row.repo_root, '/Users/phil/workspace/repo-canon')
      assert.equal(row.head_sha, undefined)
    }
  } finally {
    await env.cleanup()
  }
})

test('record repo_root is preserved when only the remote is derived', async () => {
  const env = await stageEnv()
  try {
    // A partial pre-0032 record: the hook captured an authoritative repo_root
    // (`git rev-parse --show-toplevel`) but no git_remote. Derivation must
    // recover the remote WITHOUT clobbering the record's repo_root, even when
    // the probe (run later / in a shifted worktree) reports a different
    // toplevel. This guards the `&& !exchange.repo_root` clause: drop it and
    // the derived repo_root would overwrite the record's authoritative value.
    const filePath = await writeTranscript(env, 'repo-partial', 'sess-partial', rowsWithCwd('sess-partial', '/transcript/line/cwd'))
    await appendSessionContext(env.stateFile, {
      session_id: 'sess-partial',
      transcript_path: filePath,
      cwd: '/work/repo-partial',
      git_branch: 'main',
      // git_remote omitted; repo_root present and authoritative.
      repo_root: '/work/repo-partial',
      ts: '2026-05-20T10:00:06.000Z',
    })

    let derivations = 0
    const provider = createClaudeBackfillProvider({
      homeDir: env.homeDir,
      stateFile: env.stateFile,
      deriveRepo: async () => {
        derivations += 1
        // The probe reports a DIFFERENT toplevel than the record's repo_root.
        return { git_remote: 'git@github.com:acme/repo-partial.git', repo_root: '/elsewhere/worktree' }
      },
    })
    const [item] = await collectItems(provider.run(runContext().ctx))
    assert.ok(item)
    const exchange = value(item)

    // Derivation ran (the record had no remote), and the remote landed...
    assert.equal(derivations, 1)
    assert.equal(exchange.git_remote, 'git@github.com:acme/repo-partial.git')
    // ...but the record's repo_root was NOT overwritten by the derived one.
    assert.equal(exchange.repo_root, '/work/repo-partial')
  } finally {
    await env.cleanup()
  }
})

test('an already-aborted signal stops the scan before any session is projected', async () => {
  const env = await stageEnv()
  try {
    await writeTranscript(env, 'repo-abort', 'sess-abort', conversationRows('sess-abort'))
    const provider = createClaudeBackfillProvider({ homeDir: env.homeDir, stateFile: env.stateFile })

    // Sanity: the same transcript yields an item when the run is not aborted.
    const items = await collectItems(provider.run(runContext().ctx))
    assert.equal(items.length, 1)

    const controller = new AbortController()
    controller.abort()
    const aborted = await collectItems(provider.run({ ...runContext().ctx, signal: controller.signal }))
    assert.equal(aborted.length, 0)
  } finally {
    await env.cleanup()
  }
})

test('transcript toolUseResult is promoted onto the backfilled row', async () => {
  const env = await stageEnv()
  try {
    // The structured result Claude Code writes only to the transcript.
    const toolUseResult = {
      filePath: '/work/a.txt',
      interrupted: false,
      structuredPatch: [{ oldStart: 1, newStart: 1, lines: ['-a', '+b'] }],
    }
    await writeTranscript(env, 'repo-a', 'sess-tur', [
      {
        sessionId: 'sess-tur',
        uuid: 'u-user-1',
        parentUuid: null,
        type: 'user',
        message: { role: 'user', content: 'edit the file' },
        timestamp: '2026-05-20T10:00:00.000Z',
      },
      {
        sessionId: 'sess-tur',
        uuid: 'u-asst-1',
        parentUuid: 'u-user-1',
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_x', name: 'Edit', input: { file_path: '/work/a.txt' } }],
        },
        timestamp: '2026-05-20T10:00:05.000Z',
      },
      {
        sessionId: 'sess-tur',
        uuid: 'u-result-1',
        parentUuid: 'u-asst-1',
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' }] },
        toolUseResult,
        timestamp: '2026-05-20T10:00:06.000Z',
      },
    ])
    const provider = createClaudeBackfillProvider({ homeDir: env.homeDir, stateFile: env.stateFile })
    const [item] = await collectItems(provider.run(runContext().ctx))
    assert.ok(item)

    const rows = await materialize(item)
    const resultRow = rows.find((r) => r.part_type === 'tool_result')
    assert.ok(resultRow)
    assert.deepEqual(/** @type {any} */ (resultRow.attributes).claude.tool_use_result, toolUseResult)
    // Only the line that carried toolUseResult gets the attribute.
    for (const row of rows) {
      if (row === resultRow) continue
      assert.equal(/** @type {any} */ (row.attributes)?.claude?.tool_use_result, undefined)
    }
  } finally {
    await env.cleanup()
  }
})
