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
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
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
