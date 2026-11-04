// @ts-check

/**
 * Activation for `@hypaware/crush`: wires the `[crush]` config section and
 * the `crush` source into the kernel. No dataset of its own: rows
 * materialize into `ai_gateway_messages` through the shared
 * `ai_gateway.projected_exchange` materializer contributed by
 * `@hypaware/ai-gateway`, the manifest's `requires.plugins` dependency.
 *
 * @ref LLP 0573#manifest [implements]: bundled, read-only adapter in the goose
 *   shape; it writes nothing into Crush's files and installs no skills.
 *
 * @import { PluginActivationContext } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { CrushRunnerHolder } from './types.js'
 */

import { readObservabilityEnv } from '../../../../src/core/observability/env.js'
import { SessionIgnoreSet } from '../../../../src/core/control/session_ignore_store.js'
import { CRUSH_CONFIG_SECTION, validateCrushConfig } from './config.js'
import { startCrushSource } from './source.js'

export { crushSourceStatus, startCrushSource } from './source.js'

const PLUGIN_NAME = '@hypaware/crush'
const SOURCE_NAME = 'crush'

/**
 * The plugin's `config_sections` validator, exported side-effect-free so
 * the kernel apply path can validate `[crush]` before activation.
 *
 * @type {{ section: string, validate: typeof validateCrushConfig }}
 */
export const configSection = { section: CRUSH_CONFIG_SECTION, validate: validateCrushConfig }

/**
 * Activate the `@hypaware/crush` adapter plugin. The source is only
 * registered here; the daemon runtime is its sole starter (issue #348).
 *
 * @param {PluginActivationContext} ctx
 */
export async function activate(ctx) {
  ctx.configRegistry.registerSection({
    plugin: PLUGIN_NAME,
    section: CRUSH_CONFIG_SECTION,
    validate: validateCrushConfig,
  })

  // @ref LLP 0573#privacy [implements]: the durable session exclusions load at
  // activation; the poll refreshes them by signature on ticks with candidates.
  const ignoredSessions = new SessionIgnoreSet(readObservabilityEnv(ctx.env).stateDir, ctx.log)
  /** @type {CrushRunnerHolder} */
  const holder = {}

  ctx.sources.register({
    name: SOURCE_NAME,
    plugin: PLUGIN_NAME,
    summary: 'Crush crush.db poll source (ongoing capture)',
    configSection: CRUSH_CONFIG_SECTION,
    start: (sctx) => startCrushSource(sctx, { ignoredSessions, holder }),
  })
}
