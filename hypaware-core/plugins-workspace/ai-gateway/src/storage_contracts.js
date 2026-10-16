// @ts-check

import { aiGatewayBackfillMaterializer, aiGatewayDatasetRegistration } from './dataset.js'

/**
 * @import { PluginActivationContext } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { GatewayState } from './types.js'
 */

/**
 * Install the shared normalized-conversation storage contracts once per
 * kernel runtime. The OpenCode adapter calls this when it is configured
 * without the gateway plugin; a normal gateway boot remains the owner and
 * reaches the same registrations.
 *
 * @param {PluginActivationContext} ctx
 * @param {GatewayState} [state]
 * @ref LLP 0306#dataset-ownership [implements]: reuse the dataset owner's
 *   registration and materializer without composing the gateway source
 */
export function ensureAiGatewayStorageContracts(ctx, state) {
  if (!ctx.query.getDataset('ai_gateway_messages')) {
    ctx.query.registerDataset(aiGatewayDatasetRegistration(state))
  }
  if (!ctx.backfillMaterializers.get('ai_gateway.projected_exchange')) {
    ctx.backfillMaterializers.register(aiGatewayBackfillMaterializer())
  }
}
