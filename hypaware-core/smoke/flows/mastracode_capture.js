// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { Attr, installObservability } from '../../../src/core/observability/index.js'
import { registerCoreCommands } from '../../../src/core/cli/core_commands.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { loadManifests } from '../../../src/core/manifest.js'
import { dispatchText, makeStep, sqlCount } from '../lib/github_fixture.js'
import {
  assistantContent,
  createMastraDb,
  insertMessage,
  insertThread,
  openWriter,
  rewriteMessage,
  sandboxExitPart,
  stepStartPart,
  textPart,
  toolInvocationPart,
  updateThread,
  userContent,
  workspaceMetadataPart,
} from '../lib/mastracode_fixture.js'

/** @import { DatabaseSync as SqliteDatabase } from 'node:sqlite' */

/**
 * Hermetic end-to-end proof of `@hypaware/mastracode`: the poll source and
 * `hyp backfill mastracode` read a fixture `mastra.db` under a fake HOME and
 * land Mastra Code threads as `ai_gateway_messages` rows that query, grep,
 * survive a rewrite, continue, rerun idempotently, and project into the
 * session graph.
 *
 * @ref LLP 0587#tasks [tests]: plan task T7, the mastracode_capture hermetic smoke
 * @ref LLP 0586#reconciliation [tests]: a rewritten assistant row settles to the same parts, no duplicates
 * @ref LLP 0586#privacy [tests]: a `.hypignore`d project never lands, a local-only project's rows are withheld from export, and no `data-workspace-metadata` value reaches a row
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error('mastracode_capture: tracer provider not installed - expected HYP_DEV_TELEMETRY=1')
  }
  const step = makeStep(harness)
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({
    commandRegistry: registry,
    cacheRoot: path.join(harness.stateDir, 'cache'),
  })
  const lifetime = { kernel, registry }
  const workspace = path.resolve(import.meta.dirname, '..', '..', 'plugins-workspace')
  const tmpRoot = path.join(harness.tmpDir, 'plugin-temp')
  await fs.mkdir(tmpRoot, { recursive: true })

  // The mastracode plugin resolves `mastra.db` from `ctx.env` at activation
  // (LLP 0586#config). `MASTRA_APP_DATA_DIR` names the fixture on every
  // platform; the variables that would outrank it, or name a remote store,
  // are cleared.
  const fakeHome = path.join(harness.tmpDir, 'home')
  const work = path.join(fakeHome, 'work')
  const project = path.join(work, 'included-project')
  const other = path.join(work, 'other-project')
  const ignored = path.join(work, 'ignored-project')
  const localOnly = path.join(work, 'local-only-project')
  for (const dir of [project, other, ignored, localOnly]) await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(ignored, '.hypignore'), 'ignore\n', 'utf8')
  await fs.writeFile(path.join(localOnly, '.hypignore'), 'local-only\n', 'utf8')
  // The database exists before the source starts, so the baseline tick
  // records its cursor and every later write reads as new.
  const appData = path.join(fakeHome, '.local', 'share', 'mastracode')
  const dbPath = await createMastraDb(appData)

  const needle = `mastrasmoke-${harness.devRunId}`
  const title = `mastra title ${harness.devRunId}`
  // The workspace a `data-workspace-metadata` part names; D6 drops it.
  const workspaceBase = `/opt/mastrasmoke-ws-${harness.devRunId}`

  const savedKeys = ['HOME', 'MASTRA_DB_PATH', 'MASTRA_APP_DATA_DIR', 'MASTRA_DB_URL', 'XDG_DATA_HOME']
  const saved = Object.fromEntries(savedKeys.map((key) => [key, process.env[key]]))
  for (const key of savedKeys) delete process.env[key]
  process.env.HOME = fakeHome
  process.env.MASTRA_APP_DATA_DIR = appData
  const db = openWriter(dbPath)
  const clock = fixtureClock()
  /** @type {any} */
  let sourceCtx
  let sourceRunning = false
  let stepCount = 0
  /** @type {(name: string, fn: () => Promise<any>) => Promise<any>} */
  const counted = (name, fn) => { stepCount += 1; return step(name, fn) }

  try {
    await counted('activate', async () => {
      const { loaded } = await loadManifests([
        path.join(workspace, 'ai-gateway'),
        path.join(workspace, 'context-graph'),
        path.join(workspace, 'ai-gateway-graph'),
        path.join(workspace, 'grep'),
        path.join(workspace, 'mastracode'),
      ])
      const byName = new Map(loaded.map((entry) => [entry.manifest.name, entry]))
      const order = ['@hypaware/ai-gateway', '@hypaware/context-graph', '@hypaware/ai-gateway-graph', '@hypaware/grep', '@hypaware/mastracode']
      const { results } = await activatePlugins({
        plugins: order.map((name) => {
          const entry = byName.get(name)
          if (!entry) throw new Error(`mastracode_capture: missing manifest ${name}`)
          return {
            manifest: entry.manifest,
            rootDir: entry.rootDir,
            config: /** @type {Record<string, number>} */ (name === '@hypaware/mastracode' ? { poll_interval: 200 } : {}),
          }
        }),
        stateRoot: harness.stateDir,
        runId: harness.devRunId,
        runtime: kernel,
        tmpRoot,
      })
      expect.that('activate: all five plugins ok', results, (value) => value.length === 5 && value.every((r) => r.ok))
      sourceCtx = kernel.activationContexts.get('@hypaware/mastracode')
    })

    await counted('poll_baseline', async () => {
      // The daemon is the source's sole starter in production; the smoke
      // stands in for it. The first tick records the cursor and the floor.
      await kernel.sources.start('mastracode', sourceCtx)
      sourceRunning = true
      const status = await mastracodeStatus(kernel)
      expect.that('poll_baseline: ready, no threads yet', status, (value) => value?.state === 'ready' && /no threads yet$/.test(String(value?.message)))
    })

    await counted('poll_capture', async () => {
      writeMarkerThread(db, clock, { id: 'T1', projectPath: project, needle, title, workspaceBase })
      writeThread(db, clock, { id: 'T2', projectPath: other, text: `other project ${needle}` })
      writeThread(db, clock, { id: 'T3', projectPath: ignored, text: `ignored ${needle}` })
      writeThread(db, clock, { id: 'L1', projectPath: localOnly, text: `local only ${needle}` })
      await waitFor(async () => (
        await sqlCount("select count(*) as n from ai_gateway_messages where session_id = 'mastracode-T1' and part_type = 'tool_result'", lifetime) >= 2 &&
        await sqlCount("select count(*) as n from ai_gateway_messages where session_id = 'mastracode-T2'", lifetime) >= 1 &&
        await sqlCount("select count(*) as n from ai_gateway_messages where session_id = 'mastracode-L1'", lifetime) >= 1
      ), 15_000)
    })

    const markerSql = [
      'select role, part_type, part_id, content_text, tool_name, tool_call_id, client_name, conversation_source, entrypoint, provider, model, message_id, cwd',
      "from ai_gateway_messages where session_id = 'mastracode-T1' and part_type <> 'session_metadata' order by message_index, part_index",
    ].join(' ')

    await counted('marker_turn', async () => {
      const rows = await queryJson(markerSql, lifetime)
      const shape = rows.map((r) => [r.role, r.part_type, r.tool_call_id ?? null, r.content_text ?? null])
      expect.that('marker: user text, two calls each followed by its result, then the answer', shape, (value) => JSON.stringify(value) === JSON.stringify([
        ['user', 'text', null, needle],
        ['assistant', 'tool_call', 'call-1', null],
        ['tool', 'tool_result', 'call-1', 'one'],
        ['assistant', 'tool_call', 'call-2', null],
        ['tool', 'tool_result', 'call-2', 'two'],
        ['assistant', 'text', null, 'listing the files'],
      ]))
      expect.that('marker: tool calls name execute_command', rows, (value) => value.filter((r) => r.part_type === 'tool_call').every((r) => r.tool_name === 'execute_command'))
      expect.that('marker: rows tagged mastracode with the project as cwd', rows, (value) => value.every((r) => r.client_name === 'mastracode' && r.conversation_source === 'mastracode' && r.entrypoint === 'mastracode' && r.cwd === project))
      expect.that('marker: the step-start model and the message provider', rows, (value) => value.some((r) => r.role === 'assistant' && r.provider === 'openai' && r.model === 'openai/gpt-step'))
      const titles = await sqlCount(`select count(*) as n from ai_gateway_messages where session_id = 'mastracode-T1' and part_type = 'session_metadata' and content_text is null`, lifetime)
      expect.that('marker: the thread carries one title row', titles, (n) => n === 1)
      const otherRows = await queryJson("select cwd from ai_gateway_messages where session_id = 'mastracode-T2' and part_type = 'text'", lifetime)
      expect.that('marker: the second project\'s thread landed under its own cwd', otherRows, (value) => value.length === 2 && value.every((r) => r.cwd === other))
      const dropped = await sqlCount("select count(*) as n from ai_gateway_messages where session_id = 'mastracode-T3'", lifetime)
      expect.that('privacy: .hypignored project absent', dropped, (n) => n === 0)
    })

    await counted('grep', async () => {
      const result = await dispatchText(['query', 'grep', needle, '--include-local-only', '--format', 'json'], lifetime)
      expect.that('grep: exited 0', { code: result.code, stderr: result.stderr }, (value) => value.code === 0)
      const rows = parseJson(result.stdout)
      expect.that('grep: finds the marker, other and local-only threads only', rows, (value) => Array.isArray(value)
        && value.some((r) => r.session_id === 'mastracode-T1')
        && value.every((r) => ['mastracode-T1', 'mastracode-T2', 'mastracode-L1'].includes(r.session_id)))
    })

    await counted('local_only_export', async () => {
      const storage = kernel.storage
      const table = storage.cacheTablePath('ai_gateway_messages')
      const local = await queryJson("select * from ai_gateway_messages where session_id = 'mastracode-L1'", lifetime)
      const included = await queryJson("select * from ai_gateway_messages where session_id = 'mastracode-T1'", lifetime)
      expect.that('export: every local-only project row withheld', storage.exportWithheld(table, local), (n) => n === local.length && n > 0)
      expect.that('export: no included project row withheld', storage.exportWithheld(table, included), (n) => n === 0)
      const result = await dispatchText(['query', 'sql', "select count(*) as n from ai_gateway_messages where session_id = 'mastracode-L1'", '--refresh', 'always', '--format', 'json'], lifetime)
      expect.that('query: the default query withholds the local-only rows', result, (value) => value.code === 0 && parseJson(value.stdout)?.[0]?.n === 0 && /local-only: withheld \d+ row\(s\)/.test(value.stderr))
    })

    await counted('workspace_metadata_dropped', async () => {
      const rows = await queryJson("select * from ai_gateway_messages where client_name = 'mastracode'", lifetime)
      const serialized = JSON.stringify(rows)
      expect.that('privacy: no data-workspace-metadata value in any row', serialized, (text) => rows.length > 0
        && !text.includes(workspaceBase) && !text.includes('Mastra Code Workspace') && !text.includes('local-fs-fixture') && !text.includes('memoryMB'))
    })

    await counted('rewrite', async () => {
      const before = await queryJson(markerSql, lifetime)
      // Mastra Code grows an assistant turn by rewriting its row in place:
      // the same rowid and message id, a longer `content.parts`.
      rewriteMessage(db, 'T1-a', markerAssistant({ workspaceBase, extra: 'rewrite done' }))
      updateThread(db, 'T1', { updatedAt: clock() })
      const rewroteAt = Date.now()
      // Two poll intervals after the commit, so a tick that began before it
      // has finished and one that began after it has run.
      await waitFor(async () => {
        const status = await mastracodeStatus(kernel)
        const polledAt = Date.parse(String(status?.details?.last_poll_at ?? ''))
        return polledAt > rewroteAt + 400 && status?.details?.threads_pending === 0
      }, 15_000)
      const after = await queryJson(markerSql, lifetime)
      const distinct = new Set(after.map((r) => r.part_id)).size
      expect.that('rewrite: one more part than before', after.length, (n) => n === before.length + 1)
      expect.that('rewrite: no duplicate parts', { distinct, total: after.length }, (v) => v.distinct === v.total)
      expect.that('rewrite: the parts it already had keep their ids', after, (value) => before.every((r) => value.some((a) => a.part_id === r.part_id)))
      expect.that('rewrite: the grown text landed once', after, (value) => value.filter((r) => r.content_text === 'rewrite done').length === 1)
    })

    await counted('continued_thread', async () => {
      const before = await sqlCount("select count(*) as n from ai_gateway_messages where session_id = 'mastracode-T1'", lifetime)
      writeTurn(db, clock, { threadId: 'T1', tag: 'continued' })
      await waitFor(async () => (await sqlCount("select count(*) as n from ai_gateway_messages where session_id = 'mastracode-T1' and content_text = 'continued reply'", lifetime)) === 1, 15_000)
      const after = await sqlCount("select count(*) as n from ai_gateway_messages where session_id = 'mastracode-T1'", lifetime)
      expect.that('continue: the turn appends to the same thread', { before, after }, (v) => v.after === v.before + 2)
      const sessions = await sqlCount("select count(distinct session_id) as n from ai_gateway_messages where content_text in ('continued prompt', 'continued reply')", lifetime)
      expect.that('continue: one session holds the continued turn', sessions, (n) => n === 1)
    })

    await counted('backfill_recovery', async () => {
      await kernel.sources.stop('mastracode')
      sourceRunning = false
      writeThread(db, clock, { id: 'T4', projectPath: project, text: 'written while the daemon was down' })
      const first = await dispatchText(['backfill', 'mastracode', '--json'], lifetime)
      expect.that('backfill: exited 0', first.code, (code) => code === 0)
      const provider = parseJson(first.stdout)?.providers?.find((/** @type {any} */ p) => p.provider === 'mastracode')
      expect.that('backfill: mastracode ok and wrote the missed thread', provider, (v) => v !== undefined && v.status === 'ok' && v.rows_written >= 1)
      const t4 = await sqlCount("select count(*) as n from ai_gateway_messages where session_id = 'mastracode-T4' and part_type = 'text'", lifetime)
      expect.that('backfill: missed thread landed', t4, (n) => n === 2)
    })

    await counted('idempotent_rerun', async () => {
      const total = await sqlCount("select count(*) as n from ai_gateway_messages where client_name = 'mastracode'", lifetime)
      const previousRunId = process.env.DEV_RUN_ID
      process.env.DEV_RUN_ID = `${harness.devRunId}-rerun`
      let rerun
      try {
        rerun = await dispatchText(['backfill', 'mastracode', '--json'], lifetime)
      } finally {
        if (previousRunId === undefined) delete process.env.DEV_RUN_ID
        else process.env.DEV_RUN_ID = previousRunId
      }
      expect.that('rerun: exited 0', rerun.code, (code) => code === 0)
      const provider = parseJson(rerun.stdout)?.providers?.find((/** @type {any} */ p) => p.provider === 'mastracode')
      expect.that('rerun: wrote zero rows', provider, (v) => v !== undefined && v.status === 'ok' && v.rows_written === 0)
      const after = await sqlCount("select count(*) as n from ai_gateway_messages where client_name = 'mastracode'", lifetime)
      expect.that('rerun: row count unchanged', after, (n) => n === total)
      const dropped = await sqlCount("select count(*) as n from ai_gateway_messages where session_id = 'mastracode-T3'", lifetime)
      expect.that('rerun: .hypignored project still absent', dropped, (n) => n === 0)
    })

    await counted('graph', async () => {
      const result = await dispatchText(['graph', 'project', '--source', 'ai_gateway_messages'], lifetime)
      expect.that('graph project: exited 0', result.code, (code) => code === 0)
      expect.that('graph project: no stderr', result.stderr, (text) => text === '')
      const sessions = await sqlCount("select count(*) as n from node where node_type = 'Session' and natural_key = 'mastracode-T1'", lifetime)
      expect.that('graph: the turn groups under the Mastra Code thread id', sessions, (n) => n === 1)
      const used = await sqlCount("select count(*) as n from edge e join node s on e.src_id = s.node_id join node t on e.dst_id = t.node_id where e.edge_type = 'used' and s.natural_key = 'mastracode-T1' and t.natural_key = 'execute_command'", lifetime)
      expect.that('graph: the thread used the execute_command tool', used, (n) => n === 1)
    })

    await obs.shutdown()
    const logs = await expect.logs()
    const traces = await expect.traces()
    const polls = logs.filter((/** @type {any} */ l) => l.body === 'mastracode.poll' && l.attributes?.component === 'mastracode')
    expect.that('logs: mastracode.poll ok with rows', polls, (value) => value.some((l) => l.attributes?.poll_status === 'ok' && Number(l.attributes?.rows) > 0))
    expect.that('logs: mastracode.poll baseline tick', polls, (value) => value.some((l) => l.attributes?.poll_status === 'baseline'))
    // Through the real attribute contract: a healthy run logs no failed tick.
    expect.that('logs: no mastracode.poll tick reads as failed', polls, (value) => value.every((l) => l.attributes?.status === 'ok'))
    expect.that('traces: mastracode.poll spans', traces, (value) => value.some((t) => t.name === 'mastracode.poll'))
    const drops = logs.filter((/** @type {any} */ l) => l.body === 'plugin.mastracode.usage_policy_drop')
    expect.that('logs: usage-policy drop names the ignored thread', drops, (value) => value.some((l) => l.attributes?.session_id === 'T3' && l.attributes?.declared === 'ignore'))
    const serializedLogs = JSON.stringify(logs)
    expect.that('logs: no message text, title, project path or database path', serializedLogs, (text) => !text.includes(needle) && !text.includes(title) && !text.includes(work) && !text.includes(dbPath) && !text.includes(workspaceBase))
    const finish = traces.filter((/** @type {any} */ t) => t.name === 'backfill.provider_finish' && t.attributes?.provider === 'mastracode' && t.attributes?.[Attr.DEV_RUN_ID] === harness.devRunId)
    expect.that('traces: backfill.provider_finish for mastracode under the run id', finish, (value) => value.some((t) => t.attributes?.status === 'ok' && Number(t.attributes?.rows_written) >= 1))
    const steps = traces.filter((/** @type {any} */ t) => String(t.name).startsWith('smoke.step.') && t.attributes?.[Attr.DEV_RUN_ID] === harness.devRunId && t.attributes?.[Attr.SMOKE_NAME] === harness.smokeName)
    expect.that('traces: every smoke step stamped with smoke_name, smoke_step, DEV_RUN_ID', steps, (value) => value.length === stepCount && value.every((t) => typeof t.attributes?.[Attr.SMOKE_STEP] === 'string'))
  } finally {
    if (sourceRunning) await kernel.sources.stop('mastracode').catch(() => {})
    db.close()
    for (const key of savedKeys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    await obs.shutdown().catch(() => {})
  }
}

