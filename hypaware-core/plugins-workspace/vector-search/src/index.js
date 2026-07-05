// @ts-check

import path from 'node:path'

import { runVector, runVectorSearch, runVectorStatus } from './commands.js'
import { validateVectorSearchConfig } from './config.js'
import { setVectorSearchRuntime } from './runtime.js'
import { searchVectorIndexes } from './search.js'
import { startVectorRefreshSource } from './source.js'
import { collectIndexStatus } from './status.js'

/**
 * @import { EmbedderCapability, HypError, PluginActivationContext, ValidationResult, VectorSearchCapability } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { ExtendedQueryStorageService } from '../../../../src/core/cache/types.js'
 * @import { VectorSearchRuntime } from './types.js'
 */

const PLUGIN_NAME = '@hypaware/vector-search'
const CAPABILITY_VERSION = '1.0.0'

/**
 * Activate `@hypaware/vector-search`. Registers:
 *  - capability `hypaware.vector-search` (programmatic search/status)
 *  - commands `vector`, `vector search`, `vector status`
 *  - source `vector-search-refresh` (the daemon refresh timer)
 *  - config section `vector-search`
 *
 * Vector search is a plugin capability building on the intrinsic
 * SQL/dataset surface, not kernel surface; it requires a separately
 * chosen `hypaware.embedder` provider, so which embedder runs (and
 * whether captured text may leave the machine) is always an explicit
 * `plugins[]` decision.
 *
 * @param {PluginActivationContext} ctx
 * @ref LLP 0024#plugin-not-kernel [implements]: vector search ships as a bundled plugin; query stays the SQL/dataset surface
 */
export async function activate(ctx) {
  ctx.configRegistry.registerSection({
    plugin: PLUGIN_NAME,
    section: 'vector-search',
    validate: (value) => toValidationResult(validateVectorSearchConfig(value)),
  })

  const validated = validateVectorSearchConfig(ctx.config)
  if (!validated.ok) {
    const detail = validated.errors.map((e) => `${e.pointer || '/'}: ${e.message}`).join('; ')
    const err = /** @type {HypError} */ (new Error(`${PLUGIN_NAME}: invalid config - ${detail}`))
    err.hypErrorKind = 'vector_config_invalid'
    throw err
  }

  // @ref LLP 0024#embedding-is-a-separate-capability [constrained-by]: embedding always resolves through the capability registry, never a baked-in provider
  const embedder = /** @type {EmbedderCapability} */ (ctx.requireCapability('hypaware.embedder', '^1.0.0'))

  /** @type {VectorSearchRuntime} */
  const runtime = {
    ctx,
    config: validated.config,
    embedder,
    storage: /** @type {ExtendedQueryStorageService} */ (ctx.storage),
    log: ctx.log,
    indexesDir: path.join(ctx.paths.stateDir, 'indexes'),
  }
  setVectorSearchRuntime(runtime)

  /** @type {VectorSearchCapability} */
  const capability = {
    search: (opts) => searchVectorIndexes({ runtime, opts }),
    status: () => collectIndexStatus(runtime),
  }
  ctx.provideCapability('hypaware.vector-search', CAPABILITY_VERSION, capability)

  ctx.commands.register({
    name: 'vector',
    plugin: PLUGIN_NAME,
    summary: 'Vector similarity search (see subcommands: search, status)',
    usage: 'hyp vector <subcommand> [args...]',
    run: runVector,
  })
  ctx.commands.register({
    name: 'vector search',
    plugin: PLUGIN_NAME,
    summary: 'Similarity search across configured vector indexes',
    usage: 'hyp vector search <query> [--index <name>] [--dataset <name>] [--top-k <n>] [--no-refresh] [--format <fmt>]',
    run: runVectorSearch,
  })
  ctx.commands.register({
    name: 'vector status',
    plugin: PLUGIN_NAME,
    summary: 'Per-index vector shard coverage and staleness',
    usage: 'hyp vector status [--json]',
    run: runVectorStatus,
  })

  ctx.sources.register({
    name: 'vector-search-refresh',
    plugin: PLUGIN_NAME,
    summary: 'Background vector index refresh timer',
    configSection: 'vector-search',
    start: startVectorRefreshSource,
  })

  ctx.log.info('vector.activated', {
    index_count: validated.config.indexes.length,
    embed_model: embedder.model,
    refresh_enabled: validated.config.refresh.enabled,
  })
}

/**
 * @param {ReturnType<typeof validateVectorSearchConfig>} result
 * @returns {ValidationResult}
 */
function toValidationResult(result) {
  if (result.ok) return { ok: true }
  return { ok: false, errors: result.errors.map((e) => ({ pointer: e.pointer, message: e.message })) }
}
