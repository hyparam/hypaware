// @ts-check

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
import { createBackfillSweepDriver } from '../../../src/core/daemon/backfill_sweep.js'
import { runBackfillProvider } from '../../../src/core/commands/backfill.js'
import { prepareAttach } from '../../plugins-workspace/codex/src/toml-config.js'

/**
 * Phase 7 smoke: Codex rollout backfill → query → idempotent rerun.
 *
 * Boots `@hypaware/ai-gateway` + `@hypaware/codex` against a tmp
 * HYP_HOME with a staged modern Codex rollout under the fake HOME's
 * `.codex/sessions`, then drives `hyp backfill codex` directly and
 * asserts the bead-6 contract end to end:
 *
 *  - **User-visible query result**: `ai_gateway_messages` holds the two
 *    projected rows (`provider = openai`, `conversation_source = codex`)
 *    with the exact rollout content.
 *  - **Internal telemetry**: a `backfill.provider_finish` span and a
 *    `backfill.finish` log carrying the run's `dev_run_id`, `provider`,
 *    and matching row counts, plus a `backfill.write` span for
 *    `ai_gateway_messages`.
 *  - **Idempotency (phase 8)**: a second `hyp backfill codex` (a fresh
 *    run id, so the materializer re-scans committed partitions) writes
 *    ZERO new rows and the query still returns exactly two rows.
 *
 * @param {{ harness: any, expect: any, largeRollout?: boolean }} args
 */
