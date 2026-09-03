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

/**
 * Claude scheduled transcript backfill -> query -> idempotent rerun.
 *
 * Boots `@hypaware/ai-gateway` + `@hypaware/claude` against a tmp
 * HYP_HOME with a staged Claude transcript fixture under the fake HOME,
 * then drives the Claude contribution through the daemon's real backfill
 * sweep driver and asserts LLP 0358's contract end to end:
 *
 *  - **User-visible query result**: `ai_gateway_messages` holds the two
 *    projected rows with native uuid identity and the exact transcript
 *    content/provider/source.
 *  - **Internal telemetry**: `backfill.sweep_due` and
 *    `backfill.sweep_finished` logs around the provider spans and cache write.
 *  - **Idempotency, both layers**: a second scheduled tick skips the
 *    unchanged transcript on its fingerprint; a third, after the file is
 *    touched, re-reads and re-projects it and the materializer's
 *    committed-partition dedupe is what writes ZERO new rows. Either way the
 *    query still returns exactly two rows. The rerun did not duplicate.
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'backfill_claude_fixture: tracer provider not installed - expected HYP_DEV_TELEMETRY=1'
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
  const userTs = new Date(Date.now() - 60_000)
  const assistantTs = new Date(userTs.getTime() + 5_000)
  const transcriptPath = path.join(projectsDir, `${sessionId}.jsonl`)
  await fs.writeFile(
    transcriptPath,
    [
      JSON.stringify({
        sessionId,
        uuid: 'u-user-1',
        parentUuid: null,
        type: 'user',
        entrypoint: 'claude-desktop',
        version: '1.2.3',
        message: { role: 'user', content: 'list the files' },
        timestamp: userTs.toISOString(),
      }),
      JSON.stringify({
        sessionId,
        uuid: 'u-asst-1',
        parentUuid: 'u-user-1',
        type: 'assistant',
        entrypoint: 'claude-desktop',
        message: { role: 'assistant', content: [{ type: 'text', text: 'here they are' }] },
        timestamp: assistantTs.toISOString(),
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
    const config = {
      version: 2,
      plugins: [
        { name: '@hypaware/ai-gateway', config: { upstreams: [] } },
        { name: '@hypaware/claude' },
        { name: '@hypaware/claude-desktop' },
      ],
    }
    /** @type {Array<Promise<any>>} */
    const pendingRuns = []
    const sweep = createBackfillSweepDriver({
      backfills: kernel.backfills,
      backfillMaterializers: kernel.backfillMaterializers,
      storage: kernel.storage,
      query: kernel.query,
      env,
      config: /** @type {any} */ (config),
      runBackfill: (/** @type {any} */ args) => {
        const pending = runBackfillProvider(args)
        pendingRuns.push(pending)
        return pending
      },
    })

    /** @param {Date} now */
    async function tickAndAwait(now) {
      pendingRuns.length = 0
      const report = await sweep.tick({ now })
      const results = await Promise.all(pendingRuns)
      return { report, result: results[0] }
    }

    const tick1Now = new Date(Date.UTC(2026, 0, 1, 0, 0, 0))
    const tick2Now = new Date(tick1Now.getTime() + 5 * 60 * 1000)
    const tick3Now = new Date(tick2Now.getTime() + 5 * 60 * 1000)
    const tick1RunId = `sweep-claude-${tick1Now.getTime()}`

    // ----- 1. First scheduled backfill tick -----
    const tick1 = await tickAndAwait(tick1Now)
    expect.that('tick 1: claude provider fired', tick1.report.fired, (v) => Array.isArray(v) && v.includes('claude'))
    expect.that(
      'tick 1: claude provider ok and wrote both rows',
      tick1.result,
      (v) => v !== undefined && v.ok === true && v.rowsWritten >= 2,
    )
    expect.that(
      'tick 1: at least one session scanned',
      tick1.result,
      (v) => v !== undefined && v.scanned >= 1,
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
      'query: every row is attributed to Claude Desktop',
      rows1,
      (v) => Array.isArray(v) && v.every((r) => r.provider === 'anthropic' && r.conversation_source === 'claude-desktop' && r.client_name === 'claude-desktop'),
    )

    // ----- 3. Idempotent scheduled rerun: the process-local fingerprint
    //          recognizes the unchanged transcript before body read or dedupe.
    const tick2 = await tickAndAwait(tick2Now)
    expect.that('tick 2: claude provider fired again', tick2.report.fired, (v) => Array.isArray(v) && v.includes('claude'))
    expect.that(
      'tick 2: unchanged transcript scanned and wrote ZERO items',
      tick2.result,
      (v) => v !== undefined && v.ok === true && v.scanned === 0 && v.rowsWritten === 0,
    )

    const rows2 = await queryRows({ dispatch, sql, kernel, registry, env, expect, label: 'after run 2' })
    expect.that('query: rerun did not duplicate rows (still exactly two)', rows2, (v) => Array.isArray(v) && v.length === 2)

    // ----- 3b. The fingerprint is a fast path, not the rerun guarantee.
    //           Touch the transcript so tick 3 reads and re-projects the same
    //           two messages, and the materializer's committed-partition
    //           dedupe has to be the thing that writes zero rows. Without
    //           this the flow would pass with that dedupe entirely broken.
    const touched = new Date(Date.now() + 2_000)
    await fs.utimes(transcriptPath, touched, touched)
    const tick3 = await tickAndAwait(tick3Now)
    expect.that('tick 3: claude provider fired again', tick3.report.fired, (v) => Array.isArray(v) && v.includes('claude'))
    expect.that(
      'tick 3: touched transcript is re-projected but the dedupe writes ZERO rows',
      tick3.result,
      (v) => v !== undefined && v.ok === true && v.scanned >= 1 && v.rowsWritten === 0,
    )
    const rows3 = await queryRows({ dispatch, sql, kernel, registry, env, expect, label: 'after run 3' })
    expect.that('query: the re-projected rerun did not duplicate rows either', rows3, (v) => Array.isArray(v) && v.length === 2)

    // ----- 4. Internal telemetry: dev_run_id + provider + row counts -----
    await obs.shutdown()
    const traces = await expect.traces()

    const providerFinish = traces.filter(
      (/** @type {any} */ t) =>
        t.name === 'backfill.provider_finish' &&
        t.attributes?.provider === 'claude' &&
        t.attributes?.[Attr.DEV_RUN_ID] === tick1RunId,
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
        t.attributes?.[Attr.DEV_RUN_ID] === tick1RunId,
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
    const dueLogs = logs.filter(
      (/** @type {any} */ l) => l.body === 'backfill.sweep_due' && l.attributes?.provider === 'claude',
    )
    expect.that(
      'logs: backfill.sweep_due fired once per tick',
      dueLogs,
      (v) => Array.isArray(v) && v.length === 3,
    )
    const finishedLogs = logs.filter(
      (/** @type {any} */ l) => l.body === 'backfill.sweep_finished' && l.attributes?.provider === 'claude',
    )
    expect.that(
      'logs: scheduled runs report first-write and zero-write outcomes',
      finishedLogs,
      (v) => Array.isArray(v) && v.some((l) => l.attributes?.rows_written >= 2) &&
        v.some((l) => l.attributes?.rows_written === 0),
    )
    const scanLogs = logs.filter(
      (/** @type {any} */ l) => l.body === 'claude.backfill.scan_complete',
    )
    expect.that(
      'logs: first tick reads the transcript and second tick skips its unchanged body',
      scanLogs,
      (v) => Array.isArray(v) &&
        v.some((l) => l.attributes?.files_read === 1 && l.attributes?.files_unchanged === 0) &&
        v.some((l) => l.attributes?.files_read === 0 && l.attributes?.files_unchanged === 1),
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
