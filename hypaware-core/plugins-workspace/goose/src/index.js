// @ts-check

/**
 * Activation for `@hypaware/goose`: wires the `[goose]` config section, the
 * `goose` source, and the `goose` backfill provider into the kernel. No dataset of its own: rows
 * materialize into `ai_gateway_messages` through the shared
 * `ai_gateway.projected_exchange` materializer contributed by
 * `@hypaware/ai-gateway`, the manifest's `requires.plugins` dependency.
 *
 * @ref LLP 0570 [implements]: bundled, read-only adapter in the hermes
 *   shape; it writes nothing into Goose's config and installs no skills.
 *
 * @import { PluginActivationContext } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { GooseRunnerHolder } from './types.js'
 */

import { readObservabilityEnv } from '../../../../src/core/observability/env.js'
import { SessionIgnoreSet } from '../../../../src/core/control/session_ignore_store.js'
import { localOnlyListPath } from '../../../../src/core/usage-policy/index.js'
import { createGooseBackfillProvider } from './backfill.js'
import { GOOSE_CONFIG_SECTION, resolveHomeDir, resolveSessionsDbPath, validateGooseConfig } from './config.js'
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

  // @ref LLP 0570#privacy [implements]: the durable session exclusions load at
  // activation, as NanoClaw and Copilot do; the poll refreshes them by signature.
  const observabilityStateDir = readObservabilityEnv(ctx.env).stateDir
  const ignoredSessions = new SessionIgnoreSet(observabilityStateDir, ctx.log)
  /** @type {GooseRunnerHolder} */
  const holder = {}

  ctx.backfills.register(createGooseBackfillProvider({
    sessionsDbPath: resolveSessionsDbPath(ctx, resolveHomeDir(ctx)),
    stateDir: ctx.paths.stateDir,
    config: ctx.config,
    ignoredSessions,
    localOnlyListPath: localOnlyListPath(observabilityStateDir),
    holder,
  }))

  ctx.sources.register({
    name: SOURCE_NAME,
    plugin: PLUGIN_NAME,
    summary: 'Goose sessions.db poll source (ongoing capture)',
    configSection: GOOSE_CONFIG_SECTION,
    start: (sctx) => startGooseSource(sctx, { ignoredSessions, holder }),
  })
}
