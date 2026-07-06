// @ts-check

/**
 * @import { IncomingMessage, ServerResponse } from 'node:http'
 * @import { PluginLogger } from '../../../../hypaware-plugin-kernel-types.js'
 */

/**
 * The single V1 control route. The reserved `/_hypaware/` prefix is a
 * LOCAL control surface (see `isControlPath` in proxy.js); this is the one
 * endpoint served under it today.
 */
const IGNORE_SESSION_PATH = '/_hypaware/ignore/session'

/**
 * Max request-body size for a control request. The skill sends a tiny
 * `{"session_id":"..."}` object; anything larger is rejected with 413
 * rather than buffered, so a stray large body cannot grow gateway memory.
 */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Build the `onControlRequest` callback the proxy invokes for any request
 * under the reserved `/_hypaware/` prefix (proxy.js short-circuits these
 * BEFORE upstream matching, so a control request is never proxied and never
 * starts an exchange).
 *
 * V1 serves one route — `POST` / `DELETE /_hypaware/ignore/session` — over
 * the in-memory `ignoredSessions` set. Both verbs are idempotent by `Set`
 * semantics (re-POSTing an ignored id or DELETEing an unknown id is a 200
 * no-op) and both return `{ session_id, ignored, total }`; the skill reads
 * `.total`. The `session_id` is an opaque token: the gateway never
 * interprets it, keeping the LLP 0050 provider-agnostic boundary exact.
 *
 * @ref LLP 0066#control-path [implements] — the reserved `/_hypaware/`
 * prefix is a local control surface; this handler owns the routes served
 * under it, holding only opaque session-id tokens.
 * @param {{
 *   ignoredSessions: Set<string>,
 *   log?: PluginLogger,
 * }} opts
 * @returns {(req: IncomingMessage, res: ServerResponse, url: URL) => void}
 */
export function createControlHandler(opts) {
  const ignoredSessions = opts.ignoredSessions
  const log = opts.log

  /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @param {URL} url
   */
  return function onControlRequest(req, res, url) {
    if (url.pathname !== IGNORE_SESSION_PATH) {
      req.resume()
      sendJson(res, 404, { error: 'unknown control path', path: url.pathname })
      return
    }

    const method = (req.method ?? 'GET').toUpperCase()
    if (method !== 'POST' && method !== 'DELETE') {
      req.resume()
      res.setHeader('allow', 'POST, DELETE')
      sendJson(res, 405, { error: 'method not allowed', method })
      return
    }

    readJsonBody(req, (result) => {
      if (result.status === 'too_large') {
        sendJson(res, 413, { error: 'request body too large', max_bytes: MAX_BODY_BYTES })
        return
      }
      if (result.status === 'error') {
        sendJson(res, 400, { error: 'could not read request body' })
        return
      }
      const sessionId = extractSessionId(result.body)
      if (!sessionId) {
        sendJson(res, 400, { error: 'session_id is required and must be a non-empty string' })
        return
      }

      let ignored
      if (method === 'POST') {
        ignoredSessions.add(sessionId)
        ignored = true
      } else {
        ignoredSessions.delete(sessionId)
        ignored = false
      }
      const total = ignoredSessions.size
      log?.info?.('aigw.control.ignore_session', {
        component: 'ai-gateway',
        operation: 'ignore_session',
        method,
        session_id: sessionId,
        ignored,
        total,
      })
      sendJson(res, 200, { session_id: sessionId, ignored, total })
    })
  }
}

/**
 * Pull the opaque `session_id` token out of a parsed control-request body.
 * The gateway never interprets the value; it only requires a non-empty
 * string (missing / empty / non-string → the caller returns 400).
 *
 * @param {unknown} body
 * @returns {string | undefined}
 */
function extractSessionId(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const value = /** @type {Record<string, unknown>} */ (body).session_id
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Read a JSON request body under a hard size bound. Reports one of:
 * `{ status: 'ok', body }` (parsed JSON — `body` is `undefined` when the
 * payload was malformed, which the caller treats as a 400 since a valid
 * control request always carries an object), `{ status: 'too_large' }`
 * (exceeded `MAX_BODY_BYTES`), or `{ status: 'error' }` (transport error).
 *
 * @param {IncomingMessage} req
 * @param {(result: { status: 'ok', body: unknown } | { status: 'too_large' } | { status: 'error' }) => void} done
 */
function readJsonBody(req, done) {
  /** @type {Buffer[]} */
  const chunks = []
  let size = 0
  let settled = false

  /** @param {{ status: 'ok', body: unknown } | { status: 'too_large' } | { status: 'error' }} result */
  function finish(result) {
    if (settled) return
    settled = true
    // Drain any remaining body into the void so the socket is not left
    // half-read (matters for the too_large / early-return paths).
    req.resume()
    done(result)
  }

  req.on('data', (chunk) => {
    if (settled) return
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      finish({ status: 'too_large' })
      return
    }
    chunks.push(chunk)
  })
  req.on('end', () => {
    if (settled) return
    const raw = Buffer.concat(chunks).toString('utf8')
    if (raw.trim().length === 0) {
      finish({ status: 'ok', body: undefined })
      return
    }
    try {
      finish({ status: 'ok', body: JSON.parse(raw) })
    } catch {
      // Malformed JSON: surface as a parsed-but-absent body so the caller
      // returns 400 (session_id required), same as a missing session_id.
      finish({ status: 'ok', body: undefined })
    }
  })
  req.on('error', () => finish({ status: 'error' }))
}

/**
 * @param {ServerResponse} res
 * @param {number} status
 * @param {object} body
 */
function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
