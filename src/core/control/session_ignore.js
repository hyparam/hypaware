// @ts-check

/**
 * @import { IncomingMessage, ServerResponse } from 'node:http'
 * @import { PluginLogger } from '../../../hypaware-plugin-kernel-types.js'
 */

/**
 * The single V1 control route. The reserved `/_hypaware/` prefix is a
 * LOCAL control surface (see `isControlPath` below); this is the one
 * endpoint served under it today.
 *
 * The route is hosted by every recorder that keeps an in-memory
 * ignored-session set: the gateway proxy and the claude telemetry
 * listener. One shape (verbs, body, reply) means one client, one skill,
 * and one set of tests, which is why the handler lives in core rather
 * than in either plugin.
 * @ref LLP 0256#control-route-on-listener [implements]: the second host serves
 * the identical route, so the handler is shared machinery, not a copy
 */
export const SESSION_IGNORE_CONTROL_PATH = '/_hypaware/ignore/session'

/**
 * The name a recorder advertises in its status details (`control_routes`)
 * to say "I host the session-ignore route at my bound listener". The CLI's
 * `hyp session ignore` / `unignore` discovers additional recorders by this
 * advertisement (`resolveLiveControlRouteEndpointsFromStatus`), so offering
 * the route is stated by the recorder itself, never guessed from a source
 * name - which is what keeps the client-agnostic verb free of any list of
 * client plugins.
 * @ref LLP 0256#cli-posts-to-both [implements]
 */
export const SESSION_IGNORE_ROUTE = 'ignore/session'

/**
 * Max request-body size for a control request. The skill sends a tiny
 * `{"session_id":"..."}` object; anything larger is rejected with 413
 * rather than buffered, so a stray large body cannot grow the hosting
 * process's memory.
 */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Recognize the reserved `/_hypaware/` local control prefix. Uses the same
 * segment-boundary discipline as the gateway's `pathMatchesPrefix`:
 * `/_hypaware` itself and any `/_hypaware/...` sub-path match, but
 * `/_hypawarefoo` does not, so a look-alike upstream path is never mistaken
 * for a control request.
 *
 * @ref LLP 0066#control-path [implements]
 * @param {string} pathname
 */
export function isControlPath(pathname) {
  return pathname === '/_hypaware' || pathname.startsWith('/_hypaware/')
}

/**
 * Build the control-request callback a hosting server invokes for any
 * request under the reserved `/_hypaware/` prefix (the gateway proxy and
 * the shared OTLP server both short-circuit these BEFORE their own
 * routing, so a control request is never proxied, never starts an
 * exchange, and never reads as an OTLP export).
 *
 * One route (`GET` / `POST` / `DELETE /_hypaware/ignore/session`) over
 * the in-memory `ignoredSessions` set. The mutating verbs are idempotent by
 * `Set` semantics (re-POSTing an ignored id or DELETEing an unknown id is a
 * 200 no-op); `GET` mutates nothing and answers the membership question for
 * one id. All three return `{ session_id, ignored, total }`; the skill reads
 * `.total`. The `session_id` is an opaque token: the host never
 * interprets it, keeping the LLP 0050 provider-agnostic boundary exact.
 *
 * **`ignored: true` is set membership, and is not a verified drop.** The
 * route holds tokens, not traffic: the drop happens where the recorder
 * resolves a `session_id` for the rows it is about to write (LLP 0066 R5),
 * so this route cannot tell a live session id from a Codex thread id or a
 * typo and answers `ignored: true` for all three. Making it able to would
 * mean teaching a deliberately provider-agnostic route about client grain,
 * which is the boundary above. So the contract is the narrow one and the
 * CALLER owns resolving the right key before it posts; responses that read
 * as more than that are what LLP 0066 R14 forbids.
 * @ref LLP 0066#receipt-is-membership [constrained-by]: the route confirms the
 * write only, so callers must resolve the key rather than expect an echo to
 * prove the drop.
 *
 * @ref LLP 0066#control-path [implements]: the reserved `/_hypaware/`
 * prefix is a local control surface; this handler owns the routes served
 * under it, holding only opaque session-id tokens.
 * @ref LLP 0066#readable [implements]: the ignored-session set has a reader,
 * so an opt-out that stopped applying is discoverable rather than silent.
 * @param {{
 *   ignoredSessions: Set<string>,
 *   log?: PluginLogger,
 *   logEvent?: string,
 *   logFields?: Record<string, unknown>,
 * }} opts `logEvent` / `logFields` let each host stamp its own identity on
 * the mutation log; the defaults keep the gateway's original signal shape.
 * @returns {(req: IncomingMessage, res: ServerResponse, url: URL) => void}
 */
export function createControlHandler(opts) {
  const ignoredSessions = opts.ignoredSessions
  const log = opts.log
  const logEvent = opts.logEvent ?? 'aigw.control.ignore_session'
  const logFields = opts.logFields ?? { component: 'ai-gateway' }

  /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @param {URL} url
   */
  return function onControlRequest(req, res, url) {
    if (url.pathname !== SESSION_IGNORE_CONTROL_PATH) {
      req.resume()
      sendJson(res, 404, { error: 'unknown control path', path: url.pathname })
      return
    }

    const method = (req.method ?? 'GET').toUpperCase()

    // @ref LLP 0066#readable [implements]: the set is a privacy control, so it
    // must be readable, not only writable. `GET` answers "is this session
    // being dropped right now?" without mutating anything, which is what makes
    // the two fail-open transitions - a host restart (LLP 0066#ephemeral)
    // and a session id that changed under the client - detectable instead of
    // silent. The id rides the query string rather than a body because a
    // read has no body; `URLSearchParams` round-trips the token byte-exactly,
    // so the R5 raw-token discipline below holds for reads too.
    if (method === 'GET') {
      req.resume()
      const raw = url.searchParams.get('session_id')
      if (typeof raw !== 'string' || raw.trim().length === 0) {
        sendJson(res, 400, { error: 'session_id is required and must be a non-empty string' })
        return
      }
      sendJson(res, 200, {
        session_id: raw,
        ignored: ignoredSessions.has(raw),
        total: ignoredSessions.size,
      })
      return
    }

    if (method !== 'POST' && method !== 'DELETE') {
      req.resume()
      res.setHeader('allow', 'GET, POST, DELETE')
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
      log?.info?.(logEvent, {
        ...logFields,
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
 * The host never interprets the value; it only requires a non-empty
 * string (missing / empty / non-string → the caller returns 400).
 *
 * The returned value is the RAW string verbatim, NOT trimmed. Trimming is
 * used only to validate non-emptiness; the token itself must stay
 * byte-identical to what the caller posted, because the recorders key the
 * drop on the RAW resolved session id (Claude's `resolveClaudeSessionId`,
 * Codex's metadata/header readers, the telemetry events' `session.id`) and
 * none of them trim. Trimming here would desync the stored token from the
 * recorder's lookup key: a whitespace-padded `session_id` would be stored
 * trimmed but looked up raw, so `ignoredSessions.has()` would miss and the
 * exchange would be RECORDED despite the opt-out, the privacy-relevant
 * failure direction.
 * @ref LLP 0066#requirements: R5: the match key MUST be the session_id the
 * recorder resolves and stamps, verbatim.
 *
 * @param {unknown} body
 * @returns {string | undefined}
 */
function extractSessionId(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const value = /** @type {Record<string, unknown>} */ (body).session_id
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  return value
}

/**
 * Read a JSON request body under a hard size bound. Reports one of:
 * `{ status: 'ok', body }` (parsed JSON, `body` is `undefined` when the
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
