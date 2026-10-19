// @ts-check

import { createProjectedExchangeWriter } from './exchange_writer.js'

/**
 * @import { AiGatewayCapability, AiGatewayClientRegistration, AiGatewayEndpointOptions, AiGatewayProjectedExchange, AiGatewayRecordOptions, ClientRegistration, ClientRegistry, QueryStorageService } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { GatewayState } from './types.js'
 */

/**
 * @param {Set<string>} [ignoredSessions]
 * @returns {GatewayState}
 */
export function createGatewayState(ignoredSessions = new Set()) {
  return {
    presets: new Map(),
    aliases: new Map(),
    aliasRoutes: [],
    clients: new Map(),
    projectors: [],
    enrichers: new Map(),
    listen: undefined,
    // @ref LLP 0403#storage [implements]: activation supplies a persistent set.
    ignoredSessions,
  }
}

/**
 * Build the capability API exposed under `hypaware.ai-gateway@2.0.0`.
 * Adapter plugins acquire this through
 * `ctx.requireCapability('hypaware.ai-gateway', '^2.0.0')` and call
 * the register hooks to contribute upstream presets, client wiring,
 * and exchange projectors. `localEndpoint(opts?)` returns the URL the
 * adapter should hand to the client tool so its traffic flows through
 * this gateway.
 *
 * `storage` is the activation context's storage service. It is what
 * lets `recordProjectedExchange` exist: a producer plugin holding a
 * finished projection can hand it back to the dataset's owner instead
 * of learning the table path, the column list, and the dedupe rules.
 *
 * @param {GatewayState} state
 * @param {{ storage?: QueryStorageService, clients?: ClientRegistry }} [deps]
 * @returns {AiGatewayCapability}
 */
