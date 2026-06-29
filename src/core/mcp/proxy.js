// @ts-check

import process from 'node:process'

import { Attr, getLogger } from '../observability/index.js'
import { readObservabilityEnv } from '../observability/env.js'
import { resolveToken } from '../remote/credentials.js'
import { parseRpcResponse } from './client.js'
import { INTERNAL_ERROR, jsonRpcError } from './jsonrpc.js'
import { serveStdio } from './stdio.js'

/**
 * @import { CommandRunContext } from '../../../collectivus-plugin-kernel-types.js'
 */

/**
 * `hyp mcp --remote <target>`: the **stdio proxy fallback** (LLP 0034
 * §proxy-fallback). For AI clients that can't add a remote HTTP MCP
 * directly, this serves a local stdio MCP that transparently forwards each
 * JSON-RPC message to the remote endpoint, injecting the stored
 * query-scoped credential. The client's own message ids and the
 * `Mcp-Session-Id` are preserved, so it is a thin pipe, not a re-host.
 *
 * Direct install is the primary remote path; this exists only for clients
 * without remote-MCP support, or environments still issuing the unscoped
 * token.
 *
 * @param {{ target: string, ctx: CommandRunContext }} args
 * @returns {Promise<number>}
 * @ref LLP 0034#proxy-fallback [implements]: stdio proxy injecting the 0600-stored credential; the fallback, not the primary path
 */
export async function runMcpProxy({ target, ctx }) {
  const remotes = ctx.config?.query?.remotes ?? {}
  const entry = remotes[target]
  if (!entry) {
    ctx.stderr.write(`hyp mcp: unknown remote target '${target}' - add it with 'hyp remote add ${target} <url>'\n`)
    return 2
  }
  const stateDir = readObservabilityEnv(ctx.env).stateDir
  const resolved = await resolveToken({ target, env: ctx.env, stateDir })
  if (!resolved.ok) {
    ctx.stderr.write(`hyp mcp: ${resolved.error}\n`)
    return 2
  }
  const fetchImpl = /** @type {typeof fetch | undefined} */ (globalThis.fetch)
  if (typeof fetchImpl !== 'function') {
    ctx.stderr.write('hyp mcp: no fetch implementation available for the proxy\n')
    return 1
  }

  /** @type {string | undefined} */
  let sessionId
  const log = getLogger('mcp')
  log.info('mcp.proxy_start', { [Attr.COMPONENT]: 'mcp', [Attr.OPERATION]: 'mcp.proxy', target, url: entry.url })
  // Lifecycle line to stderr: stdout is the protocol channel.
  ctx.stderr.write(`hyp mcp: proxying stdio → ${entry.url} (target '${target}')\n`)

  const server = {
    /** @param {any} message */
    async handleMessage(message) {
      const isNotify = message && typeof message === 'object' && message.id === undefined
      /** @type {Record<string, string>} */
      const headers = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${resolved.token}`,
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      }
      let res
      try {
        res = await fetchImpl(entry.url, { method: 'POST', headers, body: JSON.stringify(message) })
      } catch (err) {
        return isNotify ? null : jsonRpcError(message?.id ?? null, INTERNAL_ERROR, `proxy fetch failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      const sid = res.headers?.get?.('mcp-session-id')
      if (sid) sessionId = sid
      if (isNotify) return null
      if (!res.ok) {
        return jsonRpcError(message?.id ?? null, INTERNAL_ERROR, `remote returned HTTP ${res.status}`)
      }
      try {
        return await parseRpcResponse(res, message?.id)
      } catch (err) {
        return jsonRpcError(message?.id ?? null, INTERNAL_ERROR, err instanceof Error ? err.message : String(err))
      }
    },
  }

  const stdin = /** @type {NodeJS.ReadableStream} */ (ctx.stdin ?? process.stdin)
  await serveStdio({
    server,
    stdin,
    stdout: ctx.stdout,
    onError: (err) => log.error('mcp.proxy_error', {
      [Attr.COMPONENT]: 'mcp',
      [Attr.ERROR_KIND]: 'proxy_threw',
      message: err instanceof Error ? err.message : String(err),
    }),
  })
  log.info('mcp.proxy_stop', { [Attr.COMPONENT]: 'mcp', [Attr.OPERATION]: 'mcp.proxy' })
  return 0
}
