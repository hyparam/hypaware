/**
 * @import { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
 */

/**
 * Read the request body into a UTF-8 string, capped at `maxBytes`. Returns a
 * discriminated `{ value, error }` shape so callers can map errors to status
 * codes without try/catch flow.
 *
 * Body-size enforcement is two-layered: an explicit `Content-Length` over the
 * limit short-circuits before reading, and chunked uploads are bounded as
 * bytes accumulate. We do not destroy the socket on overflow; dropping chunks
 * until `end` lets the caller write a 413 response.
 *
 * @param {IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<{ value: string, status: 200, error?: undefined } | { value?: undefined, status: 400 | 413, error: string }>}
 */
export function readTextBody(req, maxBytes) {
  return new Promise((resolve) => {
    const contentLength = parseContentLength(req.headers['content-length'])
    if (contentLength !== undefined && contentLength > maxBytes) {
      resolve({ status: 413, error: 'request body too large' })
      return
    }
    /** @type {Buffer[]} */
    const chunks = []
    let size = 0
    let overflowed = false
    let resolved = false
    /** @param {{ status: 200, value: string } | { status: 400 | 413, error: string }} v */
    function done(v) {
      if (resolved) return
      resolved = true
      resolve(v)
    }
    req.on('data', (chunk) => {
      if (overflowed) return
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buf.length
      if (size > maxBytes) {
        overflowed = true
        chunks.length = 0
        return
      }
      chunks.push(buf)
    })
    req.on('end', () => {
      if (overflowed) {
        done({ status: 413, error: 'request body too large' })
        return
      }
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.length === 0) {
        done({ status: 400, error: 'empty request body' })
        return
      }
      done({ status: 200, value: raw })
    })
    req.on('error', (err) => {
      done({ status: 400, error: `request error: ${err.message}` })
    })
  })
}

/**
 * Read the request body as JSON, capped at `maxBytes`.
 *
 * @param {IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<{ value: unknown, status: 200, error?: undefined } | { value?: undefined, status: 400 | 413, error: string }>}
 */
export async function readJsonBody(req, maxBytes) {
  const body = await readTextBody(req, maxBytes)
  if (body.error) return body
  try {
    return { status: 200, value: JSON.parse(body.value) }
  } catch {
    return { status: 400, error: 'invalid JSON body' }
  }
}

/**
 * Parse a `Content-Length` header value. Returns `undefined` for missing,
 * malformed, or negative values; callers should fall through to streaming
 * accumulation in those cases.
 *
 * @param {string | string[] | undefined} value
 * @returns {number | undefined}
 */
export function parseContentLength(value) {
  if (typeof value !== 'string') return undefined
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n) || n < 0 || String(n) !== value.trim()) return undefined
  return n
}

/**
 * Strip parameters and lowercase the media type from a `Content-Type`
 * header. Returns the empty string when the header is missing.
 *
 * @param {string | string[] | undefined} value
 * @returns {string}
 */
export function parseContentType(value) {
  if (typeof value !== 'string') return ''
  const semi = value.indexOf(';')
  const head = semi === -1 ? value : value.slice(0, semi)
  return head.trim().toLowerCase()
}

/**
 * Determine the client IP for rate-limiting. v0 honors only the socket-level
 * remote address — we do not parse `X-Forwarded-For` because any deployment
 * with a trusted reverse proxy should be configured at that proxy.
 *
 * @param {IncomingMessage} req
 * @returns {string}
 */
export function clientIp(req) {
  return req.socket.remoteAddress ?? 'unknown'
}

/**
 * @param {ServerResponse} res
 * @param {number} status
 * @param {object} body
 * @param {OutgoingHttpHeaders} [headers]
 */
export function writeJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

/**
 * @param {ServerResponse} res
 * @param {number} status
 * @param {string} message
 */
export function writeError(res, status, message) {
  writeJson(res, status, { error: message })
}

/**
 * Write a JSON response with a `Retry-After` header.
 *
 * @param {ServerResponse} res
 * @param {number} status
 * @param {object} body
 * @param {number} retryAfterSeconds
 */
export function writeRetryAfterJson(res, status, body, retryAfterSeconds) {
  writeJson(res, status, body, { 'retry-after': String(retryAfterSeconds) })
}
