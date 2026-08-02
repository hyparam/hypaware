// @ts-check

import { Attr, getLogger } from '../observability/index.js'
import { runBackfillProvider } from '../commands/backfill.js'
import { cronMatches } from '../sinks/driver.js'

// The sweep's telemetry identity, fixed by LLP 0173's implementer note so a
// failing run is greppable by the same pair everywhere it is logged. OpenClaw
// owns the only contribution that opts into a sweep today; every record also
// carries `hyp_plugin` and `provider`, so a second opt-in stays attributable
// without changing what an operator greps for.
const SWEEP_COMPONENT = 'openclaw'
const SWEEP_OPERATION = 'backfill.sweep'

/**
 * @import { BackfillContribution } from '../../../hypaware-plugin-kernel-types.js'
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
 * ticked, which is why adding this driver is zero behavior change for Claude's
 * and Codex's contributions.
 *
 * `tick()` resolves once every due provider's run has been *started*, not once
 * any of them finishes. Runs are fired unblocked: `runProvider`'s scan, materialize,
 * write and flush pass is unbounded in the size of a user's transcript tree, and
 * the tick it rides also refreshes source details and persists `status.json`.
 * Blocking on a sweep would stall those behind a provider's disk walk. The
 * fired promise is still handled, so a failing run is a logged
 * `backfill.sweep_failed` record rather than an unhandled rejection that takes
 * the daemon process down.
 *
 * @ref LLP 0172#lane-b-sweep [implements]: the sweep rides the existing sink-tick cadence with `cronMatches` as its due-check, and fires each due provider without blocking the tick
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
  const log = getLogger('backfill-sweep')

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
      const devRunId = `sweep-${provider.name}-${now.getTime()}`
      fired.push(provider.name)
      log.info('backfill.sweep_due', {
        [Attr.COMPONENT]: SWEEP_COMPONENT,
        [Attr.OPERATION]: SWEEP_OPERATION,
        [Attr.PLUGIN]: provider.plugin,
        [Attr.DEV_RUN_ID]: devRunId,
        provider: provider.name,
        hyp_sweep_schedule: provider.sweep.cron,
        status: 'ok',
      })
      // Fire-and-forget, with both settlements handled: `void` here means "not
      // awaited", never "not observed".
      void runBackfill({
        ctx: { env, config: config ?? { version: 2 }, storage, query, backfills, backfillMaterializers },
        provider: provider.name,
        dryRun: false,
        devRunId,
      }).then(
        (result) => { logSettled(provider, devRunId, result) },
        (err) => { logFailed(provider, devRunId, err) }
      )
    }
    return { fired }
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
