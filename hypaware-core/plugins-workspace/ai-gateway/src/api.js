// @ts-check

/**
 * @typedef {import('../../../../collectivus-plugin-kernel-types').AiGatewayCapability} AiGatewayCapability
 * @typedef {import('../../../../collectivus-plugin-kernel-types').AiGatewayUpstreamPreset} AiGatewayUpstreamPreset
 * @typedef {import('../../../../collectivus-plugin-kernel-types').AiGatewayClientRegistration} AiGatewayClientRegistration
 * @typedef {import('../../../../collectivus-plugin-kernel-types').AiGatewayMessageEnricher} AiGatewayMessageEnricher
 * @typedef {import('../../../../collectivus-plugin-kernel-types').AiGatewayEndpointOptions} AiGatewayEndpointOptions
 */

/**
 * Mutable state owned by the ai-gateway plugin instance. Both the
 * `AiGatewayCapability` facade (what adapter plugins see) and the
 * running source read from this object — the API mutates it via
 * `register*` calls, the source consumes it when compiling the
 * listener's upstream table and when finalizing exchange rows.
 *
 * @typedef {Object} GatewayState
 * @property {Map<string, AiGatewayUpstreamPreset>} presets
 * @property {Map<string, AiGatewayClientRegistration>} clients
 * @property {AiGatewayMessageEnricher[]} enrichers
 * @property {{ host: string, port: number } | undefined} listen
 */

/**
 * @returns {GatewayState}
 */
export function createGatewayState() {
  return {
    presets: new Map(),
    clients: new Map(),
    enrichers: [],
    listen: undefined,
  }
}

/**
 * Build the capability API exposed under `hypaware.ai-gateway@1.0.0`.
 * Adapter plugins acquire this through
 * `ctx.requireCapability('hypaware.ai-gateway', '^1.0.0')` and call
 * the register hooks to contribute upstream presets, client wiring,
 * and message enrichers. `localEndpoint(opts?)` returns the URL the
 * adapter should hand to the client tool (e.g. Claude Code) so its
 * traffic flows through this gateway.
 *
 * @param {GatewayState} state
 * @returns {AiGatewayCapability}
 */
export function createAiGatewayApi(state) {
  return {
    registerUpstreamPreset(preset) {
      if (!preset || typeof preset.name !== 'string' || preset.name.length === 0) {
        throw new TypeError('registerUpstreamPreset: name is required')
      }
      if (typeof preset.base_url !== 'string' || preset.base_url.length === 0) {
        throw new TypeError(`registerUpstreamPreset '${preset.name}': base_url is required`)
      }
      if (typeof preset.path_prefix !== 'string' || preset.path_prefix.length === 0) {
        throw new TypeError(`registerUpstreamPreset '${preset.name}': path_prefix is required`)
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

    registerMessageEnricher(enricher) {
      if (!enricher || typeof enricher.name !== 'string' || enricher.name.length === 0) {
        throw new TypeError('registerMessageEnricher: name is required')
      }
      if (typeof enricher.enrich !== 'function') {
        throw new TypeError(`registerMessageEnricher '${enricher.name}': enrich() is required`)
      }
      state.enrichers.push(enricher)
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
