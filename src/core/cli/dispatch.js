// @ts-check

import { createRequire } from 'node:module'
import process from 'node:process'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

import {
  Attr,
  buildAttrs,
  context,
  getKernelInstruments,
  getLogger,
  getTracer,
  installObservability,
  ROOT_CONTEXT,
  SpanStatusCode,
} from '../observability/index.js'
import { createCommandRegistry } from '../registry/commands.js'
import { createKernelRuntime } from '../runtime/activation.js'
import { bootKernel } from '../runtime/boot.js'
import { readObservabilityEnv } from '../observability/env.js'
import { registerCoreCommands } from './core_commands.js'
import { materializeSinks } from '../sinks/materialize.js'

/**
 * @import { ActivePlugin, CommandRegistration, CommandRegistry, CommandRunContext, HypAwareV2Config } from '../../../collectivus-plugin-kernel-types.d.ts'
 * @import { BootProfile } from '../runtime/types.d.ts'
 * @import { DispatchOptions } from './dispatch.d.ts'
 */

const HELP_FLAGS = new Set(['--help', '-h', 'help'])
const VERSION_FLAGS = new Set(['--version', '-V'])

/**
 * Map a sink materialization failure to a one-line, actionable hint.
 * The raw `[errorKind]: message` line stays for operators; this adds a
 * "what do I do about it" line for the common, confusing cases: a host
 * that hasn't joined a fleet, and the expected-but-noisy plugin-not-active
 * warning that read-only commands emit because they don't load sink
 * writer plugins.
 *
 * @param {{ instance: string, errorKind: string, message: string }} err
 * @returns {string | undefined}
 */
function sinkWarningHint(err) {
  if (/bootstrap_token is not set/.test(err.message)) {
    return "this host hasn't joined a fleet. Run `hyp join <central-url> <token>` to enable the central sink, or ignore this warning if you only capture locally"
  }
  if (err.errorKind === 'sink_plugin_not_active') {
    return `expected for read-only commands (the writer/destination plugin for '${err.instance}' isn't loaded here); the running daemon is unaffected`
  }
  return undefined
}

/**
 * Boot the kernel CLI and dispatch `argv` to a registered command.
 *
 * Lifecycle:
 *
 * 1. `installObservability()` (idempotent — shares state with smoke
 *    harnesses and prior dispatch calls within the same process).
 * 2. Assemble a `CommandRegistry`. Core commands register directly;
 *    plugin-contributed commands land during `bootKernel` below.
 * 3. Render help and exit when argv is empty on a non-TTY stdout or
 *    begins with a help flag (no kernel boot required).
 * 4. Otherwise call `bootKernel({ ... })` — the single shared boot
 *    path that loads the config, discovers bundled plugin manifests,
 *    resolves dependencies, and activates the selected plugins
 *    *before* command dispatch. Active plugins land on
 *    `CommandRunContext.plugins` and their registry contributions
 *    (sources, sinks, capabilities, skills, init-presets) are
 *    available to the command body. `bootProfile=all-available` for
 *    `hyp init` (so the walkthrough picker sees bundled defaults plus
 *    installed plugin presets);
 *    lifecycle/status commands boot an empty runtime, and ordinary
 *    plugin-aware commands use the config.
 * 5. Match the longest registered prefix (now including plugin-
 *    contributed commands) and run the command inside a root
 *    `command.run` span. Records `command_name`, `hyp_command`,
 *    `argv_count`, `exit_code`, `status`, and `error_kind` on
 *    failure. Ticks `hyp_command_runs_total` and records the
 *    histogram `hyp_command_duration_ms`.
 *
 * Callers may inject `opts.kernel` to skip the boot step entirely;
 * existing smokes that pre-build a kernel rely on this contract.
 *
 * @param {string[]} argv
 * @param {DispatchOptions} [opts]
 * @returns {Promise<number>}
 */
