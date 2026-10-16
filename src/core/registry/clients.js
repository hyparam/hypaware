// @ts-check

/**
 * @import { ClientRegistration, ClientRegistry } from '../../../hypaware-plugin-kernel-types.js'
 */

/**
 * Kernel-owned registry for client attach effects.
 *
 * @returns {ClientRegistry}
 * @ref LLP 0306#endpoint-free-clients [implements]: client lifecycle dispatch
 *   is intrinsic; gateway adapters delegate here and endpoint-free adapters
 *   register directly
 */
export function createClientRegistry() {
  /** @type {Map<string, ClientRegistration>} */
  const clients = new Map()

  return {
    registerClient(client) {
      if (!client || typeof client.name !== 'string' || client.name.length === 0) {
        throw new TypeError('registerClient: name is required')
      }
      if (typeof client.attach !== 'function') {
        throw new TypeError(`registerClient '${client.name}': attach() is required`)
      }
      clients.set(client.name, {
        ...client,
        requiresEndpoint: client.requiresEndpoint !== false,
      })
    },
    getClient(name) {
      return clients.get(name)
    },
    listClients() {
      return Array.from(clients.values())
    },
  }
}
