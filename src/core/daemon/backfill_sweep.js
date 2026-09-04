// @ts-check

import { Attr, getLogger } from '../observability/index.js'
import { resolveRetentionDays, runBackfillProvider } from '../commands/backfill.js'
import { readBackfillPolicy } from '../config/backfill_policy.js'
import { cronMatches } from '../sinks/driver.js'

// The sweep's telemetry identity: one pair on every record this driver emits,
// so a failing run is greppable by the same `component`/`operation` everywhere
// it is logged. `component` names the emitting module (matching the
// `getLogger('backfill-sweep')` below), never the plugin that happens to have
// opted in: this driver fires any contribution carrying a `sweep` field, and
// OpenClaw is only the first. Plugin identity is already on every record as
// `hyp_plugin` and `provider`, which is where an operator filtering by client
// should look.
const SWEEP_COMPONENT = 'backfill-sweep'
const SWEEP_OPERATION = 'backfill.sweep'

/**
 * How long one queued run may hold the shared background queue before the
 * driver stops waiting on it and lets the next provider start.
 *
 * LLP 0359's queue hands off on either settlement, which is every settlement a
 * provider has - unless it has none. A `runBackfill` that never settles (a
 * stalled network mount under a transcript root, a wedged storage read) leaves
 * the chain pending for the life of the daemon: every other scheduled provider
 * waits behind it, stays in `inFlight`, and every later tick can only log
 * `already_running` at it. Nothing recovers that short of a daemon restart, so
 * the wait carries a bound.
 *
 * Six times the tightest cadence any shipped contribution sweeps on (every
 * five minutes), so a slow cold scan that outruns its own interval is not what
 * this clips: in practice only a run with no settlement left in it reaches the
 * bound. The run cannot be cancelled, so an abandoned provider keeps its
 * `inFlight` entry until its promise really settles, the same rule
 * `probeSourceDetails` applies to a hung source `status()` probe in
 * `src/core/daemon/runtime.js`.
 */
const SWEEP_RUN_TIMEOUT_MS = 30 * 60 * 1000

/**
 * @import { BackfillContribution, HypAwareV2Config } from '../../../hypaware-plugin-kernel-types.js'
 * @import {
 *   BackfillSweepDriver,
 *   BackfillSweepDriverOptions,
 *   BackfillSweepTickOptions,
 *   BackfillSweepTickReport,
 * } from '../../../src/core/daemon/types.js'
 */

/**
 * Build the daemon's backfill sweep driver: the periodic, in-process re-run of
 * every registered backfill provider that opted into a schedule.
 *
 * The driver owns no timer. `tick({ now })` is called from the daemon's
 * existing 60-second sink tick, evaluates each contribution's `sweep.cron`
 * against `now` with the same `cronMatches` the sink driver uses, and fires a
 * run for each due provider. A contribution with no `sweep` field is never
 * ticked.
 *
 * `tick()` resolves once every due provider has been enqueued, not once any of
 * them finishes. The queue runs providers serially in the background:
 * `runProvider`'s scan, materialize, write and flush pass is unbounded in the
 * size of a user's transcript tree, and the tick it rides also refreshes
 * source details and persists `status.json`. Blocking on the queue would stall
 * those behind a provider's disk walk. Every queued promise is still handled,
 * so a failing run is a logged
 * `backfill.sweep_failed` record rather than an unhandled rejection that takes
 * the daemon process down. The queue's wait on the run at its head is bounded
 * by {@link SWEEP_RUN_TIMEOUT_MS}, so a run that settles neither way costs the
 * sweep that one provider rather than every provider behind it.
 *
 * Not blocking is what makes the re-entrancy guard necessary: a provider whose
 * run outlives its own cron interval is due again while the first pass is still
 * running or waiting in the queue, so the driver tracks which providers are in
 * flight and skips a due one that already is.
 *
 * @ref LLP 0172#lane-b-sweep [implements]: the sweep rides the existing sink-tick cadence with `cronMatches` as its due-check, fires each due provider without blocking the tick, and never overlaps two runs of the same provider
 * @ref LLP 0170#decision [implements]: scheduling an existing job (the backfill provider) on the daemon's existing cron-matched loop, not building a new scheduling primitive
 * @param {BackfillSweepDriverOptions} opts
 * @returns {BackfillSweepDriver}
 */
