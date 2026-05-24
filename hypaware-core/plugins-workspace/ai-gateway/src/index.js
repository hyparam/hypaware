// @ts-check

import { createAiGatewayApi, createGatewayState } from './api.js'
import { aiGatewayDatasetRegistration } from './dataset.js'
import { createStartSource } from './source.js'
import { setAiGatewayRuntime } from './runtime.js'

/**
 * @import { PluginActivationContext } from '../../../../collectivus-plugin-kernel-types.d.ts'
 * @import { ExtendedSourceRegistry } from '../../../../src/core/registry/sources.js'
 */

const PLUGIN_NAME = '@hypaware/ai-gateway'

/**
 * Activate the `@hypaware/ai-gateway` plugin.
 *
 * Registers:
 *  - capability `hypaware.ai-gateway@2.0.0` so adapter plugins (e.g.
 *    `@hypaware/claude`, `@hypaware/codex`, future custom integrations)
 *    can contribute upstream presets, client wiring, and exchange
 *    projectors. The 2.0.0 surface drops `registerMessageEnricher`
 *    and `registerExchangeContextProjector` from 1.x in favour of a
 *    single full-exchange projector hook (see api.js).
 *  - dataset `ai_gateway_messages`
 *  - source `ai-gateway` (configSection: `ai-gateway`)
 *
 * The source listener is NOT bound at activation. The first call to
 * `kernel.sources.start('ai-gateway', ctx)` brings up the proxy and
 * sets `state.listen`, which is what makes
 * `AiGatewayCapability.localEndpoint()` resolve. Until then the
 * capability is registered (adapters can record their contributions)
 * but `localEndpoint()` throws — the contract documented in api.js.
 *
 * @param {PluginActivationContext} ctx
 */
export async function activate(ctx) {
  const state = createGatewayState()
  const api = createAiGatewayApi(state)

  ctx.provideCapability('hypaware.ai-gateway', '2.0.0', api)
  ctx.query.registerDataset(aiGatewayDatasetRegistration())

  ctx.sources.register({
    name: 'ai-gateway',
    plugin: PLUGIN_NAME,
    summary: 'HTTP/SSE AI gateway: forwards LLM client traffic to upstreams and records normalized ai_gateway_messages',
    configSection: 'ai-gateway',
    start: createStartSource(state),
  })

  setAiGatewayRuntime({
    ctx,
    state,
    sources: /** @type {ExtendedSourceRegistry} */ (ctx.sources),
    started: false,
  })
}
