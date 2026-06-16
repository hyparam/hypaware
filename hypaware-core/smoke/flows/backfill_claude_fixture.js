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
 * Phase 7 smoke — Claude transcript backfill → query → idempotent rerun.
 *
 * Boots `@hypaware/ai-gateway` + `@hypaware/claude` against a tmp
 * HYP_HOME with a staged Claude transcript fixture under the fake HOME,
 * then drives `hyp backfill claude` directly (no daemon — backfill is a
 * local file import) and asserts the bead-6 contract end to end:
 *
 *  - **User-visible query result**: `ai_gateway_messages` holds the two
 *    projected rows with native uuid identity and the exact transcript
 *    content/provider/source.
 *  - **Internal telemetry**: a `backfill.provider_finish` span and a
 *    `backfill.finish` log carrying the run's `dev_run_id`, `provider`,
 *    and matching row counts, plus a `backfill.write` / `cache.append`
 *    span for `ai_gateway_messages`.
 *  - **Idempotency (phase 8)**: a second `hyp backfill claude` (a fresh
 *    run id, so the materializer re-scans committed partitions) writes
 *    ZERO new rows and the query still returns exactly two rows — the
 *    rerun did not duplicate.
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'backfill_claude_fixture: tracer provider not installed — expected HYP_DEV_TELEMETRY=1'
    )
  }

  const cacheRoot = path.join(harness.stateDir, 'cache')
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot })

  const pluginsRoot = path.resolve(import.meta.dirname, '..', '..', 'plugins-workspace')
  const pluginDirs = [
    path.join(pluginsRoot, 'ai-gateway'),
    path.join(pluginsRoot, 'claude'),
  ]

  // The Claude provider captures its transcript root from `ctx.env.HOME`
  // at activation, so stage the fixture and point HOME at it BEFORE
  // activating plugins. One user/assistant pair with native uuids.
  const fakeHome = path.join(harness.tmpDir, 'home')
  const projectsDir = path.join(fakeHome, '.claude', 'projects', 'some-repo')
  await fs.mkdir(projectsDir, { recursive: true })
  const sessionId = `cl-${harness.devRunId}`
  await fs.writeFile(
    path.join(projectsDir, `${sessionId}.jsonl`),
    [
      JSON.stringify({
        sessionId,
        uuid: 'u-user-1',
        parentUuid: null,
        type: 'user',
        version: '1.2.3',
        message: { role: 'user', content: 'list the files' },
        timestamp: '2026-05-20T10:00:00.000Z',
      }),
      JSON.stringify({
        sessionId,
        uuid: 'u-asst-1',
        parentUuid: 'u-user-1',
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'here they are' }] },
        timestamp: '2026-05-20T10:00:05.000Z',
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
          throw new Error(`backfill_claude_fixture: expected ${pluginDirs.length} manifests, got ${loaded.length}`)
        }
        const resolution = await resolveDependencies(loaded.map((l) => l.manifest))
        if (resolution.unsatisfied.length > 0) {
          throw new Error(
            `backfill_claude_fixture: unsatisfied requirements: ${
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
    // An explicit open-ended `--since` keeps the import window deterministic
    // regardless of when the smoke runs (a pre-built kernel carries no
    // retention config, so the default window would otherwise depend on
    // today's date relative to the fixed fixture timestamps).
    const since = '2000-01-01T00:00:00.000Z'

    // ----- 1. First backfill run -----
    const bf1out = makeBuf()
    const bf1err = makeBuf()
    const bf1code = await dispatch(
      ['backfill', 'claude', '--since', since, '--json'],
      { stdout: bf1out, stderr: bf1err, kernel, registry, env }
    )
    expect.that('dispatch: backfill claude (run 1) exited 0', bf1code, (v) => v === 0)
    expect.that('stderr: backfill run 1 had no errors', bf1err.text(), (v) => typeof v === 'string' && v.length === 0)

    const run1 = JSON.parse(bf1out.text())
    const claude1 = run1.providers.find((/** @type {any} */ p) => p.provider === 'claude')
    expect.that(
      'backfill run 1: claude provider ok and wrote both rows',
      claude1,
      (v) => v !== undefined && v.status === 'ok' && v.rows_written >= 2,
    )
    expect.that(
      'backfill run 1: at least one session scanned',
      claude1,
      (v) => v !== undefined && v.sessions_seen >= 1,
    )

    // ----- 2. Query the projected rows -----
    const sql = `
      select role, content_text, message_id, provider, conversation_source, client_name
      from ai_gateway_messages
      where session_id = '${sessionId}'
      order by message_index, part_index
    `.trim().replace(/\s+/g, ' ')

    const rows1 = await queryRows({ dispatch, sql, kernel, registry, env, expect, label: 'after run 1' })
    expect.that('query: two rows for the backfilled session', rows1, (v) => Array.isArray(v) && v.length === 2)

    const user = rows1.find((/** @type {any} */ r) => r.role === 'user')
    const assistant = rows1.find((/** @type {any} */ r) => r.role === 'assistant')
    expect.that(
      'query: user row carries native uuid + transcript content',
      user,
      (v) => v !== undefined && v.message_id === 'u-user-1' && v.content_text === 'list the files',
    )
    expect.that(
      'query: assistant row carries native uuid + transcript content',
      assistant,
      (v) => v !== undefined && v.message_id === 'u-asst-1' && v.content_text === 'here they are',
    )
    expect.that(
      'query: every row tagged provider=anthropic, source=client_name=claude',
      rows1,
      (v) => Array.isArray(v) && v.every((r) => r.provider === 'anthropic' && r.conversation_source === 'claude' && r.client_name === 'claude'),
    )

    // ----- 3. Idempotent rerun: a fresh run id forces a committed-partition
    //          re-scan, so every re-materialized row is recognized and skipped.
    const bf2out = makeBuf()
    const bf2err = makeBuf()
    const bf2code = await dispatch(
      ['backfill', 'claude', '--since', since, '--json'],
      { stdout: bf2out, stderr: bf2err, kernel, registry, env: { ...env, DEV_RUN_ID: `${harness.devRunId}-rerun` } }
    )
    expect.that('dispatch: backfill claude (run 2) exited 0', bf2code, (v) => v === 0)
    const run2 = JSON.parse(bf2out.text())
    const claude2 = run2.providers.find((/** @type {any} */ p) => p.provider === 'claude')
    expect.that(
      'backfill run 2: rerun wrote ZERO new rows (all part_ids already present)',
      claude2,
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
        t.attributes?.provider === 'claude' &&
        t.attributes?.[Attr.DEV_RUN_ID] === harness.devRunId,
    )
    expect.that(
      'traces: backfill.provider_finish for claude under the run dev_run_id with rows_written>=2',
      providerFinish[0]?.attributes,
      (v) => v !== undefined && v.status === 'ok' && Number(v.rows_written) >= 2,
    )

    const writeSpans = traces.filter(
      (/** @type {any} */ t) =>
        t.name === 'backfill.write' &&
        t.attributes?.[Attr.DATASET] === 'ai_gateway_messages' &&
        t.attributes?.provider === 'claude' &&
        t.attributes?.[Attr.DEV_RUN_ID] === harness.devRunId,
    )
    expect.that(
      'traces: backfill.write span for ai_gateway_messages with row_count>=2',
      writeSpans[0]?.attributes,
      (v) => v !== undefined && Number(v.row_count) >= 2,
    )

    const cacheAppends = traces.filter(
      (/** @type {any} */ t) => t.name === 'cache.append' && t.attributes?.[Attr.DATASET] === 'ai_gateway_messages',
    )
    expect.that(
      'traces: at least one cache.append span for ai_gateway_messages',
      cacheAppends,
      (v) => Array.isArray(v) && v.length >= 1,
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
