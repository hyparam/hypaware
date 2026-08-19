// @ts-check

import fs from 'node:fs/promises'

import { argvToParams, parseControlFlags, usageForVerb } from './verb_codec.js'

/**
 * @import { CommandRegistration, CommandRunContext, PluginLogger, VerbOperationContext, VerbRegistration, VerbRenderResult } from '../../../hypaware-plugin-kernel-types.js'
 */

/**
 * Every command this module has projected from a verb, held by identity.
 *
 * `VerbRegistry.unregister` retracts the CLI half of a released verb name
 * and has to tell that command apart from a plugin's own command of the
 * same name. Identity answers that; "did *this* verb registry project it"
 * does not, because the kernel projects a core verb twice over one command
 * registry: `registerCoreCommands` pre-projects it so `hyp --help` renders
 * before boot, and the verb registry then skips its own projection because
 * the name is already taken. A per-registry ledger calls that pre-boot
 * command somebody else's and leaves `hyp query sql` routed at the verb a
 * host just displaced.
 *
 * @type {WeakSet<CommandRegistration>}
 */
const verbProjections = new WeakSet()

/**
 * Project a verb into a kernel CLI command. The wrapper owns all argv
 * handling: kernel control flags (`--format`/`--output`/`--remote`/…) are
 * stripped first, then the verb-specific tail is coerced to typed params
 * by the codec, then `operation` (local) or the remote MCP tool runs, and
 * the **same** `render` turns the structured result into stdout text.
 *
 * @param {VerbRegistration} verb
 * @returns {CommandRegistration}
 * @ref LLP 0034#verbs [implements]: one declaration → a CLI command and an MCP tool; the kernel owns both adapters so the flag set and the tool schema never drift
 */
export function verbToCommand(verb) {
  /** @type {CommandRegistration} */
  const command = {
    name: verb.name,
    ...(verb.aliases ? { aliases: verb.aliases } : {}),
    ...(verb.category ? { category: verb.category } : {}),
    ...(verb.audience ? { audience: verb.audience } : {}),
    ...(verb.plugin ? { plugin: verb.plugin } : {}),
    summary: verb.summary,
    usage: usageForVerb(verb.name, verb.inputSchema),
    // A verb that needs more than a usage line says so here, and dispatch's
    // central `--help` interception renders it exactly as it does for a core
    // command. Without the passthrough a verb could not explain itself at
    // all, which is what kept `graph neighbors` at one line of help.
    // @ref LLP 0214#d1 [implements]: verbs carry long help through the registration dispatch already renders
    ...(verb.help !== undefined ? { help: verb.help } : {}),
    run: (argv, ctx) => runVerbCommand(verb, argv, ctx),
  }
  verbProjections.add(command)
  return command
}

/**
 * Whether `command` is a CLI command this module projected from a verb,
 * and so the command a released verb name is entitled to retract. A
 * plugin's own command that merely shares the name is not.
 *
 * @param {CommandRegistration | undefined} command
 * @returns {boolean}
 * @ref LLP 0264#verb [implements]: releasing a verb name gives the CLI surface back whichever kernel path projected it, and never takes somebody else's command
 */
export function isVerbProjection(command) {
  return command !== undefined && verbProjections.has(command)
}

