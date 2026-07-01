// @ts-check

import process from 'node:process'

import { Attr, getLogger } from '../observability/index.js'
import { readObservabilityEnv } from '../observability/env.js'
import { attachWithRefresh, deriveIdentityBase, describeAuthRejection, resolveAccessJwt, resolveToken } from '../remote/credentials.js'
import { describeRefreshError, NO_FETCH_MESSAGE } from '../remote/identity_client.js'
import { isAuthStatus, mcpRequestHeaders, parseRpcResponse } from './client.js'
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
  const identityBase = deriveIdentityBase(entry.url) ?? undefined
  // Fail fast (exit 2) if there is no usable credential at all. This is a
  // presence check only - resolveToken never refreshes - so a near-expiry OIDC
  // JWT does not trigger a network refresh here that the first handleMessage
  // would immediately repeat, and a transient refresh blip can't abort a proxy
  // that would otherwise start. The per-message resolveAccessJwt below does the
  // session-aware refresh.
  try {
    const probe = await resolveToken({ target, env: ctx.env, stateDir })
    if (!probe.ok) {
      ctx.stderr.write(`hyp mcp: ${probe.error}\n`)
      return 2
    }
  } catch (err) {
    ctx.stderr.write(`hyp mcp: ${describeRefreshError(err, target).message}\n`)
    return 2
  }
  const fetchImpl = /** @type {typeof fetch | undefined} */ (globalThis.fetch)
  if (typeof fetchImpl !== 'function') {
    ctx.stderr.write(`hyp mcp: ${NO_FETCH_MESSAGE} for the proxy\n`)
    return 1
  }

  /** @type {string | undefined} */
  let sessionId
  const log = getLogger('mcp')
  log.info('mcp.proxy_start', { [Attr.COMPONENT]: 'mcp', [Attr.OPERATION]: 'mcp.proxy', target, url: entry.url })
  // Lifecycle line to stderr: stdout is the protocol channel.
  ctx.stderr.write(`hyp mcp: proxying stdio → ${entry.url} (target '${target}')\n`)

  /** Forward one message to the remote with the given bearer token. */
  const forward = (/** @type {any} */ message, /** @type {string} */ token) => {
    const headers = mcpRequestHeaders({ token, sessionId })
    return fetchImpl(entry.url, { method: 'POST', headers, body: JSON.stringify(message) })
  }

  const server = {
    /** @param {any} message */
    async handleMessage(message) {
      const isNotify = message && typeof message === 'object' && message.id === undefined
      const id = message?.id ?? null

      // Resolve a fresh access JWT per message: an OIDC session silently
      // refreshes a near-expiry JWT, env/static tokens pass through unchanged.
      let resolved
      try {
        resolved = await resolveAccessJwt({ target, env: ctx.env, stateDir, identityBase })
      } catch (err) {
        return isNotify ? null : jsonRpcError(id, INTERNAL_ERROR, describeRefreshError(err, target).message)
      }
      if (!resolved.ok) {
        return isNotify ? null : jsonRpcError(id, INTERNAL_ERROR, resolved.error)
      }

      // Forward via the shared attach policy: a live 401/403 on a refreshable
      // OIDC session forces one refresh + retry before surfacing (LLP 0058 D5);
      // an env/static token cannot refresh, so its 401 falls through. `op` folds
      // both the fetch outcome and a fetch failure into `value`, so the retry
      // decision stays in attachWithRefresh and never throws here.
      /** @type {(token: string) => Promise<{ authFailed: boolean, value: { res: Awaited<ReturnType<typeof forward>> } | { err: unknown } }>} */
      const op = async (token) => {
        try {
          const res = await forward(message, token)
          return { authFailed: isAuthStatus(res.status), value: { res } }
        } catch (err) {
          return { authFailed: false, value: { err } }
        }
      }
      let out
      try {
        out = await attachWithRefresh({
          resolved,
          refresh: () => resolveAccessJwt({ target, env: ctx.env, stateDir, identityBase, forceRefresh: true }),
          op,
        })
      } catch (err) {
        return isNotify ? null : jsonRpcError(id, INTERNAL_ERROR, describeRefreshError(err, target).message)
      }
      if (!out.ok) {
        // The forced refresh could not produce a token (e.g. no identity
        // endpoint). Surface that reason rather than letting the stale 401
        // fall through to a generic "remote returned HTTP 401" with no guidance.
        return isNotify ? null : jsonRpcError(id, INTERNAL_ERROR, out.error)
      }
      if ('err' in out.value) {
        const err = out.value.err
        return isNotify ? null : jsonRpcError(id, INTERNAL_ERROR, `proxy fetch failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      const res = out.value.res

      const sid = res.headers?.get?.('mcp-session-id')
      if (sid) sessionId = sid
      if (isNotify) return null
      if (!res.ok) {
        // A 401/403 that survives the refresh + retry above is a dead
        // credential. Explain by why it is dead - a refreshable OIDC session is
        // an expired session (re-login), a per-target env override re-login
        // cannot fix, a static file token re-login replaces - via the shared
        // policy the verb attach path also uses, so the two never drift.
        const detail = !isAuthStatus(res.status)
          ? `remote returned HTTP ${res.status}`
          : describeAuthRejection({ target, status: res.status, resolved }).message
        return jsonRpcError(id, INTERNAL_ERROR, detail)
      }
      try {
        return await parseRpcResponse(res, message?.id)
      } catch (err) {
        return jsonRpcError(id, INTERNAL_ERROR, err instanceof Error ? err.message : String(err))
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
