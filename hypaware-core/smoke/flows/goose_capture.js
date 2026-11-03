// @ts-check

import { createRequire } from 'node:module'
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

/**
 * Hermetic end-to-end proof of `@hypaware/goose`: the poll source and
 * `hyp backfill goose` read a fixture `sessions.db` under a fake HOME and
 * land one Goose session as `ai_gateway_messages` rows that query, grep,
 * survive a rewrite, rerun idempotently, and project into the session graph.
 *
 * @ref LLP 0571#tasks [tests]: plan task T7, the goose_capture hermetic smoke
 * @ref LLP 0570#reconciliation [tests]: a rewritten session settles to the same rows, no duplicates
 * @ref LLP 0570#privacy [tests]: hidden sessions and a `.hypignore`d working_dir never land
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error('goose_capture: tracer provider not installed - expected HYP_DEV_TELEMETRY=1')
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

  // The goose plugin resolves its default `sessions.db` from `ctx.env.HOME`
  // at activation (LLP 0570#config), so stage the fixture and point HOME at
  // it before activating.
  const fakeHome = path.join(harness.tmpDir, 'home')
  const normalCwd = path.join(fakeHome, 'work', 'included-project')
  const ignoredCwd = path.join(fakeHome, 'work', 'ignored-project')
  await fs.mkdir(normalCwd, { recursive: true })
  await fs.mkdir(ignoredCwd, { recursive: true })
  await fs.writeFile(path.join(ignoredCwd, '.hypignore'), 'ignore\n', 'utf8')
  const dbPath = path.join(fakeHome, '.local', 'share', 'goose', 'sessions', 'sessions.db')
  await fs.mkdir(path.dirname(dbPath), { recursive: true })

  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
  const db = new DatabaseSync(dbPath)
  createSchema(db)
  const clock = fixtureClock()
  const needle = `goosesmoke-${harness.devRunId}`

  const previousHome = process.env.HOME
  process.env.HOME = fakeHome
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
        path.join(workspace, 'goose'),
      ])
      const byName = new Map(loaded.map((entry) => [entry.manifest.name, entry]))
      const order = ['@hypaware/ai-gateway', '@hypaware/context-graph', '@hypaware/ai-gateway-graph', '@hypaware/grep', '@hypaware/goose']
      const { results } = await activatePlugins({
        plugins: order.map((name) => {
          const entry = byName.get(name)
          if (!entry) throw new Error(`goose_capture: missing manifest ${name}`)
          return {
            manifest: entry.manifest,
            rootDir: entry.rootDir,
            config: /** @type {Record<string, number>} */ (name === '@hypaware/goose' ? { poll_interval: 200 } : {}),
          }
        }),
        stateRoot: harness.stateDir,
        runId: harness.devRunId,
        runtime: kernel,
        tmpRoot,
      })
      expect.that('activate: all five plugins ok', results, (value) => value.length === 5 && value.every((r) => r.ok))
      sourceCtx = kernel.activationContexts.get('@hypaware/goose')
    })

    await counted('poll_baseline', async () => {
      // The daemon is the source's sole starter in production; the smoke
      // stands in for it. The empty store baselines without rows.
      await kernel.sources.start('goose', sourceCtx)
      sourceRunning = true
      const status = await gooseStatus(kernel)
      expect.that('poll_baseline: source reports a running state', status, (value) => value !== undefined && typeof value.state === 'string')
    })

    await counted('poll_capture', async () => {
      writeMarkerSession(db, clock, { id: 'S1', cwd: normalCwd, needle })
      writeSession(db, clock, { id: 'S2', cwd: normalCwd, type: 'hidden', text: `hidden ${needle}` })
      writeSession(db, clock, { id: 'S3', cwd: ignoredCwd, type: 'user', text: `ignored ${needle}` })
      await waitFor(async () => (await sqlCount("select count(*) as n from ai_gateway_messages where session_id = 'goose-S1'", lifetime)) >= 4, 15_000)
    })

    const markerSql = [
      'select role, part_type, content_text, tool_name, tool_call_id, attributes, client_name, conversation_source, provider, model, message_id',
      "from ai_gateway_messages where session_id = 'goose-S1' order by message_index, part_index",
    ].join(' ')

    await counted('marker_turn', async () => {
      const rows = await queryJson(markerSql, lifetime)
      expect.that('marker: user text carries the needle', rows, (value) => value.some((r) => r.role === 'user' && r.part_type === 'text' && r.content_text === needle))
      expect.that('marker: assistant text present', rows, (value) => value.some((r) => r.role === 'assistant' && r.part_type === 'text' && r.content_text === 'listing the files'))
      expect.that('marker: tool call shell/call-1', rows, (value) => value.some((r) => r.part_type === 'tool_call' && r.tool_name === 'shell' && r.tool_call_id === 'call-1'))
      expect.that('marker: tool result for call-1', rows, (value) => value.some((r) => r.part_type === 'tool_result' && r.tool_call_id === 'call-1'))
      expect.that('marker: usage on an assistant part', rows, (value) => value.some((r) => r.role === 'assistant' && usageOf(r.attributes)?.total_tokens === 18))
      expect.that('marker: rows tagged goose/openai/fixture-model', rows, (value) => value.every((r) => r.client_name === 'goose' && r.conversation_source === 'goose') && value.some((r) => r.provider === 'openai' && r.model === 'fixture-model'))
      const hidden = await sqlCount("select count(*) as n from ai_gateway_messages where session_id = 'goose-S2'", lifetime)
      expect.that('privacy: hidden session absent', hidden, (n) => n === 0)
      const ignored = await sqlCount("select count(*) as n from ai_gateway_messages where session_id = 'goose-S3'", lifetime)
      expect.that('privacy: .hypignored working_dir absent', ignored, (n) => n === 0)
    })

    await counted('grep', async () => {
      const result = await dispatchText(['query', 'grep', needle, '--format', 'json'], lifetime)
      expect.that('grep: exited 0', { code: result.code, stderr: result.stderr }, (value) => value.code === 0)
      const rows = parseJson(result.stdout)
      expect.that('grep: finds the marker session only', rows, (value) => Array.isArray(value) && value.length > 0 && value.every((r) => r.session_id === 'goose-S1'))
    })

    await counted('rewrite', async () => {
      const before = await queryJson(markerSql, lifetime)
      // Goose rewrites a session by deleting and reinserting its messages:
      // new row ids, the same message_ids.
      db.exec('BEGIN')
      db.prepare("DELETE FROM messages WHERE session_id = 'S1'").run()
      writeMarkerMessages(db, clock, { id: 'S1', needle })
      db.exec('COMMIT')
      const rewroteAt = Date.now()
      // Two poll intervals after the commit, so a tick that began before it
      // has finished and one that began after it has run.
      await waitFor(async () => {
        const status = await gooseStatus(kernel)
        const polledAt = Date.parse(String(status?.details?.last_poll_at ?? ''))
        return polledAt > rewroteAt + 400 && status?.details?.sessions_pending === 0
      }, 15_000)
      const after = await queryJson(markerSql, lifetime)
      const distinct = await sqlCount("select count(distinct message_id) as n from ai_gateway_messages where session_id = 'goose-S1'", lifetime)
      const total = await sqlCount("select count(*) as n from ai_gateway_messages where session_id = 'goose-S1'", lifetime)
      expect.that('rewrite: same row count as before', after.length, (n) => n === before.length)
      expect.that('rewrite: no duplicate message ids', { distinct, total }, (v) => v.distinct === new Set(before.map((r) => r.message_id)).size && v.total === before.length)
    })

    await counted('backfill_recovery', async () => {
      await kernel.sources.stop('goose')
      sourceRunning = false
      writeSession(db, clock, { id: 'S4', cwd: normalCwd, type: 'user', text: 'written while the daemon was down' })
      const first = await dispatchText(['backfill', 'goose', '--since', '2000-01-01T00:00:00.000Z', '--json'], lifetime)
      expect.that('backfill: exited 0', first.code, (code) => code === 0)
      const goose = parseJson(first.stdout)?.providers?.find((/** @type {any} */ p) => p.provider === 'goose')
      expect.that('backfill: goose ok and wrote the missed session', goose, (v) => v !== undefined && v.status === 'ok' && v.rows_written >= 1)
      // One text part, plus the session-title metadata row every session carries.
      const s4 = await sqlCount("select count(*) as n from ai_gateway_messages where session_id = 'goose-S4' and part_type = 'text'", lifetime)
      expect.that('backfill: missed session landed', s4, (n) => n === 1)
    })

    await counted('idempotent_rerun', async () => {
      const total = await sqlCount("select count(*) as n from ai_gateway_messages where client_name = 'goose'", lifetime)
      const previousRunId = process.env.DEV_RUN_ID
      process.env.DEV_RUN_ID = `${harness.devRunId}-rerun`
      let rerun
      try {
        rerun = await dispatchText(['backfill', 'goose', '--since', '2000-01-01T00:00:00.000Z', '--json'], lifetime)
      } finally {
        if (previousRunId === undefined) delete process.env.DEV_RUN_ID
        else process.env.DEV_RUN_ID = previousRunId
      }
      expect.that('rerun: exited 0', rerun.code, (code) => code === 0)
      const goose = parseJson(rerun.stdout)?.providers?.find((/** @type {any} */ p) => p.provider === 'goose')
      expect.that('rerun: wrote zero rows', goose, (v) => v !== undefined && v.status === 'ok' && v.rows_written === 0)
      const after = await sqlCount("select count(*) as n from ai_gateway_messages where client_name = 'goose'", lifetime)
      expect.that('rerun: row count unchanged', after, (n) => n === total)
      const privacy = await sqlCount("select count(*) as n from ai_gateway_messages where session_id in ('goose-S2', 'goose-S3')", lifetime)
      expect.that('rerun: hidden and ignored sessions still absent', privacy, (n) => n === 0)
    })

    await counted('graph', async () => {
      const result = await dispatchText(['graph', 'project', '--source', 'ai_gateway_messages'], lifetime)
      expect.that('graph project: exited 0', result.code, (code) => code === 0)
      expect.that('graph project: no stderr', result.stderr, (text) => text === '')
      const sessions = await sqlCount("select count(*) as n from node where node_type = 'Session' and natural_key = 'goose-S1'", lifetime)
      expect.that('graph: the turn groups under the Goose session id', sessions, (n) => n === 1)
      const used = await sqlCount("select count(*) as n from edge e join node s on e.src_id = s.node_id join node t on e.dst_id = t.node_id where e.edge_type = 'used' and s.natural_key = 'goose-S1' and t.natural_key = 'shell'", lifetime)
      expect.that('graph: the session used the shell tool', used, (n) => n === 1)
    })

    await obs.shutdown()
    const logs = await expect.logs()
    const traces = await expect.traces()
    const polls = logs.filter((/** @type {any} */ l) => l.body === 'goose.poll' && l.attributes?.component === 'goose')
    expect.that('logs: goose.poll ok with rows', polls, (value) => value.some((l) => l.attributes?.poll_status === 'ok' && Number(l.attributes?.rows) > 0))
    expect.that('logs: goose.poll baseline tick', polls, (value) => value.some((l) => l.attributes?.poll_status === 'baseline'))
    // Through the real attribute contract: a healthy run logs no failed tick.
    expect.that('logs: no goose.poll tick reads as failed', polls, (value) => value.every((l) => l.attributes?.status === 'ok'))
    expect.that('traces: goose.poll spans', traces, (value) => value.some((t) => t.name === 'goose.poll'))
    const drops = logs.filter((/** @type {any} */ l) => l.body === 'plugin.goose.usage_policy_drop')
    expect.that('logs: usage-policy drop names the ignored session', drops, (value) => value.some((l) => l.attributes?.session_id === 'S3' && l.attributes?.declared === 'ignore'))
    expect.that('logs: hidden session text never logged', logs, (value) => !value.some((l) => JSON.stringify(l).includes(`hidden ${needle}`)))
    const finish = traces.filter((/** @type {any} */ t) => t.name === 'backfill.provider_finish' && t.attributes?.provider === 'goose' && t.attributes?.[Attr.DEV_RUN_ID] === harness.devRunId)
    expect.that('traces: backfill.provider_finish for goose under the run id', finish, (value) => value.some((t) => t.attributes?.status === 'ok' && Number(t.attributes?.rows_written) >= 1))
    const steps = traces.filter((/** @type {any} */ t) => String(t.name).startsWith('smoke.step.') && t.attributes?.[Attr.DEV_RUN_ID] === harness.devRunId && t.attributes?.[Attr.SMOKE_NAME] === harness.smokeName)
    expect.that('traces: every smoke step stamped with smoke_name, smoke_step, DEV_RUN_ID', steps, (value) => value.length === stepCount && value.every((t) => typeof t.attributes?.[Attr.SMOKE_STEP] === 'string'))
  } finally {
    if (sourceRunning) await kernel.sources.stop('goose').catch(() => {})
    db.close()
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await obs.shutdown().catch(() => {})
  }
}

