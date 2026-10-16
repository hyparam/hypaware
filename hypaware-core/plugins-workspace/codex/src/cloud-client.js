// @ts-check
import { CloudError } from './cloud-auth.js'
import { DEFAULT_CLOUD_ORIGINS, validateCloudOrigins } from './cloud-state.js'

/** @import { CloudOriginator } from '../../../../hypaware-core/plugins-workspace/codex/src/types.js' */

export const CLOUD_ENDPOINT = 'wss://codex-cloud-backend.chatgpt.com/'

// @ref LLP 0511#bounds: serial RPC, finite bytes/pages/time, no arbitrary credential destination.
/**
 * @param {string} token
 * @param {AbortSignal} signal
 * @param {{WebSocketClass?: typeof WebSocket, maxBytes?: number, timeoutMs?: number}} [opts]
 */
export async function openCloudClient(token, signal, opts = {}) {
  const Socket = opts.WebSocketClass ?? globalThis.WebSocket
  if (!Socket) throw new CloudError('node_websocket_required')
  let socket
  try { socket = new Socket(CLOUD_ENDPOINT, ['codex-app-server', 'codex-client.hypaware', `openai-bearer.${token}`]) }
  catch { throw new CloudError('websocket_unavailable') }
  let sequence = 0
  let bytes = 0
  /** @type {CloudError | undefined} */
  let failed
  /** @type {Map<number, {resolve: (data: any) => void, reject: (error: Error) => void, timer: NodeJS.Timeout}>} */
  const pending = new Map()
  /** @type {((error: Error) => void) | undefined} */
  let rejectOpen
  const timeoutMs = opts.timeoutMs ?? 15000
  /** @param {string} code */
  const fail = code => {
    failed = new CloudError(code)
    rejectOpen?.(failed)
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.reject(failed)
    }
    pending.clear()
  }
  const abort = () => {
    fail('collection_cancelled')
    socket.close()
  }
  signal.addEventListener('abort', abort, { once: true })
  socket.addEventListener('error', () => fail('websocket_failed'))
  socket.addEventListener('close', () => fail('websocket_closed'))
  socket.addEventListener('message', event => {
    if (typeof event.data !== 'string') {
      fail('unexpected_binary_message')
      socket.close()
      return
    }
    bytes += Buffer.byteLength(event.data)
    if (bytes > (opts.maxBytes ?? 64 * 1024 * 1024)) {
      fail('response_byte_limit')
      socket.close()
      return
    }
    try {
      const message = JSON.parse(event.data)
      const p = pending.get(message.id)
      if (!p) return // Notifications are not part of history capture.
      pending.delete(message.id)
      clearTimeout(p.timer)
      if (message.error) p.reject(new CloudError('cloud_request_rejected'))
      else if (!message.result || typeof message.result !== 'object') p.reject(new CloudError('invalid_cloud_response'))
      else p.resolve(message.result)
    } catch {
      fail('invalid_cloud_json')
      socket.close()
    }
  })
  const close = () => {
    signal.removeEventListener('abort', abort)
    fail('client_closed')
    socket.close()
  }
  /** @param {string} method @param {object} params */
  const call = (method, params) => {
    if (failed) return Promise.reject(failed)
    if (signal.aborted) return Promise.reject(new CloudError('collection_cancelled'))
    if (pending.size) return Promise.reject(new CloudError('concurrent_rpc_disallowed'))
    const id = ++sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        fail('cloud_request_timeout')
        socket.close()
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      try { socket.send(JSON.stringify({ id, method, params })) }
      catch { fail('websocket_send_failed') }
    })
  }
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        fail('websocket_connect_timeout')
        socket.close()
      }, timeoutMs)
      rejectOpen = error => {
        clearTimeout(timer)
        reject(error)
      }
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        rejectOpen = undefined
        resolve(undefined)
      }, { once: true })
      if (signal.aborted) abort()
    })
    if (socket.protocol !== 'codex-app-server') throw new CloudError('unexpected_websocket_protocol')
    await call('initialize', { clientInfo: { name: 'hypaware_cloud', title: 'HypAware cloud collector', version: '1' }, capabilities: { experimentalApi: true } })
    socket.send('{"method":"initialized","params":{}}')
    return { call, close }
  } catch (error) {
    close()
    if (error instanceof CloudError) throw error
    throw new CloudError('websocket_failed')
  }
}

