// @ts-check

// Remote query client: POST SQL to the central server's admin query
// endpoint and shape the response like a local `executeQuerySql` result.
//
// Deliberately a small standalone fetch, NOT the @hypaware/central plugin
// client: that client carries the gateway-JWT flow (wrong credential — this
// path uses the operator admin token) and an ingest-oriented Retry-After
// backoff (wrong behavior — an interactive query fails fast).
//
// @ref LLP 0032#http-client [implements] — standalone fail-fast fetch, admin token, no retry

/**
 * @import { ExecuteSqlResult, RemoteQueryOptions, PingResult } from './types.d.ts'
 */

const DEFAULT_TIMEOUT_MS = 30_000
const QUERY_PATH = '/v1/query'
const PING_SQL = 'SELECT 1'

/**
 * Tagged error so callers can branch on failure kind without string
 * matching. `kind`: 'unreachable' | 'unauthorized' | 'query_failed' |
 * 'http_error'.
 */
export class RemoteQueryError extends Error {
  /**
   * @param {string} message
   * @param {'unreachable' | 'unauthorized' | 'query_failed' | 'http_error'} kind
   */
  constructor(message, kind) {
    super(message)
    this.name = 'RemoteQueryError'
    this.kind = kind
  }
}

/**
 * Join a base URL and a path, tolerating a trailing slash on the base.
 * Mirrors the helper duplicated across the central plugin clients.
 *
 * @param {string} base
 * @param {string} suffix
 * @returns {string}
 */
export function joinUrl(base, suffix) {
  const baseWithSlash = base.endsWith('/') ? base : `${base}/`
  return new URL(suffix.replace(/^\//, ''), baseWithSlash).toString()
}

/** @param {unknown} err */
function errMessage(err) {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Extract a human-readable detail from a parsed error body.
 * @param {number} status
 * @param {any} body
 * @returns {string}
 */
function errorDetail(status, body) {
  if (body && typeof body === 'object') {
    if (typeof body.detail === 'string' && body.detail.length > 0) {
      return body.error ? `${body.error}: ${body.detail}` : body.detail
    }
    if (typeof body.error === 'string' && body.error.length > 0) return body.error
    if (typeof body._text === 'string' && body._text.length > 0) return body._text.trim().slice(0, 200)
  }
  return `HTTP ${status}`
}

/**
 * POST a SQL string to the admin query endpoint. Resolves to the parsed
 * response with its status; throws `RemoteQueryError('unreachable')` if the
 * request never completes (connection refused, DNS, timeout). Fails fast —
 * no retry, a single timeout.
 *
 * @param {RemoteQueryOptions} opts
 * @returns {Promise<{ status: number, body: any }>}
 */
async function postQuery(opts) {
  const { serverUrl, token, query } = opts
  const fetchFn = opts.fetchFn ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const url = joinUrl(serverUrl, QUERY_PATH)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort(opts.signal.reason)
    else opts.signal.addEventListener('abort', () => controller.abort(opts.signal?.reason), { once: true })
  }

  let response
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    })
  } catch (err) {
    throw new RemoteQueryError(`could not reach ${serverUrl} (${errMessage(err)})`, 'unreachable')
  } finally {
    clearTimeout(timer)
  }

  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = { _text: text }
  }
  return { status: response.status, body }
}

/**
 * Run a SQL query on the central server and shape the result like a local
 * `executeQuerySql` call, so the existing formatters render it unchanged.
 *
 * @ref LLP 0032#wire-contract [implements] — request `{query}`, response `{columns,rows,datasets,truncated,limit?}`
 * @ref LLP 0032#result-mapping [implements] — server truncation → freshnessMessages
 * @param {RemoteQueryOptions} opts
 * @returns {Promise<ExecuteSqlResult>}
 */
export async function executeQuerySqlRemote(opts) {
  const { status, body } = await postQuery(opts)

  if (status === 200) {
    const columns = Array.isArray(body.columns) ? body.columns : []
    const rows = Array.isArray(body.rows) ? body.rows : []
    const datasets = Array.isArray(body.datasets) ? body.datasets : []
    /** @type {string[]} */
    const freshnessMessages = []
    if (body.truncated) {
      const cap = typeof body.limit === 'string' ? ` (server cap ${body.limit})` : ''
      freshnessMessages.push(`showing first ${rows.length} rows${cap} — narrow your query`)
    }
    return { columns, rows, datasets, freshnessMessages }
  }

  if (status === 401) {
    throw new RemoteQueryError('server rejected the admin token (401). Check HYP_ADMIN_TOKEN.', 'unauthorized')
  }
  if (status === 400 && body && body.error === 'query_failed') {
    throw new RemoteQueryError(errorDetail(status, body), 'query_failed')
  }
  throw new RemoteQueryError(errorDetail(status, body), 'http_error')
}

/**
 * Classify a connect-time ping. Asserts **reachability + auth, not query
 * validity**: the server checks the admin token before running SQL, so a
 * `400 query_failed` still proves the token was accepted. Only a connection
 * failure means "unreachable" and only `401` means "bad token"; everything
 * else — `200` or `400 query_failed` — is "connected".
 *
 * @ref LLP 0032#ping-asserts-auth [implements] — 401 = bad token, network error = unreachable, else connected
 * @param {Omit<RemoteQueryOptions, 'query'>} opts
 * @returns {Promise<PingResult>}
 */
export async function pingRemote(opts) {
  let result
  try {
    result = await postQuery({ ...opts, query: PING_SQL })
  } catch (err) {
    if (err instanceof RemoteQueryError && err.kind === 'unreachable') {
      return { kind: 'unreachable', ok: false, detail: err.message }
    }
    throw err
  }
  if (result.status === 401) {
    return { kind: 'unauthorized', ok: false }
  }
  return { kind: 'connected', ok: true }
}
