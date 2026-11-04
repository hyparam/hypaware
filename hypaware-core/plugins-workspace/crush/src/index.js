// @ts-check

/**
 * Activation for `@hypaware/crush`: wires the `[crush]` config section and
 * the `crush` source into the kernel. No dataset of its own: rows
 * materialize into `ai_gateway_messages` through the shared
 * `ai_gateway.projected_exchange` materializer contributed by
 * `@hypaware/ai-gateway`, the manifest's `requires.plugins` dependency.
 *
 * This first cut registers a source that runs discovery on each status read
 * and records nothing; the reader, the poll and the backfill provider land
 * with LLP 0574 T3 to T5.
 *
 * @ref LLP 0573#manifest [implements]: bundled, read-only adapter in the goose
 *   shape; it writes nothing into Crush's files and installs no skills.
 *
 * @import { PluginActivationContext, SourceStatus, StartedSource } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { CrushDiscoveryResult } from './types.js'
 */

import { groupThousands } from '../../../../src/core/util/format_number.js'
import {
  CRUSH_CONFIG_SECTION,
  resolveCrushEnabled,
  resolveDataDirs,
  resolveHomeDir,
  resolveIndexPath,
  resolvePollIntervalMs,
  validateCrushConfig,
} from './config.js'
import { MAX_DATABASES, createDiscoveryState, discoverDatabases } from './discovery.js'

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

  ctx.sources.register({
    name: SOURCE_NAME,
    plugin: PLUGIN_NAME,
    summary: 'Crush crush.db poll source (ongoing capture)',
    configSection: CRUSH_CONFIG_SECTION,
    start: (sctx) => startCrushSource(sctx),
  })
}

/**
 * `SourceContribution.start` for the `crush` source. Opens no database and
 * runs no timer: status reads run one discovery pass, which rereads the
 * index only when its signature moved.
 *
 * @param {PluginActivationContext} ctx
 * @returns {Promise<StartedSource>}
 */
export async function startCrushSource(ctx) {
  if (!resolveCrushEnabled(ctx.config)) return createDisabledSource(ctx)
  let activeCtx = ctx
  let stopped = false
  const state = createDiscoveryState()

  return {
    async status() {
      const homeDir = resolveHomeDir(activeCtx)
      const indexPath = resolveIndexPath(activeCtx, homeDir)
      const result = discoverDatabases(state, { indexPath, dataDirs: resolveDataDirs(activeCtx, homeDir) })
      return crushSourceStatus(result, {
        indexPath,
        pollIntervalMs: resolvePollIntervalMs(activeCtx),
        rowsWritten: 0,
        stopped,
      })
    },
    async reload(next) {
      activeCtx = next
    },
    async stop() {
      stopped = true
    },
  }
}

/**
 * Map one discovery pass to the source's health. Messages carry the index
 * path and counts only, never a project path.
 *
 * @ref LLP 0573#status [implements]: no index is `ready` with zero rows, an
 *   unreadable index and the database cap are `degraded`, stale entries only
 *   append a count.
 *
 * @param {CrushDiscoveryResult} result
 * @param {{ indexPath: string, pollIntervalMs: number, rowsWritten: number, stopped?: boolean }} opts
 * @returns {SourceStatus}
 */
export function crushSourceStatus(result, opts) {
  const { indexPath, pollIntervalMs, rowsWritten } = opts
  /** @type {string | null} */
  let errorKind = null
  /** @type {string} */
  let message
  if (result.indexUnreadable) {
    errorKind = 'index_unreadable'
    message = `cannot read the crush index at ${indexPath}`
  } else if (result.overCap > 0) {
    errorKind = 'too_many_projects'
    message = `${result.overCap} crush projects skipped over the ${groupThousands(MAX_DATABASES)} limit`
  } else if (!result.indexPresent && result.listed === 0) {
    message = `no crush installation detected at ${indexPath}`
  } else if (result.listed === 0) {
    message = `crush index at ${indexPath} lists no projects yet`
  } else {
    const every = `polling ${result.databases.length} crush projects every ${pollIntervalMs}ms`
    message = rowsWritten > 0 ? every : `${every}, no sessions yet`
  }
  if (result.stale > 0) message = `${message}; ${result.stale} listed projects have no crush.db`

  /** @type {SourceStatus} */
  const status = {
    state: opts.stopped ? 'stopped' : errorKind ? 'degraded' : 'ready',
    message,
    rowsWritten,
    details: {
      index_path: indexPath,
      poll_interval_ms: pollIntervalMs,
      databases: result.databases.length,
      stale: result.stale,
      over_cap: result.overCap,
    },
  }
  if (errorKind) {
    // Plain `hyp status` prints `lastError` over `message`, so both carry the
    // text; the kind stays in `details`.
    status.lastError = message
    if (status.details) status.details.error_kind = errorKind
  }
  return status
}

/**
 * The `StartedSource` returned when `enabled: false` turns ongoing capture
 * off. It opens nothing and runs no timer.
 *
 * @param {PluginActivationContext} ctx
 * @returns {StartedSource}
 */
function createDisabledSource(ctx) {
  const indexPath = resolveIndexPath(ctx, resolveHomeDir(ctx))
  ctx.log.info('crush.source_disabled', {
    component: 'crush',
    operation: 'crush.start',
    detail: 'crush.enabled = false',
  })
  return {
    async status() {
      return {
        state: 'ready',
        message: 'crush ongoing capture disabled (crush.enabled = false)',
        rowsWritten: 0,
        details: { index_path: indexPath, enabled: false },
      }
    },
    async reload() {},
    async stop() {},
  }
}
