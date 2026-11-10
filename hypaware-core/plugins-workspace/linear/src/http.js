// @ts-check

/** @import { LinearError, RequestOptions } from '../../../../hypaware-core/plugins-workspace/linear/src/types.js' */

/** @param {string} kind @param {string} message @returns {LinearError} */
export function linearError(kind, message) {
  const error = /** @type {LinearError} */ (new Error(`Linear: ${message}`))
  error.hypErrorKind = `linear_${kind}`
  return error
}

/**
 * Read a bounded response without exposing provider bodies, request URLs or
 * transport causes. Authentication and GraphQL both use fixed HTTPS endpoints.
 * @param {string} url
 * @param {RequestInit} init
 * @param {RequestOptions} opts
 * @param {number} [maxBytes]
 * @returns {Promise<Record<string, any>>}
 */
export async function linearJson(url, init, opts = {}, maxBytes = 64 * 1024) {
  const timeout = AbortSignal.timeout(15000)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  try {
    const response = await (opts.fetchImpl ?? fetch)(url, { ...init, redirect: 'error', signal })
    if (!response.ok) {
      await response.body?.cancel()
      throw linearError(`http_${response.status}`, `HTTP ${response.status}; check access or run \`hyp linear login\` again`)
    }
    const reader = response.body?.getReader()
    if (!reader) throw linearError('response', 'empty API response')
    const chunks = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > maxBytes) throw linearError('response', 'API response exceeds the size limit')
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => {}) }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw linearError('response', 'invalid API response')
    return data
  } catch (err) {
    if (opts.signal?.aborted) throw linearError('cancelled', 'operation cancelled')
    if (timeout.aborted) throw linearError('timeout', 'API request timed out')
    if (/** @type {LinearError} */ (err)?.hypErrorKind) throw err
    throw linearError('network', 'API request failed or returned invalid data')
  }
}

/** @param {string} token @param {string} query @param {object} variables @param {RequestOptions} [opts] */
export async function linearGraphql(token, query, variables, opts = {}) {
  const response = await linearJson('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify({ query, variables }),
  }, opts, 2 * 1024 * 1024)
  if (response.errors !== undefined && (!Array.isArray(response.errors) || response.errors.length)) {
    const limited = Array.isArray(response.errors) && response.errors.some(e => e?.extensions?.code === 'RATELIMITED')
    throw linearError(limited ? 'rate_limited' : 'graphql', limited ? 'API rate limit reached; retry later' : 'GraphQL request failed; check permissions and retry')
  }
  if (!response.data || typeof response.data !== 'object') throw linearError('response', 'missing GraphQL data')
  return response.data
}
