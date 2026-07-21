// @ts-check

import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { Attr, installObservability, runRoot } from '../../../src/core/observability/index.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { registerCoreCommands } from '../../../src/core/cli/core_commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { loadManifests } from '../../../src/core/manifest.js'
import { resolveDependencies } from '../../../src/core/dep_graph.js'

/**
 * @import { JsonObject } from '../../../hypaware-plugin-kernel-types.js'
 */

/**
 * T6 (LLP 0123): `@hypaware/hermes` backfill → query → idempotent rerun.
 *
 * @ref LLP 0123#tasks [tests]: implements plan task T6, the end-to-end
 * backfill/query/idempotency/telemetry hermetic smoke
 * @ref LLP 0118#requirements [tests]: spec R2, deterministic ids hold rows
 * steady on rerun
 * @ref LLP 0118#requirements [tests]: spec R3, usage-policy-dropped session
 * never reaches ai_gateway_messages
 *
 * Boots `@hypaware/ai-gateway` + `@hypaware/hermes` against a tmp HYP_HOME
 * with a fixture `state.db` generated (via `node:sqlite`) under the fake
 * HOME's `.hermes/state.db`, the same fixture shape T1's reader test and
 * T3's backfill test build (LLP 0122 #sqlite, #projection). The hermes
 * poll source is disabled for the plugin's activation config
 * (`[hermes] enabled = false`) so only `hyp backfill hermes` writes rows:
 * the live poll source is T4's concern (`hermes-source.test.js`), not this
 * end-to-end loop.
 *
 * Asserts the LLP 0123 T6 contract end to end:
 *
 *  - **User-visible query result**: `ai_gateway_messages` holds the
 *    included session's rows with `client_name = 'hermes'`,
 *    `conversation_source = 'hermes'`, `provider = 'openai'`.
 *  - **Usage policy (spec R3)**: a second session whose `cwd` carries a
 *    real `.hypignore` (`ignore`) is dropped at the capture seam and never
 *    appears in `ai_gateway_messages`.
 *  - **Idempotency (spec R2)**: a second `hyp backfill hermes` (a fresh
 *    run id, so the materializer re-scans committed partitions) writes
 *    ZERO new rows and the query still returns the same row count -
 *    hermes's deterministic `message_id`/`part_id` minting (session id +
 *    message id + part index) held.
 *  - **Internal telemetry**: the shared backfill CLI's
 *    `backfill.provider_finish` / `backfill.write` spans (`provider:
 *    'hermes'`) carry the rows-written count, exactly the sibling
 *    claude/codex shape (`backfill_claude_fixture.js`,
 *    `backfill_codex_fixture.js`); the hermes-specific
 *    `hermes.backfill.scan_complete` log (`component: 'plugin.hermes.backfill'`)
 *    carries `messages_projected`, and the usage-policy drop is logged as
 *    `plugin.hermes.usage_policy_drop` with a genuine `component: 'hermes'`
 *    tag naming the dropped session - the internal proof the intended
 *    per-provider path (not just the generic runner) actually ran.
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'hermes_backfill_roundtrip: tracer provider not installed - expected HYP_DEV_TELEMETRY=1'
    )
  }

  const cacheRoot = path.join(harness.stateDir, 'cache')
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot })

  const pluginsRoot = path.resolve(import.meta.dirname, '..', '..', 'plugins-workspace')
  const pluginDirs = [
    path.join(pluginsRoot, 'ai-gateway'),
    path.join(pluginsRoot, 'hermes'),
  ]

  // The hermes provider resolves `state_db` from `ctx.env.HOME` at
  // activation (default `<HOME>/.hermes/state.db`, LLP 0122#config), so
  // stage the fixture and point HOME at it BEFORE activating plugins.
  const fakeHome = path.join(harness.tmpDir, 'home')
  const normalCwd = path.join(fakeHome, 'work', 'included-project')
  const ignoredCwd = path.join(fakeHome, 'work', 'ignored-project')
  await fs.mkdir(normalCwd, { recursive: true })
  await fs.mkdir(ignoredCwd, { recursive: true })
  // A real `.hypignore` on disk: the default usage-policy resolver
  // (LLP 0050) reads the filesystem, so this session must be dropped at
  // the capture seam by the SAME mechanism a real `hyp backfill hermes`
  // run relies on, not a test-injected resolver.
  await fs.writeFile(path.join(ignoredCwd, '.hypignore'), 'ignore\n', 'utf8')

  const stateDbPath = path.join(fakeHome, '.hermes', 'state.db')
  await fs.mkdir(path.dirname(stateDbPath), { recursive: true })
  await buildFixtureStateDb(stateDbPath, { normalCwd, ignoredCwd })

  const previousHome = process.env.HOME
  process.env.HOME = fakeHome

  try {
    await runRoot(
      'kernel.boot',
      {
        [Attr.COMPONENT]: 'kernel',
        [Attr.OPERATION]: 'boot',
        [Attr.SMOKE_NAME]: harness.smokeName,
        [Attr.SMOKE_STEP]: 'backfill_activate',
        [Attr.DEV_RUN_ID]: harness.devRunId,
        status: 'ok',
      },
      async () => {
        const { loaded } = await loadManifests(pluginDirs)
        if (loaded.length !== pluginDirs.length) {
          throw new Error(`hermes_backfill_roundtrip: expected ${pluginDirs.length} manifests, got ${loaded.length}`)
        }
        const resolution = await resolveDependencies(loaded.map((l) => l.manifest))
        if (resolution.unsatisfied.length > 0) {
          throw new Error(
            `hermes_backfill_roundtrip: unsatisfied requirements: ${
              resolution.unsatisfied.map((u) => `${u.plugin}:${u.errorKind}`).join(', ')
            }`
          )
        }
        const byName = new Map(loaded.map((l) => [l.manifest.name, l]))
        const entries = resolution.order
          .map((name) => byName.get(name))
          .filter((l) => l !== undefined)
          .map((l) => ({
            manifest: l.manifest,
            rootDir: l.rootDir,
            // `enabled: false` keeps the live poll source from starting
            // (and writing rows) during activation, so `hyp backfill
            // hermes` below is the sole writer this smoke observes -
            // the poll source's own path is T4's smoke concern.
            config: activationConfigFor(l.manifest.name),
          }))
        return activatePlugins({
          plugins: entries,
          stateRoot: harness.stateDir,
          runId: harness.devRunId,
          runtime: kernel,
          tmpRoot: path.join(harness.tmpDir, 'plugin-temp'),
        })
      }
    )

    const env = { ...process.env, HYP_HOME: harness.hypHome }
    // An explicit open-ended `--since` keeps the import window deterministic
    // regardless of when the smoke runs, mirroring the claude/codex
    // backfill smokes.
    const since = '2000-01-01T00:00:00.000Z'

    // ----- 1. First backfill run -----
    const bf1out = makeBuf()
    const bf1err = makeBuf()
    const bf1code = await dispatch(
      ['backfill', 'hermes', '--since', since, '--json'],
      { stdout: bf1out, stderr: bf1err, kernel, registry, env }
    )
    expect.that('dispatch: backfill hermes (run 1) exited 0', bf1code, (v) => v === 0)
    expect.that('stderr: backfill run 1 had no errors', bf1err.text(), (v) => typeof v === 'string' && v.length === 0)

    const run1 = JSON.parse(bf1out.text())
    const hermes1 = run1.providers.find((/** @type {any} */ p) => p.provider === 'hermes')
    expect.that(
      'backfill run 1: hermes provider ok and wrote the included session rows',
      hermes1,
      (v) => v !== undefined && v.status === 'ok' && v.rows_written >= 2,
    )
    expect.that(
      'backfill run 1: the included session was materialized (the CLI-level sessions_seen counts yielded, materialized items - the usage-policy-dropped session is never yielded, see hermes.backfill.scan_complete below for the store-wide count)',
      hermes1,
      (v) => v !== undefined && v.sessions_seen >= 1,
    )

    // ----- 2. Query the projected rows -----
    const includedSql = `
      select role, content_text, provider, conversation_source, client_name
      from ai_gateway_messages
      where session_id = 'hermes-1'
      order by message_index, part_index
    `.trim().replace(/\s+/g, ' ')

    const rows1 = await queryRows({ dispatch, sql: includedSql, kernel, registry, env, expect, label: 'included session, after run 1' })
    expect.that('query: two rows for the included session', rows1, (v) => Array.isArray(v) && v.length === 2)

    const user = rows1.find((/** @type {any} */ r) => r.role === 'user')
    const assistant = rows1.find((/** @type {any} */ r) => r.role === 'assistant')
    expect.that(
      'query: user row carries the fixture content',
      user,
      (v) => v !== undefined && v.content_text === 'list the files here',
    )
    expect.that(
      'query: assistant row carries the fixture content',
      assistant,
      (v) => v !== undefined && v.content_text === 'a.txt and b.txt',
    )
    expect.that(
      'query: every row tagged provider=openai, source=client_name=hermes',
      rows1,
      (v) => Array.isArray(v) && v.every((r) => r.provider === 'openai' && r.conversation_source === 'hermes' && r.client_name === 'hermes'),
    )

    // ----- 3. Ignored-cwd session is absent -----
    const ignoredSql = `
      select count(*) as row_count from ai_gateway_messages where session_id = 'hermes-2'
    `.trim().replace(/\s+/g, ' ')
    const ignoredRows = await queryRows({ dispatch, sql: ignoredSql, kernel, registry, env, expect, label: 'ignored-cwd session, after run 1' })
    expect.that(
      'query: the .hypignore-governed session landed zero rows',
      ignoredRows,
      (v) => Array.isArray(v) && v.length === 1 && Number(v[0].row_count) === 0,
    )

    // ----- 4. Idempotent rerun: a fresh run id forces a committed-partition
    //          re-scan, so every re-materialized row is recognized and skipped.
    const bf2out = makeBuf()
    const bf2err = makeBuf()
    const bf2code = await dispatch(
      ['backfill', 'hermes', '--since', since, '--json'],
      { stdout: bf2out, stderr: bf2err, kernel, registry, env: { ...env, DEV_RUN_ID: `${harness.devRunId}-rerun` } }
    )
    expect.that('dispatch: backfill hermes (run 2) exited 0', bf2code, (v) => v === 0)
    const run2 = JSON.parse(bf2out.text())
    const hermes2 = run2.providers.find((/** @type {any} */ p) => p.provider === 'hermes')
    expect.that(
      'backfill run 2: rerun wrote ZERO new rows (deterministic message_id/part_id already present)',
      hermes2,
      (v) => v !== undefined && v.status === 'ok' && v.rows_written === 0,
    )

    const rows2 = await queryRows({ dispatch, sql: includedSql, kernel, registry, env, expect, label: 'included session, after run 2' })
    expect.that('query: rerun did not duplicate rows (still exactly two)', rows2, (v) => Array.isArray(v) && v.length === 2)

    const ignoredRows2 = await queryRows({ dispatch, sql: ignoredSql, kernel, registry, env, expect, label: 'ignored-cwd session, after run 2' })
    expect.that(
      'query: the ignored session is still absent after the rerun',
      ignoredRows2,
      (v) => Array.isArray(v) && v.length === 1 && Number(v[0].row_count) === 0,
    )

    // ----- 5. Internal telemetry -----
    await obs.shutdown()
    const traces = await expect.traces()

    const providerFinish = traces.filter(
      (/** @type {any} */ t) =>
        t.name === 'backfill.provider_finish' &&
        t.attributes?.provider === 'hermes' &&
        t.attributes?.[Attr.DEV_RUN_ID] === harness.devRunId,
    )
    expect.that(
      'traces: backfill.provider_finish for hermes under the run dev_run_id with rows_written>=2',
      providerFinish[0]?.attributes,
      (v) => v !== undefined && v.status === 'ok' && Number(v.rows_written) >= 2,
    )

    const writeSpans = traces.filter(
      (/** @type {any} */ t) =>
        t.name === 'backfill.write' &&
        t.attributes?.[Attr.DATASET] === 'ai_gateway_messages' &&
        t.attributes?.provider === 'hermes' &&
        t.attributes?.[Attr.DEV_RUN_ID] === harness.devRunId,
    )
    expect.that(
      'traces: backfill.write span for ai_gateway_messages with row_count>=2',
      writeSpans[0]?.attributes,
      (v) => v !== undefined && Number(v.row_count) >= 2,
    )

    const logs = await expect.logs()

    const finishLogs = logs.filter(
      (/** @type {any} */ l) => l.body === 'backfill.finish' && l.attributes?.[Attr.DEV_RUN_ID] === harness.devRunId,
    )
    expect.that(
      'logs: backfill.finish carries the run dev_run_id and total_rows_written>=2',
      finishLogs[0]?.attributes,
      (v) => v !== undefined && Number(v.total_rows_written) >= 2,
    )

    // Hermes-specific proof the adapter's own scan path ran (not just the
    // generic provider-agnostic runner): scan_complete carries the
    // rows-appended-equivalent count (`messages_projected`), and the
    // usage-policy drop is tagged with a genuine `component: 'hermes'`
    // naming the dropped session (LLP 0122#usage-policy, spec R3).
    const scanComplete = logs.filter((/** @type {any} */ l) => l.body === 'hermes.backfill.scan_complete')
    expect.that(
      'logs: hermes.backfill.scan_complete reports one session imported, one skipped, with messages_projected>=2',
      scanComplete[0]?.attributes,
      (v) =>
        v !== undefined &&
        v.status === 'ok' &&
        Number(v.sessions_seen) >= 2 &&
        Number(v.sessions_skipped) >= 1 &&
        Number(v.sessions_projected) >= 1 &&
        Number(v.messages_projected) >= 2,
    )

    const usagePolicyDrop = logs.filter(
      (/** @type {any} */ l) => l.body === 'plugin.hermes.usage_policy_drop' && l.attributes?.component === 'hermes',
    )
    expect.that(
      'logs: plugin.hermes.usage_policy_drop tagged component=hermes names the dropped session',
      usagePolicyDrop[0]?.attributes,
      (v) => v !== undefined && String(v.session_id) === '2' && v.declared === 'ignore',
    )
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
  }
}

