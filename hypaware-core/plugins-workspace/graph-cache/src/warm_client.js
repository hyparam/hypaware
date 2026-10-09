// @ts-check

import { McpRpcError } from '../../../../src/core/mcp/client.js'
import { readBodyCapped } from '../../../../src/core/util/backoff.js'
import { EVIDENCE_MAX_RESPONSE_BYTES, EVIDENCE_TOOL } from './evidence.js'
import { EVIDENCE_ROUTE } from './replica_source.js'

/**
 * @import { EvidenceForwardResult, EvidenceMcpClient, WarmScope } from '../../../../hypaware-core/plugins-workspace/graph-cache/src/types.js'
 */

/** The prefix of the error a scope refusal raises; the command reads the server instead. */
export const SCOPE_MISMATCH = 'scope_mismatch'

/**
 * The command side of the warm evidence path: an `EvidenceMcpClient` (the
 * interface T7's evidence client reads through) that sends the call to the
 * running daemon's control route instead of the remote, so the command pays
 * no MCP handshake. Each forwarded answer is turned back into what a direct
 * MCP client would have produced, so `callEvidence` reads both alike:
 *
 * - a tool result (success or `isError`) is returned as is;
 * - `-32601`, `-32602` and a server without the verb become `McpRpcError`
 *   (the last as `-32601`, which the evidence client treats as "fall back");
 * - the org read capacity (`429`) becomes an error with `status: 429`, which
 *   the evidence client retries once;
 * - credential and network failures become plain errors.
 *
 * Only `session_evidence` is forwarded. The per-session `query_sql`
 * fallback is the slower labeled path and goes over a cold connection.
 * `signal` is the command's budget: aborting it drops the request to the
 * daemon, which aborts the upstream call.
 *
 * @ref LLP 0480#warm-connection [implements]: the warm path sends the evidence request to the daemon's control route
 * @param {{ endpoint: string, token: string, scope: WarmScope, signal?: AbortSignal, fetchImpl?: typeof fetch }} opts
 *   `scope` is the caller's resolved remote, org and login; the daemon refuses a mismatch (`scope_mismatch`)
 *   `endpoint` is the daemon listener's base URL, as status advertises it
 * @returns {EvidenceMcpClient & { lastRoundTripMs: number | null }}
 */
export function createWarmEvidenceClient(opts) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const url = `${opts.endpoint.replace(/\/+$/, '')}/_hypaware/${EVIDENCE_ROUTE}`
  const client = {
    /** The daemon's last measured round trip to the server, for the next deadline. */
    lastRoundTripMs: /** @type {number | null} */ (null),
    /**
     * @param {string} name
     * @param {Record<string, unknown>} [args]
     */
    async callTool(name, args) {
      if (name !== EVIDENCE_TOOL) throw new Error(`the warm path forwards ${EVIDENCE_TOOL} only, not ${name}`)
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.token}` },
        body: JSON.stringify({ arguments: args ?? {}, scope: opts.scope }),
        redirect: 'error',
        signal: opts.signal,
      })
      if (res.status === 409) {
        const refusal = /** @type {any} */ (await res.json().catch(() => null))
        if (refusal?.error === 'scope_mismatch') {
          throw Object.assign(new Error(`${SCOPE_MISMATCH}: the daemon's replica belongs to another ${refusal.reason ?? 'remote'}`), { code: SCOPE_MISMATCH })
        }
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {})
        throw new Error(`the daemon's evidence route answered HTTP ${res.status}`)
      }
      // The daemon relays the server's capped answer: read no more than that bound.
      const body = await readBodyCapped(res, EVIDENCE_MAX_RESPONSE_BYTES, opts.signal)
      if (!body.ok) throw new Error(`the daemon's evidence answer exceeds ${EVIDENCE_MAX_RESPONSE_BYTES} bytes`)
      const out = /** @type {EvidenceForwardResult} */ (JSON.parse(body.body))
      if (out.ok) {
        client.lastRoundTripMs = out.round_trip_ms
        return out.result
      }
      if (out.kind === 'rpc') throw new McpRpcError('tools/call', out.code, out.message)
      if (out.kind === 'unsupported') throw new McpRpcError('tools/call', -32601, out.message)
      if (out.kind === 'capacity') throw Object.assign(new Error(out.message), { status: 429 })
      throw new Error(out.message)
    },
  }
  return client
}
