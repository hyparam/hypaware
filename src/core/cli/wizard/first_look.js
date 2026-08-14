// @ts-check

/**
 * The wizard's closing "first look": the shared gateway overview
 * (`query/overview.js`, the same block `hyp query overview` prints),
 * placed at the end of an attended setup so the run ends on the user's own
 * rows rather than on a command they still have to type.
 *
 * This module owns only the wizard's half of the contract: when the step
 * runs, and that it can never fail a finished install.
 *
 * @import { FirstLookOutcome, FirstLookResult } from '../../../../src/core/cli/wizard/types.js'
 * @import { OverviewNotice, OverviewQueryRunner } from '../../../../src/core/query/types.js'
 */

import { Attr, withSpan } from '../../observability/index.js'
import {
  OVERVIEW_DATASET,
  OVERVIEW_TIME_BUDGET_MS,
  collectOverview,
  emptyOverview,
  hasRenderableOverview,
  missingSections,
  renderOverview,
} from '../../query/overview.js'

export { overviewRunnerFromCtx as firstLookRunnerFromCtx } from '../../query/overview.js'

/**
 * The notice sink to hand `firstLookRunnerFromCtx` during setup.
 *
 * Withheld rows are disclosed, always: a block that quietly drops rows and
 * reads as a complete picture is the one failure LLP 0105 exists to
 * prevent, and being mid-install does not excuse it.
 *
 * Freshness is dropped, though, and only here. The line says live capture
 * may lag by up to the flush debounce - true, actionable, and worth
 * printing to someone who just asked a question of their data. To someone
 * finishing an install it is noise about a condition they did not cause and
 * cannot act on, attached to a block whose backfilled rows were
 * force-flushed anyway. `hyp query overview` prints both.
 *
 * The sink closes. An expired deadline abandons queries that keep running,
 * and one of them resolving late must not print a disclosure after the
 * privacy narration that setup documents as its last words.
 *
 * @ref LLP 0105 [implements]: withholding is disclosed on every surface, setup included
 * @param {{ write(chunk: string): unknown }} stderr
 * @returns {((notice: OverviewNotice) => void) & { close(): void }}
 */
export function firstLookNoticeSink(stderr) {
  let open = true
  const sink = /** @type {((notice: OverviewNotice) => void) & { close(): void }} */ (
    /** @param {OverviewNotice} notice */
    (notice) => {
      if (open && notice.kind === 'local-only') stderr.write(notice.line)
    }
  )
  sink.close = () => { open = false }
  return sink
}

/** The wizard's heading for the shared block: this is a setup milestone. */
const FIRST_LOOK_TITLE = 'First look at what HypAware has recorded'

/**
 * How long the closing look may take before setup gives up on it.
 *
 * Not an independent number: it is the shared plan's budget
 * (`OVERVIEW_TIME_BUDGET_MS`, which both callers aim at and which already
 * charges itself for the probe) plus headroom. The gap is what makes this
 * a backstop rather than the mechanism - it should only fire when the
 * measured plan was *wrong* (a pathological day, a disk that stalls after
 * the probe), never in ordinary operation. If it starts firing routinely,
 * the fix is the planner's calibration, not a longer deadline.
 *
 * Setup is where a stall does real damage: it is the last step of an
 * install, after every durable action has already succeeded, so a freeze
 * reads as "the install broke" when nothing did. `hyp query overview` runs
 * the same plan with no deadline, because there the user asked and is
 * watching, and no answer is worse than a slow one.
 *
 * The abandoned queries are not cancellable - they are in-process CPU work
 * - but the CLI ends on `process.exit`, which drops them.
 */
const FIRST_LOOK_BUDGET_MS = OVERVIEW_TIME_BUDGET_MS + 3000

/**
 * Resolve to `null` if `promise` outlives `ms`. The loser keeps running;
 * the caller's contract is only that setup stops waiting on it.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T | null>}
 */
