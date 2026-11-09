// @ts-check
import http from 'node:http'
import { isPlainObject } from '../../../../src/core/util/json_util.js'

/** @import { CursorCloudConnection, CursorCloudConversation } from '../../../../hypaware-core/plugins-workspace/cursor/src/types.js' */

export class CursorCloudError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(code)
    this.code = code
  }
}

/** @param {unknown} value @returns {value is string} */
export function cloudAgentId(value) {
  return typeof value === 'string' && /^bc-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
}

/** @param {unknown} value @returns {value is string} */
export function cloudRepository(value) {
  if (typeof value !== 'string' || value.length > 2048) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
      value === url.href.replace(/\/$/, '') && url.pathname.split('/').filter(Boolean).length >= 2
  } catch { return false }
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {AbortSignal} [signal]
 * @ref LLP 0593#scope: local metadata binds this VM; no account inventory is queried.
 */
export async function readCursorCloudMetadata(env, signal) {
  const deadline = AbortSignal.any([AbortSignal.timeout(3000), ...(signal ? [signal] : [])])
  /** @param {string} key @returns {Promise<string>} */
  const read = key => new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = []
    let bytes = 0
    const request = http.get({ socketPath: env.CURSOR_AGENT_SOCKET || '/run/cursor/api.sock', path: '/v1/meta-data/' + key, signal: deadline }, response => {
      response.on('data', chunk => {
        bytes += chunk.length
        if (bytes > 8192 || chunks.length >= 64) request.destroy(new CursorCloudError('cloud_metadata_limit'))
        else chunks.push(chunk)
      })
      response.on('error', () => reject(new CursorCloudError('cloud_metadata_unavailable')))
      response.on('end', () => {
        if (response.statusCode !== 200) reject(new CursorCloudError('cloud_metadata_unavailable'))
        else resolve(Buffer.concat(chunks).toString('utf8').trim())
      })
    })
    request.on('error', () => reject(new CursorCloudError('cloud_metadata_unavailable')))
  })
  const [agentId, repo, repos] = await Promise.all([read('agent/id'), read('workspace/repo-url'), read('workspace/repo-urls')])
  const repository = 'https://' + repo
  if (!cloudAgentId(agentId) || !cloudRepository(repository) || repos !== repo) throw new CursorCloudError('cloud_metadata_scope')
  return { agentId, repository }
}

/**
 * @param {CursorCloudConnection} connection
 * @param {string} key
 * @param {{ fetcher?: typeof fetch, signal?: AbortSignal }} [opts]
 * @returns {Promise<CursorCloudConversation | undefined>}
 * @ref LLP 0593#identity: only completed snapshots own immutable native message identities.
 */
export async function readCursorCloudConversation(connection, key, opts = {}) {
  if (!cloudAgentId(connection.agentId) || !cloudRepository(connection.repository)) throw new CursorCloudError('cloud_connection_invalid')
  if (!key || key.length > 1024 || /\s/.test(key)) throw new CursorCloudError('cloud_api_key_missing_or_invalid')
  const signal = AbortSignal.any([AbortSignal.timeout(8000), ...(opts.signal ? [opts.signal] : [])])
  const fetcher = opts.fetcher ?? fetch
  /** @param {string} suffix @param {number} limit @returns {Promise<unknown>} */
  async function get(suffix, limit) {
    try {
      const response = await fetcher('https://api.cursor.com/v0/agents/' + connection.agentId + suffix, {
        headers: { authorization: 'Basic ' + Buffer.from(key + ':').toString('base64') }, redirect: 'error', signal,
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new CursorCloudError('cloud_api_http_' + response.status)
      }
      if (!response.body) throw new CursorCloudError('cloud_api_body_missing')
      /** @type {Uint8Array[]} */
      const chunks = []
      let bytes = 0
      for await (const chunk of response.body) {
        bytes += chunk.length
        if (bytes > limit || chunks.length >= 512) throw new CursorCloudError('cloud_api_response_limit')
        chunks.push(chunk)
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new CursorCloudError('cloud_api_json') }
    } catch (error) {
      if (error instanceof CursorCloudError) throw error
      throw new CursorCloudError(signal.aborted ? 'cloud_api_aborted' : 'cloud_api_unavailable')
    }
  }
  /** @param {unknown} metadata */
  function finished(metadata) {
    if (!isPlainObject(metadata) || metadata.id !== connection.agentId || !isPlainObject(metadata.source) || metadata.source.repository !== connection.repository) throw new CursorCloudError('cloud_api_scope')
    return metadata.status === 'FINISHED'
  }
  if (!finished(await get('', 65536))) return undefined
  const conversation = await get('/conversation', 2 * 1024 * 1024)
  if (!finished(await get('', 65536))) return undefined
  if (!isPlainObject(conversation) || conversation.id !== connection.agentId || !Array.isArray(conversation.messages) || conversation.messages.length > 256) throw new CursorCloudError('cloud_api_conversation_shape')
  const ids = new Set()
  const messages = conversation.messages.map(message => {
    if (!isPlainObject(message) || typeof message.id !== 'string' || !message.id || message.id.length > 256 || /[\x00-\x1f]/.test(message.id) || ids.has(message.id) ||
        (message.type !== 'user_message' && message.type !== 'assistant_message') || typeof message.text !== 'string') throw new CursorCloudError('cloud_api_message_shape')
    ids.add(message.id)
    return { id: message.id, type: message.type, text: message.text }
  })
  return { id: connection.agentId, messages }
}