export function createBackfillSweepDriver(opts) {
  const { backfills, backfillMaterializers, env, config, storage, query } = opts
  if (!backfills) throw new Error('createBackfillSweepDriver: backfills required')
  if (!backfillMaterializers) throw new Error('createBackfillSweepDriver: backfillMaterializers required')
  if (!storage) throw new Error('createBackfillSweepDriver: storage required')
  if (!query) throw new Error('createBackfillSweepDriver: query required')
  const runBackfill = opts.runBackfill ?? runBackfillProvider
  const runTimeoutMs = opts.runTimeoutMs ?? SWEEP_RUN_TIMEOUT_MS
  const log = getLogger('backfill-sweep')
  // Due providers share the gateway materializer and backfill spool. Keep the
  // daemon tick non-blocking, but serialize the background work itself so two
  // same-cadence providers cannot replace each other's run-local state or
  // scan/write the shared cache concurrently.
  // @ref LLP 0359#serialized-providers [implements]: one background queue for
  //   every scheduled provider, while tick() still resolves after enqueue
  // @ref LLP 0372#bounded-handoff [implements]: the queue's wait on the run at
  //   its head is bounded, so a run that never settles cannot hold it forever
  /** @type {Promise<void>} */
  let queue = Promise.resolve()

  /**
   * The providers whose queued run has not settled yet. Because `tick()` does
   * not block on the work queue, a provider whose pass outlives its own cron
   * interval is due again while the previous one is waiting or walking the
   * transcript tree, and firing again would put two runs on the same datasets
   * and the same mid-flush spool. Neither `runBackfillProvider` nor
   * `runProvider` carries a lock of its own, so the guard belongs here, in the
   * only place that knows a run was queued. Same shape as the daemon's
   * `maintenanceInFlight` (`src/core/daemon/runtime.js`), a set rather than a
   * single handle because this driver fires one run per provider.
   *
   * @type {Set<string>}
   */
  const inFlight = new Set()

  /**
   * @param {BackfillSweepTickOptions} [tickOpts]
   * @returns {Promise<BackfillSweepTickReport>}
   */
  async function tick(tickOpts = {}) {
    const now = tickOpts.now ?? new Date()
    /** @type {string[]} */
    const fired = []
    for (const provider of backfills.list()) {
      if (!provider.sweep) continue
      if (!isDue(provider, now, tickOpts.force === true)) continue
      // A due provider whose previous run is still going is skipped, not
      // queued: the sweep is level-triggered, so the next tick that finds it
      // due and idle picks up whatever this one would have.
      if (inFlight.has(provider.name)) {
        log.warn('backfill.sweep_skipped', {
          [Attr.COMPONENT]: SWEEP_COMPONENT,
          [Attr.OPERATION]: SWEEP_OPERATION,
          [Attr.ERROR_KIND]: 'already_running',
          [Attr.PLUGIN]: provider.plugin,
          provider: provider.name,
          hyp_sweep_schedule: provider.sweep.cron,
          status: 'ok',
        })
        continue
      }
      const devRunId = `sweep-${provider.name}-${now.getTime()}`
      fired.push(provider.name)
      inFlight.add(provider.name)
      log.info('backfill.sweep_due', {
        [Attr.COMPONENT]: SWEEP_COMPONENT,
        [Attr.OPERATION]: SWEEP_OPERATION,
        [Attr.PLUGIN]: provider.plugin,
        [Attr.DEV_RUN_ID]: devRunId,
        provider: provider.name,
        hyp_sweep_schedule: provider.sweep.cron,
        status: 'ok',
      })
      const effectiveConfig = config ?? { version: 2 }
      const head = queue
      const pending = head.then(() => runBackfill({
        ctx: { env, config: effectiveConfig, storage, query, backfills, backfillMaterializers },
        provider: provider.name,
        dryRun: false,
        devRunId,
        retentionDays: sweepRetentionDays(provider, effectiveConfig),
        sweep: true,
      }))
      // Keep the queue live after either settlement, and after a run that
      // reaches neither. Both continuations hang off `head`, so a provider
      // that waited its turn behind a long predecessor starts its own budget
      // when it starts running, not when it was enqueued. `pending` itself
      // retains the provider result for its telemetry handlers below.
      //
      // The tail is total, the way the spool's own lock chains are
      // (`withWriteLock` / `withFlushLock` in `src/core/cache/spool.js`). A
      // queue promise that could reject would short-circuit every `head.then`
      // enqueued after it, so no provider would ever run again and each would
      // log `sweep_failed` without being tried: the same permanent wedge, from
      // the handoff that exists to prevent it.
      queue = head
        .then(() => awaitQueued(provider, devRunId, pending))
        .then(() => undefined, () => undefined)
      // Fire-and-forget, with both settlements handled: `void` here means "not
      // awaited", never "not observed".
      void pending.then(
        (result) => { inFlight.delete(provider.name); logSettled(provider, devRunId, result) },
        (err) => { inFlight.delete(provider.name); logFailed(provider, devRunId, err) }
      )
    }
    return { fired }
  }

  /**
   * Wait for one queued run, but no longer than `runTimeoutMs`, and resolve
   * either way so the provider behind it in the queue starts.
   *
   * Abandoning the wait is not abandoning the run: `pending` keeps its own
   * settlement handlers, so a run that comes back late still clears
   * `inFlight` and still logs its outcome, and the provider is skipped by
   * every tick in between rather than fired a second time onto the datasets
   * and spool the first one may still be writing.
   *
   * @ref LLP 0372#bounded-handoff [implements]: one hung provider costs the
   *   sweep that provider, not every provider behind it
   * @param {BackfillContribution} provider
   * @param {string} devRunId
   * @param {Promise<unknown>} pending
   * @returns {Promise<void>}
   */
  async function awaitQueued(provider, devRunId, pending) {
    /** @type {NodeJS.Timeout | undefined} */
    let timer
    const abandoned = new Promise((resolve) => {
      timer = setTimeout(() => resolve(true), runTimeoutMs)
      // Unref'd: a budget still counting must not hold the daemon's exit open.
      timer.unref()
    })
    // Which way `pending` settled is the fire site's business, not the
    // queue's: both hand the queue on the same way.
    const timedOut = await Promise.race([pending.then(() => false, () => false), abandoned])
    clearTimeout(timer)
    if (timedOut) logAbandoned(provider, devRunId)
  }

  /**
   * Whether a contribution's schedule is due at `now`. A malformed cron
   * expression throws out of `cronMatches`; here that is one provider's
   * scheduling metadata being wrong, not a reason to skip every later
   * provider in the list or to fail the daemon tick this runs inside, so it
   * is logged and treated as not due.
   *
   * @param {BackfillContribution} provider
   * @param {Date} now
   * @param {boolean} force
   * @returns {boolean}
   */
  function isDue(provider, now, force) {
    if (force) return true
    try {
      return cronMatches(provider.sweep?.cron ?? '', now)
    } catch (err) {
      log.warn('backfill.sweep_schedule_invalid', {
        [Attr.COMPONENT]: SWEEP_COMPONENT,
        [Attr.OPERATION]: SWEEP_OPERATION,
        [Attr.ERROR_KIND]: 'invalid_cron',
        [Attr.PLUGIN]: provider.plugin,
        provider: provider.name,
        hyp_sweep_schedule: provider.sweep?.cron,
        status: 'failed',
      })
      return false
    }
  }

  /**
   * @param {BackfillContribution} provider
   * @param {string} devRunId
   * @param {{ ok: boolean, scanned: number, rowsWritten: number, skipped: number }} result
   */
  function logSettled(provider, devRunId, result) {
    log.info('backfill.sweep_finished', {
      [Attr.COMPONENT]: SWEEP_COMPONENT,
      [Attr.OPERATION]: SWEEP_OPERATION,
      [Attr.PLUGIN]: provider.plugin,
      [Attr.DEV_RUN_ID]: devRunId,
      provider: provider.name,
      status: result.ok ? 'ok' : 'failed',
      ...(result.ok ? {} : { [Attr.ERROR_KIND]: 'provider_run_failed' }),
      items_seen: result.scanned,
      rows_written: result.rowsWritten,
      rows_skipped: result.skipped,
    })
  }

  /**
   * The run at the head of the queue outlived its budget. Distinct from
   * `sweep_run_rejected`: nothing failed, nothing finished, and the run is
   * still out there holding its `inFlight` entry.
   *
   * @param {BackfillContribution} provider
   * @param {string} devRunId
   */
  function logAbandoned(provider, devRunId) {
    log.warn('backfill.sweep_queue_abandoned', {
      [Attr.COMPONENT]: SWEEP_COMPONENT,
      [Attr.OPERATION]: SWEEP_OPERATION,
      [Attr.ERROR_KIND]: 'run_timed_out',
      [Attr.PLUGIN]: provider.plugin,
      [Attr.DEV_RUN_ID]: devRunId,
      provider: provider.name,
      status: 'failed',
      after_ms: runTimeoutMs,
    })
  }

  /**
   * @param {BackfillContribution} provider
   * @param {string} devRunId
   * @param {unknown} err
   */
  function logFailed(provider, devRunId, err) {
    log.error('backfill.sweep_failed', {
      [Attr.COMPONENT]: SWEEP_COMPONENT,
      [Attr.OPERATION]: SWEEP_OPERATION,
      [Attr.ERROR_KIND]: 'sweep_run_rejected',
      [Attr.PLUGIN]: provider.plugin,
      [Attr.DEV_RUN_ID]: devRunId,
      provider: provider.name,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return { tick }
}

/**
 * Resolve the source-specific sweep window from its existing backfill policy,
 * falling back to the cache retention contract used by manual backfill. Reads
 * the policy block through `backfill_policy.js`, the kernel's single reader of
 * it, so the schedule cannot disagree with the join-time reconciler about what
 * a given `window_days` means.
 *
 * @ref LLP 0359#sweep-context [implements]: a positive `backfill.window_days` narrows that provider's sweep, else cache retention applies
 * @param {BackfillContribution} provider
 * @param {HypAwareV2Config} config
 * @returns {number}
 */
function sweepRetentionDays(provider, config) {
  const entry = config?.plugins?.find((plugin) =>
    plugin?.name === provider.plugin && plugin.enabled !== false
  )
  const { windowDays } = readBackfillPolicy(entry)
  if (windowDays !== undefined) return windowDays
  return resolveRetentionDays({ flag: undefined, config })
}
