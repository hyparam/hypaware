// @ts-check

import { createRequire } from 'node:module'
import { parseCommandArgv } from '../cli/verb_codec.js'
import process from 'node:process'

import { Attr, getLogger } from '../observability/index.js'
import { createMcpServer } from '../mcp/server.js'
import { serveStdio } from '../mcp/stdio.js'
import { buildOperationContext } from '../cli/verb_command.js'

/**
 * @import { CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
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
    ctx.stderr.write(`hyp mcp: ${parsed.error}\n`)
    return 2
  }
  if (parsed.http) {
    ctx.stderr.write('hyp mcp: --http is a follow-up; only stdio is supported in V1 (LLP 0034 §implementation-sequencing)\n')
    return 2
  }
  if (parsed.remote) {
    // Fallback for clients without remote-MCP support: a stdio proxy that
    // injects the stored query-scoped credential (LLP 0034 §proxy-fallback).
    const { runMcpProxy } = await import('../mcp/proxy.js')
    return runMcpProxy({ target: parsed.remote, ctx })
  }

  const require = createRequire(import.meta.url)
  const { version } = require('../../../package.json')
  const server = createMcpServer({
    verbs: ctx.verbs,
    query: ctx.query,
    runTool: (verb, params) => Promise.resolve(verb.operation(params, buildOperationContext(ctx, 'auto'))),
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
  ctx.stderr.write(`hyp mcp: serving ${tools.length} tool(s) over stdio${tools.length ? ` (${tools.map((t) => t.name).join(', ')})` : ''}\n`)

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
 * @returns {{ ok: true, remote: string | undefined, http: boolean } | { ok: false, error: string }}
 */
function parseMcpArgv(argv) {
  const parsed = parseCommandArgv(argv, {
    type: 'object',
    properties: {
      remote: { type: 'string' },
      http: { type: 'boolean', default: false },
    },
  })
  if ('help' in parsed) return { ok: false, error: 'usage: hyp mcp [--remote <target>]' }
  if (!parsed.ok) return parsed
  const p = /** @type {{ remote?: string, http: boolean }} */ (parsed.params)
  return { ok: true, remote: p.remote, http: p.http }
}
