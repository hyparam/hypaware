// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { installObservability } from '../../../src/core/observability/index.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { registerCoreCommands } from '../../../src/core/cli/core_commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { loadManifests } from '../../../src/core/manifest.js'
import { resolveDependencies } from '../../../src/core/dep_graph.js'
import { writeStatusFile } from '../../../src/core/daemon/status.js'

/**
 * Capture-health smoke (LLP 0257 S17, the RFC 0245 open-question-1 duty),
 * modeled on `status_diagnostics`. Drives `hyp status` against one
 * otel-attached claude install in three states and validates that:
 *
 * 1. With the listener's `last_event_at` in lockstep with the transcript
 *    trail, the capture-health line renders, no `capture_gap` diagnostic
 *    fires, and `overall` stays healthy.
 * 2. With transcripts running hours past the last event, `--json` carries
 *    `capture_health[0].state === 'gap'`, a `capture_gap` diagnostic with an
 *    `error` severity and a repair hint appears, and `overall` degrades; the
 *    text surface shows the `[capture gap]` tag.
 * 3. With no otel attach marker the line is absent and the `capture_health`
 *    array is empty - no noise on a machine the question does not apply to.
 *
 * Everything status reads is a file: the attach marker and transcript mtimes
 * under a fake $HOME, and the listener detail under the daemon's status.json
 * (no daemon runs; the comparison must survive its daemon, which is exactly
 * the down-daemon gap it exists to catch).
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'status_capture_health: tracer provider not installed - expected HYP_DEV_TELEMETRY=1'
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

  // Fake $HOME: the attach marker and the transcript trail both live under
  // it, and the smoke must never read the developer's real attach state.
  const fakeHome = path.join(harness.tmpDir, 'home')
  await fs.mkdir(path.join(fakeHome, '.claude'), { recursive: true })
  const previousHome = process.env.HOME
  process.env.HOME = fakeHome

  const HOUR = 3_600_000
  const now = Date.now()

  try {
    const { loaded } = await loadManifests(pluginDirs)
    if (loaded.length !== pluginDirs.length) {
      throw new Error(
        `status_capture_health: expected ${pluginDirs.length} manifests loaded, got ${loaded.length}`
      )
    }
    const resolution = await resolveDependencies(loaded.map((l) => l.manifest))
    if (resolution.unsatisfied.length > 0) {
      throw new Error(
        `status_capture_health: unsatisfied requirements: ${
          resolution.unsatisfied.map((u) => `${u.plugin}:${u.errorKind}`).join(', ')
        }`
      )
    }
    const aiGatewayConfig = {
      listen: '127.0.0.1:0',
      upstreams: [
        { name: 'anthropic', base_url: 'https://api.anthropic.com', path_prefix: '/' },
      ],
    }
    const byName = new Map(loaded.map((l) => [l.manifest.name, l]))
    const entries = resolution.order
      .map((name) => byName.get(name))
      .filter((l) => l !== undefined)
      .map((l) => ({
        manifest: l.manifest,
        rootDir: l.rootDir,
        config: l.manifest.name === '@hypaware/ai-gateway' ? aiGatewayConfig : {},
      }))
    await activatePlugins({
      plugins: entries,
      stateRoot: harness.stateDir,
      runId: harness.devRunId,
      runtime: kernel,
      tmpRoot: path.join(harness.tmpDir, 'plugin-temp'),
    })

    const configPath = path.join(harness.hypHome, 'hypaware-config.json')
    await writeJson(configPath, {
      version: 2,
      plugins: [
        {
          name: '@hypaware/ai-gateway',
          config: {
            listen: '127.0.0.1:8787',
            upstreams: [
              { name: 'anthropic', base_url: 'https://api.anthropic.com', path_prefix: '/' },
            ],
          },
        },
        { name: '@hypaware/claude', config: { proxy: '@hypaware/ai-gateway' } },
      ],
    })

    // The otel attach marker a real `hyp attach --client claude` writes,
    // stubbed the way status_diagnostics stubs the base-URL one so the
    // assertions focus on the health surface rather than adapter effects.
    const attachedAt = new Date(now - 6 * HOUR).toISOString()
    await writeJson(path.join(fakeHome, '.claude', 'settings.json'), {
      _hypaware: {
        attached_at: attachedAt,
        version: '2.0.0',
        port: 8787,
        mode: 'otel',
        spool_dir: path.join(harness.hypHome, 'spool', 'claude-bodies'),
        managed: { env: {}, hooks: [] },
      },
      env: {},
    })

    // One transcript, freshly written: the client-side half of the
    // comparison.
    const transcript = path.join(fakeHome, '.claude', 'projects', '-tmp-proj', 'aaaa-session.jsonl')
    await fs.mkdir(path.dirname(transcript), { recursive: true })
    await fs.writeFile(transcript, '{}\n')
    const transcriptMtime = new Date(now - 30_000)
    await fs.utimes(transcript, transcriptMtime, transcriptMtime)

    /* ---------- Case 1: events in lockstep -> line, no gap, healthy ---------- */

    writeListenerStatus(harness.stateDir, new Date(now - 60_000).toISOString())

    const okStdout = makeBuf()
    const okExit = await dispatch(['status'], {
      stdout: okStdout,
      stderr: makeBuf(),
      kernel,
      registry,
      env: smokeEnv({ harness, hypConfig: configPath }),
    })
    expect.that('healthy: hyp status exited 0', okExit, (v) => v === 0)
    const okText = okStdout.text()
    expect.that(
      'healthy: capture-health line renders',
      okText,
      (v) => v.includes('capture health:') && /- claude {2}last event .*, last transcript activity /.test(v)
    )
    expect.that(
      'healthy: no capture-gap tag',
      okText,
      (v) => !v.includes('[capture gap]')
    )
    expect.that(
      'healthy: overall stays healthy',
      okText,
      (v) => v.includes('overall:  healthy')
    )

    /* ---------- Case 2: transcripts hours past the last event -> degraded ---------- */

    writeListenerStatus(harness.stateDir, new Date(now - 5 * HOUR).toISOString())

    const gapStdout = makeBuf()
    const gapExit = await dispatch(['status', '--json'], {
      stdout: gapStdout,
      stderr: makeBuf(),
      kernel,
      registry,
      env: smokeEnv({ harness, hypConfig: configPath }),
    })
    expect.that('gap json: hyp status --json exited 0', gapExit, (v) => v === 0)
    /** @type {any} */
    let gapJson
    try {
      gapJson = JSON.parse(gapStdout.text())
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      expect.that(`gap json: parseable (${message})`, false, (v) => v === true)
    }
    expect.that(
      'gap json: capture_health carries the gap entry',
      gapJson?.capture_health,
      (v) => Array.isArray(v) && v.length === 1 && v[0].client === 'claude' &&
        v[0].state === 'gap' && typeof v[0].gap_seconds === 'number' && v[0].gap_seconds > 4 * 3600
    )
    expect.that(
      'gap json: client_attach reports the otel mode',
      gapJson?.client_attach,
      (v) => Array.isArray(v) && v.some(
        (/** @type {any} */ c) => c.name === 'claude' && c.attached === true && c.mode === 'otel'
      )
    )
    const gapDiag = (gapJson?.diagnostics ?? []).find(
      (/** @type {any} */ d) => d.kind === 'capture_gap'
    )
    expect.that(
      'gap json: capture_gap diagnostic fires at error severity',
      gapDiag,
      (v) => v !== undefined && v.severity === 'error' && typeof v.message === 'string'
    )
    expect.that(
      'gap json: the diagnostic carries a repair hint',
      gapDiag?.repair,
      (v) => Array.isArray(v) && v.length > 0 && v.some(
        (/** @type {any} */ r) => typeof r === 'string' && r.includes('hyp attach --client claude')
      )
    )
    expect.that(
      'gap json: overall degrades',
      gapJson?.overall,
      (v) => v === 'degraded'
    )

    const gapTextStdout = makeBuf()
    const gapTextExit = await dispatch(['status'], {
      stdout: gapTextStdout,
      stderr: makeBuf(),
      kernel,
      registry,
      env: smokeEnv({ harness, hypConfig: configPath }),
    })
    expect.that('gap text: hyp status exited 0', gapTextExit, (v) => v === 0)
    const gapText = gapTextStdout.text()
    expect.that(
      'gap text: the line carries the capture-gap tag',
      gapText,
      (v) => /- claude {2}last event .*, last transcript activity .* {2}\[capture gap\]/.test(v)
    )
    expect.that(
      'gap text: diagnostics name capture_gap',
      gapText,
      (v) => v.includes('capture_gap')
    )

    /* ---------- Case 3: no otel attach -> no line, no noise ---------- */

    await fs.rm(path.join(fakeHome, '.claude', 'settings.json'), { force: true })

    const offStdout = makeBuf()
    const offExit = await dispatch(['status', '--json'], {
      stdout: offStdout,
      stderr: makeBuf(),
      kernel,
      registry,
      env: smokeEnv({ harness, hypConfig: configPath }),
    })
    expect.that('detached json: hyp status --json exited 0', offExit, (v) => v === 0)
    /** @type {any} */
    let offJson
    try {
      offJson = JSON.parse(offStdout.text())
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      expect.that(`detached json: parseable (${message})`, false, (v) => v === true)
    }
    expect.that(
      'detached json: capture_health is empty',
      offJson?.capture_health,
      (v) => Array.isArray(v) && v.length === 0
    )
    expect.that(
      'detached json: no capture_gap diagnostic',
      (offJson?.diagnostics ?? []).map((/** @type {any} */ d) => d.kind),
      (v) => Array.isArray(v) && !v.includes('capture_gap')
    )

    const offTextStdout = makeBuf()
    await dispatch(['status'], {
      stdout: offTextStdout,
      stderr: makeBuf(),
      kernel,
      registry,
      env: smokeEnv({ harness, hypConfig: configPath }),
    })
    expect.that(
      'detached text: no capture-health section',
      offTextStdout.text(),
      (v) => !v.includes('capture health')
    )

    await obs.shutdown()

    /* ---------- Span assertions ---------- */

    const traces = await expect.traces()
    const statusSpans = traces.filter(
      (/** @type {any} */ t) => t.name === 'status.render'
    )
    expect.that(
      'traces: five status.render spans (healthy + gap json + gap text + detached json + detached text)',
      statusSpans,
      (v) => Array.isArray(v) && v.length >= 5
    )
    const degradedSpan = statusSpans.find(
      (/** @type {any} */ s) => s.attributes?.overall === 'degraded'
    )
    expect.that(
      'traces: the gap run records degraded with a diagnostic counted',
      degradedSpan?.attributes,
      (v) => v !== undefined && v.diagnostics_count >= 1
    )
    const healthySpan = statusSpans.find(
      (/** @type {any} */ s) => s.attributes?.overall === 'healthy'
    )
    expect.that(
      'traces: the lockstep run stayed healthy',
      healthySpan,
      (v) => v !== undefined
    )
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
  }
}

