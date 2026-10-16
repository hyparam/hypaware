// @ts-check

import { compareStrings } from 'hypaware/core/util'

import { discoverParts } from '../../ai-gateway/src/dataset.js'
import { SOURCE_DATASET } from './graph_contract.js'
/**
 * @import { PluginActivationContext, StartedSource } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { ExtendedQueryStorageService } from '../../../../src/core/cache/types.js'
 * @import { ContextGraphCapability } from './types.js'
 */

export const PROJECTION_INTERVAL_MS = 5 * 60_000
export const FIRST_PROJECTION_DELAY_MS = 1_000

/**
 * @param {PluginActivationContext} ctx
 * @param {ContextGraphCapability} graph
 * @returns {Promise<StartedSource>}
 * @ref LLP 0512#lifecycle [implements]: completion-relative scheduling, retry and shutdown share the source lifecycle
 */
export async function startGraphSource(ctx, graph) {
  const storage = /** @type {ExtendedQueryStorageService} */ (ctx.storage)
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer
  /** @type {Promise<void> | undefined} */
  let inFlight
  /** @type {string | undefined} */
  let projectedFingerprint
  /** @type {string | undefined} */
  let lastError
  /** @type {string | null} */
  let lastSuccessAt = null
  let stopped = false
  let projectionDue = true
  let rowsWritten = 0

  async function tick() {
    const started = Date.now()
    try {
      const dataset = ctx.query.getDataset(SOURCE_DATASET)
      if (!dataset) throw new Error(`graph projection: missing dataset '${SOURCE_DATASET}'`)
      const parts = await storage.discoverCachePartitions({ datasets: [SOURCE_DATASET] })
      const fingerprint = JSON.stringify(parts.map(p => [p.path, p.epoch, p.rowCount]).sort((a, b) => compareStrings(String(a[0]), String(b[0]))))
      // Dataset discovery includes uncommitted spool paths that cache partition
      // discovery cannot see. Projection's normal query path settles those rows.
      const queryParts = await discoverParts({
        config: { version: 2, plugins: [] },
        scope: { datasets: [SOURCE_DATASET], limit: 0 },
        cacheDir: storage.cacheRoot,
      }, parts)
      const pending = queryParts.some(p => p.tablePath && storage.hasPendingSync(p.tablePath))
      if (stopped) return
      if (!projectionDue && fingerprint === projectedFingerprint && !pending) {
        lastError = undefined
        return
      }

      projectionDue = true
      ctx.log.info('graph.projection_started', { source_dataset: SOURCE_DATASET })
      const result = await graph.project(SOURCE_DATASET)
      // Keep the pre-scan fingerprint: capture during a projection must stay
      // due. Flushing a pending spool can cause one extra idempotent pass.
      projectedFingerprint = fingerprint
      projectionDue = false
      rowsWritten += result.nodesWritten + result.edgesWritten
      lastSuccessAt = new Date().toISOString()
      lastError = undefined
      ctx.log.info('graph.projection_completed', {
        source_dataset: SOURCE_DATASET,
        nodes_written: result.nodesWritten,
        edges_written: result.edgesWritten,
        duration_ms: Date.now() - started,
      })
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      ctx.log.error('graph.projection_failed', {
        source_dataset: SOURCE_DATASET,
        error: lastError,
        duration_ms: Date.now() - started,
      })
    }
  }

  /** @param {number} delay */
  function schedule(delay) {
    timer = setTimeout(() => {
      timer = undefined
      inFlight = tick().finally(() => {
        inFlight = undefined
        if (!stopped) schedule(PROJECTION_INTERVAL_MS)
      })
    }, delay)
    timer.unref()
  }

  schedule(FIRST_PROJECTION_DELAY_MS)
  return {
    async status() {
      return {
        state: stopped ? 'stopped' : lastError ? 'error' : 'ready',
        message: 'Projecting recorded AI sessions into the local graph every five minutes',
        rowsWritten,
        lastError,
        details: { in_flight: inFlight !== undefined, last_success_at: lastSuccessAt },
      }
    },
    async stop() {
      stopped = true
      clearTimeout(timer)
      await inFlight
    },
  }
}
