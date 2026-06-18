// @ts-check

import { Attr, withSpan } from '../../../../src/core/observability/index.js'

import { PROSPECTS_DATASET } from './datasets.js'
import {
  appendCommitted,
  appendResolutions,
  buildCurateClusters,
  curateRequestForCluster,
  routeClusterDecisions,
  runCurateTick,
  selectPending,
  skipResolutionRows,
} from './curate.js'
import { getCompletion, requireEnrichRuntime } from './runtime.js'
import { runSql } from './sql.js'
import { readState, writeState } from './state.js'

/**
 * Batch-regime curate orchestration ([§two-regimes](LLP 0028)). T2's frontier
 * calls go through the Anthropic **Batch API** (50% off, async). Two drivers
 * share one cluster-building + routing core (from curate.js):
 *
 * - **backfill** (`hyp enrich backfill`) — {@link runCurateBatch} submits the
 *   whole eligible pool and **polls to completion in one run** (out of daemon).
 * - **ongoing** (daemon source) — {@link submitCurateJob} submits on one tick
 *   and {@link collectCurateJob} collects on a later tick, carrying the job in
 *   the sidecar, so the frontier work never blocks a daemon tick.
 *
 * Either driver falls back to the synchronous {@link runCurateTick} when the
 * completion provider exposes no `batch` surface.
 *
 * @ref LLP 0028#two-regimes [implements]
 *
 * @import { EnrichRuntime } from './types.d.ts'
 * @import { CompletionBatch, CompletionBatchStatus, SourceStatus, StartedSource } from '../../../../collectivus-plugin-kernel-types.d.ts'
 */

/**
 * Run a complete curate batch end-to-end: cluster the whole pending pool,
 * submit, poll to completion, collect, route, append. Blocks until the job
 * finishes (≤24h) — the deliberate backfill-command path. Falls back to a
 * synchronous tick when the provider has no batch API.
 *
 * @param {EnrichRuntime} runtime
 * @param {{ signal?: AbortSignal, intervalMs?: number, onProgress?: (s: CompletionBatchStatus) => void }} [opts]
 * @returns {Promise<{ pending: number, processed: number, committed: number, rejected: number, merged: number, skipped: number, clusters: number, batched: boolean }>}
 */
export async function runCurateBatch(runtime, opts = {}) {
  const completion = getCompletion(runtime)
  const batch = completion.batch
  if (!batch) {
    runtime.log.warn('enrich.curate_batch_unavailable', { [Attr.ERROR_KIND]: 'enrich_batch_unavailable', provider: completion.provider })
    const sync = await runCurateTick(runtime, { signal: opts.signal })
    return { ...sync, batched: false }
  }
  return withSpan(
    'enrich.curate_batch',
    { [Attr.COMPONENT]: 'plugin', [Attr.OPERATION]: 'enrich.curate_batch', [Attr.PLUGIN]: '@hypaware/context-graph-enrich', status: 'ok' },
    async (span) => {
      const pending = await selectPending(runtime)
      const { clusters, skipped, recallByProspect } = await buildCurateClusters(runtime, pending, { uncapped: true })
      const at = new Date().toISOString()
      /** @type {Record<string, unknown>[]} */
      const committedRows = []
      /** @type {Record<string, unknown>[]} */
      const resolutionRows = [...skipResolutionRows(skipped, at)]
      let processed = 0
      let rejected = 0
      let merged = 0

      if (clusters.length > 0) {
        const built = await buildClusterRequests(runtime, clusters, recallByProspect)
        const status = await batch.submit(built.map((b) => ({ customId: b.customId, request: b.request })), { signal: opts.signal })
        span.setAttribute('batch_id', status.id)
        await pollUntilEnded(batch, status.id, { signal: opts.signal, intervalMs: opts.intervalMs, onProgress: opts.onProgress })
        const results = await batch.results(status.id, { signal: opts.signal })
        const byCustom = new Map(results.map((r) => [r.customId, r]))
        for (const b of built) {
          const routed = routeClusterDecisions(b.cluster, byCustom.get(b.customId)?.result ?? null, at)
          committedRows.push(...routed.committedRows)
          resolutionRows.push(...routed.resolutionRows)
          processed += routed.processed
          rejected += routed.rejected
          merged += routed.merged
        }
      }

      await appendCommitted(runtime, committedRows)
      await appendResolutions(runtime, resolutionRows)

      span.setAttribute('pending', pending.length)
      span.setAttribute('clusters', clusters.length)
      span.setAttribute('processed', processed)
      span.setAttribute('committed', committedRows.length)
      span.setAttribute('skipped', skipped.length)
      return { pending: pending.length, processed, committed: committedRows.length, rejected, merged, skipped: skipped.length, clusters: clusters.length, batched: true }
    },
    { component: 'plugin' }
  )
}

