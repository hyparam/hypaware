// @ts-check

import { McpRpcError, isAuthStatus, mcpRequestHeaders, parseRpcResponse } from '../../../../src/core/mcp/client.js'
import { deriveMcpEndpoint } from '../../../../src/core/remote/credentials.js'
import { discardBody } from '../../../../src/core/util/backoff.js'

/**
 * @import { EvidenceForwardResult, EvidenceSessionRecord, ReplicaTarget } from '../../../../hypaware-core/plugins-workspace/fastask/src/types.js'
 */

const PROTOCOL_VERSION = '2025-06-18'
const TOOL = 'session_evidence'
export const EVIDENCE_CONTRACT = 'hypaware.session-evidence/1'
/** A rejected reuse right after a fresh session twice in a row: the server does not keep sessions. */
const PER_CALL_AFTER = 2

/**
 * The daemon half of the warm evidence path: one MCP session per remote,
 * initialized once and kept between calls, so a `hyp fastask` on the warm
 * path pays one round trip instead of `initialize`, `tools/list` and the
 * call. Per remote it records whether `session_evidence` is offered with the
 * `hypaware.session-evidence/1` contract, under which server version.
 *
 * The session is dropped and re-initialized when the server rejects it
 * (HTTP 404 or 400 on a request that carried the session id), answers
 * `-32601` or `-32602`, or reports another server version. A rejected
 * session is retried once on a fresh one. If even a fresh session is
 * refused on reuse twice in a row, the remote is recorded as per-call and
 * every call initializes first (`per_call` in status).
 *
 * The caller's `signal` reaches the upstream request, so a command that
 * gives up aborts the server's work too. A bearer comes from the target on
 * every call, with one forced refresh on a 401.
 *
 * The core MCP client fixes its signal and token per client and keeps its
 * session id private, so this keeps its own small request loop over the
 * client's exported header, parsing and error pieces.
 *
 * @ref LLP 0480#warm-connection [implements]: one kept-alive session per remote, re-initialized on rejection, -32601/-32602 or a server version change; the caller's abort propagates; per-call fallback recorded
 * @param {{ fetchImpl?: typeof fetch, now?: () => number, clientInfo?: { name: string, version: string } }} [opts]
 */
