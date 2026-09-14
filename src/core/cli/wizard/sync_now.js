// @ts-check

/**
 * The wizard's closing "send now" offer: an enrolled attended run starts
 * `hyp sync` for the user, whose plan and confirm are the one question about
 * the first sync. Answering no keeps the wait.
 *
 * Naming a verb is not the same as offering it: the user who wants their
 * logs on the server tonight would otherwise have to notice a sentence,
 * remember the command, and run it in a terminal the wizard is about to
 * hand to a client.
 *
 * @ref LLP 0203#offer [implements]: setup offers the release rather than only naming it
 *
 * @import { RunWizardSyncNowOptions, WizardSyncNowResult } from '../../../../src/core/cli/wizard/types.js'
 */

import process from 'node:process'

import { Attr, withSpan } from '../../observability/index.js'
import { readObservabilityEnv } from '../../observability/env.js'
import {
  SYNC_HELD_NO_DESTINATIONS_EXIT,
  formatFirstSyncDeadline,
  readFirstSyncDeadline,
} from '../../usage-policy/first_sync_hold.js'
import { resyncLineStart } from '../style.js'
import { isTty } from '../tui-router.js'

/**
 * Run the real `hyp sync`, whose plan and confirm are the one question.
 *
 * Never throws and never changes the wizard's exit code: setup finished
 * before this ran, so a failed boot or sync command
 * degrades to the wait the user already had.
 *
 * @ref LLP 0203#offer [implements]: the closing sync offer, attended-only, asked once by `hyp sync` itself
 * @param {RunWizardSyncNowOptions} opts
 * @returns {Promise<WizardSyncNowResult>}
 */
export async function runWizardSyncNow(opts) {
  return withSpan(
    'wizard.sync_now',
    {
      [Attr.COMPONENT]: 'wizard',
      [Attr.OPERATION]: 'wizard.sync_now',
      status: 'ok',
    },
    async (span) => {
      try {
        if (typeof opts.deadline !== 'number') {
          span.setAttribute('status', 'skipped')
          span.setAttribute('skip_reason', 'no-hold')
          return { asked: false, reason: /** @type {const} */ ('no-hold') }
        }
        // A real terminal on both ends, not merely an "interactive" flag: the
        // confirmation sends data off the machine, so it is started only where
        // a person can answer it. A piped or redirected run keeps the wait,
        // which is the state it would have had before this step existed.
        const canPrompt = opts.dispatchFn !== undefined
          || (isTty(opts.stdin ?? process.stdin) && isTty(opts.stdoutStream ?? opts.stdout))
        if (opts.interactive === false || !canPrompt) {
          span.setAttribute('status', 'skipped')
          span.setAttribute('skip_reason', 'not-interactive')
          // The privacy narration above stays silent on the expectation this
          // step would put the deadline in front of the user. A run that
          // cannot prompt still owes the reader the deadline and the way
          // out, so the skip states both (LLP 0188 #never-silent).
          writeHeldStatement(opts, opts.deadline)
          return { asked: false, reason: /** @type {const} */ ('not-interactive') }
        }

        // @ref LLP 0203#no-new-consent [implements]: sync owns the plan and the only confirmation
        opts.stdout.write('\nReady to upload your selected logs:\n\n')
        const code = await runConfiguredSync(opts)
        span.setAttribute('exit_code', code)
        if (code !== 0) span.setAttribute('status', 'error')
        // @ref LLP 0203#read-back [implements]: success also means declined, so re-read the hold
        const stillHeld = await readHold(opts)
        // This is a command return value, not a process exit status. Boot
        // failures throw or return 1; only sync's empty-destination path
        // returns this code. No diagnostic-text corroboration is needed.
        if (code === SYNC_HELD_NO_DESTINATIONS_EXIT) {
          span.setAttribute('released', false)
          writeNoDestinations(opts, stillHeld ?? opts.deadline)
          return { asked: true, released: false, reason: /** @type {const} */ ('no-destinations') }
        }
        span.setAttribute('released', stillHeld === null)
        if (stillHeld !== null) {
          if (code !== 0) {
            writeHeldStatement(opts, stillHeld)
            return { asked: true, released: false, reason: /** @type {const} */ ('sync-failed') }
          }
          writeStillHeld(opts, stillHeld)
          return { asked: true, released: false, reason: /** @type {const} */ ('sync-declined') }
        }
        return { asked: true, released: true }
      } catch (err) {
        span.setAttribute('status', 'error')
        span.setAttribute(Attr.ERROR_KIND, err instanceof Error ? err.name : 'unknown')
        // An unforeseen throw is the one remaining way this path ends with
        // the deadline nowhere on screen: the narration stood down for a
        // step that then said nothing. State the hold instead, in the same
        // conservative direction `readHold` takes, and inside its own guard
        // because a failed stdout is one of the things that lands here.
        // @ref LLP 0188#never-silent [implements]: even the unforeseen exit states the hold
        try {
          opts.stderr?.write(`Could not run hyp sync: ${err instanceof Error ? err.message : String(err)}\n`)
        } catch {
          // The diagnostic surface may be the failed stream.
        }
        try {
          if (typeof opts.deadline === 'number') writeHeldStatement(opts, opts.deadline)
        } catch {
          // Nowhere left to say it.
        }
        return { asked: false, reason: /** @type {const} */ ('error') }
      }
    },
    { component: 'wizard' }
  )
}

