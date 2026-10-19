// @ts-check

import { createAiGatewayGraphContract } from './graph_contract.js'
import { startGraphSource } from './source.js'

/**
 * @import { PluginActivationContext } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { ContextGraphCapability } from './types.js'
 */

/**
 * Activate `@hypaware/ai-gateway-graph`.
 *
 * Connector: it requires the `hypaware.context-graph` capability and
 * registers the `ai_gateway_messages → graph` contract, building its rows with
 * the capability's shared kit. It declares plugin + capability dependencies on
 * both `@hypaware/ai-gateway` (the source it exists for) and the graph plugin,
 * so both activate first: neither of them depends on the other or on this.
 * Install this connector to project the gateway's data into the graph; omit it
 * and the gateway runs exactly as before.
 *
 * @param {PluginActivationContext} ctx
 * @ref LLP 0023#contract-contribution [implements]: connector contributes the source's contract via the capability
 */
export async function activate(ctx) {
  // This connector uses the engine's generic kit and scoped projection API
  // (`nodeId`/`edgeId`/`makeRowBuilders`). The bridge-key recipe is owned here
  // (`./graph-keys.js`), not the engine, so requiring `keys` on the kit would
  // wrongly couple a node-type concern to the generic substrate (LLP 0032).
  const graph = /** @type {ContextGraphCapability} */ (
    ctx.requireCapability('hypaware.context-graph', '^1.1.0')
  )
  graph.registerContract(createAiGatewayGraphContract(graph.kit))
  // @ref LLP 0512#lifecycle [implements]: one daemon source maintains all locally captured sessions
  ctx.sources.register({
    name: 'ai-gateway-graph',
    plugin: '@hypaware/ai-gateway-graph',
    summary: 'Automatically project recorded AI sessions into the local activity graph',
    start: (sourceCtx) => startGraphSource(sourceCtx, graph),
  })
}
