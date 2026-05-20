// @ts-check

import process from 'node:process'
import path from 'node:path'
import fs from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { context, ROOT_CONTEXT, SpanStatusCode } from '@opentelemetry/api'

import {
  Attr,
  buildAttrs,
  getKernelInstruments,
  getLogger,
  getTracer,
  installObservability,
} from '../observability/index.js'
import { createCommandRegistry } from '../registry/commands.js'
import { createKernelRuntime } from '../runtime/activation.js'
import { loadManifests } from '../manifest.js'
import { registerCoreCommands } from './core_commands.js'

/** @typedef {import('../../../collectivus-plugin-kernel-types').CommandRegistry} CommandRegistry */
/** @typedef {import('../../../collectivus-plugin-kernel-types').CommandRegistration} CommandRegistration */
/** @typedef {import('../../../collectivus-plugin-kernel-types').CommandRunContext} CommandRunContext */
/** @typedef {import('../../../collectivus-plugin-kernel-types').HypAwareV2Config} HypAwareV2Config */
/** @typedef {import('../../../collectivus-plugin-kernel-types').ActivePlugin} ActivePlugin */

/**
 * @typedef {Object} DispatchOptions
 * @property {NodeJS.WriteStream | { write(chunk: string): unknown }} [stdout]
 * @property {NodeJS.WriteStream | { write(chunk: string): unknown }} [stderr]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {string} [cwd]
 * @property {string} [workspaceDir]   Override the local plugin workspace
 * @property {ReturnType<typeof createCommandRegistry>} [registry]
 * @property {ReturnType<typeof createKernelRuntime>} [kernel]
 */

const HELP_FLAGS = new Set(['--help', '-h', 'help'])

/**
 * Boot the kernel CLI and dispatch `argv` to a registered command.
 *
 * Lifecycle:
 *
 * 1. `installObservability()` (idempotent — shares state with smoke
 *    harnesses and prior dispatch calls within the same process).
 * 2. Assemble a `CommandRegistry`. Core commands register directly;
 *    plugin contributions land later (Phase 4+).
 * 3. Discover plugin manifests in the local workspace
 *    (`hypaware-core/plugins-workspace/<plugin>/hypaware.plugin.json`).
 *    The Phase 3 set is empty by design; the loader tolerates a missing
 *    directory so the dispatcher works against a fresh checkout.
 * 4. Render help and emit `cli.help_rendered` when argv is empty or
 *    begins with a help flag.
 * 5. Otherwise match the longest registered prefix and run the command
 *    inside a root `command.run` span. Records `command_name`,
 *    `argv_count`, `exit_code`, `status`. Ticks `hyp_command_runs_total`
 *    and records the histogram `hyp_command_duration_ms`.
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

  const kernel = opts.kernel ?? createKernelRuntime({ commandRegistry: registry })

  await loadWorkspacePlugins({
    workspaceDir: opts.workspaceDir ?? path.resolve(process.cwd(), 'hypaware-core', 'plugins-workspace'),
  })

  if (argv.length === 0 || HELP_FLAGS.has(argv[0])) {
    getLogger('cli').info('cli.help_rendered', {
      [Attr.COMPONENT]: 'cmd-dispatch',
      command_count: registry.size(),
    })
    renderHelp({ stdout, registry })
    return 0
  }

  const matched = registry.match(argv)
  if (!matched) {
    stderr.write(`hyp: unknown command '${argv.join(' ')}'\n`)
    stderr.write(`run 'hyp --help' for the list of available commands\n`)
    return 2
  }

  const devRunId = env.DEV_RUN_ID
  const attrs = buildAttrs({
    [Attr.COMPONENT]: 'cmd-dispatch',
    [Attr.OPERATION]: 'command.run',
    command_name: matched.command.name,
    argv_count: argv.length,
    ...(devRunId ? { [Attr.DEV_RUN_ID]: devRunId } : {}),
  })

  const tracer = getTracer('cmd-dispatch')
  const instruments = getKernelInstruments()
  /** @type {CommandRunContext} */
  const cmdCtx = {
    stdout,
    stderr,
    env,
    cwd,
    config: { version: 2 },
    plugins: /** @type {ActivePlugin[]} */ ([]),
    capabilities: kernel.capabilities,
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
 * Discover plugin manifests under `workspaceDir`. Returns the manifest
 * load results. Missing directory is treated as an empty workspace.
 *
 * Phase 3 ships an empty workspace; the dispatcher still calls into the
 * manifest loader so Phase 4+ inherits the same spans without changing
 * the dispatch contract.
 *
 * @param {{ workspaceDir: string }} args
 */
async function loadWorkspacePlugins({ workspaceDir }) {
  /** @type {string[]} */
  let entries
  try {
    entries = await fs.readdir(workspaceDir, { withFileTypes: true })
      .then((items) => items.filter((d) => d.isDirectory()).map((d) => path.join(workspaceDir, d.name)))
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return { loaded: [], failed: [] }
    throw err
  }
  if (entries.length === 0) return { loaded: [], failed: [] }
  return loadManifests(entries)
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
