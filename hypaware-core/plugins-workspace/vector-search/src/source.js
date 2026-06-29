// @ts-check

import { Attr, withSpan } from '../../../../src/core/observability/index.js'
import { refreshIndexes } from './refresh.js'
import { getVectorSearchRuntime } from './runtime.js'
import { validateVectorSearchConfig } from './config.js'

/**
 * @import { PluginActivationContext, SourceStatus, StartedSource } from '../../../../collectivus-plugin-kernel-types.js'
 * @import { RefreshReport } from './types.js'
 */

/**
 * Daemon refresh timer, modeled on the kernel's cache-maintenance loop
 * (`src/core/cache/maintenance.js` via `daemon/runtime.js`): its own
 * interval, a wall-clock budget per tick, an in-flight guard so a slow
 * tick never stacks, and an unref'd handle so the timer cannot keep the
 * process alive. Registered as a source contribution because the daemon
 * starts every registered source (that is, the kernel's "give a plugin
 * a periodic foothold") seam.
 *
 * Per-tick embedding spend is additionally bounded by
 * `refresh.max_rows_per_tick`; bounded per-partition shard writes match
 * the work-shape the maintenance tick already performs in-daemon, so
 * the monolithic parquet-export OOM constraint does not apply here.
 *
 * @param {PluginActivationContext} _ctx
 * @returns {Promise<StartedSource>}
 * @ref LLP 0024#freshness-rides-the-cache-maintenance-pattern [implements]: daemon timer with interval + per-tick wall-clock and row budgets
 */
export async function startVectorRefreshSource(_ctx) {
  const runtime = getVectorSearchRuntime()

  /** @type {NodeJS.Timeout | null} */
  let handle = null
  /** @type {Promise<void> | null} */
  let inFlight = null
  /** @type {RefreshReport | null} */
  let lastReport = null
  /** @type {string | null} */
  let lastError = null
  /** @type {string | null} */
  let lastTickAt = null

  async function runTick() {
    const cfg = runtime.config.refresh
    lastTickAt = new Date().toISOString()
    await withSpan(
      'vector.refresh_tick',
      {
        [Attr.COMPONENT]: 'vector-search',
        [Attr.OPERATION]: 'vector.refresh_tick',
        [Attr.PLUGIN]: '@hypaware/vector-search',
        index_count: runtime.config.indexes.length,
        status: 'ok',
      },
      async (span) => {
        const report = await refreshIndexes({
          decls: runtime.config.indexes,
          embedder: runtime.embedder,
          storage: runtime.storage,
          indexesDir: runtime.indexesDir,
          log: runtime.log,
          budget: {
            deadlineMs: Date.now() + cfg.max_tick_ms,
            maxRows: cfg.max_rows_per_tick,
          },
        })
        lastReport = report
        lastError = null
        span.setAttribute('shards_built', report.shardsBuilt)
        span.setAttribute('shards_skipped', report.shardsSkipped)
        span.setAttribute('orphans_swept', report.orphansSwept)
        span.setAttribute('rows_embedded', report.rowsEmbedded)
        span.setAttribute('budget_exhausted', report.budgetExhausted)
      },
      { component: 'vector-search' }
    ).catch((/** @type {unknown} */ err) => {
      lastError = err instanceof Error ? err.message : String(err)
      runtime.log.error('vector.refresh_tick_failed', { message: lastError })
    })
  }

  function startTimer() {
    const cfg = runtime.config.refresh
    if (!cfg.enabled || runtime.config.indexes.length === 0) return
    const intervalMs = Math.max(1, Math.round(cfg.interval_minutes * 60_000))
    handle = setInterval(() => {
      if (inFlight) return
      inFlight = runTick().finally(() => { inFlight = null })
    }, intervalMs)
    if (typeof handle.unref === 'function') handle.unref()
  }

  function stopTimer() {
    if (handle) {
      clearInterval(handle)
      handle = null
    }
  }

  startTimer()
  runtime.log.info('vector.refresh_source_started', {
    enabled: runtime.config.refresh.enabled,
    index_count: runtime.config.indexes.length,
    interval_minutes: runtime.config.refresh.interval_minutes,
  })

  return {
    async status() {
      /** @type {SourceStatus} */
      const status = {
        state: 'ready',
        message: handle
          ? `refreshing ${runtime.config.indexes.length} index(es) every ${runtime.config.refresh.interval_minutes}m`
          : 'idle (refresh disabled or no indexes configured)',
        details: {
          last_tick_at: lastTickAt,
          last_error: lastError,
          ...(lastReport
            ? {
                shards_built: lastReport.shardsBuilt,
                shards_skipped: lastReport.shardsSkipped,
                orphans_swept: lastReport.orphansSwept,
                rows_embedded: lastReport.rowsEmbedded,
                budget_exhausted: lastReport.budgetExhausted,
              }
            : {}),
        },
      }
      return status
    },
    async reload(freshCtx) {
      const validated = validateVectorSearchConfig(freshCtx.config)
      if (!validated.ok) {
        runtime.log.warn('vector.reload_config_invalid', {
          errors: validated.errors.map((e) => `${e.pointer}: ${e.message}`).join('; '),
        })
        return
      }
      runtime.config = validated.config
      stopTimer()
      startTimer()
    },
    async stop() {
      stopTimer()
      if (inFlight) await inFlight
    },
  }
}
