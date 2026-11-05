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
 * @import { PluginActivationContext, StartedSource } from '../../../../hypaware-plugin-kernel-types.js'
 */

import { MASTRACODE_CONFIG_SECTION, resolveMastracodeEnabled, validateMastracodeConfig } from './config.js'

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

  ctx.sources.register({
    name: SOURCE_NAME,
    plugin: PLUGIN_NAME,
    summary: 'Mastra Code mastra.db poll source (ongoing capture)',
    configSection: MASTRACODE_CONFIG_SECTION,
    start: startMastracodeSource,
  })
}

/**
 * Start the source. It reads nothing yet and reports `ready` with zero rows.
 *
 * @param {PluginActivationContext} ctx
 * @returns {Promise<StartedSource>}
 */
async function startMastracodeSource(ctx) {
  const enabled = resolveMastracodeEnabled(ctx.config)
  if (!enabled) {
    ctx.log.info('mastracode.source_disabled', {
      component: 'mastracode',
      operation: 'mastracode.start',
      detail: 'mastracode.enabled = false',
    })
  }
  return {
    async status() {
      return {
        state: 'ready',
        message: enabled
          ? 'mastracode source started, no threads read'
          : 'mastracode ongoing capture disabled (mastracode.enabled = false)',
        rowsWritten: 0,
        details: { enabled },
      }
    },
    async reload() {},
    async stop() {},
  }
}
