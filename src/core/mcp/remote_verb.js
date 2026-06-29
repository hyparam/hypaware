// @ts-check

import { readObservabilityEnv } from '../observability/env.js'
import { deriveIdentityBase, resolveAccessJwt } from '../remote/credentials.js'
import { InvalidGrantError } from '../remote/identity_client.js'
import { createHttpMcpClient } from './client.js'

/**
 * @import { CommandRunContext, VerbRegistration } from '../../../collectivus-plugin-kernel-types.js'
 */

/**
 * Run a verb against a remote MCP tool. Resolves the named target's URL
 * (local config `query.remotes`) + the query-scoped token (env → file),
 * calls the remote tool of the same `inputSchema`, and returns the
 * structured result for the verb's **same** `render` to format.
 *
 * Surfaces the **server-side cap** (data volume) as a distinct notice line;
 * the client display budget (context volume) is added separately by the
 * renderer: the two truncations of LLP 0033 §two-truncations.
 *
 * @param {{ verb: VerbRegistration, params: Record<string, unknown>, target: string, ctx: CommandRunContext }} args
 * @returns {Promise<{ ok: true, result: unknown, notices: string[] } | { ok: false, error: string, exitCode?: number }>}
 * @ref LLP 0033#two-truncations [implements]: server cap surfaced here as its own line; client cannot lift it
 */
export async function runRemoteVerb({ verb, params, target, ctx }) {
  const remotes = ctx.config?.query?.remotes ?? {}
  const entry = remotes[target]
  if (!entry) {
    return {
      ok: false,
      error: `unknown remote target '${target}' - add it with 'hyp remote add ${target} <url>'`,
      exitCode: 2,
    }
  }

  const stateDir = readObservabilityEnv(ctx.env).stateDir
  const identityBase = deriveIdentityBase(entry.url) ?? undefined
  /** @type {Awaited<ReturnType<typeof resolveAccessJwt>>} */
  let resolved
  try {
    // The initial resolve can itself refresh (and fail) when the stored JWT is
    // already stale; map an invalid_grant here too, not only on the 401 retry.
    resolved = await resolveAccessJwt({ target, env: ctx.env, stateDir, identityBase })
  } catch (err) {
    return mapRefreshError(err, target)
  }
  if (!resolved.ok) {
    return { ok: false, error: resolved.error, exitCode: 2 }
  }

  /** Run one full attach attempt with a given bearer token. */
  const attempt = (/** @type {string} */ token) => callRemoteTool({ url: entry.url, token, verb, params })

  try {
    return await attempt(resolved.token)
  } catch (err) {
    // A live 401/403 on an OIDC session means the cached JWT is stale or was
    // revoked early. Refresh once and retry before surfacing (LLP 0046 D5). An
    // env override or a static token cannot be refreshed, so it surfaces as-is.
    const refreshable = resolved.kind === 'oidc' && resolved.source === 'file'
    if (!refreshable || !isAuthError(err)) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), exitCode: 1 }
    }
    /** @type {Awaited<ReturnType<typeof resolveAccessJwt>>} */
    let refreshed
    try {
      refreshed = await resolveAccessJwt({ target, env: ctx.env, stateDir, identityBase, forceRefresh: true })
    } catch (refreshErr) {
      return mapRefreshError(refreshErr, target)
    }
    if (!refreshed.ok) {
      return { ok: false, error: refreshed.error, exitCode: 2 }
    }
    try {
      return await attempt(refreshed.token)
    } catch (retryErr) {
      return { ok: false, error: retryErr instanceof Error ? retryErr.message : String(retryErr), exitCode: 1 }
    }
  }
}

/**
 * One remote attach attempt: initialize, call the tool, and shape the result.
 * Throws on transport/auth errors (so the caller can retry); a tool-level
 * `isError` is a normal return, not a throw (it is not retryable).
 *
 * @param {{ url: string, token: string, verb: VerbRegistration, params: Record<string, unknown> }} args
 * @returns {Promise<{ ok: true, result: unknown, notices: string[] } | { ok: false, error: string, exitCode: number }>}
 */
async function callRemoteTool({ url, token, verb, params }) {
  const client = createHttpMcpClient({ url, token })
  await client.initialize()
  const toolResult = await client.callTool(verb.tool, params)
  if (toolResult?.isError) {
    const text = firstTextContent(toolResult) ?? 'remote tool reported an error'
    return { ok: false, error: text, exitCode: 1 }
  }
  const structured = toolResult?.structuredContent ?? parseTextContent(toolResult)
  return { ok: true, result: structured, notices: serverCapNotices(structured) }
}

/**
 * Map a refresh failure to a verb result: a typed `invalid_grant` (the refresh
 * row was revoked or expired) becomes the re-login guidance (LLP 0046 D5); any
 * other failure is a generic error.
 *
 * @param {unknown} err
 * @param {string} target
 * @returns {{ ok: false, error: string, exitCode: number }}
 */
function mapRefreshError(err, target) {
  if (err instanceof InvalidGrantError) {
    return { ok: false, error: `remote session expired - re-run 'hyp remote login ${target}'`, exitCode: 2 }
  }
  return { ok: false, error: err instanceof Error ? err.message : String(err), exitCode: 1 }
}

/**
 * Whether a thrown error is an MCP-client auth rejection (a 401/403 tagged by
 * `client.js`), eligible for a one-shot refresh + retry.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isAuthError(err) {
  return !!err && typeof err === 'object' &&
    (/** @type {any} */ (err).authError === true || /** @type {any} */ (err).status === 401 || /** @type {any} */ (err).status === 403)
}

/**
 * Build the server-cap stderr line when the remote tool marked its result
 * truncated. Those rows never left the server; the client cannot lift this
 * cap (LLP 0033 §two-truncations). The exact field shape is server-owned
 * (out of tree); read it defensively.
 *
 * @param {any} structured
 * @returns {string[]}
 */
function serverCapNotices(structured) {
  if (!structured || typeof structured !== 'object' || !structured.truncated) return []
  const shown = Array.isArray(structured.rows) ? structured.rows.length : structured.row_count
  const cap = structured.server_cap?.rows ?? structured.cap?.rows ?? structured.limit
  const capPart = cap !== undefined ? ` (server cap rows:${cap})` : ''
  const shownPart = shown !== undefined ? `showing first ${shown} rows` : 'result truncated'
  return [
    `remote: ${shownPart}${capPart} - narrow the query, or read the Iceberg archive directly for bulk`,
  ]
}

/** @param {any} toolResult */
function firstTextContent(toolResult) {
  const item = Array.isArray(toolResult?.content)
    ? toolResult.content.find((/** @type {any} */ c) => c?.type === 'text')
    : undefined
  return typeof item?.text === 'string' ? item.text : undefined
}

/** @param {any} toolResult */
function parseTextContent(toolResult) {
  const text = firstTextContent(toolResult)
  if (typeof text !== 'string') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return { text }
  }
}
