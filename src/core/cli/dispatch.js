// @ts-check

import { createRequire } from 'node:module'
import process from 'node:process'
import os from 'node:os'
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
import { bootKernel, resolveConfigPath, resolveLayeredConfigFromDisk, selectBootPlugins } from '../runtime/boot.js'
import { discoverBundledPlugins } from '../runtime/bundled.js'
import { discoverInstalledPlugins } from '../runtime/installed.js'
import { buildPluginCatalog } from '../plugin_catalog.js'
import { readObservabilityEnv } from '../observability/env.js'
import { registerCoreCommands } from './core_commands.js'
import { isHelpFlag, listGroupChildren, renderCommandHelp, renderGroupHelp, synthesizeGroupSummary } from './group_help.js'
import { materializeSinks } from '../sinks/materialize.js'

/**
 * @import { ActivePlugin, CommandRegistration, CommandRegistry, CommandRunContext, HypAwareV2Config, PluginName } from '../../../hypaware-plugin-kernel-types.js'
 * @import { BootProfile } from '../../../src/core/runtime/types.js'
 * @import { DispatchOptions } from '../../../src/core/cli/types.js'
 */

const HELP_FLAGS = new Set(['--help', '-h', 'help'])
const VERSION_FLAGS = new Set(['--version', '-V'])

/**
 * Map a sink materialization failure to a one-line, actionable hint.
 * The raw `[errorKind]: message` line stays for operators; this adds a
 * "what do I do about it" line for the common, confusing cases: a host
 * that hasn't joined a fleet, and a configured sink whose writer or
 * destination plugin isn't enabled in the active config.
 *
 * Note this only runs for commands that actually activate plugins.
 * Lifecycle/read-only commands (boot profile `{ activate: [] }`) skip
 * sink materialization entirely, so they never reach this hint.
 *
 * @param {{ instance: string, errorKind: string, message: string }} err
 * @returns {string | undefined}
 */
function sinkWarningHint(err) {
  if (/bootstrap_token is not set/.test(err.message)) {
    return "this host hasn't joined a fleet. Run `hyp join <central-url> <token>` to enable the central sink, or ignore this warning if you only capture locally"
  }
  if (err.errorKind === 'sink_plugin_not_active') {
    return `sink '${err.instance}' names a writer/destination plugin that isn't enabled in the active config. Add it to plugins[] or remove the sink`
  }
  return undefined
}

/**
 * Whether a boot profile intends to activate any plugins. Lifecycle and
 * read-only commands boot with `{ activate: [] }` (see `decideBootProfile`)
 * so they never load sink writer/destination plugins; a sink can therefore
 * never materialize and every `sink_plugin_not_active` warning would be
 * structurally guaranteed noise. Sink materialization only carries signal
 * when the command actually intended to load those plugins.
 *
 * @param {BootProfile} bootProfile
 * @returns {boolean}
 */
function bootProfileActivatesPlugins(bootProfile) {
  if (typeof bootProfile === 'object' && Array.isArray(bootProfile.activate)) {
    return bootProfile.activate.length > 0
  }
  return true
}