/**
 * Submit a curate batch for the ongoing regime and record it in the sidecar —
 * **does not block** waiting for results ({@link collectCurateJob} picks them up
 * on a later tick). Below-salience prospects get their terminal `skip`
 * resolutions now (batch-independent). No-op when a job is already in flight;
 * runs synchronously when the provider has no batch API.
 *
 * @param {EnrichRuntime} runtime
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ phase: 'in_flight' | 'idle' | 'sync' | 'submitted', id?: string, clusters?: number, skipped?: number }>}
 */
export async function submitCurateJob(runtime, opts = {}) {
  const state = readState(runtime.stateDir)
  if (state.curate_job) return { phase: 'in_flight', id: state.curate_job.id }

  const completion = getCompletion(runtime)
  const batch = completion.batch
  const pending = await selectPending(runtime)
  const { clusters, skipped, recallByProspect } = await buildCurateClusters(runtime, pending, { uncapped: true })
  const at = new Date().toISOString()
  await appendResolutions(runtime, skipResolutionRows(skipped, at))
  if (clusters.length === 0) return { phase: 'idle', skipped: skipped.length }
  if (!batch) {
    runtime.log.warn('enrich.curate_batch_unavailable', { [Attr.ERROR_KIND]: 'enrich_batch_unavailable', provider: completion.provider })
    await runCurateTick(runtime, { signal: opts.signal })
    return { phase: 'sync' }
  }
  return withSpan(
    'enrich.curate_submit',
    { [Attr.COMPONENT]: 'plugin', [Attr.OPERATION]: 'enrich.curate_submit', [Attr.PLUGIN]: '@hypaware/context-graph-enrich', status: 'ok' },
    async (span) => {
      const built = await buildClusterRequests(runtime, clusters, recallByProspect)
      const status = await batch.submit(built.map((b) => ({ customId: b.customId, request: b.request })), { signal: opts.signal })
      // Re-read so a concurrent propose tick's session_marks (advanced during
      // the submit await) aren't clobbered by the stale snapshot.
      writeState(runtime.stateDir, {
        ...readState(runtime.stateDir),
        curate_job: { id: status.id, submitted_at: at, clusters: built.map((b) => ({ customId: b.customId, prospectIds: b.prospectIds })) },
      })
      span.setAttribute('batch_id', status.id)
      span.setAttribute('clusters', built.length)
      return { phase: 'submitted', id: status.id, clusters: built.length }
    },
    { component: 'plugin' }
  )
}

/**
 * Poll the in-flight ongoing curate job; if it has ended, collect its results,
 * route them (re-fetching the recorded prospect rows so a moved-on pending pool
 * doesn't matter), append, and clear the job. Append-then-clear errs toward a
 * harmless re-collect on a crash (committed rows dedup at projection, resolution
 * ids dedup in the pending set) rather than losing a finished job's output.
 *
 * @param {EnrichRuntime} runtime
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ phase: 'none' | 'pending' | 'collected', id?: string, status?: string, committed?: number, processed?: number, rejected?: number, merged?: number }>}
 */
export async function collectCurateJob(runtime, opts = {}) {
  const state = readState(runtime.stateDir)
  const job = state.curate_job
  if (!job) return { phase: 'none' }
  const batch = getCompletion(runtime).batch
  if (!batch) {
    writeState(runtime.stateDir, { ...state, curate_job: null })
    return { phase: 'none' }
  }
  return withSpan(
    'enrich.curate_collect',
    { [Attr.COMPONENT]: 'plugin', [Attr.OPERATION]: 'enrich.curate_collect', [Attr.PLUGIN]: '@hypaware/context-graph-enrich', batch_id: job.id, status: 'ok' },
    async (span) => {
      const jobStatus = await batch.poll(job.id, { signal: opts.signal })
      span.setAttribute('batch_status', jobStatus.status)
      if (jobStatus.status !== 'ended') return { phase: 'pending', id: job.id, status: jobStatus.status }

      const results = await batch.results(job.id, { signal: opts.signal })
      const byCustom = new Map(results.map((r) => [r.customId, r]))
      const allProspects = await runSql(runtime, `SELECT * FROM ${PROSPECTS_DATASET}`, { allowMissing: true })
      const byId = new Map(allProspects.map((p) => [strField(p.prospect_id), p]))
      const at = new Date().toISOString()
      /** @type {Record<string, unknown>[]} */
      const committedRows = []
      /** @type {Record<string, unknown>[]} */
      const resolutionRows = []
      let processed = 0
      let rejected = 0
      let merged = 0
      for (const c of job.clusters) {
        const cluster = c.prospectIds.map((id) => byId.get(id)).filter(/** @returns {p is Record<string, unknown>} */ (p) => p !== undefined)
        if (cluster.length === 0) continue
        const routed = routeClusterDecisions(cluster, byCustom.get(c.customId)?.result ?? null, at)
        committedRows.push(...routed.committedRows)
        resolutionRows.push(...routed.resolutionRows)
        processed += routed.processed
        rejected += routed.rejected
        merged += routed.merged
      }
      await appendCommitted(runtime, committedRows)
      await appendResolutions(runtime, resolutionRows)
      writeState(runtime.stateDir, { ...readState(runtime.stateDir), curate_job: null })

      span.setAttribute('committed', committedRows.length)
      span.setAttribute('processed', processed)
      return { phase: 'collected', id: job.id, committed: committedRows.length, processed, rejected, merged }
    },
    { component: 'plugin' }
  )
}