/**
 * Strictly increasing ISO `updatedAt` values, as Mastra Code writes them,
 * so every write moves a thread's `updatedAt`.
 */
function fixtureClock() {
  let ms = Date.parse('2026-11-06T10:00:00Z')
  return () => {
    ms += 2000
    return new Date(ms).toISOString()
  }
}

/**
 * @param {SqliteDatabase} db
 * @param {() => string} clock
 * @param {{ id: string, projectPath: string, title?: string }} thread
 */
function writeThreadRow(db, clock, { id, projectPath, title }) {
  const at = clock()
  insertThread(db, {
    id,
    title: title ?? '',
    metadata: { projectPath, currentModelId: 'mastracode/openai/gpt-thread' },
    createdAt: at,
    updatedAt: at,
  })
}

/**
 * A thread with one plain user-and-assistant turn.
 *
 * @param {SqliteDatabase} db
 * @param {() => string} clock
 * @param {{ id: string, projectPath: string, text: string }} thread
 */
function writeThread(db, clock, { id, projectPath, text }) {
  db.exec('BEGIN')
  writeThreadRow(db, clock, { id, projectPath })
  insertMessage(db, { id: `${id}-u`, thread_id: id, role: 'signal', type: 'user', content: userContent(`${id}-sig`, text) })
  insertMessage(db, {
    id: `${id}-a`, thread_id: id, role: 'assistant', type: 'v2',
    content: assistantContent([textPart(`${id} reply`)], { modelId: 'openai/gpt-fixture', provider: 'openai' }),
  })
  db.exec('COMMIT')
}