export function createAiGatewayApi(state, deps = {}) {
  const clients = deps.clients ?? legacyClientRegistry(state)
  let projectorSeq = 0
  /** @type {ReturnType<typeof createProjectedExchangeWriter> | undefined} */
  let writer
  return {
    registerUpstreamPreset(preset) {
      if (!preset || typeof preset.name !== 'string' || preset.name.length === 0) {
        throw new TypeError('registerUpstreamPreset: name is required')
      }
      if (typeof preset.base_url !== 'string' || preset.base_url.length === 0) {
        throw new TypeError(`registerUpstreamPreset '${preset.name}': base_url is required`)
      }
      if (state.aliases.has(preset.name)) throw new TypeError('registerUpstreamPreset: alias name collision')
      const hasMatch = typeof preset.match === 'function'
      const hasPathPrefix = typeof preset.path_prefix === 'string' && preset.path_prefix.length > 0
      if (!hasMatch && !hasPathPrefix) {
        throw new TypeError(
          `registerUpstreamPreset '${preset.name}': either match() or path_prefix is required`
        )
      }
      state.presets.set(preset.name, preset)
    },

    // @ref LLP 0474#routes [implements]: registration is runtime-only; resolve after normal operator/preset merge
    registerUpstreamAlias(name, canonicalName, route) {
      if (typeof name !== 'string' || !name || name.length > 128 || typeof canonicalName !== 'string' || !canonicalName || canonicalName.length > 128) {
        throw new TypeError('registerUpstreamAlias: name and canonical target are required')
      }
      if (name === canonicalName) throw new TypeError('registerUpstreamAlias: self reference')
      if (state.aliases.size >= 32) throw new TypeError('registerUpstreamAlias: alias limit exceeded')
      if (state.aliases.has(name) || state.presets.has(name)) throw new TypeError('registerUpstreamAlias: duplicate name collision')
      if (state.aliases.has(canonicalName) || [...state.aliases.values()].some(a => a.canonicalName === name)) {
        throw new TypeError('registerUpstreamAlias: alias chains are unsupported')
      }
      if (!route || typeof route.path_prefix !== 'string' || route.path_prefix.length > 256 || !route.path_prefix.startsWith('/') || route.path_prefix === '/'
        || route.path_prefix.endsWith('/') || /[?#]/.test(route.path_prefix) || route.path_prefix.split('/').includes('..')
        || typeof route.match !== 'function' || !route.rewrite || route.rewrite.from !== route.path_prefix
        || route.rewrite.to !== '/' || (route.captureMatch !== undefined && typeof route.captureMatch !== 'function')
        || (route.priority !== undefined && !Number.isFinite(route.priority))) {
        throw new TypeError('registerUpstreamAlias: invalid scoped route or root rewrite')
      }
      state.aliases.set(name, { canonicalName, route: {
        path_prefix: route.path_prefix,
        ...(route.provider !== undefined ? { provider: route.provider } : {}),
        ...(route.priority !== undefined ? { priority: route.priority } : {}),
        match: route.match, rewrite: { ...route.rewrite }, captureMatch: route.captureMatch,
      } })
    },

    registerClient(client) {
      if (!client || typeof client.name !== 'string' || client.name.length === 0) {
        throw new TypeError('registerClient: name is required')
      }
      if (typeof client.defaultUpstream !== 'string' || client.defaultUpstream.length === 0) {
        throw new TypeError(`registerClient '${client.name}': defaultUpstream is required`)
      }
      // An adapter owns only attach(); the reversing detach is the single
      // core disk-driven undo (LLP 0045 §Part 3), not a per-adapter hook.
      if (typeof client.attach !== 'function') {
        throw new TypeError(`registerClient '${client.name}': attach() is required`)
      }
      clients.registerClient(client)
    },

    registerExchangeProjector(projector) {
      if (!projector || typeof projector.name !== 'string' || projector.name.length === 0) {
        throw new TypeError('registerExchangeProjector: name is required')
      }
      if (typeof projector.match !== 'function') {
        throw new TypeError(`registerExchangeProjector '${projector.name}': match() is required`)
      }
      if (typeof projector.project !== 'function') {
        throw new TypeError(`registerExchangeProjector '${projector.name}': project() is required`)
      }
      state.projectors.push({ ...projector, _seq: projectorSeq++ })
    },

    registerSettlementEnricher(enricher) {
      if (!enricher || typeof enricher.name !== 'string' || enricher.name.length === 0) {
        throw new TypeError('registerSettlementEnricher: name is required')
      }
      if (typeof enricher.clientName !== 'string' || enricher.clientName.length === 0) {
        throw new TypeError(`registerSettlementEnricher '${enricher.name}': clientName is required`)
      }
      if (typeof enricher.settle !== 'function') {
        throw new TypeError(`registerSettlementEnricher '${enricher.name}': settle() is required`)
      }
      state.enrichers.set(enricher.clientName, enricher)
    },

    /**
     * Record one already-projected exchange into `ai_gateway_messages`.
     *
     * The caller supplies the projection; everything downstream of it
     * (row expansion, `part_id` identity, the `part_id` dedupe against
     * committed and spooled rows, the table path, the column list) stays
     * here, so a second live producer cannot drift from the proxy's rows
     * for the same content.
     *
     * @ref LLP 0252#projection-unchanged [implements]: the OTEL listener is a
     *   third producer of this dataset, not the owner of a new one
     * @param {AiGatewayProjectedExchange} projection
     * @param {AiGatewayRecordOptions} [opts]
     */
    async recordProjectedExchange(projection, opts) {
      if (!deps.storage) {
        throw new Error('ai-gateway: recordProjectedExchange() needs a storage service')
      }
      if (!writer) writer = createProjectedExchangeWriter({ storage: deps.storage })
      return writer.record(projection, opts ?? {})
    },

    /**
     * Resolve the local endpoint URL the gateway is listening on. The
     * source must be started (`state.listen` set) before this returns
     * a usable URL; calling before start throws so callers fail loudly
     * instead of pointing clients at a phantom address.
     *
     * @param {AiGatewayEndpointOptions} [opts]
     */
    localEndpoint(opts) {
      if (!state.listen) {
        throw new Error('ai-gateway: localEndpoint() called before the gateway started')
      }
      const host = formatHost(state.listen.host)
      const base = `http://${host}:${state.listen.port}`
      const prefix = opts?.pathPrefix
      if (typeof prefix === 'string' && prefix.length > 0) {
        return prefix.startsWith('/') ? `${base}${prefix}` : `${base}/${prefix}`
      }
      return base
    },

    /** @param {string} name */
    getClient(name) {
      const client = clients.getClient(name)
      return isGatewayClient(client) ? client : undefined
    },

    listClients() {
      return clients.listClients().filter(isGatewayClient)
    },
  }
}

/**
 * The intrinsic registry also carries endpoint-free adapters. Keep the
 * gateway capability's established contract limited to registrations with a
 * gateway upstream.
 *
 * @param {ClientRegistration | undefined} client
 * @returns {client is AiGatewayClientRegistration}
 */
function isGatewayClient(client) {
  return client !== undefined &&
    typeof /** @type {{ defaultUpstream?: unknown }} */ (client).defaultUpstream === 'string'
}

/** @param {GatewayState} state @returns {ClientRegistry} */
function legacyClientRegistry(state) {
  return {
    registerClient(client) { state.clients.set(client.name, /** @type {any} */ (client)) },
    getClient(name) { return state.clients.get(name) },
    listClients() { return Array.from(state.clients.values()) },
  }
}

/**
 * Bracket IPv6 literals so URL parsers don't choke on the colons.
 *
 * @param {string} host
 */
function formatHost(host) {
  if (host.includes(':') && !host.startsWith('[')) return `[${host}]`
  return host
}
