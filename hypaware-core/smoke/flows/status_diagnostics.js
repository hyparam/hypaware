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

/**
 * Phase 8 status diagnostics smoke. Drives `hyp status` against two
 * configs, one healthy and one broken, and validates that:
 *
 * 1. Healthy config reports `overall=healthy`, no error diagnostics,
 *    and the printed status lists the expected sources/sinks/clients
 *    plus the V1 cache retention window.
 * 2. Broken config (Claude enabled, no `@hypaware/ai-gateway`) reports
 *    `overall=degraded` and surfaces a `client_without_gateway`
 *    diagnostic with a concrete repair suggestion.
 * 3. The `--json` output is parseable, omits any `@hypaware/central`
 *    or `@hypaware/gascity` requirements, and exposes the
 *    `status.render` span attributes the bead documents
 *    (`source_count`, `sink_count`, `cache_size_bytes`,
 *    `oldest_partition_date`, `daemon_state`, `diagnostics_count`).
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'status_diagnostics: tracer provider not installed - expected HYP_DEV_TELEMETRY=1'
    )
  }

  const cacheRoot = path.join(harness.stateDir, 'cache')
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot })

  const pluginsRoot = path.resolve(import.meta.dirname, '..', '..', 'plugins-workspace')
  const pluginDirs = [
    path.join(pluginsRoot, 'ai-gateway'),
    path.join(pluginsRoot, 'otel'),
    path.join(pluginsRoot, 'local-fs'),
    path.join(pluginsRoot, 'format-parquet'),
    path.join(pluginsRoot, 'claude'),
    path.join(pluginsRoot, 'codex'),
  ]

  const aiGatewayConfig = {
    listen: '127.0.0.1:0',
    upstreams: [
      {
        name: 'anthropic',
        base_url: 'https://api.anthropic.com',
        path_prefix: '/',
      },
    ],
  }
  const otelConfig = { listen_host: '127.0.0.1', listen_port: 0 }

  // Avoid mutating the real HOME under tests: every probe in the
  // status collector walks $HOME for client settings files. Swap in a
  // tmp HOME so the smoke never picks up the developer's attach state.
  const fakeHome = path.join(harness.tmpDir, 'home')
  await fs.mkdir(path.join(fakeHome, '.claude'), { recursive: true })
  await fs.mkdir(path.join(fakeHome, '.codex'), { recursive: true })
  const previousHome = process.env.HOME
  process.env.HOME = fakeHome

  try {
    const { loaded } = await loadManifests(pluginDirs)
    if (loaded.length !== pluginDirs.length) {
      throw new Error(
        `status_diagnostics: expected ${pluginDirs.length} manifests loaded, got ${loaded.length}`
      )
    }
    const resolution = await resolveDependencies(loaded.map((l) => l.manifest))
    if (resolution.unsatisfied.length > 0) {
      throw new Error(
        `status_diagnostics: unsatisfied requirements: ${
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
        config:
          l.manifest.name === '@hypaware/ai-gateway' ? aiGatewayConfig
          : l.manifest.name === '@hypaware/otel'      ? otelConfig
          : {},
      }))
    await activatePlugins({
      plugins: entries,
      stateRoot: harness.stateDir,
      runId: harness.devRunId,
      runtime: kernel,
      tmpRoot: path.join(harness.tmpDir, 'plugin-temp'),
    })

    /* ---------- Case 1: healthy config ---------- */

    const okConfigPath = path.join(harness.hypHome, 'hypaware-config.json')
    await writeJson(okConfigPath, healthyConfig({ hypHome: harness.hypHome }))

    // Pre-write the Claude attach marker so the healthy-case probe
    // reports `attached=true`. Real installs reach this state by
    // running `hyp attach --client claude`; the smoke stubs it out
    // here so the assertions can focus on diagnostics rather than
    // adapter side effects.
    await writeJson(path.join(fakeHome, '.claude', 'settings.json'), {
      _hypaware: { attached_at: new Date().toISOString(), version: '0.0.0', port: 8787 },
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787' },
    })

    const okStdout = makeBuf()
    const okStderr = makeBuf()
    const okExit = await dispatch(['status'], {
      stdout: okStdout,
      stderr: okStderr,
      kernel,
      registry,
      env: smokeEnv({ harness, hypConfig: okConfigPath }),
    })
    expect.that('healthy: hyp status exited 0', okExit, (v) => v === 0)
    expect.that(
      'healthy: stderr is empty',
      okStderr.text(),
      (v) => v.length === 0
    )
    const okText = okStdout.text()
    expect.that(
      'healthy: text status mentions overall=healthy',
      okText,
      (v) => v.includes('overall:  healthy')
    )
    for (const expected of [
      'ai-gateway',
      'otlp',
      'local-fs',
      'claude',
      'cache retention',
      '30 days',
    ]) {
      expect.that(
        `healthy: stdout mentions '${expected}'`,
        okText,
        (v) => v.includes(expected)
      )
    }
    expect.that(
      'healthy: no diagnostics section emitted',
      okText,
      (v) => !v.includes('diagnostics:')
    )

    /* ---------- Case 2: healthy config + --json ---------- */

    const okJsonStdout = makeBuf()
    const okJsonStderr = makeBuf()
    const okJsonExit = await dispatch(['status', '--json'], {
      stdout: okJsonStdout,
      stderr: okJsonStderr,
      kernel,
      registry,
      env: smokeEnv({ harness, hypConfig: okConfigPath }),
    })
    expect.that('healthy json: hyp status --json exited 0', okJsonExit, (v) => v === 0)
    /** @type {any} */
    let okJson
    try {
      okJson = JSON.parse(okJsonStdout.text())
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      expect.that(`healthy json: parseable (${message})`, false, (v) => v === true)
    }
    expect.that(
      'healthy json: overall=healthy',
      okJson?.overall,
      (v) => v === 'healthy'
    )
    expect.that(
      'healthy json: zero diagnostics',
      okJson?.diagnostics,
      (v) => Array.isArray(v) && v.length === 0
    )
    expect.that(
      'healthy json: active_plugins is array',
      okJson?.active_plugins,
      (v) => Array.isArray(v)
    )
    expect.that(
      'healthy json: includes ai-gateway in active_plugins',
      (okJson?.active_plugins ?? []).map((/** @type {any} */ p) => p.name),
      (v) => Array.isArray(v) && v.includes('@hypaware/ai-gateway')
    )
    expect.that(
      'healthy json: cache.retention_days=30',
      okJson?.cache?.retention_days,
      (v) => v === 30
    )
    expect.that(
      'healthy json: registered clients include claude',
      okJson?.clients,
      (v) => Array.isArray(v) && v.includes('claude')
    )
    expect.that(
      'healthy json: client_attach shows claude as configured + attached',
      okJson?.client_attach,
      (v) => Array.isArray(v) && v.some(
        (/** @type {any} */ c) => c.name === 'claude' && c.configured === true && c.attached === true
      )
    )

    // V1 contract: no `central` or `gascity` references in JSON.
    const okJsonText = JSON.stringify(okJson)
    expect.that(
      'healthy json: contains no @hypaware/central reference',
      okJsonText,
      (v) => !v.includes('@hypaware/central')
    )
    expect.that(
      'healthy json: contains no @hypaware/gascity reference',
      okJsonText,
      (v) => !v.includes('@hypaware/gascity')
    )

    /* ---------- Case 3: broken config (client without gateway) ---------- */

    // Reset client attach state so the broken case reflects a real
    // "fresh install, walkthrough never finished" situation. Removing
    // the Claude marker lets the smoke verify the diagnostic fires
    // regardless of attach side effects from Case 1.
    await fs.rm(path.join(fakeHome, '.claude', 'settings.json'), { force: true })

    const badConfigPath = path.join(harness.hypHome, 'hypaware-config.bad.json')
    await writeJson(badConfigPath, {
      version: 2,
      plugins: [
        // Claude enabled but ai-gateway intentionally omitted: the
        // status collector should surface client_without_gateway plus
        // the gateway_missing_anthropic_upstream warning.
        { name: '@hypaware/claude', config: { proxy: '@hypaware/ai-gateway' } },
      ],
    })

    const badStdout = makeBuf()
    const badStderr = makeBuf()
    const badExit = await dispatch(['status', '--json'], {
      stdout: badStdout,
      stderr: badStderr,
      kernel,
      registry,
      env: smokeEnv({ harness, hypConfig: badConfigPath }),
    })
    expect.that('broken json: hyp status --json exited 0', badExit, (v) => v === 0)
    /** @type {any} */
    let badJson
    try {
      badJson = JSON.parse(badStdout.text())
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      expect.that(`broken json: parseable (${message})`, false, (v) => v === true)
    }
    expect.that(
      'broken json: overall=degraded',
      badJson?.overall,
      (v) => v === 'degraded'
    )
    const kinds = (badJson?.diagnostics ?? []).map(
      (/** @type {any} */ d) => d.kind
    )
    expect.that(
      'broken json: client_without_gateway diagnostic present',
      kinds,
      (v) => Array.isArray(v) && v.includes('client_without_gateway')
    )
    const clientDiag = (badJson?.diagnostics ?? []).find(
      (/** @type {any} */ d) => d.kind === 'client_without_gateway'
    )
    expect.that(
      'broken json: diagnostic carries a repair suggestion',
      clientDiag?.repair,
      (v) => Array.isArray(v) && v.length > 0 && typeof v[0] === 'string'
    )
    expect.that(
      'broken json: claude configured but not attached',
      badJson?.client_attach,
      (v) => Array.isArray(v) && v.some(
        (/** @type {any} */ c) => c.name === 'claude' && c.configured === true && c.attached === false
      )
    )

    /* ---------- Case 4: broken config text rendering ---------- */

    const badTextStdout = makeBuf()
    const badTextStderr = makeBuf()
    const badTextExit = await dispatch(['status'], {
      stdout: badTextStdout,
      stderr: badTextStderr,
      kernel,
      registry,
      env: smokeEnv({ harness, hypConfig: badConfigPath }),
    })
    expect.that('broken text: hyp status exited 0', badTextExit, (v) => v === 0)
    const badText = badTextStdout.text()
    expect.that(
      'broken text: overall=degraded printed',
      badText,
      (v) => v.includes('overall:  degraded')
    )
    expect.that(
      'broken text: diagnostics block surfaces client_without_gateway',
      badText,
      (v) => v.includes('client_without_gateway')
    )
    expect.that(
      'broken text: surfaces a repair command',
      badText,
      (v) => v.includes('repair: hyp attach --client claude')
    )

    await obs.shutdown()

    /* ---------- Span assertions ---------- */

    const traces = await expect.traces()
    const statusSpans = traces.filter(
      (/** @type {any} */ t) => t.name === 'status.render'
    )
    expect.that(
      'traces: at least four status.render spans (case 1 text + json + case 3 + case 4)',
      statusSpans,
      (v) => Array.isArray(v) && v.length >= 4
    )
    // Healthy case attribute contract.
    const okSpan = statusSpans.find(
      (/** @type {any} */ s) => s.attributes?.overall === 'healthy'
    )
    expect.that(
      'traces: healthy status.render carries Phase 8 attribute set',
      okSpan?.attributes,
      (v) =>
        v !== undefined &&
        typeof v.source_count === 'number' &&
        typeof v.sink_count === 'number' &&
        typeof v.client_count === 'number' &&
        typeof v.cache_size_bytes === 'number' &&
        typeof v.oldest_partition_date === 'string' &&
        typeof v.diagnostics_count === 'number' &&
        v.diagnostics_count === 0 &&
        typeof v.daemon_state === 'string'
    )
    // Broken case must record diagnostics_count > 0 and overall=degraded.
    const badSpan = statusSpans.find(
      (/** @type {any} */ s) => s.attributes?.overall === 'degraded'
    )
    expect.that(
      'traces: degraded status.render attributes set',
      badSpan?.attributes,
      (v) => v !== undefined && v.diagnostics_count >= 1 && v.overall === 'degraded'
    )
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
  }
}

/**
 * @param {{ hypHome: string }} args
 */
function healthyConfig({ hypHome }) {
  return {
    version: 2,
    plugins: [
      {
        name: '@hypaware/ai-gateway',
        config: {
          listen: '127.0.0.1:8787',
          upstreams: [
            {
              name: 'anthropic',
              base_url: 'https://api.anthropic.com',
              path_prefix: '/',
            },
          ],
        },
      },
      {
        name: '@hypaware/otel',
        config: { listen_host: '127.0.0.1', listen_port: 4318 },
      },
      { name: '@hypaware/local-fs' },
      { name: '@hypaware/format-parquet' },
      {
        name: '@hypaware/claude',
        config: { proxy: '@hypaware/ai-gateway' },
      },
    ],
    sinks: {
      local: {
        writer: '@hypaware/format-parquet',
        destination: '@hypaware/local-fs',
        config: {
          dir: path.join(hypHome, 'exports'),
          schedule: '*/5 * * * *',
        },
      },
    },
    query: {
      cache: {
        retention: { default_days: 30 },
      },
    },
  }
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