/**
 * The Goose `sessions` and `messages` tables, as the reader tests build them.
 *
 * @param {any} db
 */
function createSchema(db) {
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', session_type TEXT NOT NULL DEFAULT 'user', working_dir TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, provider_name TEXT, model_config_json TEXT, parent_session_id TEXT)`)
  db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT, session_id TEXT NOT NULL, role TEXT NOT NULL, content_json TEXT NOT NULL, created_timestamp INTEGER NOT NULL, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP, metadata_json TEXT)`)
}

/**
 * Strictly increasing fixture timestamps, so every write moves the
 * source's `updated_at` watermark.
 */
function fixtureClock() {
  let ms = Date.parse('2026-07-20T10:00:00Z')
  return () => {
    ms += 2000
    return { sql: new Date(ms).toISOString().slice(0, 19).replace('T', ' '), epoch: Math.floor(ms / 1000) }
  }
}

/**
 * @param {any} db
 * @param {() => { sql: string, epoch: number }} clock
 * @param {{ id: string, cwd: string, type: string }} session
 */
function insertSession(db, clock, { id, cwd, type }) {
  const at = clock().sql
  db.prepare(`INSERT INTO sessions (id, name, session_type, working_dir, created_at, updated_at, provider_name, model_config_json) VALUES (?, ?, ?, ?, ?, ?, 'openai', '{"model_name":"fixture-model"}')`)
    .run(id, `session ${id}`, type, cwd, at, at)
}

/**
 * @param {any} db
 * @param {() => { sql: string, epoch: number }} clock
 * @param {{ sessionId: string, messageId: string, role: string, content: unknown[], metadata?: unknown }} message
 */
function insertMessage(db, clock, { sessionId, messageId, role, content, metadata }) {
  const at = clock()
  db.prepare('INSERT INTO messages (message_id, session_id, role, content_json, created_timestamp, metadata_json) VALUES (?, ?, ?, ?, ?, ?)')
    .run(messageId, sessionId, role, JSON.stringify(content), at.epoch, metadata === undefined ? null : JSON.stringify(metadata))
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(at.sql, sessionId)
}

/**
 * @param {any} db
 * @param {() => { sql: string, epoch: number }} clock
 * @param {{ id: string, cwd: string, type: string, text: string }} session
 */
function writeSession(db, clock, { id, cwd, type, text }) {
  insertSession(db, clock, { id, cwd, type })
  insertMessage(db, clock, { sessionId: id, messageId: `${id}-m1`, role: 'user', content: [{ type: 'text', text }] })
}

/**
 * @param {any} db
 * @param {() => { sql: string, epoch: number }} clock
 * @param {{ id: string, cwd: string, needle: string }} session
 */
function writeMarkerSession(db, clock, { id, cwd, needle }) {
  insertSession(db, clock, { id, cwd, type: 'user' })
  writeMarkerMessages(db, clock, { id, needle })
}

/**
 * The marker turn: user text, assistant text plus a tool call with usage,
 * and the tool result.
 *
 * @param {any} db
 * @param {() => { sql: string, epoch: number }} clock
 * @param {{ id: string, needle: string }} session
 */
function writeMarkerMessages(db, clock, { id, needle }) {
  insertMessage(db, clock, { sessionId: id, messageId: `${id}-m1`, role: 'user', content: [{ type: 'text', text: needle }] })
  insertMessage(db, clock, {
    sessionId: id,
    messageId: `${id}-m2`,
    role: 'assistant',
    content: [
      { type: 'text', text: 'listing the files' },
      { type: 'toolRequest', id: 'call-1', toolCall: { status: 'success', value: { name: 'shell', arguments: { command: 'ls' } } } },
    ],
    metadata: { usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 }, inference: { provider: 'openai', requestedModel: 'fixture-model' } },
  })
  insertMessage(db, clock, {
    sessionId: id,
    messageId: `${id}-m3`,
    role: 'user',
    content: [{ type: 'toolResponse', id: 'call-1', toolResult: { status: 'success', value: { content: [{ type: 'text', text: 'a.txt' }] } } }],
  })
}

/** @param {any} kernel */
async function gooseStatus(kernel) {
  return kernel.sources.status('goose')
}

/** @param {unknown} attributes */
function usageOf(attributes) {
  const parsed = typeof attributes === 'string' ? parseJson(attributes) : attributes
  return parsed && typeof parsed === 'object' ? /** @type {any} */ (parsed).usage : undefined
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
  if (result.code !== 0 || result.stderr !== '') throw new Error(`goose_capture: query failed: ${result.stderr || result.stdout}`)
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
  throw new Error(`goose_capture: condition not met within ${timeoutMs}ms`)
}
