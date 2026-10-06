// @ts-check

import { createOllamaExchangeProjector, ollamaUpstreamPreset } from './projector.js'

/**
 * @import { AiGatewayCapability, PluginActivationContext } from '../../../../hypaware-plugin-kernel-types.js'
 */

// @ref LLP 0469#seams [implements]: API opt-in contributes only the existing gateway route and projector
/** @param {PluginActivationContext} ctx */
export function activate(ctx) {
  const gateway = /** @type {AiGatewayCapability} */ (ctx.requireCapability('hypaware.ai-gateway', '^2.0.0'))
  gateway.registerUpstreamPreset(ollamaUpstreamPreset())
  gateway.registerExchangeProjector(createOllamaExchangeProjector())
}
