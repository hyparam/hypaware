// @ts-check

import { createRequire } from 'node:module'
import { parseCommandArgv } from '../cli/verb_codec.js'
import process from 'node:process'

import { Attr, getLogger } from '../observability/index.js'
import { createMcpServer } from '../mcp/server.js'
import { serveStdio } from '../mcp/stdio.js'
import { buildOperationContext } from '../cli/verb_command.js'
import { pluginScopedConfig } from '../config/plugin_scope.js'

/**
 * @import { CommandRunContext, HypAwareV2Config, PluginName } from '../../../hypaware-plugin-kernel-types.js'
 */

/**
 * `hyp mcp`: serve this host's verbs as an MCP server. The tool surface is
 * assembled dynamically from the verbs the active plugins registered (LLP
 * 0034): a bare host offers `query_sql`; add `@hypaware/context-graph` and
 * `graph_neighbors` appears. Local stdio is local-user trust (same as
 * running `hyp query` at the terminal), so no auth and operator tools are
 * exposed.
 *
 * stdout is the JSON-RPC channel; the lifecycle line and all logs go to
 * stderr/telemetry, never stdout.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 * @ref LLP 0034#kernel-wide-not-server-only [implements]: a local gateway exposes its own active plugins' tools to a local AI client
 */
export async function runMcp(argv, ctx) {
  const parsed = parseMcpArgv(argv)
  if (!parsed.ok) {
    ctx.stderr.write(`hyp mcp serve: ${parsed.error}\n`)
    return 2
  }
  if (parsed.http) {
    ctx.stderr.write('hyp mcp serve: --http is a follow-up; only stdio is supported in V1 (LLP 0034 §implementation-sequencing)\n')
    return 2
  }
  if (parsed.remote) {
    // Fallback for clients without remote-MCP support: a stdio proxy that
    // injects the stored query-scoped credential (LLP 0034 §proxy-fallback).
    const { runMcpProxy } = await import('../mcp/proxy.js')
    return runMcpProxy({ target: parsed.remote, org: parsed.org, ctx })
  }

  const require = createRequire(import.meta.url)
  const { version } = require('../../../package.json')
  // Whose verb each tool call ran. `hyp mcp` is core's own command, so
  // `ctx.config` is the whole effective config, and running every tool against
  // it handed a plugin's `operation` every other plugin's `plugins[]` config
  // and a configured sink's inline credential (issue #1982).
  //
  // The host (`createMcpServer.callTool`) settles the owner from the same
  // resolution that produced the verb, before any plugin property runs, and
  // hands it here. This function never re-asks the registry: a plugin whose
  // `inputSchema` accessor unregisters its own verb mid-dispatch cannot make a
  // later lookup answer `undefined` and so cannot widen its slice back to the
  // whole config.
  /**
   * The slice each owner reads, built on its first tool call and kept for the
   * session. `ctx.config` and `ctx.plugins` are fixed for this invocation,
   * so a long-lived stdio host pays one slice per plugin that owns a tool
   * rather than one per `tools/call`. Bounded by the active plugin set.
   *
   * @type {Map<PluginName, HypAwareV2Config>}
   * @ref LLP 0425#session-slice [implements]: one slice per owner per session, not one per tools/call
   */
  const scopedConfigs = new Map()
  /**
   * @param {PluginName | undefined} owner the plugin that registered the verb, captured by the host at the instant it resolved the tool
   * @returns {HypAwareV2Config}
   * @ref LLP 0425#tool-owner [implements]: the owner is captured at resolution and carried forward; an ownerless verb is core's, authoritatively so because no plugin code ran between resolution and this read
   */
  function configForOwner(owner) {
    // `undefined` means core registered this verb (`registerCoreVerbs` runs
    // outside any activation, so it is ownerless): `query_sql` keeps the whole
    // config, as `hyp query sql` does. It is authoritative here, not a missing
    // answer, because the host captured `owner` at the resolution instant
    // before a single plugin property ran, so it can never be an owner a
    // mid-dispatch `unregister` erased from the ledger.
    if (owner === undefined) return ctx.config
    let scoped = scopedConfigs.get(owner)
    if (scoped === undefined) {
      scoped = pluginScopedConfig(ctx.config, owner, ctx.plugins)
      scopedConfigs.set(owner, scoped)
    }
    return scoped
  }
  const server = createMcpServer({
    verbs: ctx.verbs,
    query: ctx.query,
    // buildOperationContext derives `callerCwd` from ctx.cwd: an MCP client
    // spawns this stdio server inside the project it serves, so the process
    // cwd IS the querying context and the LLP 0105 visibility filter resolves
    // the caller's real class instead of the fail-closed unknown backstop.
    // A future transport that cannot derive one (e.g. --http) must pass a ctx
    // whose cwd is absent so the filter stays fail-closed (LLP 0105 #unknown).
    // `owner` is settled by the host at the same instant it resolves the tool,
    // the CLI route's order: dispatch narrows the command context from
    // `registry.ownerOf(matched.invokedName)` before it runs any plugin code.
    // @ref LLP 0422#scope [implements]: a plugin's verb operation reads its own slice on whichever surface invoked it
    runTool: (verb, params, owner) => {
      const opCtx = buildOperationContext(ctx, 'auto')
      opCtx.config = configForOwner(owner)
      return Promise.resolve(verb.operation(params, opCtx))
    },
    transport: 'stdio',
    allowOperator: true,
    serverVersion: version,
  })

  const tools = server.listTools()
  const log = getLogger('mcp')
  log.info('mcp.serve_start', {
    [Attr.COMPONENT]: 'mcp',
    [Attr.OPERATION]: 'mcp.serve',
    transport: 'stdio',
    tool_count: tools.length,
  })
  // Lifecycle line to stderr (stdout is reserved for the protocol).
  ctx.stderr.write(`hyp mcp serve: serving ${tools.length} tool(s) over stdio${tools.length ? ` (${tools.map((t) => t.name).join(', ')})` : ''}\n`)

  const stdin = /** @type {NodeJS.ReadableStream} */ (ctx.stdin ?? process.stdin)
  await serveStdio({
    server,
    stdin,
    stdout: ctx.stdout,
    onError: (err) => log.error('mcp.handler_error', {
      [Attr.COMPONENT]: 'mcp',
      [Attr.ERROR_KIND]: 'handler_threw',
      message: err instanceof Error ? err.message : String(err),
    }),
  })
  log.info('mcp.serve_stop', { [Attr.COMPONENT]: 'mcp', [Attr.OPERATION]: 'mcp.serve' })
  return 0
}

/**
 * Parse `hyp mcp` flags: `--remote <target>` (stdio proxy), `--http`
 * (reserved follow-up).
 *
 * @param {string[]} argv
 * @returns {{ ok: true, remote: string | undefined, org?: string, http: boolean } | { ok: false, error: string }}
 */
function parseMcpArgv(argv) {
  const parsed = parseCommandArgv(argv, {
    type: 'object',
    properties: {
      remote: { type: 'string' },
      org: { type: 'string' },
      http: { type: 'boolean', default: false },
    },
  })
  if ('help' in parsed) return { ok: false, error: 'usage: hyp mcp serve [--remote <target> [--org <label|*>]]' }
  if (!parsed.ok) return parsed
  const p = /** @type {{ remote?: string, org?: string, http: boolean }} */ (parsed.params)
  // Value check first: `--org=` with no --remote is an empty selector, and
  // saying so beats blaming the missing target for it.
  if (p.org === '') return { ok: false, error: '--org expects an org label or *' }
  if (p.org !== undefined && !p.remote) return { ok: false, error: '--org requires --remote' }
  return { ok: true, remote: p.remote, org: p.org, http: p.http }
}
