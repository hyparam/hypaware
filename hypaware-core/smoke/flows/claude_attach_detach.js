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
 * Phase 8.4 smoke, updated for LLP 0258's `otel` attach mode. Brings up
 * `@hypaware/ai-gateway` + `@hypaware/claude` in a temp HYP_HOME with
 * HOME pointed at the same tmp tree so the Claude settings file lives
 * under it. Asserts:
 *
 * - `hyp client attach claude` patches `~/.claude/settings.json`
 *   with the HypAware marker, the LLP 0258 telemetry `env` block
 *   (golden compare against the exact key set), and the managed hook
 *   entries: `session-context` on every managed event, plus the LLP
 *   0106 `classify-cwd` hook, which the plugin scopes to the two
 *   fresh-cwd events.
 * - No routing key is written: `ANTHROPIC_BASE_URL`, `HTTPS_PROXY`,
 *   and `NODE_EXTRA_CA_CERTS` all stay absent, which is the Remote
 *   Control predicate holding with no override keys (LLP 0258
 *   #env-keys).
 * - The marker records `mode: 'otel'` and the spool directory (LLP
 *   0258 #marker-and-spool).
 * - A `client.attach` span exists with `hyp_plugin=@hypaware/claude`,
 *   `client_name=claude`, `status=ok`, `restored=false`.
 * - `hyp client detach claude` removes the managed keys and the
 *   settings file matches its pre-attach state byte-for-byte.
 * - A `client.detach` span exists with `status=ok`, `restored=true`.
 *
 * @param {{ harness: any, expect: any }} args
 * @ref LLP 0258#env-keys [tests]: the golden compare pins the exact env block attach writes
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
  // Pin the version the floor check sees: without this the smoke would
  // inherit whatever `claude` binary the machine running it carries, and a
  // stale install would flip the attach below to a refusal.
  // @ref LLP 0258#version-floor [tests]: a version at or above the floor attaches
  const previousClaudeVersion = process.env.HYP_CLAUDE_CODE_VERSION
  process.env.HYP_CLAUDE_CODE_VERSION = '2.1.233'

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

    // Drive `hyp client attach claude` through the dispatcher.
    const attachStdout = makeBuf()
    const attachStderr = makeBuf()
    const attachCode = await dispatch(
      ['client', 'attach', 'claude'],
      {
        stdout: attachStdout,
        stderr: attachStderr,
        kernel,
        registry,
        env: smokeEnv(harness),
      }
    )
    expect.that('dispatch: hyp client attach claude exited 0', attachCode, (v) => v === 0)
    // Silent stderr: the claude row stopped declaring proxy attach when the
    // client went otel-only, so there is no migration to point a scripted
    // attach at, and the LLP 0244 pointer is gone with it.
    // @ref LLP 0262#migration [tests]: an otel attach offers no proxy-mode switch, in any shape
    expect.that(
      'stderr: hyp client attach had no errors and no proxy-mode note',
      attachStderr.text(),
      (v) => v === ''
    )
    expect.that(
      'stdout: hyp client attach printed the settings path',
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
    // The LLP 0258 #env-keys golden compare: the exact telemetry block, and
    // only it. Each flag is asserted by value so a silently renamed or
    // dropped key fails here instead of as an empty dataset in production.
    expect.that(
      'settings: env.CLAUDE_CODE_ENABLE_TELEMETRY is on',
      attached?.env?.CLAUDE_CODE_ENABLE_TELEMETRY,
      (v) => v === '1'
    )
    expect.that(
      'settings: both exporters are otlp',
      [attached?.env?.OTEL_LOGS_EXPORTER, attached?.env?.OTEL_METRICS_EXPORTER],
      (v) => v[0] === 'otlp' && v[1] === 'otlp'
    )
    expect.that(
      'settings: the exporter protocol is http/json',
      attached?.env?.OTEL_EXPORTER_OTLP_PROTOCOL,
      (v) => v === 'http/json'
    )
    expect.that(
      'settings: env.OTEL_EXPORTER_OTLP_ENDPOINT points at the loopback listener',
      attached?.env?.OTEL_EXPORTER_OTLP_ENDPOINT,
      (v) => typeof v === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(v)
    )
    expect.that(
      'settings: all three content flags are on',
      [
        attached?.env?.OTEL_LOG_USER_PROMPTS,
        attached?.env?.OTEL_LOG_ASSISTANT_RESPONSES,
        attached?.env?.OTEL_LOG_TOOL_DETAILS,
      ],
      (v) => v.every((flag) => flag === '1')
    )
    expect.that(
      'settings: env.OTEL_LOG_RAW_API_BODIES names the spool under HYP_HOME',
      attached?.env?.OTEL_LOG_RAW_API_BODIES,
      (v) =>
        typeof v === 'string' &&
        v.startsWith('file:') &&
        v.endsWith(path.join('spool', 'claude-bodies')) &&
        v.includes(harness.hypHome)
    )
    // The Remote Control predicate, stated as absences: no base URL change,
    // no proxy keys. This is what lets Claude Code keep treating the
    // endpoint as first party with no override keys at all.
    // @ref LLP 0258#env-keys [tests]: ANTHROPIC_BASE_URL, HTTPS_PROXY, and NODE_EXTRA_CA_CERTS are not written
    expect.that(
      'settings: no routing key was written (base URL, proxy, CA all absent)',
      attached?.env,
      (v) =>
        v !== null &&
        typeof v === 'object' &&
        !Object.hasOwn(v, 'ANTHROPIC_BASE_URL') &&
        !Object.hasOwn(v, 'HTTPS_PROXY') &&
        !Object.hasOwn(v, 'NODE_EXTRA_CA_CERTS')
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
    // @ref LLP 0258#marker-and-spool [tests]: the marker records the mode and the spool directory detach and purge sweep
    expect.that(
      'settings: marker records mode=otel and the spool directory',
      attached?._hypaware,
      (v) =>
        v !== null &&
        typeof v === 'object' &&
        v.mode === 'otel' &&
        typeof v.spool_dir === 'string' &&
        path.isAbsolute(v.spool_dir) &&
        v.spool_dir.endsWith(path.join('spool', 'claude-bodies'))
    )
    expect.that(
      'settings: the marker manages exactly the nine telemetry keys',
      attached?._hypaware?.managed?.env,
      (v) =>
        v !== null &&
        typeof v === 'object' &&
        Object.keys(v).length === 9 &&
        Object.hasOwn(v, 'CLAUDE_CODE_ENABLE_TELEMETRY') &&
        Object.hasOwn(v, 'OTEL_LOG_RAW_API_BODIES')
    )
    // The spool exists, owner-only, before any session is told to write into
    // it.
    // @ref LLP 0253#spool-location [tests]: created mode 0700 under HYP_HOME
    const spoolStat = await fs.stat(path.join(harness.hypHome, 'spool', 'claude-bodies'))
    expect.that(
      'spool: directory created owner-only at attach',
      spoolStat,
      (v) => v.isDirectory() && (v.mode & 0o777) === 0o700
    )
    // LLP 0106 settles that attach installs the classification hook *alongside*
    // the existing session-context hook, which is what makes a golden compare
    // expecting session-context on its own stale.
    //
    // Which events each kind rides is not 0106's to say and is not stated
    // there: `session-context` on every managed event, `classify-cwd` only
    // where a *fresh* working directory appears (SessionStart, CwdChanged), is
    // decided by `MANAGED_HOOK_SPECS` in the claude plugin's `src/settings.js`,
    // with the reasoning in the comment above it. Both sides are asserted here
    // so dropping either kind, or leaking `classify-cwd` onto the per-prompt
    // and per-tool events, fails the golden compare instead of passing quietly.
    // @ref LLP 0106#decision [tests]: attach installs the classification hook beside the session-context hook
    expect.that(
      'settings: SessionStart carries session-context (with --state-file) then classify-cwd',
      hookCommands(attached?.hooks?.SessionStart),
      (v) =>
        v.length === 2 &&
        v[0].includes('claude-hook session-context') &&
        v[0].includes('--state-file ') &&
        v[0].includes('session-context.jsonl') &&
        v[1].endsWith('claude-hook classify-cwd')
    )
    expect.that(
      'settings: CwdChanged carries the same pair (the other fresh-cwd event)',
      hookCommands(attached?.hooks?.CwdChanged),
      (v) =>
        v.length === 2 &&
        v[0].includes('claude-hook session-context') &&
        v[0].includes('session-context.jsonl') &&
        v[1].endsWith('claude-hook classify-cwd')
    )
    expect.that(
      'settings: UserPromptSubmit carries session-context only (no re-ask per prompt)',
      hookCommands(attached?.hooks?.UserPromptSubmit),
      (v) => v.length === 1 && v[0].includes('claude-hook session-context')
    )
    expect.that(
      'settings: PostToolUse carries session-context only, scoped to the Bash matcher',
      attached?.hooks?.PostToolUse,
      (v) =>
        Array.isArray(v) &&
        v.length === 1 &&
        v[0]?.matcher === 'Bash' &&
        hookCommands(v).length === 1 &&
        hookCommands(v)[0].includes('claude-hook session-context')
    )

    // Drive `hyp client detach claude` through the dispatcher.
    const detachStdout = makeBuf()
    const detachStderr = makeBuf()
    const detachCode = await dispatch(
      ['client', 'detach', 'claude'],
      {
        stdout: detachStdout,
        stderr: detachStderr,
        kernel,
        registry,
        env: smokeEnv(harness),
      }
    )
    expect.that('dispatch: hyp client detach claude exited 0', detachCode, (v) => v === 0)
    expect.that(
      'stderr: hyp client detach had no errors',
      detachStderr.text(),
      (v) => typeof v === 'string' && v.length === 0
    )
    expect.that(
      'stdout: hyp client detach reported the revert (core disk-driven undo, plugin-agnostic prose)',
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
    if (previousClaudeVersion === undefined) delete process.env.HYP_CLAUDE_CODE_VERSION
    else process.env.HYP_CLAUDE_CODE_VERSION = previousClaudeVersion
  }
}

/**
 * Flatten a `hooks.<event>` block into its command strings, in install order.
 * Each element of the block is a `{ matcher?, hooks: [{ type, command }] }`
 * group, and attach pushes one group per command kind the event carries.
 *
 * @param {unknown} groups
 * @returns {string[]}
 */
function hookCommands(groups) {
  if (!Array.isArray(groups)) return []
  return groups.flatMap((group) => {
    const handlers = group?.hooks
    if (!Array.isArray(handlers)) return []
    return handlers
      .filter((/** @type {any} */ h) => h?.type === 'command' && typeof h.command === 'string')
      .map((/** @type {any} */ h) => /** @type {string} */ (h.command))
  })
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