/**
 * One more turn on an existing thread, then the `updatedAt` bump Mastra
 * Code writes with it.
 *
 * @param {SqliteDatabase} db
 * @param {() => string} clock
 * @param {{ threadId: string, tag: string }} turn
 */
function writeTurn(db, clock, { threadId, tag }) {
  db.exec('BEGIN')
  insertMessage(db, { id: `${threadId}-${tag}-u`, thread_id: threadId, role: 'signal', type: 'user', content: userContent(`${threadId}-${tag}-sig`, `${tag} prompt`, 1793919160000) })
  insertMessage(db, {
    id: `${threadId}-${tag}-a`, thread_id: threadId, role: 'assistant', type: 'v2',
    content: assistantContent([textPart(`${tag} reply`, 1793919161000)], { modelId: 'openai/gpt-fixture', provider: 'openai' }),
  })
  updateThread(db, threadId, { updatedAt: clock() })
  db.exec('COMMIT')
}

/**
 * The marker assistant row, the a4 sample's part order: two tool
 * invocations with their workspace metadata, sandbox exit and step start,
 * then the answer.
 *
 * @param {{ workspaceBase: string, extra?: string }} opts
 */
function markerAssistant({ workspaceBase, extra }) {
  return assistantContent([
    toolInvocationPart({ toolCallId: 'call-1', command: 'echo one', result: 'one' }),
    workspaceMetadataPart('call-1', workspaceBase),
    sandboxExitPart('call-1'),
    stepStartPart('openai/gpt-step'),
    toolInvocationPart({ toolCallId: 'call-2', command: 'echo two', result: 'two' }),
    textPart('listing the files'),
    ...(extra ? [textPart(extra, 1793919140990)] : []),
  ], { modelId: 'openai/gpt-message', provider: 'openai' })
}