/**
 * @param {VerbRegistration} verb
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runVerbCommand(verb, argv, ctx) {
  if (argv[0] === '--help' || argv[0] === '-h') {
    ctx.stdout.write(usageForVerb(verb.name, verb.inputSchema) + '\n')
    return 0
  }

  const ctrl = parseControlFlags(argv)
  if (!ctrl.ok) {
    ctx.stderr.write(`hyp ${verb.name}: ${ctrl.error}\n`)
    return 2
  }
  const parsed = argvToParams(verb.inputSchema, ctrl.rest)
  if (!parsed.ok) {
    ctx.stderr.write(`hyp ${verb.name}: ${parsed.error}\n`)
    ctx.stderr.write(`usage: ${usageForVerb(verb.name, verb.inputSchema)}\n`)
    return 2
  }

  /** @type {unknown} */
  let result
  if (ctrl.controls.remote !== undefined) {
    // `--refresh` is a local-cache control; the server owns its freshness,
    // so combining it with `--remote` is a hard error, not a silent ignore.
    // @ref LLP 0033#flag-compat [implements]: --remote with --refresh is rejected; other render flags stay valid
    if (ctrl.controls.refreshExplicit) {
      ctx.stderr.write(
        `hyp ${verb.name}: --refresh is a local cache control and cannot be combined with --remote (the server owns its freshness)\n`
      )
      return 2
    }
    // Lazy-loaded: the remote stack (MCP client, credential store) is only
    // reached on `--remote`, so a local `hyp <verb>` never pays for it.
    const { runRemoteVerb } = await import('../mcp/remote_verb.js')
    const { effectiveDefaultRemote } = await import('../remote/builtin_remotes.js')
    // Bare `--remote` (empty sentinel) resolves to the default target; a named
    // `--remote <name>` passes straight through.
    // @ref LLP 0062#bare-remote [implements]: bare --remote uses query.default_remote, else the shipped built-in default
    const target = ctrl.controls.remote === '' ? effectiveDefaultRemote(ctx.config) : ctrl.controls.remote
    const remote = await runRemoteVerb({ verb, params: parsed.params, target, ctx })
    if (!remote.ok) {
      ctx.stderr.write(`hyp ${verb.name}: ${remote.error}\n`)
      return remote.exitCode ?? 1
    }
    // Server-side cap (data volume) surfaced as its own stderr line, distinct
    // from the client display budget the renderer adds below.
    // @ref LLP 0033#two-truncations [implements]: server cap and client display budget are two separate stderr lines
    for (const line of remote.notices) ctx.stderr.write(line + '\n')
    result = remote.result
  } else {
    try {
      result = await verb.operation(parsed.params, buildOperationContext(ctx, ctrl.controls.refresh))
    } catch (err) {
      ctx.stderr.write(`hyp ${verb.name}: ${err instanceof Error ? err.message : String(err)}\n`)
      return 1
    }
  }

  /** @type {VerbRenderResult} */
  let rendered
  try {
    rendered = verb.render(result, ctrl.controls)
  } catch (err) {
    ctx.stderr.write(`hyp ${verb.name}: render failed: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
  if (rendered.file) await fs.writeFile(rendered.file.path, rendered.file.content)
  if (rendered.stderr) ctx.stderr.write(rendered.stderr)
  if (rendered.stdout) ctx.stdout.write(rendered.stdout)
  return rendered.exitCode ?? 0
}

/**
 * Build the local-execution context a verb's `operation` receives, from
 * the per-invocation command context. Shared by the CLI projection and
 * the local MCP host so both run the operation identically.
 *
 * `callerCwd` is the querying context's directory for the LLP 0105
 * visibility filter: the terminal's cwd for a CLI invocation, and the spawn
 * directory for the local stdio MCP host (an MCP client launches `hyp mcp`
 * inside the project it serves, so the process cwd IS the caller's context).
 * A context without a derivable cwd yields null, which the filter treats
 * fail-closed (LLP 0105 #unknown).
 *
 * @param {CommandRunContext} ctx
 * @param {'never'|'auto'|'always'} refresh
 * @returns {VerbOperationContext}
 */
export function buildOperationContext(ctx, refresh) {
  return {
    query: ctx.query,
    storage: ctx.storage,
    config: ctx.config,
    env: ctx.env,
    log: noopVerbLogger(),
    refresh,
    callerCwd: typeof ctx.cwd === 'string' && ctx.cwd.length > 0 ? ctx.cwd : null,
  }
}

/**
 * Operations route their own structured telemetry through `withSpan`; the
 * `log` handle is a convenience the query core treats as optional, so a
 * silent logger keeps the verb path free of a CLI-side logger dependency.
 *
 * @returns {PluginLogger}
 */
function noopVerbLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} }
}
