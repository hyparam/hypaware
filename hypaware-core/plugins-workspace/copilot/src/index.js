// @ts-check
import { readObservabilityEnv } from '../../../../src/core/observability/env.js'
import { SessionIgnoreSet } from '../../../../src/core/control/session_ignore_store.js'
import { localOnlyListPath } from '../../../../src/core/usage-policy/index.js'
import { ensureAiGatewayStorageContracts } from '../../ai-gateway/src/storage_contracts.js'
import { aiGatewayBackfillMaterializer } from '../../ai-gateway/src/dataset.js'
import { copilotSessionCommand } from './session.js'
import { validateCopilotConfig } from './config.js'
import { attachCopilot } from './attach.js'
import { createCopilotBackfillProvider, COPILOT_KIND, writeGuards } from './backfill.js'

/** @import { PluginActivationContext } from '../../../../hypaware-plugin-kernel-types.js' */
/** @import { CopilotHealth } from '../../../../hypaware-core/plugins-workspace/copilot/src/types.js' */

export const configSection = { section: 'copilot', validate: validateCopilotConfig }

/** @param {PluginActivationContext} ctx */
export async function activate(ctx) {
  ctx.configRegistry.registerSection({ plugin: '@hypaware/copilot', ...configSection })
  ensureAiGatewayStorageContracts(ctx)
  const { stateDir } = readObservabilityEnv(ctx.env)
  const ignoredSessions = new SessionIgnoreSet(stateDir, ctx.log)
  /** @type {CopilotHealth} */
  const health = { stores: 0, selected: 0, read: 0, unchanged: 0, dropped: 0, incomplete: 0 }
  ctx.backfills.register(createCopilotBackfillProvider({ env: ctx.env, config: ctx.config, ignoredSessions, localOnlyListPath: localOnlyListPath(stateDir) }, health))
  const shared = aiGatewayBackfillMaterializer()
  ctx.backfillMaterializers.register({
    kind: COPILOT_KIND, dataset: 'ai_gateway_messages', plugin: '@hypaware/copilot',
    async materialize(item, materializeCtx) {
      const guard = writeGuards.get(item)
      if (!guard || !await guard()) throw new Error('copilot_policy_changed')
      const rows = await shared.materialize(item, materializeCtx)
      // @ref LLP 0549#privacy: recheck after asynchronous stored/spooled dedupe
      if (!await guard()) {
        ctx.log.info('copilot.recovery.policy_drop', { component: 'plugin.copilot', operation: 'recovery.write', status: 'skipped' })
        throw new Error('copilot_policy_changed')
      }
      return rows
    },
  })
  ctx.sources.register({
    name: 'copilot', plugin: '@hypaware/copilot', configSection: 'copilot', summary: 'VS Code Copilot completed-span recovery',
    async start() {
      let stopped = false
      return {
        async stop() { stopped = true },
        async status() { return { state: stopped ? 'stopped' : health.incomplete || !health.last_scan ? 'degraded' : 'ready', message: 'Local single-root DB capture via scheduled recovery. Reload VS Code after attach. Live editor fidelity unverified.', details: { ...health } } },
      }
    },
  })
  ctx.clients.registerClient({
    name: 'copilot', requiresEndpoint: false,
    async attach(attachCtx) {
      const result = await attachCopilot({ env: ctx.env, config: ctx.config, version: ctx.plugin.version, dryRun: attachCtx.dryRun })
      ctx.log.info('copilot.attach.write', { component: 'plugin.copilot', operation: 'client.attach', changed: result.changed, files: result.files, status: 'ok' })
      if (attachCtx.json) attachCtx.stdout.write(JSON.stringify({ status: 'ok', action: 'attach', client: 'copilot', dry_run: attachCtx.dryRun === true, settings_path: result.settingsPath, changed: result.changed }) + '\n')
      else attachCtx.stdout.write(`${attachCtx.dryRun ? 'Would enable' : 'Enabled'} Copilot DB recording for both harnesses. Reload VS Code. The editor may store full debug content locally; HypAware applies its own exclusions before import. Capture runs every minute by default, within native retention (seven days/latest 100 conversations).\n`)
    },
  })
  if (!ctx.commands.get('session ignore')) for (const command of [{ name: 'session ignore', run: copilotSessionCommand('ignore') }, { name: 'session unignore', run: copilotSessionCommand('unignore') }, { name: 'session status', run: copilotSessionCommand('status') }]) {
    ctx.commands.register({ ...command, usage: `hyp ${command.name} [session-id] [--json]`, plugin: '@hypaware/copilot', summary: { 'session ignore': 'Persistently stop recording an AI session', 'session unignore': 'Resume recording an AI session', 'session status': 'Report recording exclusion' }[command.name], category: 'capture-movement', audience: 'everyday' })
  }
}