/**
 * @param {SqliteDatabase} db
 * @param {() => string} clock
 * @param {{ id: string, projectPath: string, needle: string, title: string, workspaceBase: string }} thread
 */
function writeMarkerThread(db, clock, { id, projectPath, needle, title, workspaceBase }) {
  db.exec('BEGIN')
  writeThreadRow(db, clock, { id, projectPath, title })
  insertMessage(db, { id: `${id}-u`, thread_id: id, role: 'signal', type: 'user', content: userContent(`${id}-sig`, needle) })
  insertMessage(db, { id: `${id}-a`, thread_id: id, role: 'assistant', type: 'v2', content: markerAssistant({ workspaceBase }) })
  db.exec('COMMIT')
}

/** @param {any} kernel */
async function mastracodeStatus(kernel) {
  return kernel.sources.status('mastracode')
}

/** @param {string} text */
function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * @param {string} sql
 * @param {{ kernel: any, registry: any }} lifetime
 * @returns {Promise<any[]>}
 */
async function queryJson(sql, lifetime) {
  const result = await dispatchText(['query', 'sql', sql, '--refresh', 'always', '--include-local-only', '--format', 'json'], lifetime)
  if (result.code !== 0 || result.stderr !== '') throw new Error(`mastracode_capture: query failed: ${result.stderr || result.stdout}`)
  return JSON.parse(result.stdout)
}

/**
 * Poll a condition until it holds or the deadline passes.
 *
 * @param {() => Promise<boolean>} check
 * @param {number} timeoutMs
 */
async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`mastracode_capture: condition not met within ${timeoutMs}ms`)
}
