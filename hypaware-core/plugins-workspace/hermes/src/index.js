// @ts-check

/**
 * Activation for `@hypaware/hermes`: wires the `[hermes]` config section,
 * the `hermes` poll source (T4, `src/source.js`), and the `hermes` backfill
 * provider (T3, `src/backfill.js`) into the kernel. No dataset of its own:
 * both paths materialize into `ai_gateway_messages` through the shared
 * `ai_gateway.projected_exchange` materializer contributed by
 * `@hypaware/ai-gateway` (LLP 0120), the manifest's `requires.plugins` hard
 * dependency.
 *
 * @ref LLP 0121 [implements]: bundled plugin, same activation shape as the
 *   claude/codex adapters, registered beside them in the plugins workspace.
 *
 * @import { PluginActivationContext } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { ExtendedSourceRegistry } from '../../../../src/core/registry/types.js'
 */

import { HERMES_CONFIG_SECTION, resolveHermesEnabled, validateHermesConfig } from './config.js'
import { createHermesBackfillProvider } from './backfill.js'
import { HERMES_CLIENT_NAME } from './projector.js'
import { resolveHomeDir, resolveStateDbPath, startHermesSource } from './source.js'

const PLUGIN_NAME = '@hypaware/hermes'
const SOURCE_NAME = 'hermes'

/**
 * The plugin's `config_sections` validator, surfaced as a side-effect-free
 * export so the kernel apply path can validate this plugin's `[hermes]`
 * config block before the plugin is ever activated, the same pattern
 * `@hypaware/codex` uses (`src/index.js#configSection`).
 *
 * @type {{ section: string, validate: typeof validateHermesConfig }}
 */
export const configSection = { section: HERMES_CONFIG_SECTION, validate: validateHermesConfig }

/**
 * Activate the `@hypaware/hermes` adapter plugin.
 *
 * Registers the `[hermes]` config section, the `hermes` backfill provider
 * (always available: `hyp backfill hermes` behaves the same whether or not
 * ongoing capture is enabled), and the `hermes` poll source. The source is
 * always *registered* so it is discoverable and its config section wired,
 * but only *started* when `enabled` resolves true (LLP 0122#config):
 * `enabled: false` is a static kill switch for ongoing capture, distinct
 * from the source's own missing-`state.db` idle mode (spec R9), which
 * applies either way once started.
 *
 * @param {PluginActivationContext} ctx
 * @ref LLP 0121 [implements]: config section + source + backfill registration, no dataset of its own
 */
export async function activate(ctx) {
  ctx.configRegistry.registerSection({
    plugin: PLUGIN_NAME,
    section: HERMES_CONFIG_SECTION,
    validate: validateHermesConfig,
  })

  ctx.sources.register({
    name: SOURCE_NAME,
    plugin: PLUGIN_NAME,
    summary: 'Hermes Agent state.db poll source (ongoing capture)',
    configSection: HERMES_CONFIG_SECTION,
    start: startHermesSource,
  })

  const homeDir = resolveHomeDir(ctx)
  // @ref LLP 0122#config [implements]: the backfill provider and the poll
  // source resolve `state_db` through the same helper, so a config
  // override (profiles/tests) applies identically to both paths.
  ctx.backfills.register(
    createHermesBackfillProvider({
      homeDir,
      stateDbPath: resolveStateDbPath(ctx, homeDir),
      clientName: HERMES_CLIENT_NAME,
      pluginName: PLUGIN_NAME,
    })
  )

  if (resolveHermesEnabled(ctx.config)) {
    const sources = /** @type {ExtendedSourceRegistry} */ (ctx.sources)
    await sources.start(SOURCE_NAME, ctx)
  }
}
