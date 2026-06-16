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
 * Phase 7 smoke — full onboarding walkthrough with the client-history
 * backfill step.
 *
 * Boots `@hypaware/ai-gateway` + `@hypaware/claude` + `@hypaware/codex`
 * against a tmp HYP_HOME with both a Claude transcript and a Codex
 * rollout staged under the fake HOME (timestamped inside the retention
 * window), then drives the real `hyp init` picker non-interactively with
 * both clients selected and `--no-daemon` (a local import still runs).
 * Asserts the bead-6 onboarding contract:
 *
 *  - **Finale backfill ran for both providers**: the `walkthrough.backfill`
 *    span and the finale stdout summary report claude AND codex importing
 *    rows, and per-provider `backfill.provider_finish` spans carry the
 *    run's `dev_run_id` with matching row counts.
 *  - **User-visible query result**: `ai_gateway_messages` holds the
 *    backfilled rows for both the Claude (`provider = anthropic`) and
 *    Codex (`provider = openai`) sessions with the staged content.
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'walkthrough_backfill_client_history: tracer provider not installed — expected HYP_DEV_TELEMETRY=1'
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
    path.join(pluginsRoot, 'codex'),
  ]

  // Stage both clients' history under a fake HOME the providers capture
  // at activation. The finale backfill window is [now - retentionDays,
  // now], so timestamp the fixtures two days back to land inside it
  // regardless of when the smoke runs.
  const fakeHome = path.join(harness.tmpDir, 'home')
  const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
  const tsUser = recent.toISOString()
  const tsAsst = new Date(recent.getTime() + 5000).toISOString()

  const claudeSession = `wcl-${harness.devRunId}`
  const claudeProjects = path.join(fakeHome, '.claude', 'projects', 'some-repo')
  await fs.mkdir(claudeProjects, { recursive: true })
  await fs.writeFile(
    path.join(claudeProjects, `${claudeSession}.jsonl`),
    [
      JSON.stringify({
        sessionId: claudeSession,
        uuid: 'wcl-user-1',
        parentUuid: null,
        type: 'user',
        version: '1.2.3',
        message: { role: 'user', content: 'claude history please' },
        timestamp: tsUser,
      }),
      JSON.stringify({
        sessionId: claudeSession,
        uuid: 'wcl-asst-1',
        parentUuid: 'wcl-user-1',
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'claude history reply' }] },
        timestamp: tsAsst,
      }),
    ].join('\n') + '\n',
    'utf8'
  )

  const codexSession = `wcx-${harness.devRunId}`
  const codexSessions = path.join(fakeHome, '.codex', 'sessions', '2026', '05')
  await fs.mkdir(codexSessions, { recursive: true })
  await fs.writeFile(
    path.join(codexSessions, `rollout-${codexSession}.jsonl`),
    [
      JSON.stringify({ type: 'session_meta', timestamp: tsUser, payload: { id: codexSession, timestamp: tsUser, cwd: '/work/repo', originator: 'Codex Desktop', cli_version: '0.133.0' } }),
      JSON.stringify({ type: 'response_item', timestamp: tsUser, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'codex history please' }] } }),
      JSON.stringify({ type: 'response_item', timestamp: tsAsst, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'codex history reply' }] } }),
    ].join('\n') + '\n',
    'utf8'
  )

  const previousHome = process.env.HOME
  process.env.HOME = fakeHome
  const stableBinPath = path.join(harness.tmpDir, 'stable', 'hypaware-bin', 'hypaware')

  try {
    await runRoot(
      'kernel.boot',
      {
        [Attr.COMPONENT]: 'kernel',
        [Attr.OPERATION]: 'boot',
        [Attr.SMOKE_NAME]: harness.smokeName,
        [Attr.SMOKE_STEP]: 'walkthrough_activate',
        [Attr.DEV_RUN_ID]: harness.devRunId,
        status: 'ok',
      },
      async () => {
        const { loaded } = await loadManifests(pluginDirs)
        if (loaded.length !== pluginDirs.length) {
          throw new Error(`walkthrough_backfill_client_history: expected ${pluginDirs.length} manifests, got ${loaded.length}`)
        }
        const resolution = await resolveDependencies(loaded.map((l) => l.manifest))
        if (resolution.unsatisfied.length > 0) {
          throw new Error(
            `walkthrough_backfill_client_history: unsatisfied requirements: ${
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

    // ----- Drive the real picker init with both clients, importing history -----
    const initStdout = makeBuf()
    const initStderr = makeBuf()
    const initCode = await dispatch(
      [
        'init',
        '--yes',
        '--client', 'claude',
        '--client', 'codex',
        '--source', 'claude',
        '--source', 'codex',
        '--export', 'keep-local',
        '--retention-days', '30',
        '--no-daemon',
        '--bin', stableBinPath,
      ],
      { stdout: initStdout, stderr: initStderr, kernel, registry, env }
    )
    const initText = initStdout.text()
    expect.that('dispatch: hyp init exited 0', initCode, (v) => v === 0)

    // ----- Finale summary: both providers imported rows -----
    expect.that(
      'finale: claude backfill imported its session rows',
      initText,
      (v) => typeof v === 'string' && /backfill claude: ok \(scanned \d+, wrote [2-9]\d*/.test(v),
    )
    expect.that(
      'finale: codex backfill imported its session rows',
      initText,
      (v) => typeof v === 'string' && /backfill codex: ok \(scanned \d+, wrote [2-9]\d*/.test(v),
    )

    // ----- User-visible query result: both clients' history landed -----
    // session_id is the always-present session key; conversation_id is null
    // for Claude after the schema v6 split, so scope/filter on session_id.
    const sql = `
      select session_id, role, content_text, provider, conversation_source
      from ai_gateway_messages
      where session_id in ('${claudeSession}', '${codexSession}')
      order by conversation_source, message_index, part_index
    `.trim().replace(/\s+/g, ' ')

    const out = makeBuf()
    const err = makeBuf()
    const code = await dispatch(
      ['query', 'sql', sql, '--refresh', 'always', '--format', 'json'],
      { stdout: out, stderr: err, kernel, registry, env }
    )
    expect.that('dispatch: query exited 0', code, (v) => v === 0)
    expect.that('stderr: query had no errors', err.text(), (v) => typeof v === 'string' && v.length === 0)

    /** @type {any[]} */
    let rows = []
    try {
      rows = JSON.parse(out.text())
    } catch (e) {
      expect.that(`stdout: query was valid JSON (${e instanceof Error ? e.message : String(e)})`, false, (v) => v === true)
    }

    const claudeRows = rows.filter((r) => r.session_id === claudeSession)
    const codexRows = rows.filter((r) => r.session_id === codexSession)
    expect.that('query: claude session produced two rows', claudeRows, (v) => Array.isArray(v) && v.length === 2)
    expect.that('query: codex session produced two rows', codexRows, (v) => Array.isArray(v) && v.length === 2)
    expect.that(
      'query: claude rows tagged provider=anthropic with transcript content',
      claudeRows,
      (v) => v.every((r) => r.provider === 'anthropic' && r.conversation_source === 'claude') &&
        v.some((r) => r.content_text === 'claude history please') &&
        v.some((r) => r.content_text === 'claude history reply'),
    )
    expect.that(
      'query: codex rows tagged provider=openai with rollout content',
      codexRows,
      (v) => v.every((r) => r.provider === 'openai' && r.conversation_source === 'codex') &&
        v.some((r) => r.content_text === 'codex history please') &&
        v.some((r) => r.content_text === 'codex history reply'),
    )

    // ----- Internal telemetry: the walkthrough backfill step + per-provider finishes -----
    await obs.shutdown()
    const traces = await expect.traces()

    const walkthroughBackfill = traces.filter(
      (/** @type {any} */ t) => t.name === 'walkthrough.backfill',
    )
    expect.that(
      'traces: walkthrough.backfill span ran both providers and wrote rows',
      walkthroughBackfill[0]?.attributes,
      (v) =>
        v !== undefined &&
        typeof v.providers === 'string' &&
        v.providers.includes('claude') &&
        v.providers.includes('codex') &&
        Number(v.rows_written) >= 4,
    )

    for (const provider of ['claude', 'codex']) {
      const finish = traces.filter(
        (/** @type {any} */ t) =>
          t.name === 'backfill.provider_finish' &&
          t.attributes?.provider === provider &&
          t.attributes?.[Attr.DEV_RUN_ID] === harness.devRunId,
      )
      expect.that(
        `traces: backfill.provider_finish for ${provider} under the run dev_run_id with rows_written>=2`,
        finish[0]?.attributes,
        (v) => v !== undefined && v.status === 'ok' && Number(v.rows_written) >= 2,
      )
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
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