export async function run({ harness, expect, largeRollout = false }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'backfill_codex_fixture: tracer provider not installed - expected HYP_DEV_TELEMETRY=1'
    )
  }

  const cacheRoot = path.join(harness.stateDir, 'cache')
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot })

  const pluginsRoot = path.resolve(import.meta.dirname, '..', '..', 'plugins-workspace')
  const pluginDirs = [
    path.join(pluginsRoot, 'ai-gateway'),
    path.join(pluginsRoot, 'codex'),
  ]

  // The Codex provider captures its sessions root from `ctx.env.HOME`
  // (→ `<HOME>/.codex/sessions`) at activation, so stage the rollout and
  // point HOME at it BEFORE activating plugins. One modern rollout file
  // with a user message and an assistant message.
  const fakeHome = path.join(harness.tmpDir, 'home')
  const sessionsDir = path.join(fakeHome, '.codex', 'sessions', '2026', '05', '20')
  await fs.mkdir(sessionsDir, { recursive: true })
  const sessionId = `cx-${harness.devRunId}`
  await fs.writeFile(
    path.join(sessionsDir, `rollout-2026-05-20T10-00-00-${sessionId}.jsonl`),
    [
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-05-20T10:00:00.000Z',
        payload: {
          id: sessionId,
          timestamp: '2026-05-20T10:00:00.000Z',
          cwd: '/work/repo',
          originator: 'Codex Desktop',
          cli_version: '0.133.0',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-05-20T10:00:01.000Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list the files' }] },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-05-20T10:00:02.000Z',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'here they are' }] },
      }),
    ].join('\n') + '\n',
    'utf8'
  )

  if (largeRollout) {
    // @ref LLP 0583#verification [tests]: exceed V8's string limit without constructing the file in memory
    await runRoot('smoke.large_rollout_fixture', {
      [Attr.SMOKE_NAME]: harness.smokeName, [Attr.SMOKE_STEP]: 'large_rollout_fixture',
      [Attr.DEV_RUN_ID]: harness.devRunId, status: 'ok',
    }, async () => {
      const filePath = path.join(sessionsDir, `rollout-2026-05-20T10-00-00-${sessionId}.jsonl`)
      const original = await fs.readFile(filePath, 'utf8')
      const split = original.indexOf('\n') + 1
      const padding = Buffer.from(JSON.stringify({ type: 'event_msg', payload: { type: 'synthetic_padding', text: 'x'.repeat(28_800) } }) + '\n')
      const file = await fs.open(filePath, 'w')
      try {
        await file.writeFile(original.slice(0, split))
        for (let bytes = 0; bytes < 742 * 1024 * 1024;) {
          bytes += (await file.writev(Array(64).fill(padding))).bytesWritten
        }
        await file.writeFile(original.slice(split))
      } finally { await file.close() }
      expect.that('fixture exceeds the single-string limit', (await fs.stat(filePath)).size, v => v > 742 * 1024 * 1024)
    })
  }

  const previousHome = process.env.HOME
  const previousCodexHome = process.env.CODEX_HOME
  process.env.HOME = fakeHome
  process.env.CODEX_HOME = path.join(fakeHome, '.codex')

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
          throw new Error(`backfill_codex_fixture: expected ${pluginDirs.length} manifests, got ${loaded.length}`)
        }
        const resolution = await resolveDependencies(loaded.map((l) => l.manifest))
        if (resolution.unsatisfied.length > 0) {
          throw new Error(
            `backfill_codex_fixture: unsatisfied requirements: ${
              resolution.unsatisfied.map((u) => `${u.plugin}:${u.errorKind}`).join(', ')
            }`
          )
        }
        const byName = new Map(loaded.map((l) => [l.manifest.name, l]))
        const entries = resolution.order
          .map((name) => byName.get(name))
          .filter((l) => l !== undefined)
          .map((l) => ({ manifest: l.manifest, rootDir: l.rootDir, config: {} }))
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
    const since = '2000-01-01T00:00:00.000Z'

    // ----- 1. First backfill run -----
    const bf1out = makeBuf()
    const bf1err = makeBuf()
    const bf1code = await dispatch(
      ['backfill', 'codex', '--since', since, '--json'],
      { stdout: bf1out, stderr: bf1err, kernel, registry, env }
    )
    expect.that('dispatch: backfill codex (run 1) exited 0', bf1code, (v) => v === 0)
    expect.that('stderr: backfill run 1 had no errors', bf1err.text(), (v) => typeof v === 'string' && v.length === 0)

    const run1 = JSON.parse(bf1out.text())
    const codex1 = run1.providers.find((/** @type {any} */ p) => p.provider === 'codex')
    expect.that(
      'backfill run 1: codex provider ok and wrote both rows',
      codex1,
      (v) => v !== undefined && v.status === 'ok' && v.rows_written >= 2,
    )
    expect.that(
      'backfill run 1: at least one session scanned',
      codex1,
      (v) => v !== undefined && v.sessions_seen >= 1,
    )

    // ----- 2. Query the projected rows -----
    const sql = `
      select role, content_text, provider, conversation_source, client_name
      from ai_gateway_messages
      where session_id = '${sessionId}'
      order by message_index, part_index
    `.trim().replace(/\s+/g, ' ')

    const rows1 = await queryRows({ dispatch, sql, kernel, registry, env, expect, label: 'after run 1' })
    expect.that('query: two rows for the backfilled session', rows1, (v) => Array.isArray(v) && v.length === 2)

    const user = rows1.find((/** @type {any} */ r) => r.role === 'user')
    const assistant = rows1.find((/** @type {any} */ r) => r.role === 'assistant')
    expect.that(
      'query: user row carries the rollout content',
      user,
      (v) => v !== undefined && v.content_text === 'list the files',
    )
    expect.that(
      'query: assistant row carries the rollout content',
      assistant,
      (v) => v !== undefined && v.content_text === 'here they are',
    )
    expect.that(
      'query: every row tagged provider=openai, source=codex, client_name=codex',
      rows1,
      (v) => Array.isArray(v) && v.every((r) => r.provider === 'openai' && r.conversation_source === 'codex' && r.client_name === 'codex'),
    )

    // ----- 3. Idempotent rerun: fresh run id → committed-partition re-scan -----
    const bf2out = makeBuf()
    const bf2err = makeBuf()
    const bf2code = await dispatch(
      ['backfill', 'codex', '--since', since, '--json'],
      { stdout: bf2out, stderr: bf2err, kernel, registry, env: { ...env, DEV_RUN_ID: `${harness.devRunId}-rerun` } }
    )
    expect.that('dispatch: backfill codex (run 2) exited 0', bf2code, (v) => v === 0)
    const run2 = JSON.parse(bf2out.text())
    const codex2 = run2.providers.find((/** @type {any} */ p) => p.provider === 'codex')
    expect.that(
      'backfill run 2: rerun wrote ZERO new rows (all part_ids already present)',
      codex2,
      (v) => v !== undefined && v.status === 'ok' && v.rows_written === 0,
    )

    const rows2 = await queryRows({ dispatch, sql, kernel, registry, env, expect, label: 'after run 2' })
    expect.that('query: rerun did not duplicate rows (still exactly two)', rows2, (v) => Array.isArray(v) && v.length === 2)

    // Exercise default ongoing capture through the real daemon scheduler,
    // with no inference listener or client request in the loop.
    const configPath = path.join(fakeHome, '.codex', 'config.toml')
    await fs.writeFile(configPath, prepareAttach('model_provider = "custom"\n', 4388, 'old').content)
    for (const originator of ['codex-tui', 'Codex Desktop']) {
      const id = `${sessionId}-${originator}`
      const records = [
        { type: 'session_meta', payload: { id, originator, base_instructions: { text: 'native instructions' } } },
        { type: 'event_msg', payload: { type: 'task_started' } },
        { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'developer instructions' }] } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'scheduled answer' }] } },
        { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 2 } } } },
        { type: 'event_msg', payload: { type: 'task_complete' } },
      ]
      await fs.writeFile(path.join(sessionsDir, `rollout-${originator}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n')
    }
    // @ref LLP 0567#turn-items [tests]: a May thread resumed today in
    // paginated history records the new turn as completed TurnItems only.
    const resumedId = `${sessionId}-resumed`
    const resumedAt = (/** @type {number} */ offset) => new Date(Date.now() - 60_000 + offset).toISOString()
    /** @param {number} offset @param {Record<string, unknown>} item */
    const completed = (offset, item) => ({ type: 'event_msg', timestamp: resumedAt(offset), payload: { type: 'item_completed', thread_id: resumedId, turn_id: 'turn-resumed', item, completed_at_ms: Date.parse(resumedAt(offset)) } })
    const resumed = [
      { type: 'session_meta', timestamp: '2026-05-20T10:00:00.000Z', payload: { id: resumedId, timestamp: '2026-05-20T10:00:00.000Z', originator: 'Codex Desktop', history_mode: 'paginated' } },
      { type: 'event_msg', timestamp: resumedAt(0), payload: { type: 'task_started', turn_id: 'turn-resumed' } },
      completed(1, { type: 'UserMessage', id: 'resumed-user', content: [{ type: 'text', text: 'resumed prompt' }] }),
      completed(2, { type: 'AgentMessage', id: 'resumed-agent', content: [{ type: 'Text', text: 'resumed answer' }] }),
      { type: 'event_msg', timestamp: resumedAt(3), payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 2 } } } },
      { type: 'event_msg', timestamp: resumedAt(3), payload: { type: 'task_complete', turn_id: 'turn-resumed' } },
    ]
    await fs.writeFile(path.join(sessionsDir, `rollout-2026-05-20T10-00-00-${resumedId}-${sessionId}.jsonl`), resumed.map((r) => JSON.stringify(r)).join('\n') + '\n')
    /** @type {Array<Promise<any>>} */
    const pending = []
    const sweep = createBackfillSweepDriver({
      backfills: kernel.backfills, backfillMaterializers: kernel.backfillMaterializers,
      storage: kernel.storage, query: kernel.query, env,
      config: { version: 2, query: { cache: { retention: { default_days: 0 } } } },
      runBackfill: (args) => {
        const run = runBackfillProvider(args)
        pending.push(run)
        return run
      },
    })
    const now = new Date()
    await sweep.tick({ now })
    const firstSweep = await Promise.all(pending)
    expect.that('sweep: both client surfaces and the resumed thread imported', firstSweep[0], (v) => v?.ok && v.rowsWritten === 6)
    expect.that('sweep: previous provider restored', await fs.readFile(configPath, 'utf8'), (v) => v.startsWith('model_provider = "custom"\n') && v.includes('[model_providers.hypaware]') && !v.includes('127.0.0.1'))
    const nativeRows = await queryRows({
      dispatch, kernel, registry, env, expect, label: 'scheduled capture',
      sql: "select entrypoint, system_text, tools from ai_gateway_messages where content_text = 'scheduled answer'",
    })
    expect.that('sweep: CLI and Desktop attribution and base instructions', nativeRows, (v) =>
      v.length === 2 && new Set(v.map((r) => r.entrypoint)).size === 2 &&
      v.every((r) => r.system_text === 'native instructions' && r.tools == null))
    const resumedRows = await queryRows({
      dispatch, kernel, registry, env, expect, label: 'resumed paginated thread',
      sql: `select role, content_text, message_id, entrypoint from ai_gateway_messages where conversation_id = '${resumedId}' and part_type <> 'session_metadata' order by message_index, part_index`,
    })
    expect.that('sweep: resumed TurnItem turn captured once, with native ids', resumedRows, (v) =>
      v.length === 2 && v[0].role === 'user' && v[0].content_text === 'resumed prompt' && v[0].message_id === 'resumed-user' &&
      v[1].role === 'assistant' && v[1].content_text === 'resumed answer' && v[1].entrypoint === 'Codex Desktop')
    pending.length = 0
    await sweep.tick({ now: new Date(now.getTime() + 60_000) })
    const secondSweep = await Promise.all(pending)
    expect.that('sweep: unchanged inputs do no materialization', secondSweep[0], (v) => v?.ok && v.scanned === 0 && v.rowsWritten === 0)

    // @ref LLP 0556#updates [tests]: idle title changes must write just the
    // metadata revision after durable dedupe, never duplicate old content.
    for (const [index, title] of ['Generated name', 'Renamed chat', 'Generated name'].entries()) {
      await runRoot('smoke.title_update', {
        [Attr.SMOKE_NAME]: harness.smokeName, [Attr.SMOKE_STEP]: 'title_update',
        [Attr.DEV_RUN_ID]: harness.devRunId, status: 'ok',
      }, async () => {
        await fs.appendFile(path.join(fakeHome, '.codex', 'session_index.jsonl'), JSON.stringify({
          id: sessionId, thread_name: title, updated_at: new Date(now.getTime() + (index + 1) * 1000).toISOString(),
        }) + '\n')
        pending.length = 0
        await sweep.tick({ now: new Date(now.getTime() + (index + 2) * 60_000) })
        const [result] = await Promise.all(pending)
        expect.that('idle title update writes exactly one metadata part', result,
          v => v?.ok && v.rowsWritten === 1)
        const rows = await queryRows({ dispatch, kernel, registry, env, expect, label: 'native title',
          sql: `select max_by(JSON_EXTRACT(attributes, '$.session.title'), JSON_EXTRACT(attributes, '$.session.title_updated_at')) as title from ai_gateway_messages where session_id = '${sessionId}' and part_type = 'session_metadata'`,
        })
        expect.that('query returns the latest native title', rows[0]?.title, v => v === title)
      })
    }

    if (largeRollout) {
      await runRoot('smoke.batched_rollout', {
        [Attr.SMOKE_NAME]: harness.smokeName, [Attr.SMOKE_STEP]: 'batched_rollout',
        [Attr.DEV_RUN_ID]: harness.devRunId, status: 'ok',
      }, async () => {
        const id = `${sessionId}-batched`
        const file = await fs.open(path.join(sessionsDir, 'rollout-batched.jsonl'), 'w')
        const at = new Date().toISOString()
        try {
          await file.writeFile(JSON.stringify({ type: 'session_meta', payload: { id, timestamp: at } }) + '\n')
          for (let i = 0; i < 300; i++) {
            await file.writeFile(JSON.stringify({ type: 'response_item', timestamp: at, payload: {
              type: 'message', role: 'user', content: [{ type: 'input_text', text: `${i}:` + 'x'.repeat(64 * 1024) }],
            } }) + '\n')
          }
        } finally { await file.close() }
        const args = { provider: 'codex', dryRun: false, ctx: {
          env, storage: kernel.storage, query: kernel.query, config: { version: /** @type {const} */ (2) },
          backfills: kernel.backfills, backfillMaterializers: kernel.backfillMaterializers,
        } }
        const first = await runBackfillProvider(args)
        expect.that('batched import writes all 300 rows', first, v => v.ok && v.rowsWritten === 300)
        const second = await runBackfillProvider(args)
        expect.that('batched rerun writes no duplicate rows', second, v => v.ok && v.rowsWritten === 0)
        const rows = await queryRows({ dispatch, kernel, registry, env, expect, label: 'durable batched rows',
          sql: `select count(*) as n, max(message_index) as last_index from ai_gateway_messages where session_id = '${id}'`,
        })
        expect.that('durable batched positions cover the whole conversation', rows[0], v => Number(v?.n) === 300 && Number(v?.last_index) === 299)
        const invalid = path.join(sessionsDir, 'rollout-invalid.jsonl')
        await fs.writeFile(invalid, 'synthetic unreadable JSON record\n')
        const recoveredId = `${sessionId}-partial-recovery`
        await fs.writeFile(path.join(sessionsDir, 'rollout-healthy-recovery.jsonl'), [
          JSON.stringify({ type: 'session_meta', payload: { id: recoveredId, timestamp: at } }),
          JSON.stringify({ type: 'response_item', timestamp: at, payload: {
            type: 'message', role: 'user', content: [{ type: 'input_text', text: 'healthy file survives another file failure' }],
          } }),
        ].join('\n') + '\n')
        const failed = await runBackfillProvider(args)
        expect.that('unreadable file fails the run while healthy rows are committed', failed, v => !v.ok && v.rowsWritten === 1)
        const partial = await queryRows({ dispatch, kernel, registry, env, expect, label: 'partial capture flush',
          sql: `select count(*) as n from ai_gateway_messages where session_id = '${recoveredId}'`,
        })
        expect.that('partial capture is queryable after the failed run', partial[0], v => Number(v?.n) === 1)
        await fs.rm(invalid)
        const recovered = await runBackfillProvider(args)
        expect.that('removing the failed input recovers without duplicate rows', recovered, v => v.ok && v.rowsWritten === 0)

      })
    }

    // ----- 4. Internal telemetry: dev_run_id + provider + row counts -----
    await obs.shutdown()
    const traces = await expect.traces()

    const providerFinish = traces.filter(
      (/** @type {any} */ t) =>
        t.name === 'backfill.provider_finish' &&
        t.attributes?.provider === 'codex' &&
        t.attributes?.[Attr.DEV_RUN_ID] === harness.devRunId,
    )
    expect.that(
      'traces: backfill.provider_finish for codex under the run dev_run_id with rows_written>=2',
      providerFinish[0]?.attributes,
      (v) => v !== undefined && v.status === 'ok' && Number(v.rows_written) >= 2,
    )

    const writeSpans = traces.filter(
      (/** @type {any} */ t) =>
        t.name === 'backfill.write' &&
        t.attributes?.[Attr.DATASET] === 'ai_gateway_messages' &&
        t.attributes?.provider === 'codex' &&
        t.attributes?.[Attr.DEV_RUN_ID] === harness.devRunId,
    )
    expect.that(
      'traces: backfill.write span for ai_gateway_messages with row_count>=2',
      writeSpans[0]?.attributes,
      (v) => v !== undefined && Number(v.row_count) >= 2,
    )

    const logs = await expect.logs()
    expect.that('logs: title capture is observable without title text', logs, v => v.some(l =>
      l.body === 'codex.backfill.session_projected' && l.attributes?.title_captured === true))
    expect.that('logs: scheduled unchanged-file skip', logs, (v) => v.some((l) =>
      l.body === 'codex.backfill.scan_complete' && l.attributes?.files_read === 0 && l.attributes?.files_unchanged === 4))
    expect.that('logs: scheduled capture completed', logs, (v) => v.some((l) =>
      l.body === 'backfill.sweep_finished' && l.attributes?.provider === 'codex' && l.attributes?.rows_written === 6))
    if (largeRollout) expect.that('logs: failed file marks the scan failed', logs, v => v.some(l =>
      l.body === 'codex.backfill.scan_complete' && l.attributes?.status === 'failed' && l.attributes?.files_read_failing === 1))
    const finishLogs = logs.filter(
      (/** @type {any} */ l) => l.body === 'backfill.finish' && l.attributes?.[Attr.DEV_RUN_ID] === harness.devRunId,
    )
    expect.that(
      'logs: backfill.finish carries the run dev_run_id and total_rows_written>=2',
      finishLogs[0]?.attributes,
      (v) => v !== undefined && Number(v.total_rows_written) >= 2,
    )
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousCodexHome
  }
}

/**
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
