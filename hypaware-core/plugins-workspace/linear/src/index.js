// @ts-check

import * as commands from './commands.js'
import { validateLinearConfig } from './config.js'
import { linearEventsDatasetRegistration } from './dataset.js'
import { createLinearGraphContract } from './graph_contract.js'
import { setLinearRuntime } from './runtime.js'
import { startLinearSource } from './source.js'

/** @import { PluginActivationContext, LinearGraph, LinearStorage } from '../../../../hypaware-core/plugins-workspace/linear/src/types.js' */

/** @param {PluginActivationContext} ctx */
export async function activate(ctx) {
  ctx.configRegistry.registerSection({ plugin: '@hypaware/linear', section: 'linear', validate: value => {
    const result = validateLinearConfig(value)
    return result.ok ? { ok: true } : { ok: false, errors: result.errors ?? [] }
  } })
  const result = validateLinearConfig(ctx.config)
  if (!result.ok || !result.config) throw new Error('@hypaware/linear: invalid config; check teams, poll_interval and OAuth app settings')
  const graph = /** @type {LinearGraph} */ (ctx.requireCapability('hypaware.context-graph', '^1.1.0'))
  setLinearRuntime({ config: result.config, stateDir: ctx.paths.stateDir, env: ctx.env, log: ctx.log,
    storage: /** @type {LinearStorage} */ (ctx.storage), graph })
  ctx.query.registerDataset(linearEventsDatasetRegistration())
  graph.registerContract(createLinearGraphContract(graph.kit))
  ctx.sources.register({ name: 'linear', plugin: '@hypaware/linear', configSection: 'linear', summary: 'Poll explicitly configured Linear teams', start: startLinearSource })
  for (const command of [
    { name: 'linear', run: commands.runLinear, summary: 'Linear capture and authentication', usage: 'hyp linear <login|logout|status|backfill|sync>' },
    { name: 'linear login', run: commands.runLinearLogin, summary: 'Sign in to Linear with read-only browser OAuth', usage: 'hyp linear login [--no-browser]' },
    { name: 'linear logout', run: commands.runLinearLogout, summary: 'Remove local Linear OAuth credentials', usage: 'hyp linear logout' },
    { name: 'linear status', run: commands.runLinearStatus, summary: 'Verify the Linear account and workspace', usage: 'hyp linear status' },
    { name: 'linear backfill', run: commands.runLinearBackfill, summary: 'Import configured teams from the beginning', usage: 'hyp linear backfill' },
    { name: 'linear sync', run: commands.runLinearSync, summary: 'Resume Linear capture and graph projection', usage: 'hyp linear sync' },
  ]) ctx.commands.register({ ...command, plugin: '@hypaware/linear' })
  ctx.log.info('linear.activated', { operation: 'linear.activate', teams: result.config.teams.length, cadence: result.config.poll_interval })
}