export async function dispatch(argv, opts = {}) {
  const stdout = opts.stdout ?? process.stdout
  const stderr = opts.stderr ?? process.stderr
  const env = opts.env ?? process.env
  const cwd = opts.cwd ?? process.cwd()

  installObservability()

  const registry = opts.registry ?? createCommandRegistry()
  if (!opts.registry) registerCoreCommands(registry)

  const obsEnv = readObservabilityEnv(env)
  const cacheRoot = path.join(obsEnv.stateDir, 'cache')

  if (argv.length === 0 && !isInteractiveStream(stdout)) {
    return runHelp({ stdout, registry, devRunId: env.DEV_RUN_ID, argvCount: 0 })
  }
  if (argv.length > 0 && VERSION_FLAGS.has(argv[0])) {
    const require = createRequire(import.meta.url)
    const { version } = require('../../../package.json')
    stdout.write(`hypaware ${version}\n`)
    return 0
  }
  if (argv.length > 0 && HELP_FLAGS.has(argv[0])) {
    return runHelp({ stdout, registry, devRunId: env.DEV_RUN_ID, argvCount: argv.length })
  }

  // Boot the kernel so plugin-contributed commands, sources, sinks,
  // capabilities, skills, and init presets are visible to dispatch.
  // Callers that already built a kernel (test flows pre-activating a
  // specific plugin set) pass `opts.kernel` and we skip boot.
  /** @type {ReturnType<typeof createKernelRuntime>} */
  let kernel
  /** @type {ActivePlugin[]} */
  let activePlugins = []
  /** @type {HypAwareV2Config} */
  let activeConfig = { version: 2 }
  const ownsKernel = !opts.kernel
  if (opts.kernel) {
    kernel = opts.kernel
  } else {
    const bootProfile = decideBootProfile(argv)
    const boot = await bootKernel({
      hypHome: obsEnv.hypHome,
      mode: 'cli',
      runId: env.DEV_RUN_ID,
      bootProfile,
      commandRegistry: registry,
      cacheRoot,
      workspaceDir: opts.workspaceDir,
      env,
    })
    kernel = boot.runtime
    activePlugins = boot.activePlugins
    if (boot.config) activeConfig = boot.config

    const sinkResult = await materializeSinks(kernel, boot.config, {
      stateRoot: path.join(obsEnv.hypHome, 'hypaware'),
      runId: env.DEV_RUN_ID ?? `cli-${process.pid}`,
    })
    for (const err of sinkResult.errors) {
      stderr.write(
        `warning: sink '${err.instance}' not materialized [${err.errorKind}]: ${err.message}\n`
      )
      const hint = sinkWarningHint(err)
      if (hint) stderr.write(`  → ${hint}\n`)
    }
  }

  if (argv.length === 0) {
    // TTY + empty argv → re-enter as `init` so the walkthrough is the
    // no-arg behavior. Pass the booted kernel + registry through so
    // we don't pay the boot cost twice.
    try {
      return await runCommandByName('init', [], { stdout, stderr, env, cwd, registry, kernel })
    } finally {
      if (ownsKernel) {
        await stopBootStartedSources(kernel)
      }
    }
  }

  const matched = registry.match(argv)
  if (!matched) {
    stderr.write(`hyp: unknown command '${argv.join(' ')}'\n`)
    stderr.write(`run 'hyp --help' for the list of available commands\n`)
    if (ownsKernel) {
      await stopBootStartedSources(kernel)
    }
    return 2
  }

  const devRunId = env.DEV_RUN_ID
  const attrs = buildAttrs({
    [Attr.COMPONENT]: 'cmd-dispatch',
    [Attr.OPERATION]: 'command.run',
    command_name: matched.command.name,
    hyp_command: matched.command.name,
    argv_count: argv.length,
    ...(devRunId ? { [Attr.DEV_RUN_ID]: devRunId } : {}),
  })

  const tracer = getTracer('cmd-dispatch')
  const instruments = getKernelInstruments()
  /** @type {CommandRunContext} */
  const cmdCtx = {
    stdout,
    stderr,
    stdin: opts.stdin,
    env,
    cwd,
    config: activeConfig,
    plugins: activePlugins,
    capabilities: kernel.capabilities,
    query: kernel.query,
    verbs: kernel.verbs,
    storage: kernel.storage,
    skills: kernel.skills,
    agents: kernel.agents,
    sources: kernel.sources,
    sinks: kernel.sinks,
    initPresets: kernel.initPresets,
    backfills: kernel.backfills,
    backfillMaterializers: kernel.backfillMaterializers,
  }

  return context.with(ROOT_CONTEXT, () =>
    tracer.startActiveSpan(
      'command.run',
      { attributes: attrs, root: true },
      async (span) => {
        const start = performance.now()
        let exitCode = 1
        try {
          exitCode = await matched.command.run(matched.rest, cmdCtx)
          if (typeof exitCode !== 'number' || !Number.isFinite(exitCode)) {
            exitCode = 0
          }
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error))
          span.recordException(err)
          span.setAttribute('error_kind', 'unhandled_exception')
          stderr.write(`hyp ${matched.command.name}: ${err.message}\n`)
          exitCode = 1
        } finally {
          if (ownsKernel) {
            await stopBootStartedSources(kernel)
          }
          const duration = performance.now() - start
          const finalStatus = exitCode === 0 ? 'ok' : 'failed'
          span.setAttribute('status', finalStatus)
          span.setAttribute('exit_code', exitCode)
          span.setStatus(
            finalStatus === 'ok'
              ? { code: SpanStatusCode.OK }
              : { code: SpanStatusCode.ERROR, message: `exit ${exitCode}` }
          )
          span.end()
          instruments.commandRunsTotal.add(1, {
            command: matched.command.name,
            exit_code: String(exitCode),
          })
          instruments.commandDurationMs.record(duration, {
            command: matched.command.name,
          })
        }
        return exitCode
      }
    )
  )
}

