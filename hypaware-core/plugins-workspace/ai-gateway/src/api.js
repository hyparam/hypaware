// @ts-check

/**
 * @import { AiGatewayCapability, AiGatewayClientRegistration, AiGatewayEndpointOptions, AiGatewayExchangeProjector, AiGatewaySettlementEnricher, AiGatewayUpstreamPreset } from '../../../../collectivus-plugin-kernel-types.js'
 * @import { GatewayState, RegisteredProjector } from './types.js'
 */

/**
 * @returns {GatewayState}
 */
export function createGatewayState() {
  return {
    presets: new Map(),
    clients: new Map(),
    projectors: [],
    enrichers: new Map(),
    listen: undefined,
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
 * @param {GatewayState} state
 * @returns {AiGatewayCapability}
 */
export function createAiGatewayApi(state) {
  let projectorSeq = 0
  return {
    registerUpstreamPreset(preset) {
      if (!preset || typeof preset.name !== 'string' || preset.name.length === 0) {
        throw new TypeError('registerUpstreamPreset: name is required')
      }
      if (typeof preset.base_url !== 'string' || preset.base_url.length === 0) {
        throw new TypeError(`registerUpstreamPreset '${preset.name}': base_url is required`)
      }
      const hasMatch = typeof preset.match === 'function'
      const hasPathPrefix = typeof preset.path_prefix === 'string' && preset.path_prefix.length > 0
      if (!hasMatch && !hasPathPrefix) {
        throw new TypeError(
          `registerUpstreamPreset '${preset.name}': either match() or path_prefix is required`
        )
      }
      state.presets.set(preset.name, preset)
    },

    registerClient(client) {
      if (!client || typeof client.name !== 'string' || client.name.length === 0) {
        throw new TypeError('registerClient: name is required')
      }
      if (typeof client.defaultUpstream !== 'string' || client.defaultUpstream.length === 0) {
        throw new TypeError(`registerClient '${client.name}': defaultUpstream is required`)
      }
      if (typeof client.attach !== 'function' || typeof client.detach !== 'function') {
        throw new TypeError(`registerClient '${client.name}': attach()/detach() are required`)
      }
      state.clients.set(client.name, client)
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
      return state.clients.get(name)
    },

    listClients() {
      return Array.from(state.clients.values())
    },
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
