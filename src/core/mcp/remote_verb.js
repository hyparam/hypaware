// @ts-check

import { readObservabilityEnv } from '../observability/env.js'
import { resolveToken } from '../remote/credentials.js'
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
 * renderer — the two truncations of LLP 0033 §two-truncations.
 *
 * @param {{ verb: VerbRegistration, params: Record<string, unknown>, target: string, ctx: CommandRunContext }} args
 * @returns {Promise<{ ok: true, result: unknown, notices: string[] } | { ok: false, error: string, exitCode?: number }>}
 * @ref LLP 0033#two-truncations [implements] — server cap surfaced here as its own line; client cannot lift it
 */
export async function runRemoteVerb({ verb, params, target, ctx }) {
  const remotes = ctx.config?.query?.remotes ?? {}
  const entry = remotes[target]
  if (!entry) {
    return {
      ok: false,
      error: `unknown remote target '${target}' — add it with 'hyp remote add ${target} <url>'`,
      exitCode: 2,
    }
  }

  const stateDir = readObservabilityEnv(ctx.env).stateDir
  const resolved = await resolveToken({ target, env: ctx.env, stateDir })
  if (!resolved.ok) {
    return { ok: false, error: resolved.error, exitCode: 2 }
  }

  const client = createHttpMcpClient({ url: entry.url, token: resolved.token })
  try {
    await client.initialize()
    const toolResult = await client.callTool(verb.tool, params)
    if (toolResult?.isError) {
      const text = firstTextContent(toolResult) ?? 'remote tool reported an error'
      return { ok: false, error: text, exitCode: 1 }
    }
    const structured = toolResult?.structuredContent ?? parseTextContent(toolResult)
    return { ok: true, result: structured, notices: serverCapNotices(structured) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), exitCode: 1 }
  }
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
    `remote: ${shownPart}${capPart} — narrow the query, or read the Iceberg archive directly for bulk`,
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
