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
import { createCrushDb, insertMessage, insertSession, openWriter } from '../lib/crush_fixture.js'

/**
 * Hermetic end-to-end proof of `@hypaware/crush`: the poll source and
 * `hyp backfill crush` read fixture per-project `crush.db` files named by a
 * fixture `projects.json` under a fake HOME, and land Crush sessions as
 * `ai_gateway_messages` rows that query, grep, settle an in-place update,
 * rerun idempotently, honor `.hypignore`, and project into the session graph.
 *
 * @ref LLP 0574#tasks [tests]: plan task T7, the crush_capture hermetic smoke
 * @ref LLP 0573#reconciliation [tests]: a streamed message finished in place settles to its final rows, no duplicates
 * @ref LLP 0573#privacy [tests]: title sessions and a `.hypignore`d project never land, a local-only project's rows are withheld from export
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error('crush_capture: tracer provider not installed - expected HYP_DEV_TELEMETRY=1')
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

  // The crush plugin resolves `projects.json` from `ctx.env` at activation
  // (LLP 0573#config), so stage the fixture under a fake HOME and clear the
  // two variables that would outrank it.
  const fakeHome = path.join(harness.tmpDir, 'home')
  const work = path.join(fakeHome, 'work')
  await fs.mkdir(work, { recursive: true })
  const project = await makeProject(work, 'included-project')
  const ignored = await makeProject(work, 'ignored-project')
  const localOnly = await makeProject(work, 'local-only-project')
  await fs.writeFile(path.join(ignored, '.hypignore'), 'ignore\n', 'utf8')
  await fs.writeFile(path.join(localOnly, '.hypignore'), 'local-only\n', 'utf8')
  // Every database exists before the source starts, so the baseline tick
  // records each one's cursor and the later writes read as new.
  const projectDb = await createCrushDb(project)
  const ignoredDb = await createCrushDb(ignored)
  const localOnlyDb = await createCrushDb(localOnly)
  const indexPath = path.join(fakeHome, '.local', 'share', 'crush', 'projects.json')
  await fs.mkdir(path.dirname(indexPath), { recursive: true })
  await fs.writeFile(indexPath, JSON.stringify({
    projects: [project, ignored, localOnly].map((dir) => ({ path: dir, data_dir: path.join(dir, '.crush') })),
  }), 'utf8')

  const needle = `crushsmoke-${harness.devRunId}`
  const title = `crush title ${harness.devRunId}`
  // The directory Crush appends to tool output; D5 strips it.
  const toolCwd = `/opt/crushsmoke-cwd-${harness.devRunId}`

  const saved = { HOME: process.env.HOME, CRUSH_GLOBAL_DATA: process.env.CRUSH_GLOBAL_DATA, XDG_DATA_HOME: process.env.XDG_DATA_HOME }
  process.env.HOME = fakeHome
  delete process.env.CRUSH_GLOBAL_DATA
  delete process.env.XDG_DATA_HOME
  const writers = [openWriter(projectDb), openWriter(ignoredDb), openWriter(localOnlyDb)]
  const [db, ignoredWriter, localOnlyWriter] = writers
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
        path.join(workspace, 'crush'),
      ])
      const byName = new Map(loaded.map((entry) => [entry.manifest.name, entry]))
      const order = ['@hypaware/ai-gateway', '@hypaware/context-graph', '@hypaware/ai-gateway-graph', '@hypaware/grep', '@hypaware/crush']
      const { results } = await activatePlugins({
        plugins: order.map((name) => {
          const entry = byName.get(name)
          if (!entry) throw new Error(`crush_capture: missing manifest ${name}`)
          return {
            manifest: entry.manifest,
            rootDir: entry.rootDir,
            config: /** @type {Record<string, number>} */ (name === '@hypaware/crush' ? { poll_interval: 200 } : {}),
          }
        }),
        stateRoot: harness.stateDir,
        runId: harness.devRunId,
        runtime: kernel,
        tmpRoot,
      })
      expect.that('activate: all five plugins ok', results, (value) => value.length === 5 && value.every((r) => r.ok))
      sourceCtx = kernel.activationContexts.get('@hypaware/crush')
    })

    await counted('poll_baseline', async () => {
      // The daemon is the source's sole starter in production; the smoke
      // stands in for it. The first tick records each database's cursor.
      await kernel.sources.start('crush', sourceCtx)
      sourceRunning = true
      await waitFor(async () => (await crushStatus(kernel))?.details?.last_poll_at !== undefined, 15_000)
    })

    await counted('poll_capture', async () => {
      writeMarkerSession(db, { id: 'S1', needle, title, toolCwd })
      writeChildSession(db, { id: 'C1', parentId: 'S1' })
      writeUserSession(db, { id: 'title-S1', text: `title prompt ${needle}` })
      writeUserSession(ignoredWriter, { id: 'S3', text: `ignored ${needle}` })
      writeUserSession(localOnlyWriter, { id: 'L1', text: `local only ${needle}` })
      await waitFor(async () => (
        await sqlCount("select count(*) as n from ai_gateway_messages where session_id = 'crush-S1' and part_type = 'tool_result'", lifetime) >= 1 &&
        await sqlCount("select count(*) as n from ai_gateway_messages where session_id = 'crush-C1'", lifetime) >= 1 &&
        await sqlCount("select count(*) as n from ai_gateway_messages where session_id = 'crush-L1'", lifetime) >= 1
      ), 15_000)
    })

    const markerSql = [
      'select role, part_type, content_text, tool_name, tool_call_id, attributes, client_name, conversation_source, entrypoint, provider, model, message_id, cwd',
      "from ai_gateway_messages where session_id = 'crush-S1' order by message_index, part_index",
    ].join(' ')

    await counted('marker_turn', async () => {
      const rows = await queryJson(markerSql, lifetime)
      expect.that('marker: user text carries the needle', rows, (value) => value.some((r) => r.role === 'user' && r.part_type === 'text' && r.content_text === needle))
      expect.that('marker: assistant text present', rows, (value) => value.some((r) => r.role === 'assistant' && r.part_type === 'text' && r.content_text === 'listing the files'))
      expect.that('marker: tool call bash/call-1', rows, (value) => value.some((r) => r.part_type === 'tool_call' && r.tool_name === 'bash' && r.tool_call_id === 'call-1'))
      expect.that('marker: tool result preserves hook context', rows, (value) => value.some((r) => r.part_type === 'tool_result' && r.tool_call_id === 'call-1' && r.content_text === 'a.txt\npost-hook context'))
      expect.that('marker: no usage on any row', rows, (value) => value.every((r) => usageOf(r.attributes) === undefined))
      expect.that('marker: root session cost rides an assistant part', rows, (value) => value.some((r) => r.role === 'assistant' && crushAttrs(r.attributes)?.session_cost_usd === 0.25))
      expect.that('marker: rows tagged crush/fixture-provider/fixture-model', rows, (value) => value.every((r) => r.client_name === 'crush' && r.conversation_source === 'crush' && r.entrypoint === 'crush') && value.some((r) => r.provider === 'fixture-provider' && r.model === 'fixture-model'))
      expect.that('marker: cwd is the project directory', rows, (value) => value.length > 0 && value.every((r) => r.cwd === project))
      const all = await queryJson("select * from ai_gateway_messages where client_name = 'crush'", lifetime)
      expect.that('privacy: no <cwd> element or tool working directory in any row', JSON.stringify(all), (text) => !text.includes('<cwd>') && !text.includes(toolCwd))
      const child = await queryJson("select entrypoint, parent_thread_id from ai_gateway_messages where session_id = 'crush-C1'", lifetime)
      expect.that('task: child session links to its parent', child, (value) => value.length > 0 && value.every((r) => r.entrypoint === 'crush-task' && r.parent_thread_id === 'crush-S1'))
      const titleRows = await sqlCount("select count(*) as n from ai_gateway_messages where session_id = 'crush-title-S1'", lifetime)
      expect.that('privacy: title session absent', titleRows, (n) => n === 0)
      const ignoredRows = await sqlCount("select count(*) as n from ai_gateway_messages where session_id = 'crush-S3'", lifetime)
      expect.that('privacy: .hypignored project absent', ignoredRows, (n) => n === 0)
    })

    await counted('grep', async () => {
      const result = await dispatchText(['query', 'grep', needle, '--include-local-only', '--format', 'json'], lifetime)
      expect.that('grep: exited 0', { code: result.code, stderr: result.stderr }, (value) => value.code === 0)
      const rows = parseJson(result.stdout)
      expect.that('grep: finds the marker and local-only sessions only', rows, (value) => Array.isArray(value) && value.some((r) => r.session_id === 'crush-S1') && value.every((r) => r.session_id === 'crush-S1' || r.session_id === 'crush-L1'))
    })

    await counted('local_only_export', async () => {
      const storage = kernel.storage
      const table = storage.cacheTablePath('ai_gateway_messages')
      const local = await queryJson("select * from ai_gateway_messages where session_id = 'crush-L1'", lifetime)
      const included = await queryJson("select * from ai_gateway_messages where session_id = 'crush-S1'", lifetime)
      expect.that('export: every local-only project row withheld', storage.exportWithheld(table, local), (n) => n === local.length && n > 0)
      expect.that('export: no included project row withheld', storage.exportWithheld(table, included), (n) => n === 0)
      const result = await dispatchText(['query', 'sql', "select count(*) as n from ai_gateway_messages where session_id = 'crush-L1'", '--refresh', 'always', '--format', 'json'], lifetime)
      expect.that('query: the default query withholds the local-only rows', result, (value) => value.code === 0 && parseJson(value.stdout)?.[0]?.n === 0 && /local-only: withheld \d+ row\(s\)/.test(value.stderr))
    })

    const streamSql = "select content_text, message_id from ai_gateway_messages where session_id = 'crush-S5' and part_type = 'text' and role = 'assistant'"

    await counted('in_place_update', async () => {
      // Crush streams an assistant message by updating its row in place:
      // `parts` grows and `finished_at` is set when the turn ends.
      const at = nowSeconds()
      insertSession(db, { id: 'S5', title: 'stream', created_at: at })
      insertMessage(db, { id: 'S5-m1', session_id: 'S5', role: 'user', parts: [{ type: 'text', data: { text: 'stream please' } }], created_at: at })
      insertMessage(db, { id: 'S5-m2', session_id: 'S5', role: 'assistant', parts: [{ type: 'text', data: { text: 'partial ans' } }], model: 'fixture-model', provider: 'fixture-provider', created_at: at, finished_at: null })
      await waitFor(async () => (await sqlCount("select count(*) as n from ai_gateway_messages where session_id = 'crush-S5' and role = 'user'", lifetime)) >= 1, 15_000)
      db.prepare('UPDATE messages SET parts = ?, finished_at = ? WHERE id = ?').run(
        JSON.stringify([{ type: 'text', data: { text: 'the final answer' } }, { type: 'finish', data: { reason: 'end_turn' } }]),
        nowSeconds(),
        'S5-m2',
      )
      const updatedAt = Date.now()
      // Two poll intervals after the update, so a tick that began before it
      // has finished and one that began after it has run.
      await waitFor(async () => {
        const status = await crushStatus(kernel)
        const polledAt = Date.parse(String(status?.details?.last_poll_at ?? ''))
        if (!(polledAt > updatedAt + 400 && status?.details?.sessions_pending === 0)) return false
        const rows = await queryJson(streamSql, lifetime)
        return rows.some((r) => r.content_text === 'the final answer')
      }, 15_000)
      const rows = await queryJson(streamSql, lifetime)
      expect.that('update: the final text replaced the partial text', rows, (value) => value.length === 1 && value[0].content_text === 'the final answer')
      const distinct = await sqlCount("select count(distinct message_id) as n from ai_gateway_messages where session_id = 'crush-S5'", lifetime)
      const total = await sqlCount("select count(*) as n from ai_gateway_messages where session_id = 'crush-S5'", lifetime)
      expect.that('update: no duplicate message ids', { distinct, total }, (v) => v.total > 0 && v.distinct === v.total)
    })

    await counted('backfill_recovery', async () => {
      await kernel.sources.stop('crush')
      sourceRunning = false
      writeUserSession(db, { id: 'S4', text: 'written while the daemon was down' })
      const first = await dispatchText(['backfill', 'crush', '--since', '2000-01-01T00:00:00.000Z', '--json'], lifetime)
      expect.that('backfill: exited 0', first.code, (code) => code === 0)
      const crush = parseJson(first.stdout)?.providers?.find((/** @type {any} */ p) => p.provider === 'crush')
      expect.that('backfill: crush ok, wrote the missed session', crush, (v) => v !== undefined && v.status === 'ok' && v.rows_written >= 1)
      const s4 = await sqlCount("select count(*) as n from ai_gateway_messages where session_id = 'crush-S4' and part_type = 'text'", lifetime)
      expect.that('backfill: missed session landed', s4, (n) => n === 1)
    })

    await counted('idempotent_rerun', async () => {
      const total = await sqlCount("select count(*) as n from ai_gateway_messages where client_name = 'crush'", lifetime)
      const previousRunId = process.env.DEV_RUN_ID
      process.env.DEV_RUN_ID = `${harness.devRunId}-rerun`
      let rerun
      try {
        rerun = await dispatchText(['backfill', 'crush', '--since', '2000-01-01T00:00:00.000Z', '--json'], lifetime)
      } finally {
        if (previousRunId === undefined) delete process.env.DEV_RUN_ID
        else process.env.DEV_RUN_ID = previousRunId
      }
      expect.that('rerun: exited 0', rerun.code, (code) => code === 0)
      const crush = parseJson(rerun.stdout)?.providers?.find((/** @type {any} */ p) => p.provider === 'crush')
      expect.that('rerun: wrote zero rows', crush, (v) => v !== undefined && v.status === 'ok' && v.rows_written === 0)
      const after = await sqlCount("select count(*) as n from ai_gateway_messages where client_name = 'crush'", lifetime)
      expect.that('rerun: row count unchanged', after, (n) => n === total)
      const privacy = await sqlCount("select count(*) as n from ai_gateway_messages where session_id in ('crush-title-S1', 'crush-S3')", lifetime)
      expect.that('rerun: title and ignored sessions still absent', privacy, (n) => n === 0)
    })

    await counted('graph', async () => {
      const result = await dispatchText(['graph', 'project', '--source', 'ai_gateway_messages'], lifetime)
      expect.that('graph project: exited 0', result.code, (code) => code === 0)
      expect.that('graph project: no stderr', result.stderr, (text) => text === '')
      const sessions = await sqlCount("select count(*) as n from node where node_type = 'Session' and natural_key = 'crush-S1'", lifetime)
      expect.that('graph: the turn groups under the Crush session id', sessions, (n) => n === 1)
      const used = await sqlCount("select count(*) as n from edge e join node s on e.src_id = s.node_id join node t on e.dst_id = t.node_id where e.edge_type = 'used' and s.natural_key = 'crush-S1' and t.natural_key = 'bash'", lifetime)
      expect.that('graph: the session used the bash tool', used, (n) => n === 1)
    })

    await obs.shutdown()
    const logs = await expect.logs()
    const traces = await expect.traces()
    const polls = logs.filter((/** @type {any} */ l) => l.body === 'crush.poll' && l.attributes?.component === 'crush')
    expect.that('logs: crush.poll ok tick', polls, (value) => value.some((l) => l.attributes?.poll_status === 'ok'))
    expect.that('logs: crush.poll baseline tick', polls, (value) => value.some((l) => l.attributes?.poll_status === 'baseline'))
    // Through the real attribute contract: a healthy run logs no failed tick.
    expect.that('logs: no crush.poll tick reads as failed', polls, (value) => value.every((l) => l.attributes?.status === 'ok'))
    expect.that('traces: crush.poll spans', traces, (value) => value.some((t) => t.name === 'crush.poll'))
    // D7: content and paths never reach the adapter's own telemetry.
    const crushLogs = logs.filter((/** @type {any} */ l) => l.attributes?.component === 'crush' || String(l.body).includes('crush'))
    expect.that('logs: no crush log carries prompt text, a title or a project path', crushLogs, (value) => value.length > 0 && !value.some((l) => {
      const text = JSON.stringify(l)
      return text.includes(needle) || text.includes(title) || text.includes(work)
    }))
    const scans = logs.filter((/** @type {any} */ l) => l.body === 'crush.backfill.scan_complete' && l.attributes?.[Attr.DEV_RUN_ID] === harness.devRunId)
    expect.that('logs: the backfill skipped the ignored project without opening it', scans, (value) => value.length > 0 && value.every((l) => Number(l.attributes?.dbs_ignored) === 1))
    const finish = traces.filter((/** @type {any} */ t) => t.name === 'backfill.provider_finish' && t.attributes?.provider === 'crush' && t.attributes?.[Attr.DEV_RUN_ID] === harness.devRunId)
    expect.that('traces: backfill.provider_finish for crush under the run id', finish, (value) => value.some((t) => t.attributes?.status === 'ok' && Number(t.attributes?.rows_written) >= 1))
    const steps = traces.filter((/** @type {any} */ t) => String(t.name).startsWith('smoke.step.') && t.attributes?.[Attr.DEV_RUN_ID] === harness.devRunId && t.attributes?.[Attr.SMOKE_NAME] === harness.smokeName)
    expect.that('traces: every smoke step stamped with smoke_name, smoke_step, DEV_RUN_ID', steps, (value) => value.length === stepCount && value.every((t) => typeof t.attributes?.[Attr.SMOKE_STEP] === 'string'))
  } finally {
    if (sourceRunning) await kernel.sources.stop('crush').catch(() => {})
    for (const writer of writers) writer.close()
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await obs.shutdown().catch(() => {})
  }
}