/**
 * Build one batch request per cluster, plus the cluster→prospect-id mapping the
 * ongoing regime persists for later routing.
 *
 * @param {EnrichRuntime} runtime
 * @param {Record<string, unknown>[][]} clusters
 * @param {Map<string, import('../../../../collectivus-plugin-kernel-types.d.ts').VectorSearchHit[]>} recallByProspect
 * @returns {Promise<Array<{ customId: string, cluster: Record<string, unknown>[], prospectIds: string[], request: import('../../../../collectivus-plugin-kernel-types.d.ts').CompletionRequest }>>}
 */
async function buildClusterRequests(runtime, clusters, recallByProspect) {
  const built = []
  for (let i = 0; i < clusters.length; i++) {
    const request = await curateRequestForCluster(runtime, clusters[i], recallByProspect)
    built.push({ customId: `c${i}`, cluster: clusters[i], prospectIds: clusters[i].map((p) => strField(p.prospect_id)), request })
  }
  return built
}

/**
 * Poll a batch job until `status === 'ended'`, sleeping `intervalMs` between
 * polls (default 10s; `maxWaitMs` caps the total wait, default 24h — the Batch
 * API's own ceiling).
 *
 * @param {CompletionBatch} batch
 * @param {string} id
 * @param {{ signal?: AbortSignal, intervalMs?: number, maxWaitMs?: number, onProgress?: (s: CompletionBatchStatus) => void }} [opts]
 * @returns {Promise<CompletionBatchStatus>}
 */
export async function pollUntilEnded(batch, id, opts = {}) {
  const intervalMs = opts.intervalMs ?? 10_000
  const maxWaitMs = opts.maxWaitMs ?? 24 * 60 * 60 * 1000
  const start = Date.now()
  for (;;) {
    const status = await batch.poll(id, { signal: opts.signal })
    if (opts.onProgress) opts.onProgress(status)
    if (status.status === 'ended') return status
    if (Date.now() - start > maxWaitMs) {
      throw new Error(`batch ${id} did not finish within ${maxWaitMs}ms (last status: ${status.status})`)
    }
    await delay(intervalMs, opts.signal)
  }
}

/**
 * @param {number} ms
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<void>}
 */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'))
    const t = setTimeout(resolve, ms)
    if (typeof t.unref === 'function') t.unref()
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')) }, { once: true })
  })
}

/**
 * Daemon source for the **ongoing** curate regime: a coarse-interval
 * submit-and-collect timer. Each tick either collects an in-flight job (and
 * waits if it is still running) or submits a fresh one — so the frontier
 * curator work never blocks a tick. @ref LLP 0028#two-regimes
 *
 * @returns {Promise<StartedSource>}
 */
export async function startCurateSource() {
  const runtime = requireEnrichRuntime()
  /** @type {ReturnType<typeof setInterval> | null} */
  let handle = null
  /** @type {Promise<unknown> | null} */
  let inFlight = null
  let lastTickAt = /** @type {string | null} */ (null)
  let lastPhase = /** @type {string | null} */ (null)

  async function tick() {
    lastTickAt = new Date().toISOString()
    try {
      const state = readState(runtime.stateDir)
      const r = state.curate_job ? await collectCurateJob(runtime) : await submitCurateJob(runtime)
      lastPhase = r.phase
    } catch (err) {
      runtime.log.error('enrich.curate_tick_failed', {
        [Attr.ERROR_KIND]: 'enrich_curate_failed',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  function startTimer() {
    const c = runtime.config.curate
    if (!c.enabled) return
    const intervalMs = Math.max(1, Math.round(c.interval_minutes * 60_000))
    handle = setInterval(() => {
      if (inFlight) return
      inFlight = tick().finally(() => { inFlight = null })
    }, intervalMs)
    if (typeof handle.unref === 'function') handle.unref()
  }

  function stopTimer() {
    if (handle) clearInterval(handle)
    handle = null
  }

  startTimer()

  return {
    async status() {
      /** @type {SourceStatus} */
      const status = {
        state: handle !== null ? 'ready' : 'stopped',
        message: runtime.config.curate.enabled
          ? `curate batch every ${runtime.config.curate.interval_minutes}m`
          : 'disabled',
        details: { last_tick_at: lastTickAt, last_phase: lastPhase },
      }
      return status
    },
    async reload() {
      stopTimer()
      startTimer()
    },
    async stop() {
      stopTimer()
      if (inFlight) await inFlight.catch(() => {})
    },
  }
}

/** @param {unknown} v @returns {string} */
function strField(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}