/**
 * Re-enter the dispatcher with a synthetic argv. Used to handle the
 * walkthrough as a normal command (`hyp init`) when `hyp` is invoked
 * with no args on a TTY. Keeps the `command.run` span around the
 * walkthrough exactly like every other command.
 *
 * @param {string} name
 * @param {string[]} rest
 * @param {{
 *   stdout: NodeJS.WriteStream | { write(chunk: string): unknown },
 *   stderr: NodeJS.WriteStream | { write(chunk: string): unknown },
 *   stdin?: NodeJS.ReadStream,
 *   env: NodeJS.ProcessEnv,
 *   cwd: string,
 *   registry: ReturnType<typeof createCommandRegistry>,
 *   kernel: ReturnType<typeof createKernelRuntime>,
 * }} ctx
 * @returns {Promise<number>}
 */
async function runCommandByName(name, rest, ctx) {
  return dispatch([name, ...rest], {
    stdout: ctx.stdout,
    stderr: ctx.stderr,
    stdin: ctx.stdin,
    env: ctx.env,
    cwd: ctx.cwd,
    registry: ctx.registry,
    kernel: ctx.kernel,
  })
}

/** @param {unknown} stream */
function isInteractiveStream(stream) {
  return !!stream && typeof stream === 'object' && /** @type {{ isTTY?: boolean }} */ (stream).isTTY === true
}

/**
 * Pick the boot profile based on the requested command. `hyp init`
 * (interactive walkthrough or preset) needs bundled defaults plus
 * installed plugins loaded so the picker can list plugin presets before
 * the user has written a config. Lifecycle and diagnostics commands
 * avoid activation so they do not bind gateway/OTLP listeners while
 * checking or managing state. Ordinary commands activate only the
 * plugins listed in config.
 *
 * @param {string[]} argv
 * @returns {BootProfile}
 */
function decideBootProfile(argv) {
  if (argv.length === 0) return 'all-available'
  if (argv[0] === 'init') return 'all-available'
  if (argv[0] === 'daemon' || argv[0] === 'status' || argv[0] === 'smoke' || argv[0] === 'version') return { activate: [] }
  return 'config'
}