/**
 * Boot the kernel CLI and dispatch `argv` to a registered command.
 *
 * Lifecycle:
 *
 * 1. `installObservability()` (idempotent: shares state with smoke
 *    harnesses and prior dispatch calls within the same process).
 * 2. Assemble a `CommandRegistry`. Core commands register directly;
 *    plugin-contributed commands land during `bootKernel` below.
 * 3. Render help and exit when argv is empty on a non-TTY stdout or
 *    begins with a help flag (no kernel boot required).
 * 4. Otherwise call `bootKernel({ ... })`: the single shared boot
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

  // Inputs the help path uses to list plugin commands without booting.
  // `obsEnv.stateDir` is `<HYP_HOME>/hypaware`: the same `stateRoot`
  // boot derives; so manifest discovery and config resolution see the
  // exact plugin set and effective config dispatch would activate.
  const helpDiscovery = {
    workspaceDir: opts.workspaceDir,
    stateRoot: obsEnv.stateDir,
    configPath: resolveConfigPath({ env, hypHome: obsEnv.hypHome }),
  }

  if (argv.length === 0 && !isInteractiveStream(stdout)) {
    return runHelp({ stdout, registry, devRunId: env.DEV_RUN_ID, argvCount: 0, discovery: helpDiscovery })
  }
  if (argv.length > 0 && VERSION_FLAGS.has(argv[0])) {
    const require = createRequire(import.meta.url)
    const { version } = require('../../../package.json')
    stdout.write(`hypaware ${version}\n`)
    return 0
  }
  if (argv.length > 0 && HELP_FLAGS.has(argv[0])) {
    return runHelp({ stdout, registry, devRunId: env.DEV_RUN_ID, argvCount: argv.length, discovery: helpDiscovery })
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

    // Lifecycle/read-only commands boot with no plugins, so no sink can
    // ever materialize; skip the pass rather than emit a guaranteed
    // `sink_plugin_not_active` warning per configured sink. The daemon's
    // own materialization (src/core/daemon/runtime.js) is untouched, so a
    // sink that genuinely fails to materialize there still surfaces.
    if (bootProfileActivatesPlugins(bootProfile)) {
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
    // No command owns this argv. Before failing, see whether the leading
    // tokens name a *group*: a prefix shared by registered subcommands
    // (e.g. `graph`, with `graph neighbors`/`graph project` registered)
    // and synthesize group help for it. A group that registers an explicit
    // bare command (`query`, `remote`, …) never reaches here: it matched
    // above and renders its own help, so the explicit registration wins.
    const group = resolveGroupHelp(registry, argv)
    if (group) {
      if (group.unknownSub !== undefined) {
        stderr.write(`hyp ${group.prefix}: unknown subcommand '${group.unknownSub}'\n`)
        stderr.write(`  expected one of: ${group.children.map((c) => c.name).join(', ')}\n`)
      } else {
        renderGroupHelp({ stdout, group: group.prefix, children: group.children })
      }
      if (ownsKernel) {
        await stopBootStartedSources(kernel)
      }
      return group.unknownSub !== undefined ? 2 : 0
    }
    // Not a group either. Before the generic "unknown command", see whether
    // the leading token exactly names a command declared by a plugin that is
    // bundled/installed but NOT active in the effective config. If so the
    // command is *unavailable*, not unknown: report which plugin provides it
    // and how to enable it, instead of implying the feature does not exist. A
    // genuine typo matches nothing here and still gets the generic message.
    // @ref LLP 0098#decision [implements]: dispatch miss on a known-but-inactive plugin command reports unavailable + repair, not unknown
    const inactive = await findInactivePluginForCommand(helpDiscovery, argv[0])
    if (inactive) {
      stderr.write(
        `hyp: '${inactive.token}' is provided by ${inactive.plugin}, which is not in the active config\n`
      )
      // The repair depends on *why* the plugin is inactive. Absent from
      // plugins[] → add it (LLP 0098, byte-identical). Present but
      // `enabled: false` → the entry exists, so tell the user to flip it, and
      // when the fleet (central) layer is what disabled it, say it cannot be
      // enabled locally at all rather than send them editing a local entry the
      // additive merge would drop (collides_with_central).
      // @ref LLP 0099#decision [implements]: repair wording branches on absent vs disabled-local vs disabled-central
      if (inactive.state === 'disabled-central') {
        stderr.write(
          `  repair: ${inactive.plugin} is disabled by the fleet (central) config and cannot be enabled locally; ask your fleet admin to enable it\n`
        )
      } else if (inactive.state === 'disabled-local') {
        stderr.write(
          `  repair: set "enabled": true on the {"name": "${inactive.plugin}"} entry in plugins[] in ${displayConfigPath(helpDiscovery.configPath, env)}\n`
        )
      } else {
        stderr.write(
          `  repair: add {"name": "${inactive.plugin}"} to plugins[] in ${displayConfigPath(helpDiscovery.configPath, env)}\n`
        )
      }
    } else {
      stderr.write(`hyp: unknown command '${argv.join(' ')}'\n`)
      stderr.write(`run 'hyp --help' for the list of available commands\n`)
    }
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
          // Core owns `--help` for every registered command: a leading
          // help flag renders registry-backed help (group table when the
          // command has subcommands, usage otherwise) instead of running
          // the command, so each command body stays help-free.
          // @ref LLP 0009#central-help-interception [implements]: help renders inside command.run so it stays in command analytics
          if (isHelpFlag(matched.rest[0])) {
            const children = listGroupChildren(registry, matched.command.name)
            if (children.length > 0) {
              renderGroupHelp({ stdout, group: matched.command.name, groupCommand: matched.command, children })
            } else {
              renderCommandHelp({ stdout, command: matched.command })
            }
            exitCode = 0
          } else {
            exitCode = await matched.command.run(matched.rest, cmdCtx)
          }
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

/**
 * Resolve group-level help for an argv that matched no command.
 *
 * A "group" is a command-name prefix shared by registered subcommands but
 * with no command of its own; e.g. `graph`, when `graph neighbors` and
 * `graph project` are registered but `graph` is not. Walk the leading
 * non-flag tokens from longest to shortest and return the longest prefix
 * that has registered children, so `hyp graph`, `hyp graph --help`, and
 * `hyp graph bogus` all resolve to the `graph` group.
 *
 * Runs only on the dispatch miss path (`registry.match` returned
 * undefined), so it costs nothing on the hot path: a single pass over the
 * registry right before the process renders help and exits. Hidden
 * commands are excluded so they stay out of synthesized help exactly as
 * they stay out of top-level help.
 *
 * @param {ReturnType<typeof createCommandRegistry>} registry
 * @param {string[]} argv
 * @returns {{ prefix: string, children: { name: string, summary: string }[], unknownSub: string | undefined } | undefined}
 * @ref LLP 0009#core-owns-dispatch: core renders group help; plugins only register the leaf subcommands
 */
