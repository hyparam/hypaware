// @ts-check
import { readObservabilityEnv } from '../../../../src/core/observability/env.js'
import { SessionIgnoreSet } from '../../../../src/core/control/session_ignore_store.js'
import { localOnlyListPath } from '../../../../src/core/usage-policy/index.js'
import { ensureAiGatewayStorageContracts } from '../../ai-gateway/src/storage_contracts.js'
import { aiGatewayBackfillMaterializer } from '../../ai-gateway/src/dataset.js'
import { databaseOnlySessionCommand } from '../../copilot/src/session.js'
import { createNanoclawBackfillProvider, NANOCLAW_KIND, writeGuards } from './backfill.js'
import { validateNanoclawConfig } from './config.js'

/** @import { PluginActivationContext } from '../../../../hypaware-plugin-kernel-types.js' */
/** @import { NanoclawHealth } from '../../../../hypaware-core/plugins-workspace/nanoclaw/src/types.js' */

export const configSection = { section: 'nanoclaw', validate: validateNanoclawConfig }

/** @param {PluginActivationContext} ctx */
export async function activate(ctx) {
  ctx.configRegistry.registerSection({ plugin: '@hypaware/nanoclaw', ...configSection })
  ensureAiGatewayStorageContracts(ctx)
  const { stateDir } = readObservabilityEnv(ctx.env)
  /** @type {NanoclawHealth} */
  const health = { groups: 0, files_read: 0, files_unchanged: 0, files_failed: 0, policy_drops: 0, deferred: false }
  ctx.backfills.register(createNanoclawBackfillProvider({ config: ctx.config, ignoredSessions: new SessionIgnoreSet(stateDir, ctx.log), localOnlyListPath: localOnlyListPath(stateDir) }, health))
  const shared = aiGatewayBackfillMaterializer()
  ctx.backfillMaterializers.register({ kind: NANOCLAW_KIND, dataset: 'ai_gateway_messages', plugin: '@hypaware/nanoclaw',
    // @ref LLP 0553#privacy: recheck the capture policy around asynchronous dedupe
    async materialize(item, materializeCtx) {
      const guard = writeGuards.get(item)
      if (!guard?.()) throw new Error('nanoclaw_policy_changed')
      const rows = await shared.materialize(item, materializeCtx)
      if (!guard()) throw new Error('nanoclaw_policy_changed')
      return rows
    },
  })
  ctx.sources.register({ name: 'nanoclaw', plugin: '@hypaware/nanoclaw', configSection: 'nanoclaw', summary: 'NanoClaw local Claude transcript recovery',
    async start() {
      let stopped = false
      return {
        async stop() { stopped = true },
        async status() { return { state: stopped ? 'stopped' : !health.last_scan || health.error_kind || health.files_failed || health.deferred ? 'degraded' : 'ready', message: 'Local NanoClaw v2 Claude capture via scheduled recovery', details: { ...health } } },
      }
    },
  })
  ctx.clients.registerClient({ name: 'nanoclaw', requiresEndpoint: false,
    async attach(attachCtx) {
      if (!validateNanoclawConfig(ctx.config).ok) throw new Error('Set @hypaware/nanoclaw config.root to the absolute NanoClaw installation directory first')
      if (attachCtx.json) attachCtx.stdout.write(JSON.stringify({ status: 'ok', client: 'nanoclaw', changed: false, root: ctx.config.root, dry_run: attachCtx.dryRun === true }) + '\n')
      else attachCtx.stdout.write('NanoClaw native capture is configured. Restart the HypAware daemon to enable scheduled recovery. NanoClaw needs no settings changes.\n')
    },
  })
  for (const [name, operation] of /** @type {const} */ ([['session ignore', 'ignore'], ['session unignore', 'unignore'], ['session status', 'status']])) {
    if (!ctx.commands.get(name)) ctx.commands.register({ name, run: databaseOnlySessionCommand(operation, 'nanoclaw'), usage: `hyp ${name} [session-id] [--json]`, plugin: '@hypaware/nanoclaw', category: 'capture-movement', audience: 'everyday', summary: 'Manage persistent recording exclusions for a native session ID' })
  }
}
