// @ts-check

import { startCurateSource } from './batch.js'
import { buildEnrichmentContract } from './contract.js'
import { validateEnrichConfig } from './config.js'
import { COMMITTED_DATASET, enrichDatasetRegistration, PROSPECTS_DATASET, RESOLUTIONS_DATASET } from './datasets.js'
import { runEnrich, runEnrichBackfill, runEnrichCurate, runEnrichPropose, runEnrichStatus } from './commands.js'
import { startProposeSource } from './propose.js'
import { setEnrichRuntime } from './runtime.js'

/**
 * @import { HypError, PluginActivationContext, ValidationResult } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { ExtendedQueryStorageService } from '../../../../src/core/cache/types.js'
 * @import { ContextGraphCapabilityLike } from './types.js'
 */

const PLUGIN_NAME = '@hypaware/context-graph-enrich'

/**
 * Activate `@hypaware/context-graph-enrich`. Resolves the graph, vector, and
 * completion capabilities; registers the three owned datasets; registers the
 * committed-only projection contract with the graph; and starts the T1
 * propose and T2 curate daemon sources.
 *
 * The prospect lifecycle lives in this plugin's datasets. Only committed
 * knowledge is projected, so a rejected prospect never reaches the graph.
 * Projection itself runs via `hyp graph project` (the connector pattern):
 * `projectGraph` is internal to the graph plugin, so this plugin contributes
 * a contract and relies on the existing projection flow.
 *
 * @param {PluginActivationContext} ctx
 */
export async function activate(ctx) {
  ctx.configRegistry.registerSection({
    plugin: PLUGIN_NAME,
    section: 'context-graph-enrich',
    validate: (value) => toValidationResult(validateEnrichConfig(value)),
  })

  const validated = validateEnrichConfig(ctx.config)
  if (!validated.ok) {
    const detail = validated.errors.map((e) => `${e.pointer || '/'}: ${e.message}`).join('; ')
    const err = /** @type {HypError} */ (new Error(`${PLUGIN_NAME}: invalid config - ${detail}`))
    err.hypErrorKind = 'enrich_config_invalid'
    throw err
  }
  const config = validated.config

  // Resolve only the graph capability eagerly: registerContract + the kit
  // are needed now, and context-graph is ordered before this plugin. The
  // vector-search + completion capabilities are resolved lazily on first
  // tick/command (see runtime.getVector/getCompletion): the resolver orders
  // by `requires.plugins`, not `requires.capabilities`, so their providers
  // may activate after this plugin, and the completion provider is swappable.
  const graph = /** @type {ContextGraphCapabilityLike} */ (ctx.requireCapability('hypaware.context-graph', '^1.0.0'))

  ctx.query.registerDataset(enrichDatasetRegistration(PROSPECTS_DATASET, 'created_at'))
  ctx.query.registerDataset(enrichDatasetRegistration(RESOLUTIONS_DATASET, 'resolved_at'))
  ctx.query.registerDataset(enrichDatasetRegistration(COMMITTED_DATASET, 'committed_at'))

  setEnrichRuntime({
    ctx,
    config,
    graph,
    storage: /** @type {ExtendedQueryStorageService} */ (ctx.storage),
    query: ctx.query,
    log: ctx.log,
    stateDir: ctx.paths.stateDir,
  })

  graph.registerContract(buildEnrichmentContract(graph.kit))

  ctx.sources.register({
    name: 'enrich-propose',
    plugin: PLUGIN_NAME,
    summary: 'T1 proposer (ongoing): extract whole settled sessions into prospect knowledge',
    configSection: 'context-graph-enrich',
    start: startProposeSource,
  })
  ctx.sources.register({
    name: 'enrich-curate',
    plugin: PLUGIN_NAME,
    summary: 'T2 curator (ongoing): cluster + curate pending prospects via the Batch API (submit-and-collect)',
    configSection: 'context-graph-enrich',
    start: startCurateSource,
  })

  ctx.commands.register({ name: 'enrich', plugin: PLUGIN_NAME, summary: 'Context-graph enrichment', usage: 'hyp enrich <propose|curate|backfill|status>', run: runEnrich })
  ctx.commands.register({ name: 'enrich propose', plugin: PLUGIN_NAME, summary: 'Run one T1 propose tick now', usage: 'hyp enrich propose', run: runEnrichPropose })
  ctx.commands.register({ name: 'enrich curate', plugin: PLUGIN_NAME, summary: 'Run one T2 curate tick now', usage: 'hyp enrich curate', run: runEnrichCurate })
  ctx.commands.register({ name: 'enrich backfill', plugin: PLUGIN_NAME, summary: 'Enrich ALL history (propose every session, curate via the Batch API)', usage: 'hyp enrich backfill [--propose-only|--curate-only]', run: runEnrichBackfill })
  ctx.commands.register({ name: 'enrich status', plugin: PLUGIN_NAME, summary: 'Show enrichment watermarks and counts', usage: 'hyp enrich status', run: runEnrichStatus })

  ctx.log.info('enrich.activated', {
    source_dataset: config.source_dataset,
    t1_model: config.propose.t1_model,
    t2_model: config.curate.t2_model,
    propose_enabled: config.propose.enabled,
    curate_enabled: config.curate.enabled,
  })
}

/**
 * @param {ReturnType<typeof validateEnrichConfig>} result
 * @returns {ValidationResult}
 */
function toValidationResult(result) {
  if (result.ok) return { ok: true }
  return { ok: false, errors: result.errors.map((e) => ({ pointer: e.pointer, message: e.message })) }
}