/**
 * Per-plugin activation config: hermes gets `enabled: false` (source
 * disabled, see the activation comment above), every other plugin gets an
 * empty config.
 *
 * @param {string} pluginName
 * @returns {JsonObject}
 */
function activationConfigFor(pluginName) {
  if (pluginName === '@hypaware/hermes') return { enabled: false }
  return {}
}

/**
 * Build a fixture hermes `state.db`: the same schema T1's reader test and
 * T3's backfill test generate via `node:sqlite` (LLP 0122#sqlite), with two
 * sessions - one under a plain cwd (imports), one under a `.hypignore`'d
 * cwd (dropped, spec R3).
 *
 * @param {string} dbPath
 * @param {{ normalCwd: string, ignoredCwd: string }} cwds
 * @returns {Promise<void>}
 */
async function buildFixtureStateDb(dbPath, { normalCwd, ignoredCwd }) {
  const require = createRequire(import.meta.url)
  const { DatabaseSync } = require('node:sqlite')

  const SESSION_COLUMNS = [
    'id', 'source', 'model', 'cwd', 'parent_session_id', 'started_at', 'ended_at',
    'end_reason', 'billing_provider', 'billing_base_url', 'system_prompt',
    'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens',
    'reasoning_tokens', 'estimated_cost_usd', 'actual_cost_usd', 'api_call_count',
  ]
  const MESSAGE_COLUMNS = [
    'id', 'session_id', 'role', 'content', 'tool_calls', 'tool_name',
    'tool_call_id', 'reasoning', 'timestamp', 'token_count', 'finish_reason',
  ]

  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      model TEXT,
      cwd TEXT,
      parent_session_id INTEGER,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      end_reason TEXT,
      billing_provider TEXT,
      billing_base_url TEXT,
      system_prompt TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      reasoning_tokens INTEGER,
      estimated_cost_usd REAL,
      actual_cost_usd REAL,
      api_call_count INTEGER
    )
  `)
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY,
      session_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_calls TEXT,
      tool_name TEXT,
      tool_call_id TEXT,
      reasoning TEXT,
      timestamp TEXT NOT NULL,
      token_count INTEGER,
      finish_reason TEXT
    )
  `)

  const insertSession = db.prepare(
    `INSERT INTO sessions (${SESSION_COLUMNS.join(', ')}) VALUES (${SESSION_COLUMNS.map(() => '?').join(', ')})`
  )
  const insertMessage = db.prepare(
    `INSERT INTO messages (${MESSAGE_COLUMNS.join(', ')}) VALUES (${MESSAGE_COLUMNS.map(() => '?').join(', ')})`
  )

  // Session 1 (hermes-1): plain interactive cwd, imports normally.
  insertSession.run(
    1, 'cli', 'gpt-4o', normalCwd, null, '2026-07-20T10:00:00Z', null,
    null, 'openai', 'https://api.openai.com/v1', null,
    null, null, null, null, null, null, null, null
  )
  insertMessage.run(1, 1, 'user', 'list the files here', null, null, null, null, '2026-07-20T10:00:01Z', null, null)
  insertMessage.run(2, 1, 'assistant', 'a.txt and b.txt', null, null, null, null, '2026-07-20T10:00:02Z', 42, 'stop')

  // Session 2 (hermes-2): cwd carries a real .hypignore("ignore"), dropped
  // at the capture seam (spec R3, LLP 0050) - never reaches ai_gateway_messages.
  insertSession.run(
    2, 'cli', 'gpt-4o', ignoredCwd, null, '2026-07-20T09:00:00Z', null,
    null, 'openai', 'https://api.openai.com/v1', null,
    null, null, null, null, null, null, null, null
  )
  insertMessage.run(3, 2, 'user', 'a private question', null, null, null, null, '2026-07-20T09:00:01Z', null, null)

  db.close()
}

