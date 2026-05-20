/**
 * @import { StorageConnector } from '../upload.d.ts'
 */

/**
 * In-memory StorageConnector for tests. Backed by a Map<string, Uint8Array>
 * exposed on `connector.store` so tests can introspect what was uploaded.
 *
 * @returns {StorageConnector & { store: Map<string, Uint8Array> }}
 */
export function memoryConnector() {
  /** @type {Map<string, Uint8Array>} */
  const store = new Map()

  return {
    scheme: 'memory',
    store,
    async putObject(key, body) {
      store.set(key, body)
    },
    async headObject(key) {
      const body = store.get(key)
      if (!body) return undefined
      return { size: body.byteLength }
    },
  }
}