export function createEvidenceForwarder(opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const now = opts.now ?? (() => performance.now())
  const clientInfo = opts.clientInfo ?? { name: 'hyp-fastask', version: '1' }
  /** @type {Map<string, EvidenceSessionRecord & { pending: Promise<void> | null, ready: boolean, token: string | null, rejections: number, nextId: number }>} */
  const sessions = new Map()

  /**
   * @param {string} endpoint
   */
  function sessionFor(endpoint) {
    let s = sessions.get(endpoint)
    if (!s) {
      s = {
        endpoint,
        session_id: null,
        server_version: null,
        supports_evidence: null,
        contracts: [],
        per_call: false,
        initializes: 0,
        last_round_trip_ms: null,
        pending: null,
        ready: false,
        token: null,
        rejections: 0,
        nextId: 1,
      }
      sessions.set(endpoint, s)
    }
    return s
  }

  /**
   * One JSON-RPC request on the session. Throws `SessionRejected`,
   * `McpRpcError`, an auth error (`status` 401/403) or a transport error.
   *
   * @param {ReturnType<typeof sessionFor>} s
   * @param {string} method
   * @param {unknown} params
   * @param {AbortSignal} signal
   * @param {{ notify?: boolean }} [flags]
   */
  async function rpc(s, method, params, signal, flags = {}) {
    const id = flags.notify ? undefined : s.nextId++
    const sentSession = s.session_id ?? undefined
    signal.throwIfAborted()
    const res = await fetchImpl(s.endpoint, {
      method: 'POST',
      headers: mcpRequestHeaders({ token: s.token ?? undefined, sessionId: sentSession }),
      body: JSON.stringify({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, ...(params !== undefined ? { params } : {}) }),
      redirect: 'error',
      signal,
    })
    const sid = res.headers.get('mcp-session-id')
    if (sid) s.session_id = sid
    if (isAuthStatus(res.status)) {
      await discardBody(res)
      throw Object.assign(new Error(`MCP ${method}: HTTP ${res.status}`), { status: res.status })
    }
    if (sentSession && (res.status === 404 || res.status === 400)) {
      await discardBody(res)
      throw new SessionRejected(res.status)
    }
    if (flags.notify) {
      await discardBody(res)
      if (!res.ok && res.status !== 202) throw new Error(`MCP ${method}: HTTP ${res.status}`)
      return undefined
    }
    if (!res.ok) {
      await discardBody(res)
      throw new Error(`MCP ${method}: HTTP ${res.status}`)
    }
    const message = await parseRpcResponse(res, id)
    if (message?.error) throw new McpRpcError(method, message.error.code, message.error.message)
    return message?.result
  }

  /**
   * `initialize`, `notifications/initialized` and `tools/list`, recording
   * what the server offers. Concurrent callers share one handshake.
   *
   * @param {ReturnType<typeof sessionFor>} s
   * @param {AbortSignal} signal
   */
  function initialize(s, signal) {
    if (s.pending) return s.pending
    s.pending = (async () => {
      s.session_id = null
      s.ready = false
      const init = await rpc(s, 'initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo }, signal)
      s.initializes++
      const version = typeof init?.serverInfo?.version === 'string' ? init.serverInfo.version : null
      await rpc(s, 'notifications/initialized', undefined, signal, { notify: true })
      const listed = await rpc(s, 'tools/list', {}, signal)
      const tool = Array.isArray(listed?.tools) ? listed.tools.find((/** @type {any} */ t) => t?.name === TOOL) : undefined
      const contracts = tool?.inputSchema?.properties?.contract?.enum
      s.contracts = Array.isArray(contracts) ? contracts.filter((c) => typeof c === 'string') : []
      s.supports_evidence = Boolean(tool) && s.contracts.includes(EVIDENCE_CONTRACT)
      s.server_version = version
      s.ready = true
    })().finally(() => { s.pending = null })
    return s.pending
  }

  /**
   * Forwards one `session_evidence` call for `target`.
   *
   * @param {{ target: ReplicaTarget, args: Record<string, unknown>, signal: AbortSignal }} call
   * @returns {Promise<EvidenceForwardResult>}
   */
  async function forward({ target, args, signal }) {
    const s = sessionFor(deriveMcpEndpoint(target.url))
    let resolved = await target.token(false).catch((err) => ({ ok: /** @type {const} */ (false), error: messageOf(err) }))
    if (!resolved.ok) return { ok: false, kind: 'credential', message: resolved.error, session: record(s) }
    s.token = resolved.token
    let refreshed = false
    let retried = false

    for (;;) {
      let fresh = false
      try {
        if (!s.ready || s.per_call) {
          await initialize(s, signal)
          fresh = true
        }
        if (!s.supports_evidence) {
          return { ok: false, kind: 'unsupported', message: `server offers no ${TOOL} with ${EVIDENCE_CONTRACT}`, session: record(s) }
        }
        const started = now()
        const result = await rpc(s, 'tools/call', { name: TOOL, arguments: args }, signal)
        const elapsed = now() - started
        const content = result?.structuredContent
        const serverElapsed = typeof content?.elapsed_ms === 'number' ? content.elapsed_ms : 0
        s.last_round_trip_ms = Math.max(0, Math.round(elapsed - serverElapsed))
        if (!fresh) s.rejections = 0
        const version = typeof content?.server_version === 'string' ? content.server_version : null
        // A server upgraded under a live session may offer another contract
        // set: look again before the next call.
        if (version !== null && s.server_version !== null && version !== s.server_version) s.ready = false
        return { ok: true, result, round_trip_ms: s.last_round_trip_ms, reused: !fresh, session: record(s) }
      } catch (err) {
        if (signal.aborted) throw signal.reason
        if (err instanceof SessionRejected && !retried) {
          // A rejected reuse: retry once on a fresh session. Refused even
          // right after a fresh one, repeatedly: go per call.
          retried = true
          s.ready = false
          if (fresh || ++s.rejections >= PER_CALL_AFTER) s.per_call = true
          continue
        }
        if (/** @type {any} */ (err)?.status === 401 && !refreshed) {
          refreshed = true
          resolved = await target.token(true).catch((e) => ({ ok: /** @type {const} */ (false), error: messageOf(e) }))
          if (!resolved.ok) return { ok: false, kind: 'credential', message: resolved.error, session: record(s) }
          s.token = resolved.token
          continue
        }
        if (err instanceof McpRpcError) {
          // -32601 (no such tool) and -32602 (arguments outside the
          // advertised schema) mean what this session recorded is stale.
          if (err.rpcCode === -32601 || err.rpcCode === -32602) s.ready = false
          return { ok: false, kind: 'rpc', code: err.rpcCode, message: err.rpcMessage, session: record(s) }
        }
        const status = /** @type {any} */ (err)?.status
        if (status === 401 || status === 403) return { ok: false, kind: 'credential', message: messageOf(err), session: record(s) }
        s.ready = false
        return { ok: false, kind: 'network', message: messageOf(err), session: record(s) }
      }
    }
  }

  /** Per-remote records for status. */
  function status() {
    return [...sessions.values()].map(record)
  }

  return { forward, status }
}

/**
 * @param {EvidenceSessionRecord} s
 * @returns {EvidenceSessionRecord}
 */
function record(s) {
  return {
    endpoint: s.endpoint,
    session_id: s.session_id ? 'present' : null,
    server_version: s.server_version,
    supports_evidence: s.supports_evidence,
    contracts: [...s.contracts],
    per_call: s.per_call,
    initializes: s.initializes,
    last_round_trip_ms: s.last_round_trip_ms,
  }
}

class SessionRejected extends Error {
  /** @param {number} status */
  constructor(status) {
    super(`MCP session rejected (HTTP ${status})`)
    this.status = status
  }
}

/** @param {unknown} err */
function messageOf(err) {
  return err instanceof Error ? err.message : String(err)
}
