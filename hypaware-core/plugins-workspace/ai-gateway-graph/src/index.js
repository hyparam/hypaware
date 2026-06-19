// @ts-check

import { createAiGatewayGraphContract } from './graph_contract.js'

/**
 * @import { PluginActivationContext } from '../../../../collectivus-plugin-kernel-types.d.ts'
 * @import { ContextGraphCapability } from './types.d.ts'
 */

/**
 * Activate `@hypaware/ai-gateway-graph`.
 *
 * Pure connector: it requires the `hypaware.context-graph` capability and
 * registers the `ai_gateway_messages → graph` contract, building its rows with
 * the capability's shared kit. It declares plugin + capability dependencies on
 * both `@hypaware/ai-gateway` (the source it exists for) and the graph plugin,
 * so both activate first — neither of them depends on the other or on this.
 * Install this connector to project the gateway's data into the graph; omit it
 * and the gateway runs exactly as before.
 *
 * @param {PluginActivationContext} ctx
 * @ref LLP 0023#contract-contribution [implements] — connector contributes the source's contract via the capability
 */
export async function activate(ctx) {
  // ^1.1.0: the contract calls `kit.keys` unconditionally, which only a
  // provider that ships the shared key vocabulary has (LLP 0032). A pre-`keys`
  // 1.0.x provider is rejected here, not mid-projection.
  const graph = /** @type {ContextGraphCapability} */ (
    ctx.requireCapability('hypaware.context-graph', '^1.1.0')
  )
  graph.registerContract(createAiGatewayGraphContract(graph.kit))
}
