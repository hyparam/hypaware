// @ts-check

/**
 * MCP **client** over Streamable HTTP: the consumer half of remote attach
 * (LLP 0033). `hyp` is an MCP client, so `hyp <verb> --remote <target>`
 * runs the verb's operation against the remote tool of the **same**
 * `inputSchema` instead of locally (LLP 0034 §consumer-side).
 *
 * This path is **E2E-blocked** on the server's MCP route + the
 * query-scoped credential, which do not exist yet (LLP 0034
 * §server-coordination). It is written against the wire contract and
 * unit-tested through an injectable `fetchImpl`; integration-test it once
 * the server lands.
 *
 * @ref LLP 0034#pluggable-transport [implements]: the HTTP adapter the fleet server needs, reused on the client side
 */

const PROTOCOL_VERSION = '2025-06-18'

/**
 * @param {{
 *   url: string,
 *   token?: string,
 *   fetchImpl?: typeof fetch,
 *   clientInfo?: { name: string, version: string },
 * }} opts
 */
export function createHttpMcpClient(opts) {
  const maybeFetch = opts.fetchImpl ?? /** @type {typeof fetch | undefined} */ (globalThis.fetch)
  if (typeof maybeFetch !== 'function') {
    throw new Error('no fetch implementation available for the MCP client')
  }
  const doFetch = maybeFetch
  /** @type {string | undefined} */
  let sessionId
  let nextId = 1

  /**
   * @param {string} method
   * @param {unknown} [params]
   * @param {{ notify?: boolean }} [opts]
   * @returns {Promise<any>}
   */
  async function rpc(method, params, { notify = false } = {}) {
    const id = notify ? undefined : nextId++
    const body = {
      jsonrpc: '2.0',
      ...(notify ? {} : { id }),
      method,
      ...(params !== undefined ? { params } : {}),
    }
    /** @type {Record<string, string>} */
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    }
    const res = await doFetch(opts.url, { method: 'POST', headers, body: JSON.stringify(body) })
    const sid = res.headers?.get?.('mcp-session-id')
    if (sid) sessionId = sid

    if (notify) {
      // A notification gets `202 Accepted` with no body.
      if (!res.ok && res.status !== 202) throw new Error(`MCP ${method} failed: HTTP ${res.status}`)
      return undefined
    }
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        // Tag the error so the attach path can recognize an auth rejection and
        // attempt a single silent refresh + retry (LLP 0046 D5).
        throw Object.assign(
          new Error(`remote rejected the credential (HTTP ${res.status}) - re-run 'hyp remote login'`),
          { authError: true, status: res.status },
        )
      }
      const text = await safeText(res)
      throw new Error(`MCP ${method} failed: HTTP ${res.status}${text ? ` - ${text.slice(0, 200)}` : ''}`)
    }
    const message = await parseRpcResponse(res, id)
    if (message?.error) {
      throw new Error(`remote ${method} error ${message.error.code}: ${message.error.message}`)
    }
    return message?.result
  }

  return {
    /** Run the MCP handshake. Returns the server's `initialize` result. */
    async initialize() {
      const result = await rpc('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: opts.clientInfo ?? { name: 'hyp', version: '0.0.0' },
      })
      await rpc('notifications/initialized', undefined, { notify: true })
      return result
    },
    /**
     * @param {string} name
     * @param {Record<string, unknown>} [args]
     */
    async callTool(name, args) {
      return rpc('tools/call', { name, arguments: args ?? {} })
    },
    async listTools() {
      return rpc('tools/list', {})
    },
  }
}

/**
 * Parse a Streamable-HTTP response into the JSON-RPC message matching `id`.
 * The server may answer a POST with a single `application/json` body or an
 * SSE (`text/event-stream`) stream; handle both. Exported so the stdio
 * proxy ([proxy.js](./proxy.js)) shares one parser.
 *
 * @param {any} res
 * @param {string | number | undefined} id
 * @returns {Promise<any>}
 */
export async function parseRpcResponse(res, id) {
  const contentType = res.headers?.get?.('content-type') ?? ''
  const text = await res.text()
  if (contentType.includes('text/event-stream')) {
    const messages = parseSse(text)
    return pickById(messages, id) ?? messages[messages.length - 1]
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`remote returned a non-JSON response: ${text.slice(0, 200)}`)
  }
  if (Array.isArray(parsed)) return pickById(parsed, id) ?? parsed[parsed.length - 1]
  return parsed
}

/**
 * @param {string} text
 * @returns {any[]}
 */
function parseSse(text) {
  /** @type {any[]} */
  const out = []
  for (const block of text.split(/\n\n/)) {
    const dataLines = block
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice('data:'.length).trim())
    if (dataLines.length === 0) continue
    try {
      out.push(JSON.parse(dataLines.join('\n')))
    } catch {
      // skip non-JSON SSE frames (comments, keep-alives)
    }
  }
  return out
}

/**
 * @param {any[]} messages
 * @param {string | number | undefined} id
 */
function pickById(messages, id) {
  return messages.find((m) => m && typeof m === 'object' && m.id === id)
}

/** @param {any} res */
async function safeText(res) {
  try {
    return await res.text()
  } catch {
    return ''
  }
}