/**
 * Load the completed configuration in a fresh runtime in this process.
 * The wizard's all-available runtime omits the central sink and predates
 * setup's config writes. Dispatch without an injected kernel uses the config
 * profile, materializes its sinks, and stops boot-started sources on return.
 *
 * @ref LLP 0203#child-process [implements]: a fresh configured runtime supplies the complete destination plan in-process
 * @param {RunWizardSyncNowOptions} opts
 * @returns {Promise<number>}
 */
async function runConfiguredSync(opts) {
  const dispatch = opts.dispatchFn ?? (await import('../dispatch.js')).dispatch
  const stderr = opts.stderr ?? process.stderr
  try {
    return await dispatch(['sync'], {
      env: opts.env,
      stdin: /** @type {NodeJS.ReadStream} */ (opts.stdin ?? process.stdin),
      stdout: opts.stdoutStream ?? opts.stdout,
      // Preserve the former stderr pipe's non-terminal readline mode. The
      // terminal keeps canonical input and delivers Ctrl+C as SIGINT instead
      // of readline consuming it as a declined answer and continuing setup.
      stderr: {
        write(chunk) {
          // The terminal echoes the answer's newline outside this adapter.
          resyncLineStart(stderr)
          return stderr.write(chunk)
        },
      },
    })
  } finally {
    resyncLineStart(stderr)
  }
}

/**
 * Re-read the hold marker after sync returns. Unreadable state reads as
 * "still held", the conservative direction: claiming a sync happened is the
 * one wrong answer that cannot be walked back.
 *
 * A failed re-read therefore returns the deadline this step started from,
 * never `null` - `null` is the caller's word for "the marker is gone, it
 * sent", so handing it back on an error would report a release nobody
 * observed and swallow the line that restates the wait.
 *
 * @ref LLP 0203#read-back [implements]: an unreadable re-read is treated as still held
 * @param {RunWizardSyncNowOptions} opts
 * @returns {Promise<number | null>}
 */
async function readHold(opts) {
  try {
    if (opts.readDeadline) return await opts.readDeadline()
    const stateDir = readObservabilityEnv(opts.env).stateDir
    return await readFirstSyncDeadline({ stateDir })
  } catch {
    return opts.deadline
  }
}

/**
 * The statement for a run whose question was never put, and the only screen
 * such a run gets: `offerFollows` upstream is true whenever the run is
 * attended, so an attended run whose stdin is not a terminal
 * (`hyp init < file`, which `hyp init` still admits because it gates the
 * wizard on stdout alone) stood the narration down and then landed here.
 * A failed boot and an unforeseen throw land here for the same reason:
 * sync printed no plan, so nothing else on the run says any of this.
 * It therefore carries every fact the narration carried: the deadline, that
 * the first sync includes the imported history, the countdown command, the
 * way out, and the review hint.
 *
 * @ref LLP 0188#never-silent [implements]: the un-askable path states what the narration would have
 * @param {RunWizardSyncNowOptions} opts
 * @param {number} deadline
 */
function writeHeldStatement(opts, deadline) {
  opts.stdout.write(
    '\nNothing has been uploaded yet: nothing leaves this machine before\n' +
    `${formatFirstSyncDeadline(deadline)}. That first sync includes your imported history,\n` +
    'and `hyp status` shows the countdown.\n' +
    'To send it sooner, run `hyp sync`: it shows what would leave and asks first.\n' +
    'To review or exclude anything before then, run the hypaware-privacy skill\n' +
    'in Claude or Codex.\n'
  )
}

/**
 * The line for every path that did not send: the wait is intact, and it is
 * still the user's to end. Without it, a declined sync prompt leaves setup
 * ending on `hyp sync: cancelled` with no statement of what that means for
 * the deadline, which on this path only the sync warning printed and
 * which scrolls away with the answer.
 *
 * @param {RunWizardSyncNowOptions} opts
 * @param {number} deadline
 */
function writeStillHeld(opts, deadline) {
  opts.stdout.write(
    `\nNothing was sent. Your history stays on this machine until ${formatFirstSyncDeadline(deadline)};\n` +
    'run `hyp sync` any time to send it sooner.\n'
  )
}

/**
 * The line for the one path that did not send because it had nowhere to send
 * to. Separate from {@link writeStillHeld} because its statements are wrong
 * here: the deadline is not when this history leaves while nothing is
 * configured to take it, and re-running `hyp sync` on this machine as it
 * stands would find the same nothing.
 *
 * What it must not do is drop the deadline, which is the mistake the first
 * draft of this line made. The hold marker is untouched here and still lapses
 * on schedule, and the driver gates on the marker alone: if a destination
 * appears before the deadline by any route the user did not drive (a pulled
 * org config carrying a `sinks` block, a retried `hyp remote login`), the
 * deadline forwards this history with no `hyp sync` from anyone. So the
 * deadline is stated as what it is, conditional on a destination existing,
 * rather than left off setup's last screen as inapplicable.
 *
 * @param {RunWizardSyncNowOptions} opts
 * @param {number} deadline
 */
function writeNoDestinations(opts, deadline) {
  opts.stdout.write(
    '\nNothing was sent: no destinations are configured on this machine yet.\n' +
    'Your history stays here while that is true. Once one is configured it\n' +
    `leaves on the ${formatFirstSyncDeadline(deadline)} deadline, or sooner with \`hyp sync\`.\n`
  )
}