/**
 * The listener detail the daemon tick would have collected into
 * status.json: the claude-telemetry snapshot with `last_event_at`
 * (LLP 0257 S16). No pid file rides beside it on purpose - the
 * comparison is not liveness-gated.
 *
 * @param {string} stateRoot
 * @param {string | null} lastEventAt
 */
function writeListenerStatus(stateRoot, lastEventAt) {
  writeStatusFile(stateRoot, /** @type {any} */ ({
    state: 'healthy',
    sources: [
      {
        name: 'ai-gateway',
        plugin: '@hypaware/ai-gateway',
        state: 'started',
        details: { host: '127.0.0.1', port: 8787 },
      },
      {
        name: 'claude-telemetry',
        plugin: '@hypaware/claude',
        state: 'started',
        details: { listen_host: '127.0.0.1', listen_port: 4319, last_event_at: lastEventAt },
      },
    ],
    sinks: [],
  }))
}

/**
 * @param {{ harness: { hypHome: string }, hypConfig: string }} args
 */
function smokeEnv({ harness, hypConfig }) {
  return { ...process.env, HYP_HOME: harness.hypHome, HYP_CONFIG: hypConfig }
}

/**
 * @param {string} filePath
 * @param {unknown} value
 */
async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

function makeBuf() {
  /** @type {string[]} */
  const chunks = []
  return {
    chunks,
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