async function withDeadline(promise, ms) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Run the first look and write it to stdout. Never throws: a query
 * failure (an unreadable cache, a dataset registered but not yet
 * materialized) degrades to a skipped step, because setup itself already
 * succeeded by the time this runs.
 *
 * Returns `wrote` alongside `shown`, and it is *measured*: the writable the
 * body sees is a counter in front of the caller's, so every branch, present
 * or future, reports whether it put text on the screen. The two questions
 * are not the same one. `shown` is "did the block render", and a caller that
 * needs "did this push what came before it out of view" cannot infer that
 * from `shown`: the `slow` skip renders no block and still writes two lines
 * saying so. The wizard's closing repeat asks the second question
 * (LLP 0188 #when), and inferring it from `shown` is what broke across the
 * no-dataset, error and slow branches in turn.
 *
 * @ref LLP 0135#first-look [implements]: setup ends on the user's own rows, and never fails on them
 * @ref LLP 0188#when [implements]: the caller needs "wrote something", so measure it here rather than let the caller guess
 *
 * @param {{
 *   runner?: OverviewQueryRunner | undefined,
 *   stdout: NodeJS.WritableStream | { write(chunk: string): unknown },
 *   color?: boolean,
 *   budgetMs?: number,
 * }} args
 * @returns {Promise<FirstLookResult>}
 */
export async function runWizardFirstLook({ runner, stdout: target, color = false, budgetMs = FIRST_LOOK_BUDGET_MS }) {
  /** @type {boolean} */
  let wrote = false
  // The only `stdout` in scope below, so a branch cannot write without being
  // counted. Set before delegating rather than after: a `write` that throws
  // part-way (EPIPE on a closed pipe) may have emitted, and the safe error
  // is an extra reminder, not a lost one.
  /** @type {{ write(chunk: string): unknown }} */
  const stdout = {
    /** @param {string} chunk */
    write(chunk) {
      wrote = true
      return target.write(chunk)
    },
  }
  /** @type {FirstLookOutcome} */
  const outcome = await withSpan(
    'wizard.first_look',
    {
      [Attr.COMPONENT]: 'wizard',
      [Attr.OPERATION]: 'wizard.first_look',
      status: 'ok',
    },
    async (span) => {
      if (!runner || !runner.hasDataset(OVERVIEW_DATASET)) {
        span.setAttribute('status', 'skipped')
        span.setAttribute('skip_reason', 'no-dataset')
        return { shown: false, reason: /** @type {const} */ ('no-dataset') }
      }

      // Sections land in `partial` as they complete, so an expired deadline
      // keeps finished work rather than discarding it: three sections done
      // and a fourth in flight is a shorter block, not a blank one.
      const partial = emptyOverview()
      // The whole step is inside one try, not just the queries: rendering
      // and writing can fail too (an unforeseen row shape, or a stream that
      // throws on write), and an escape from *any* of it would surface as
      // `hyp: <error>` and a non-zero exit from an install that had already
      // fully succeeded. Nothing here may fail setup.
      //
      // Scope, stated precisely: this contains *synchronous* failures. An
      // asynchronous stream error - EPIPE on a real pipe arrives as an
      // 'error' event on the socket, not as a throw - bypasses every
      // try/catch in the process, so it is not this block's to catch and
      // never could be. `bin/hypaware.js` installs a listener for it
      // (`cli/stream_errors.js`), which is where it belongs: it is a
      // property of the process's streams, not of any one command.
      try {
        // Every section, the same block `hyp query overview` prints. The
        // run is longer for it (~60 lines against ~35), which the privacy
        // narration survives because it is written after this and stays the
        // last thing on screen (`@ref LLP 0135#privacy`).
        const overview = await withDeadline(collectOverview(runner, { into: partial }), budgetMs)

        const expired = overview === null
        const rows = overview ?? partial
        if (expired && !hasRenderableOverview(rows)) {
          // Nothing usable landed - the probe itself outlasted the budget.
          // Say what happened and what to run instead: a silent skip after a
          // visible pause reads as something having gone wrong.
          span.setAttribute('status', 'skipped')
          span.setAttribute('skip_reason', 'slow')
          span.setAttribute('budget_ms', budgetMs)
          stdout.write(
            '\nSkipped the first look: summarizing this much history would hold up setup.\n' +
            'Run `hyp query overview` to see it.\n'
          )
          return { shown: false, reason: /** @type {const} */ ('slow') }
        }

        span.setAttribute('provider_rows', rows.providerRows.length)
        span.setAttribute('day_rows', rows.dailyRows.length)
        if (expired) {
          span.setAttribute('partial', true)
          span.setAttribute('budget_ms', budgetMs)
          span.setAttribute('missing_sections', missingSections(rows).join(','))
        }
        // `footer: false` because the closing line below is this run's single
        // pointer: setup should teach one command, not two dim lines naming
        // the same one.
        stdout.write(renderOverview({
          ...rows,
          title: FIRST_LOOK_TITLE,
          color,
          footer: false,
          withheld: runner.sawWithholding?.() ?? false,
        }))
        if (expired) {
          // Name the missing sections as *unfinished*, not as empty. "no
          // repos" and "the repos section did not finish" are different
          // claims, and only one of them is true - the same never-silent rule
          // the block follows for the rows it omits.
          const missing = missingSections(rows)
          const which = missing.length > 1
            ? `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]} sections`
            : `${missing[0]} section`
          stdout.write(
            missing.length > 0
              ? `\nStopped here to keep setup moving - the ${which} did not finish.\n`
              : '\nStopped here to keep setup moving.\n'
          )
        }
        // The block is re-runnable: name the command that reprints it, so the
        // setup teaches one durable entry point instead of a one-off view.
        stdout.write(`\nSee this again anytime: hyp query overview (--sql shows the queries)\n`)
        return {
          shown: true,
          providerRows: rows.providerRows.length,
          dayRows: rows.dailyRows.length,
          ...(expired ? { partial: true } : {}),
        }
      } catch (err) {
        // The block is a diagnostic, not a gate: record the failure kind on
        // the span and end quietly rather than printing a stack over a
        // successful install.
        span.setAttribute('status', 'error')
        span.setAttribute(Attr.ERROR_KIND, err instanceof Error ? err.name : 'unknown')
        return { shown: false, reason: /** @type {const} */ ('error') }
      }
    },
    { component: 'wizard' }
  )
  // One exit, so `wrote` is attached to whatever the body decided rather
  // than restated per branch.
  return { ...outcome, wrote }
}
