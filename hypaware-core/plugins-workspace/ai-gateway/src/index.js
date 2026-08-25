// @ts-check

import { createAiGatewayApi, createGatewayState } from './api.js'
import { ensureAiGatewayStorageContracts } from './storage_contracts.js'
import { createStartSource } from './source.js'
import { setAiGatewayRuntime } from './runtime.js'
import { runSessionIgnore, runSessionStatus, runSessionUnignore } from './session_command.js'

/**
 * @import { PluginActivationContext } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { ExtendedSourceRegistry } from '../../../../src/core/registry/types.js'
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
 *  - backfill materializer `ai_gateway.projected_exchange` (so client
 *    history providers can import into `ai_gateway_messages` through the
 *    same row expansion as live capture)
 *  - source `ai-gateway` (configSection: `ai-gateway`)
 *
 * The source listener is NOT bound at activation. The first call to
 * `kernel.sources.start('ai-gateway', ctx)` brings up the proxy and
 * sets `state.listen`, which is what makes
 * `AiGatewayCapability.localEndpoint()` resolve. Until then the
 * capability is registered (adapters can record their contributions)
 * but `localEndpoint()` throws: the contract documented in api.js.
 *
 * @param {PluginActivationContext} ctx
 * @ref LLP 0016#knows-nothing-about-claude-or-codex [implements]: owns the gateway capability + ai_gateway_messages; no client specifics
 */
export async function activate(ctx) {
  const state = createGatewayState()
  const api = createAiGatewayApi(state, { storage: ctx.storage, clients: ctx.clients })

  ctx.provideCapability('hypaware.ai-gateway', '2.0.0', api)
  ensureAiGatewayStorageContracts(ctx, state)

  ctx.sources.register({
    name: 'ai-gateway',
    plugin: PLUGIN_NAME,
    summary: 'HTTP/SSE AI gateway: forwards LLM client traffic to upstreams and records normalized ai_gateway_messages',
    configSection: 'ai-gateway',
    start: createStartSource(state),
  })

  // @ref LLP 0067#cli [implements]: the gateway hosts the original
  // `/_hypaware/ignore/session`, so it owns the verbs over it (LLP 0003). One
  // client-agnostic verb group serves Claude and Codex alike, and as a
  // plugin-contributed group it inherits the inactive-plugin `repair:` line
  // (LLP 0153/0154) for free. The mutations also address every OTHER recorder
  // that advertises the route (the claude telemetry listener, LLP 0256), so
  // one verb reaches them all. Deliberately NOT `hyp ignore --session`:
  // LLP 0110 diagnosed that shape.
  if (!ctx.commands.get('session ignore')) ctx.commands.register({
    name: 'session ignore',
    plugin: PLUGIN_NAME,
    category: 'capture-movement',
    audience: 'everyday',
    summary: 'Stop recording this AI session on every local recorder (in-memory, until the daemon restarts)',
    usage: 'hyp session ignore [session-id] [--json]',
    run: runSessionIgnore,
  })

  if (!ctx.commands.get('session unignore')) ctx.commands.register({
    name: 'session unignore',
    plugin: PLUGIN_NAME,
    category: 'capture-movement',
    audience: 'everyday',
    summary: 'Resume recording this AI session',
    usage: 'hyp session unignore [session-id] [--json]',
    run: runSessionUnignore,
  })

  if (!ctx.commands.get('session status')) ctx.commands.register({
    name: 'session status',
    plugin: PLUGIN_NAME,
    category: 'capture-movement',
    audience: 'everyday',
    summary: 'Report whether this AI session is being dropped right now (fails closed)',
    usage: 'hyp session status [session-id] [--json]',
    help: [
      'Reads every live recorder advertising the shared in-memory session set. Exit codes:',
      '  0  confirmed ignored - every advertised recorder holds this session',
      '  1  confirmed NOT ignored - at least one recorder is recording it',
      '  3  unknown - the check could not be completed; assume you ARE recorded',
      '',
      'This verb reports the session set only. The folder governor (.hypignore)',
      'is independent and either match suppresses: see `hyp privacy show`.',
    ].join('\n'),
    run: runSessionStatus,
  })

  setAiGatewayRuntime({
    ctx,
    state,
    sources: /** @type {ExtendedSourceRegistry} */ (ctx.sources),
    started: false,
  })
}