/**
 * Some plugins currently start listeners during activation. For a
 * one-shot CLI command, any source that was started only because this
 * dispatch booted the kernel must be closed before returning or the
 * Node process will stay alive after printing its result.
 *
 * Injected kernels belong to callers and are intentionally not cleaned
 * up here; smokes and daemon internals manage their own source
 * lifecycles.
 *
 * @param {ReturnType<typeof createKernelRuntime>} kernel
 */
async function stopBootStartedSources(kernel) {
  try {
    await kernel.sources.stopAll()
  } catch {
    // Source cleanup is best-effort; command result rendering has
    // already completed, and individual source stop failures are not
    // actionable from the dispatcher layer.
  }
}

/**
 * Render help under a synthetic `command.run` span so help shows up in
 * the same analytics view as real commands. Emits the same shape as
 * the matched-command path: a root span carrying `hyp_command=help`,
 * `hyp_component=cmd-dispatch`, `argv_count`, `status`, and `exit_code`,
 * plus the `cli.help_rendered` log and the `hyp_command_runs_total`
 * counter / `hyp_command_duration_ms` histogram observation.
 *
 * @param {{
 *   stdout: { write(chunk: string): unknown },
 *   registry: ReturnType<typeof createCommandRegistry>,
 *   devRunId: string | undefined,
 *   argvCount: number,
 * }} args
 * @returns {Promise<number>}
 */
async function runHelp({ stdout, registry, devRunId, argvCount }) {
  const attrs = buildAttrs({
    [Attr.COMPONENT]: 'cmd-dispatch',
    [Attr.OPERATION]: 'command.run',
    command_name: 'help',
    hyp_command: 'help',
    argv_count: argvCount,
    ...(devRunId ? { [Attr.DEV_RUN_ID]: devRunId } : {}),
  })

  const tracer = getTracer('cmd-dispatch')
  const instruments = getKernelInstruments()

  return context.with(ROOT_CONTEXT, () =>
    tracer.startActiveSpan(
      'command.run',
      { attributes: attrs, root: true },
      async (span) => {
        const start = performance.now()
        let exitCode = 0
        try {
          getLogger('cli').info('cli.help_rendered', {
            [Attr.COMPONENT]: 'cmd-dispatch',
            command_count: registry.size(),
          })
          renderHelp({ stdout, registry })
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error))
          span.recordException(err)
          span.setAttribute('error_kind', 'unhandled_exception')
          exitCode = 1
        } finally {
          const duration = performance.now() - start
          const finalStatus = exitCode === 0 ? 'ok' : 'failed'
          span.setAttribute('status', finalStatus)
          span.setAttribute('exit_code', exitCode)
          span.setStatus(
            finalStatus === 'ok'
              ? { code: SpanStatusCode.OK }
              : { code: SpanStatusCode.ERROR, message: `exit ${exitCode}` }
          )
          span.end()
          instruments.commandRunsTotal.add(1, {
            command: 'help',
            exit_code: String(exitCode),
          })
          instruments.commandDurationMs.record(duration, {
            command: 'help',
          })
        }
        return exitCode
      }
    )
  )
}

/**
 * Render the help text. Lists visible commands (sorted) with their
 * summary; hidden commands are dropped.
 *
 * @param {{ stdout: { write(chunk: string): unknown }, registry: ReturnType<typeof createCommandRegistry> }} args
 */
function renderHelp({ stdout, registry }) {
  const visible = registry.list().filter((c) => !c.hidden)
  stdout.write('hyp — HypAware kernel CLI\n')
  stdout.write('\n')
  stdout.write('usage: hyp <command> [args...]\n')
  stdout.write('\n')
  stdout.write('Commands:\n')
  const nameWidth = Math.max(...visible.map((c) => c.name.length), 8)
  for (const cmd of visible) {
    stdout.write(`  ${cmd.name.padEnd(nameWidth)}  ${cmd.summary}\n`)
  }
  stdout.write('\n')
  stdout.write(`Run 'hyp <command> --help' for command-specific help.\n`)
}