function resolveGroupHelp(registry, argv) {
  /** @type {string[]} */
  const lead = []
  for (const token of argv) {
    if (typeof token !== 'string' || token.startsWith('-')) break
    lead.push(token)
  }
  if (lead.length === 0) return undefined
  for (let depth = lead.length; depth >= 1; depth -= 1) {
    const prefix = lead.slice(0, depth).join(' ')
    const children = listGroupChildren(registry, prefix)
    if (children.length > 0) {
      return {
        prefix,
        children,
        unknownSub: depth < lead.length ? lead[depth] : undefined,
      }
    }
  }
  return undefined
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
 *   discovery?: { workspaceDir?: string, stateRoot: string, configPath: string },
 * }} args
 * @returns {Promise<number>}
 */
async function runHelp({ stdout, registry, devRunId, argvCount, discovery }) {
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
          const pluginCommands = discovery ? await collectPluginHelpCommands(discovery) : []
          getLogger('cli').info('cli.help_rendered', {
            [Attr.COMPONENT]: 'cmd-dispatch',
            command_count: registry.size(),
            plugin_command_count: pluginCommands.length,
          })
          renderHelp({ stdout, registry, pluginCommands })
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
 * Render the top-level help text: one row per top-level command token,
 * sorted, with subcommands collapsed into their group ('hyp <group>
 * --help' lists them). Hidden commands are dropped. Plugin-contributed
 * commands (gathered from manifests by {@link collectPluginHelpCommands})
 * are merged in alongside core commands; a core command always wins a
 * name collision so its registered summary is authoritative.
 *
 * A group row's summary is its bare command's summary (`query`,
 * `daemon`, ...). A group with no bare command (plugin namespaces like
 * `graph`) gets a synthesized subcommand listing instead.
 *
 * @ref LLP 0009#layered-help [implements]: one row per top-level token; subcommand summaries live in group help
 * @param {{
 *   stdout: { write(chunk: string): unknown },
 *   registry: ReturnType<typeof createCommandRegistry>,
 *   pluginCommands?: { name: string, summary: string }[],
 * }} args
 */
function renderHelp({ stdout, registry, pluginCommands = [] }) {
  const core = registry
    .list()
    .filter((c) => !c.hidden)
    .map((c) => ({ name: c.name, summary: c.summary }))
  const coreNames = new Set(core.map((c) => c.name))
  const merged = [...core, ...pluginCommands.filter((c) => !coreNames.has(c.name))]

  /** @type {Map<string, string>} */
  const rows = new Map()
  /** @type {Map<string, Set<string>>} */
  const groupChildren = new Map()
  for (const cmd of merged) {
    const [head, ...restTokens] = cmd.name.split(' ')
    if (restTokens.length === 0) {
      rows.set(head, cmd.summary)
    } else {
      let children = groupChildren.get(head)
      if (!children) groupChildren.set(head, (children = new Set()))
      children.add(restTokens[0])
    }
  }
  for (const [head, children] of groupChildren) {
    if (!rows.has(head)) rows.set(head, synthesizeGroupSummary([...children].sort()))
  }
  const names = [...rows.keys()].sort()

  stdout.write('hyp - HypAware kernel CLI\n')
  stdout.write('\n')
  stdout.write('usage: hyp <command> [args...]\n')
  stdout.write('\n')
  stdout.write('Commands:\n')
  const nameWidth = Math.max(...names.map((n) => n.length), 8)
  for (const name of names) {
    stdout.write(`  ${name.padEnd(nameWidth)}  ${rows.get(name)}\n`)
  }
  stdout.write('\n')
  stdout.write(`Run 'hyp <command> --help' for subcommands and details.\n`)
}

/**
 * Collect the listable plugin commands for top-level help, WITHOUT
 * activating any plugin.
 *
 * Help renders before `bootKernel`, so it cannot read the activated
 * command registry; doing so would cost a full boot: importing every
 * plugin entrypoint and binding the gateway/OTLP listeners some plugins
 * open during activation (the same reason `decideBootProfile` uses an
 * empty activation set for `daemon`/`status`/`version`). Instead help
 * reads the two cheap inputs boot uses for *discovery*: plugin
 * manifests (plain JSON) and the effective config, and lists the
 * commands each config-active plugin *declares* in its manifest
 * `contributes.commands`. That scope matches dispatch's `config` boot
 * profile, so every command shown here is one that will actually
 * dispatch.
 *
 * Best-effort: any failure (missing workspace, unreadable config or
 * lock file) degrades to "no plugin commands" rather than failing
 * `--help`.
 *
 * @param {{ workspaceDir?: string, stateRoot: string, configPath: string }} discovery
 * @returns {Promise<{ name: string, summary: string }[]>}
 * @ref LLP 0005#declarative [implements]: manifest lists commands before any plugin code is loaded
 */
async function collectPluginHelpCommands(discovery) {
  try {
    const selection = await computeBootSelection(discovery)
    // A shadow collision makes real boot throw before any command
    // dispatches; advertise no plugin commands rather than ones boot rejects.
    if (!selection || selection.shadowing.length > 0) return []

    /** @type {Map<string, { name: string, summary: string }>} */
    const out = new Map()
    for (const entry of selection.selectedManifests) {
      for (const cmd of entry.manifest.contributes?.commands ?? []) {
        if (!cmd || typeof cmd.name !== 'string' || out.has(cmd.name)) continue
        out.set(cmd.name, {
          name: cmd.name,
          summary: typeof cmd.summary === 'string' ? cmd.summary : '',
        })
      }
    }
    return [...out.values()]
  } catch {
    // Help must never fail because plugin discovery did. Fall back to
    // core commands only.
    return []
  }
}

/**
 * Run boot's cheap discovery + plugin SELECTION without activating anything.
 * Both the pre-boot `--help` synthesis and the dispatch-miss availability
 * check need the exact plugin set (and its manifests) that a `config`-profile
 * boot would activate, split from what it would leave inactive.
 *
 * Resolves the effective config the SAME way `bootKernel` does: with the
 * discovered plugin catalog. Without the catalog the merge validator treats
 * every bundled plugin as unknown and drops local `plugins[]` additions
 * (e.g. `@hypaware/context-graph`) from a fleet-joined host's effective
 * config. Then reuses the pure `selectBootPlugins` computation, so the caller
 * sees exactly the pool/selection dispatch would (including the shadow and
 * excluded-skeleton-vs-installed rules a hand-rolled pool would miss).
 *
 * Also returns the resolved `layered` config (effective + per-layer
 * documents) so the dispatch-miss availability check can tell *why* a plugin
 * is inactive: absent from `plugins[]` vs present-but-`enabled: false`, and in
 * the disabled case which layer (central vs local) carries the entry.
 *
 * @param {{ workspaceDir?: string, stateRoot: string, configPath: string }} args
 * @returns {Promise<ReturnType<typeof selectBootPlugins> & { layered: Awaited<ReturnType<typeof resolveLayeredConfigFromDisk>> }>}
 */
async function computeBootSelection({ workspaceDir, stateRoot, configPath }) {
  const [bundled, installed] = await Promise.all([
    discoverBundledPlugins(workspaceDir !== undefined ? { workspaceDir } : {}),
    discoverInstalledPlugins({ stateDir: stateRoot }),
  ])
  const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded], installed.loaded)
  const layered = await resolveLayeredConfigFromDisk({
    stateRoot,
    configPath,
    knownPlugins: catalog.pluginMetadata,
    knownDatasets: catalog.knownDatasets,
  })
  const selection = selectBootPlugins({
    discovered: bundled,
    installed,
    config: layered.effective,
    bootProfile: 'config',
  })
  return { ...selection, layered }
}