/**
 * Run a `query sql ... --format json` dispatch and return the parsed
 * rows, asserting a clean exit and parseable output.
 *
 * @param {{ dispatch: any, sql: string, kernel: any, registry: any, env: any, expect: any, label: string }} args
 * @returns {Promise<any[]>}
 */
async function queryRows(args) {
  const { dispatch, sql, kernel, registry, env, expect, label } = args
  const out = makeBuf()
  const err = makeBuf()
  const code = await dispatch(
    ['query', 'sql', sql, '--refresh', 'always', '--format', 'json'],
    { stdout: out, stderr: err, kernel, registry, env }
  )
  expect.that(`dispatch: query (${label}) exited 0`, code, (v) => v === 0)
  expect.that(`stderr: query (${label}) had no errors`, err.text(), (v) => typeof v === 'string' && v.length === 0)
  try {
    return JSON.parse(out.text())
  } catch (e) {
    expect.that(
      `stdout: query (${label}) was valid JSON (${e instanceof Error ? e.message : String(e)})`,
      false,
      (v) => v === true,
    )
    return []
  }
}

function makeBuf() {
  /** @type {string[]} */
  const chunks = []
  return {
    /** @param {unknown} chunk */
    write(chunk) {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk))
      return true
    },
    text() {
      return chunks.join('')
    },
  }
}