/**
 * Read every bounded page before admitting a chat to append-only storage.
 * @param {{call: (method: string, params: object) => Promise<any>}} client
 * @param {string} threadId
 * @param {CloudOriginator[]} [origins]
 */
export async function readCloudThread(client, threadId, origins = DEFAULT_CLOUD_ORIGINS) {
  validateCloudOrigins(origins)
  const result = await client.call('thread/read', { threadId, includeTurns: false })
  const thread = result.thread
  if (thread?.id !== threadId) throw new CloudError('thread_identity_mismatch')
  if (thread.source?.custom !== 'codex-cloud-agent') throw new CloudError('unsupported_thread_source')
  // @ref LLP 0511#discovery: the cloud-agent source also contains Work/dot chats.
  if (!origins.includes(thread.originator)) throw new CloudError('unsupported_thread_originator')
  /** @type {any[]} */
  const items = []
  const cursors = new Set()
  const ids = new Set()
  let cursor
  for (let page = 0; page < 20; page++) {
    const response = await client.call('thread/items/list', { threadId, limit: 100, ...(cursor ? { cursor } : {}) })
    if (!Array.isArray(response.data) || response.data.length > 100) throw new CloudError('invalid_item_page')
    for (const wrapper of response.data) {
      if (!wrapper || typeof wrapper.turnId !== 'string' || !wrapper.turnId
        || typeof wrapper.item?.id !== 'string' || !wrapper.item.id) throw new CloudError('invalid_item_identity')
      const id = wrapper.item.id
      if (ids.has(id)) throw new CloudError('duplicate_item_identity')
      ids.add(id)
      items.push(wrapper)
    }
    cursor = response.nextCursor
    if (cursor === null) return { thread, items }
    if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) throw new CloudError('invalid_history_cursor')
    cursors.add(cursor)
  }
  throw new CloudError('history_page_limit')
}

// @ref LLP 0511#discovery: list both archive states without retaining previews or content.
/**
 * @param {{call: (method: string, params: object) => Promise<any>}} client
 * @param {CloudOriginator[]} [origins]
 * @returns {Promise<Array<{id: string, updatedAt: number}>>}
 */
export async function listCloudThreads(client, origins = DEFAULT_CLOUD_ORIGINS) {
  validateCloudOrigins(origins)
  const threads = new Map()
  for (const archived of [false, true]) {
    const cursors = new Set()
    let cursor
    for (let page = 0; page < 20; page++) {
      // @ref LLP 0511#discovery: hosted origin filters omit chats; select locally after pagination.
      const response = await client.call('thread/list', {
        limit: 100, sortKey: 'updated_at', sortDirection: 'desc', archived,
        ...(cursor ? { cursor } : {}),
      })
      if (!Array.isArray(response.data) || response.data.length > 100) throw new CloudError('invalid_thread_page')
      for (const thread of response.data) {
        if (thread?.source?.custom !== 'codex-cloud-agent' || !origins.includes(thread.originator)) continue
        if (typeof thread.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(thread.id)
          || !Number.isFinite(thread.updatedAt) || Math.abs(thread.updatedAt) > 8640000000000) throw new CloudError('invalid_thread_metadata')
        const old = threads.get(thread.id)
        if (!old || thread.updatedAt > old.updatedAt) threads.set(thread.id, { id: thread.id, updatedAt: thread.updatedAt })
      }
      cursor = response.nextCursor
      if (cursor === null) break
      if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) throw new CloudError('invalid_thread_cursor')
      cursors.add(cursor)
      if (page === 19) throw new CloudError('thread_discovery_page_limit')
    }
  }
  return [...threads.values()]
}
