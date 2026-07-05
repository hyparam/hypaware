// @ts-check

import fs from 'node:fs/promises'

import { argvToParams, parseControlFlags, usageForVerb } from './verb_codec.js'

/**
 * @import { CommandRegistration, CommandRunContext, PluginLogger, VerbOperationContext, VerbRegistration, VerbRenderResult } from '../../../hypaware-plugin-kernel-types.js'
 */

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
  return {
    name: verb.name,
    ...(verb.plugin ? { plugin: verb.plugin } : {}),
    summary: verb.summary,
    usage: usageForVerb(verb.name, verb.inputSchema),
    run: (argv, ctx) => runVerbCommand(verb, argv, ctx),
  }
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
