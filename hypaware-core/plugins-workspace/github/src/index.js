// @ts-check

import { runGithub, runGithubBackfill, runGithubSync } from './commands.js'
import { validateGithubConfig } from './config.js'
import { githubEventsDatasetRegistration } from './dataset.js'
import { createGithubGraphContract } from './graph_contract.js'
import { createLocalObservedReposIndex } from './observed-repos.js'
import { setGithubRuntime } from './runtime.js'
import { startGithubSource } from './source.js'

/**
 * @import { ContextGraphCapabilityLike, ExtendedQueryStorageService, HypError, PluginActivationContext, ValidationResult } from './types.js'
 */

const PLUGIN_NAME = '@hypaware/github'

/**
 * Activate `@hypaware/github`. Registers the `github` config section, validates
 * config, resolves the context-graph capability, registers the `github_events`
 * dataset, **registers the bundled T0 contract** with the graph, and registers
 * the `github` poll source + `github backfill`/`sync` commands.
 *
 * The graph capability is resolved **eagerly** (its `kit` + `registerContract`
 * are needed now) and the plugin dependency on `@hypaware/context-graph`
 * guarantees it activated first: the resolver orders by `requires.plugins`, not
 * `requires.capabilities` (LLP 0360 §both-dependency-kinds; LLP 0006).
 *
 * @ref LLP 0360#decision [implements]: bundle the contract; require context-graph as plugin + capability; register in activate()
 *
 * @param {PluginActivationContext} ctx
 */
export async function activate(ctx) {
  ctx.configRegistry.registerSection({
    plugin: PLUGIN_NAME,
    section: 'github',
    validate: (value) => toValidationResult(validateGithubConfig(value)),
  })

  const validated = validateGithubConfig(ctx.config)
  if (!validated.ok) {
    const detail = validated.errors.map((e) => `${e.pointer || '/'}: ${e.message}`).join('; ')
    const err = /** @type {HypError} */ (new Error(`${PLUGIN_NAME}: invalid config - ${detail}`))
    err.hypErrorKind = 'github_config_invalid'
    throw err
  }
  const config = validated.config

  const graph = /** @type {ContextGraphCapabilityLike} */ (
    ctx.requireCapability('hypaware.context-graph', '^1.0.0')
  )

  ctx.query.registerDataset(githubEventsDatasetRegistration())

  setGithubRuntime({
    ctx,
    config,
    log: ctx.log,
    stateDir: ctx.paths.stateDir,
    storage: /** @type {ExtendedQueryStorageService} */ (ctx.storage),
    env: ctx.env,
    observedRepos: createLocalObservedReposIndex({
      storage: ctx.storage,
      stateDir: ctx.paths.stateDir,
    }),
  })

  graph.registerContract(createGithubGraphContract(graph.kit))

  ctx.sources.register({
    name: 'github',
    plugin: PLUGIN_NAME,
    summary: 'Poll session-observed repositories by default, or all visible repositories when configured',
    configSection: 'github',
    start: startGithubSource,
  })

  ctx.commands.register({ name: 'github', plugin: PLUGIN_NAME, summary: 'GitHub capture', usage: 'hyp github <backfill|sync>', run: runGithub })
  ctx.commands.register({ name: 'github backfill', plugin: PLUGIN_NAME, summary: 'Pull full history into github_events', usage: 'hyp github backfill [owner/repo ...]', run: runGithubBackfill })
  ctx.commands.register({ name: 'github sync', plugin: PLUGIN_NAME, summary: 'Run one poll tick now', usage: 'hyp github sync', run: runGithubSync })

  ctx.log.info('github.activated', {
    ignore: config.ignore.length,
    poll: config.poll_interval,
    inventory: config.inventory,
  })
}

/**
 * @param {ReturnType<typeof validateGithubConfig>} result
 * @returns {ValidationResult}
 */
function toValidationResult(result) {
  if (result.ok) return { ok: true }
  return { ok: false, errors: result.errors.map((e) => ({ pointer: e.pointer, message: e.message })) }
}
