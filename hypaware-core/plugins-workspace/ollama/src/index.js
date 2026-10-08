// @ts-check

import { createOllamaExchangeProjector, ollamaUpstreamPreset } from './projector.js'
import { ollamaNativeRoute, resolveOllamaRouting, runOllamaSetup } from './setup.js'
import { resolveConfigPath, resolveLayeredConfigForDaemon } from '../../../../src/core/runtime/boot.js'
import { readObservabilityEnv } from '../../../../src/core/observability/env.js'
import { writeClientRecording } from '../../../../src/core/config/client_recording.js'
import { confirmOllamaRecording } from '../../../../src/core/control/client_recording.js'

/**
 * @import { AiGatewayCapability, PluginActivationContext } from '../../../../hypaware-plugin-kernel-types.js'
 */

// @ref LLP 0474#routes [implements]: a probe-less client prints scoped recipes and owns no persistent shell/service settings
/** @param {PluginActivationContext} ctx */
export function activate(ctx) {
  const gateway = /** @type {AiGatewayCapability} */ (ctx.requireCapability('hypaware.ai-gateway', '^2.0.0'))
  gateway.registerUpstreamPreset(ollamaUpstreamPreset())
  gateway.registerUpstreamAlias('ollama-native', 'ollama', ollamaNativeRoute())
  gateway.registerExchangeProjector(createOllamaExchangeProjector())
  gateway.registerClient({
    // Recipes remain useful with no collector, so the generic attach path
    // need not resolve an endpoint before this adapter reads live evidence.
    name: 'ollama', defaultUpstream: 'ollama', requiresEndpoint: false,
    async attach(attachCtx) {
      const { hypHome, stateDir } = readObservabilityEnv(ctx.env)
      const layers = await resolveLayeredConfigForDaemon({ stateRoot: stateDir, configPath: resolveConfigPath({ env: ctx.env, hypHome }) })
      if (layers.localLoaded?.ok === false || layers.centralLoaded?.ok === false || !layers.effective) throw new Error('Cannot read valid current Ollama configuration')
      const routing = resolveOllamaRouting(ctx.env, layers.effective, gateway)
      const result = await writeClientRecording({ env: ctx.env, plugin: '@hypaware/ollama', recording: true, dryRun: attachCtx.dryRun })
      if (result.status === 'failed' || result.status === 'central_managed' || result.status === 'no_entry') {
        throw new Error('Ollama recording could not be enabled; check organization policy and hyp setup --source ollama')
      }
      if (!attachCtx.dryRun) {
        let endpoint
        try { endpoint = gateway.localEndpoint() } catch { /* CLI boot has no local listener. */ }
        const confirmed = await confirmOllamaRecording({ env: ctx.env, recording: true, endpoint })
        if (!confirmed.confirmed) throw new Error('Recording enabled in configuration; live resume not confirmed. Retry hyp client attach ollama or run hyp daemon restart, then attach again.')
      }
      const payload = { status: 'ok', action: 'attach', client: 'ollama', dry_run: attachCtx.dryRun === true, recording: !attachCtx.dryRun, ...routing,
        changed: result.status === 'changed', next: 'Route your next client using this URL',
      }
      if (attachCtx.json) attachCtx.stdout.write(JSON.stringify(payload) + '\n')
      else {
        attachCtx.stdout.write(`${attachCtx.dryRun ? 'Would enable recording' : 'Recording enabled'}; route your next client using this URL${routing.confirmed ? ' (live)' : ' (unconfirmed)'}: ${routing.capture_root}\n`)
        attachCtx.stdout.write(`${routing.cli}\n${routing.sdk}\nExisting clients retain their host. Collector outage or direct next launch:\n${routing.direct_cli}\n${routing.direct_sdk}\n`)
      }
    },
  })
  ctx.commands.registerGroup({ name: 'ollama', plugin: '@hypaware/ollama',
    summary: 'Configure explicit Ollama routing and check local readiness',
    help: 'Use setup for direct service discovery and next-launch CLI/SDK routing recipes. Setup never starts or loads a model.',
  })
  ctx.commands.register({ name: 'ollama setup', plugin: '@hypaware/ollama', category: 'capture-movement', audience: 'everyday',
    summary: 'Check Ollama readiness and explain explicit CLI/SDK routing', usage: 'hyp ollama setup [--upstream URL] [--json]',
    run: (argv, commandCtx) => runOllamaSetup(argv, commandCtx, gateway),
  })
}