/**
 * A project directory by its real path, the form the reader reports as `cwd`.
 *
 * @param {string} parent
 * @param {string} name
 */
async function makeProject(parent, name) {
  const dir = path.join(parent, name)
  await fs.mkdir(dir, { recursive: true })
  return fs.realpath(dir)
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

/**
 * @param {any} db
 * @param {{ id: string, text: string }} session
 */
function writeUserSession(db, { id, text }) {
  const at = nowSeconds()
  insertSession(db, { id, title: `session ${id}`, created_at: at })
  insertMessage(db, { id: `${id}-m1`, session_id: id, role: 'user', parts: [{ type: 'text', data: { text } }], created_at: at })
}

/**
 * The marker turn: user text, assistant text plus a tool call, the tool
 * result with Crush's `<cwd>` element followed by hook context, and a cost
 * on the session.
 *
 * @param {any} db
 * @param {{ id: string, needle: string, title: string, toolCwd: string }} session
 */
function writeMarkerSession(db, { id, needle, title, toolCwd }) {
  const at = nowSeconds()
  insertSession(db, { id, title, cost: 0.25, created_at: at })
  insertMessage(db, { id: `${id}-m1`, session_id: id, role: 'user', parts: [{ type: 'text', data: { text: needle } }], created_at: at })
  insertMessage(db, {
    id: `${id}-m2`,
    session_id: id,
    role: 'assistant',
    parts: [
      { type: 'text', data: { text: 'listing the files' } },
      { type: 'tool_call', data: { id: 'call-1', name: 'bash', input: JSON.stringify({ command: 'ls' }), finished: true } },
      { type: 'finish', data: { reason: 'tool_use' } },
    ],
    model: 'fixture-model',
    provider: 'fixture-provider',
    created_at: at,
  })
  insertMessage(db, {
    id: `${id}-m3`,
    session_id: id,
    role: 'tool',
    parts: [{ type: 'tool_result', data: { tool_call_id: 'call-1', name: 'bash', content: `a.txt\n\n<cwd>${toolCwd}</cwd>\npost-hook context`, metadata: JSON.stringify({ working_directory: toolCwd }) } }],
    created_at: at,
  })
}

/**
 * A task session Crush spawned from a parent's agent tool.
 *
 * @param {any} db
 * @param {{ id: string, parentId: string }} session
 */
function writeChildSession(db, { id, parentId }) {
  const at = nowSeconds()
  insertSession(db, { id, parent_session_id: parentId, title: 'task', created_at: at })
  insertMessage(db, { id: `${id}-m1`, session_id: id, role: 'user', parts: [{ type: 'text', data: { text: 'find the config' } }], created_at: at })
  insertMessage(db, { id: `${id}-m2`, session_id: id, role: 'assistant', parts: [{ type: 'text', data: { text: 'found it' } }], model: 'fixture-model', provider: 'fixture-provider', created_at: at })
}

/** @param {any} kernel */
async function crushStatus(kernel) {
  return kernel.sources.status('crush')
}

/** @param {unknown} attributes */
function parsedAttributes(attributes) {
  const parsed = typeof attributes === 'string' ? parseJson(attributes) : attributes
  return parsed && typeof parsed === 'object' ? /** @type {any} */ (parsed) : undefined
}

/** @param {unknown} attributes */
function usageOf(attributes) {
  return parsedAttributes(attributes)?.usage
}

/** @param {unknown} attributes */
function crushAttrs(attributes) {
  return parsedAttributes(attributes)?.crush
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
  if (result.code !== 0 || result.stderr !== '') throw new Error(`crush_capture: query failed: ${result.stderr || result.stdout}`)
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
  throw new Error(`crush_capture: condition not met within ${timeoutMs}ms`)
}
