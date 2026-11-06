// @ts-check

/**
 * Activation for `@hypaware/mastracode`: wires the `[mastracode]` config
 * section and the `mastracode` source into the kernel. No dataset of its
 * own: rows materialize into `ai_gateway_messages` through the shared
 * `ai_gateway.projected_exchange` materializer contributed by
 * `@hypaware/ai-gateway`, the manifest's `requires.plugins` dependency.
 *
 * @ref LLP 0586#manifest [implements]: bundled, read-only adapter in the
 *   goose shape; it writes nothing into Mastra Code and installs no skills.
 *
 * @import { PluginActivationContext } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { MastraRunnerHolder } from './types.js'
 */

import { readObservabilityEnv } from '../../../../src/core/observability/env.js'
import { SessionIgnoreSet } from '../../../../src/core/control/session_ignore_store.js'
import { localOnlyListPath } from '../../../../src/core/usage-policy/index.js'
import { createMastracodeBackfillProvider } from './backfill.js'
import { MASTRACODE_CONFIG_SECTION, resolveHomeDir, resolveMastraDbLocation, validateMastracodeConfig } from './config.js'
import { startMastracodeSource } from './source.js'

const PLUGIN_NAME = '@hypaware/mastracode'
const SOURCE_NAME = 'mastracode'

/**
 * The plugin's `config_sections` validator, exported side-effect-free so
 * the kernel apply path can validate `[mastracode]` before activation.
 *
 * @type {{ section: string, validate: typeof validateMastracodeConfig }}
 */
export const configSection = { section: MASTRACODE_CONFIG_SECTION, validate: validateMastracodeConfig }

/**
 * Activate the `@hypaware/mastracode` adapter plugin. The source is only
 * registered here; the daemon runtime is its sole starter (issue #348).
 *
 * @param {PluginActivationContext} ctx
 */
export async function activate(ctx) {
  ctx.configRegistry.registerSection({
    plugin: PLUGIN_NAME,
    section: MASTRACODE_CONFIG_SECTION,
    validate: validateMastracodeConfig,
  })

  // @ref LLP 0586#privacy [implements]: the durable session exclusions load at
  // activation; the poll refreshes them by signature on ticks with candidates.
  const observabilityStateDir = readObservabilityEnv(ctx.env).stateDir
  const ignoredSessions = new SessionIgnoreSet(observabilityStateDir, ctx.log)
  /** @type {MastraRunnerHolder} */
  const holder = {}

  ctx.backfills.register(createMastracodeBackfillProvider({
    location: resolveMastraDbLocation(ctx, resolveHomeDir(ctx)),
    stateDir: ctx.paths.stateDir,
    config: ctx.config,
    ignoredSessions,
    localOnlyListPath: localOnlyListPath(observabilityStateDir),
    holder,
  }))

  ctx.sources.register({
    name: SOURCE_NAME,
    plugin: PLUGIN_NAME,
    summary: 'Mastra Code mastra.db poll source (ongoing capture)',
    configSection: MASTRACODE_CONFIG_SECTION,
    start: (sctx) => startMastracodeSource(sctx, { ignoredSessions, holder }),
  })
}
