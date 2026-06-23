// @ts-check

/**
 * Minimal JSON-RPC 2.0 framing for the hand-rolled MCP host. The kernel
 * never `npm install`s (LLP 0008), and the protocol surface MCP needs is
 * small — `initialize` / `tools/list` / `tools/call` / `resources/*` — so
 * the implementation call here is to hand-roll JSON-RPC rather than add an
 * SDK dependency (LLP 0034 dependency note).
 *
 * @ref LLP 0034#stdio-stdout-discipline [constrained-by] — JSON-RPC is the stdout channel; helpers here produce only protocol objects
 */

export const PARSE_ERROR = -32700
export const INVALID_REQUEST = -32600
export const METHOD_NOT_FOUND = -32601
export const INVALID_PARAMS = -32602
export const INTERNAL_ERROR = -32603

/**
 * @param {string | number | null} id
 * @param {unknown} result
 * @returns {{ jsonrpc: '2.0', id: string | number | null, result: unknown }}
 */
export function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}

/**
 * @param {string | number | null} id
 * @param {number} code
 * @param {string} message
 * @param {unknown} [data]
 * @returns {{ jsonrpc: '2.0', id: string | number | null, error: { code: number, message: string, data?: unknown } }}
 */
export function jsonRpcError(id, code, message, data) {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  }
}

/**
 * Parse one JSON-RPC line. Returns the decoded message or a parse-failure
 * marker; the caller maps a failure to a `-32700` response.
 *
 * @param {string} line
 * @returns {{ ok: true, message: any } | { ok: false }}
 */
export function parseMessage(line) {
  try {
    return { ok: true, message: JSON.parse(line) }
  } catch {
    return { ok: false }
  }
}

/**
 * A JSON-RPC request carries an `id`; a notification omits it. The MCP
 * stdio transport sends `notifications/initialized` as a notification, to
 * which the server must NOT reply.
 *
 * @param {any} message
 * @returns {boolean}
 */
export function isNotification(message) {
  return message !== null && typeof message === 'object' && message.id === undefined
}
