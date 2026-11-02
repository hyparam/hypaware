// @ts-check

/**
 * Activation for `@hypaware/goose`: wires the `[goose]` config section and
 * the `goose` source into the kernel. No dataset of its own: rows
 * materialize into `ai_gateway_messages` through the shared
 * `ai_gateway.projected_exchange` materializer contributed by
 * `@hypaware/ai-gateway`, the manifest's `requires.plugins` dependency.
 *
 * @ref LLP 0570 [implements]: bundled, read-only adapter in the hermes
 *   shape; it writes nothing into Goose's config and installs no skills.
 *
 * @import { PluginActivationContext } from '../../../../hypaware-plugin-kernel-types.js'
 */

import { GOOSE_CONFIG_SECTION, validateGooseConfig } from './config.js'
import { startGooseSource } from './source.js'

const PLUGIN_NAME = '@hypaware/goose'
const SOURCE_NAME = 'goose'

/**
 * The plugin's `config_sections` validator, exported side-effect-free so
 * the kernel apply path can validate `[goose]` before activation.
 *
 * @type {{ section: string, validate: typeof validateGooseConfig }}
 */
export const configSection = { section: GOOSE_CONFIG_SECTION, validate: validateGooseConfig }

/**
 * Activate the `@hypaware/goose` adapter plugin. The source is only
 * registered here; the daemon runtime is its sole starter (issue #348).
 *
 * @param {PluginActivationContext} ctx
 */
export async function activate(ctx) {
  ctx.configRegistry.registerSection({
    plugin: PLUGIN_NAME,
    section: GOOSE_CONFIG_SECTION,
    validate: validateGooseConfig,
  })

  ctx.sources.register({
    name: SOURCE_NAME,
    plugin: PLUGIN_NAME,
    summary: 'Goose sessions.db poll source (ongoing capture)',
    configSection: GOOSE_CONFIG_SECTION,
    start: startGooseSource,
  })
}