/**
 * On a top-level dispatch miss, resolve whether `token` exactly names the
 * leading command word declared by a plugin that is bundled or installed but
 * NOT active in the effective config. Returns the owning plugin so the caller
 * can say "unavailable, here's how to enable it" instead of "unknown".
 *
 * Exact match ONLY: `token` must equal the first word of a declared command
 * name (`graph` for `graph project`). A typo matches nothing and falls
 * through to the generic unknown-command message. Active plugins never reach
 * here for their own commands: those matched `registry.match`/group help
 * above, so at the miss path `token` is unowned by any active or core command.
 *
 * Best-effort and cheap: the same manifest discovery `--help` already runs,
 * wrapped so any failure (missing workspace, unreadable config) degrades to
 * "no suggestion" rather than corrupting the error path.
 *
 * @param {{ workspaceDir?: string, stateRoot: string, configPath: string }} discovery
 * @param {string} token
 * @returns {Promise<{ token: string, plugin: PluginName, state: 'absent' | 'disabled-local' | 'disabled-central' } | undefined>}
 */
async function findInactivePluginForCommand(discovery, token) {
  if (typeof token !== 'string' || token.length === 0 || token.startsWith('-')) return undefined
  try {
    const selection = await computeBootSelection(discovery)
    // A shadow collision makes real boot throw; there is no dispatchable
    // command set to reason about, so offer no suggestion.
    if (selection.shadowing.length > 0) return undefined
    // Inactive = in the boot pool but not selected for a `config` boot. Walk
    // in pool order (bundled, then excluded, then installed) so the first
    // declaring plugin wins a head-token collision, matching boot's own
    // first-writer precedence.
    for (const entry of selection.pool) {
      const name = /** @type {PluginName} */ (entry.manifest.name)
      if (selection.selected.has(name)) continue
      for (const cmd of entry.manifest.contributes?.commands ?? []) {
        if (!cmd || typeof cmd.name !== 'string') continue
        if (cmd.name.split(' ')[0] === token) {
          return { token, plugin: name, state: classifyInactiveState(selection.layered, name) }
        }
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Classify *why* an in-pool plugin is inactive, so the dispatch-miss repair
 * line can advise the right fix. A plugin lands in the pool-but-not-selected
 * set for two config reasons: it is simply absent from the effective
 * `plugins[]` (LLP 0098's case - add it), or it is present with
 * `enabled: false` (the entry exists - flip it). For the disabled case the
 * layer matters: the additive merge model (@ref LLP 0031#merge-model
 * [constrained-by]) drops a local `plugins[]` entry whose name the central
 * layer already declares, so a fleet-disabled plugin cannot be enabled from
 * the local file - the effective disabled entry belongs to central iff central
 * declares that name.
 *
 * @ref LLP 0099#decision [implements]: absent vs disabled, and local vs central for the disabled case
 * @param {Awaited<ReturnType<typeof resolveLayeredConfigFromDisk>>} layered
 * @param {PluginName} name
 * @returns {'absent' | 'disabled-local' | 'disabled-central'}
 */
function classifyInactiveState(layered, name) {
  const effectiveEntry = (layered.effective?.plugins ?? []).find((p) => p.name === name)
  if (!effectiveEntry || effectiveEntry.enabled !== false) return 'absent'
  const disabledByCentral = (layered.centralConfig?.plugins ?? []).some((p) => p.name === name)
  return disabledByCentral ? 'disabled-central' : 'disabled-local'
}

/**
 * Render a config path for the repair line, collapsing the user's home
 * directory to `~` so the hint reads like the documented default
 * (`~/.hyp/hypaware-config.json`) rather than an absolute machine path.
 *
 * @param {string} configPath
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function displayConfigPath(configPath, env) {
  const home = env.HOME ?? os.homedir()
  if (home && (configPath === home || configPath.startsWith(home + path.sep))) {
    return `~${configPath.slice(home.length)}`
  }
  return configPath
}
