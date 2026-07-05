// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import {
  Attr,
  installObservability,
  runRoot,
} from '../../../src/core/observability/index.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { registerCoreCommands } from '../../../src/core/cli/core_commands.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { loadManifests } from '../../../src/core/manifest.js'
import { resolveDependencies } from '../../../src/core/dep_graph.js'
import { requireAiGatewayRuntime } from '../../plugins-workspace/ai-gateway/src/runtime.js'

/**
 * Phase 8.4 smoke. Brings up `@hypaware/ai-gateway` + `@hypaware/claude`
 * in a temp HYP_HOME with HOME pointed at the same tmp tree so the
 * Claude settings file lives under it. Asserts the §Phase 8.4 contract
 * from the implementation plan:
 *
 * - `hyp attach --client claude` patches `~/.claude/settings.json`
 *   with the HypAware marker, `env.ANTHROPIC_BASE_URL`, and the
 *   managed session-context hook entries (golden compare).
 * - A `client.attach` span exists with `hyp_plugin=@hypaware/claude`,
 *   `client_name=claude`, `status=ok`, `restored=false`.
 * - `hyp detach --client claude` removes the managed keys and the
 *   settings file matches its pre-attach state byte-for-byte.
 * - A `client.detach` span exists with `status=ok`, `restored=true`.
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'claude_attach_detach: tracer provider not installed - expected HYP_DEV_TELEMETRY=1'
    )
  }

  const fakeHome = path.join(harness.tmpDir, 'home')
  await fs.mkdir(path.join(fakeHome, '.claude'), { recursive: true })
  const settingsPath = path.join(fakeHome, '.claude', 'settings.json')

  // Seed an existing settings file with a non-managed env var so the
  // golden compare can verify the detach really restored the pre-attach
  // state: not just deleted everything HypAware added.
  const originalSettings = {
    env: { ANTHROPIC_API_KEY: 'sk-original-key' },
    permissions: { allow: ['Bash(ls *)'] },
  }
  const originalBody = JSON.stringify(originalSettings, null, 2) + '\n'
  await fs.writeFile(settingsPath, originalBody, 'utf8')

  const previousHome = process.env.HOME
  process.env.HOME = fakeHome

  try {
    const registry = createCommandRegistry()
    registerCoreCommands(registry)
    const cacheRoot = path.join(harness.stateDir, 'cache')
    const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot })

    const pluginsRoot = path.resolve(import.meta.dirname, '..', '..', 'plugins-workspace')
    const aiGatewayDir = path.join(pluginsRoot, 'ai-gateway')
    const claudeDir = path.join(pluginsRoot, 'claude')

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

    await runRoot(
      'kernel.boot',
      {
        [Attr.COMPONENT]: 'kernel',
        [Attr.OPERATION]: 'boot',
        [Attr.SMOKE_NAME]: harness.smokeName,
        [Attr.SMOKE_STEP]: 'claude_activate',
        [Attr.DEV_RUN_ID]: harness.devRunId,
        status: 'ok',
      },
      async () => {
        const { loaded } = await loadManifests([aiGatewayDir, claudeDir])
        if (loaded.length !== 2) {
          throw new Error(`claude_attach_detach: expected 2 plugins loaded, got ${loaded.length}`)
        }
        const resolution = await resolveDependencies(loaded.map((l) => l.manifest))
        if (resolution.unsatisfied.length > 0) {
          throw new Error(
            `claude_attach_detach: unsatisfied requirements: ${
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
            config: l.manifest.name === '@hypaware/ai-gateway' ? aiGatewayConfig : {},
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

    const runtime = requireAiGatewayRuntime()
    await kernel.sources.start('ai-gateway', runtime.ctx)
    runtime.started = true

    // Drive `hyp attach --client claude` through the dispatcher.
    const attachStdout = makeBuf()
    const attachStderr = makeBuf()
    const attachCode = await dispatch(
      ['attach', '--client', 'claude'],
      {
        stdout: attachStdout,
        stderr: attachStderr,
        kernel,
        registry,
        env: smokeEnv(harness),
      }
    )
    expect.that('dispatch: hyp attach --client claude exited 0', attachCode, (v) => v === 0)
    expect.that(
      'stderr: hyp attach had no errors',
      attachStderr.text(),
      (v) => typeof v === 'string' && v.length === 0
    )
    expect.that(
      'stdout: hyp attach printed the settings path',
      attachStdout.text(),
      (v) => typeof v === 'string' && v.includes('Claude Code attached') && v.includes(settingsPath)
    )

    // Read patched settings: golden compare against an expected shape.
    const attached = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    expect.that(
      'settings: pre-existing env.ANTHROPIC_API_KEY was preserved',
      attached?.env?.ANTHROPIC_API_KEY,
      (v) => v === 'sk-original-key'
    )
    expect.that(
      'settings: pre-existing permissions block was preserved',
      attached?.permissions?.allow,
      (v) => Array.isArray(v) && v.length === 1 && v[0] === 'Bash(ls *)'
    )
    expect.that(
      'settings: env.ANTHROPIC_BASE_URL points at the local gateway',
      attached?.env?.ANTHROPIC_BASE_URL,
      (v) => typeof v === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(v)
    )
    expect.that(
      'settings: _hypaware marker has the recorded port, version, and state file',
      attached?._hypaware,
      (v) =>
        v !== null &&
        typeof v === 'object' &&
        typeof v.port === 'number' &&
        v.version === '2.0.0' &&
        typeof v.attached_at === 'string' &&
        typeof v.state_file === 'string' &&
        v.state_file.endsWith('session-context.jsonl')
    )
    expect.that(
      'settings: SessionStart hook installed with --state-file pointing at the plugin state dir',
      attached?.hooks?.SessionStart,
      (v) =>
        Array.isArray(v) &&
        v.length === 1 &&
        Array.isArray(v[0].hooks) &&
        v[0].hooks[0]?.type === 'command' &&
        typeof v[0].hooks[0]?.command === 'string' &&
        v[0].hooks[0].command.includes('claude-hook session-context') &&
        v[0].hooks[0].command.includes('--state-file ') &&
        v[0].hooks[0].command.includes('session-context.jsonl')
    )
    expect.that(
      'settings: PostToolUse hook scoped to Bash matcher',
      attached?.hooks?.PostToolUse?.[0]?.matcher,
      (v) => v === 'Bash'
    )

    // Drive `hyp detach --client claude` through the dispatcher.
    const detachStdout = makeBuf()
    const detachStderr = makeBuf()
    const detachCode = await dispatch(
      ['detach', '--client', 'claude'],
      {
        stdout: detachStdout,
        stderr: detachStderr,
        kernel,
        registry,
        env: smokeEnv(harness),
      }
    )
    expect.that('dispatch: hyp detach --client claude exited 0', detachCode, (v) => v === 0)
    expect.that(
      'stderr: hyp detach had no errors',
      detachStderr.text(),
      (v) => typeof v === 'string' && v.length === 0
    )
    expect.that(
      'stdout: hyp detach reported the revert (core disk-driven undo, plugin-agnostic prose)',
      detachStdout.text(),
      (v) => typeof v === 'string' && v.includes('Detached claude') && v.includes(settingsPath)
    )

    const afterDetach = await fs.readFile(settingsPath, 'utf8')
    expect.that(
      'settings: file matches its pre-attach state byte-for-byte',
      afterDetach,
      (v) => v === originalBody
    )

    await kernel.sources.stop('ai-gateway')
    await obs.shutdown()

    // Telemetry assertions.
    const traces = await expect.traces()

    const attachSpans = traces.filter(
      (/** @type {any} */ t) =>
        t.name === 'client.attach' &&
        t.attributes?.[Attr.PLUGIN] === '@hypaware/claude'
    )
    expect.that(
      'traces: client.attach span emitted for @hypaware/claude',
      attachSpans,
      (rows) => rows.length === 1
    )
    expect.that(
      'traces: client.attach has client_name=claude',
      attachSpans[0]?.attributes?.client_name,
      (v) => v === 'claude'
    )
    expect.that(
      'traces: client.attach has status=ok',
      attachSpans[0]?.attributes?.status,
      (v) => v === 'ok'
    )
    expect.that(
      'traces: client.attach has restored=false',
      attachSpans[0]?.attributes?.restored,
      (v) => v === false
    )

    const detachSpans = traces.filter(
      (/** @type {any} */ t) =>
        t.name === 'client.detach' &&
        t.attributes?.[Attr.PLUGIN] === '@hypaware/claude'
    )
    expect.that(
      'traces: client.detach span emitted for @hypaware/claude',
      detachSpans,
      (rows) => rows.length === 1
    )
    expect.that(
      'traces: client.detach has client_name=claude',
      detachSpans[0]?.attributes?.client_name,
      (v) => v === 'claude'
    )
    expect.that(
      'traces: client.detach has status=ok',
      detachSpans[0]?.attributes?.status,
      (v) => v === 'ok'
    )
    expect.that(
      'traces: client.detach has restored=true (settings file existed and carried the marker)',
      detachSpans[0]?.attributes?.restored,
      (v) => v === true
    )
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
  }
}

/**
 * @param {{ hypHome: string }} harness
 */
function smokeEnv(harness) {
  return { ...process.env, HYP_HOME: harness.hypHome }
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
