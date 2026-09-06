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

import { spawn } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { Attr, withSpan } from '../../observability/index.js'
import { readObservabilityEnv } from '../../observability/env.js'
import {
  SYNC_HELD_NO_DESTINATIONS_EXIT,
  SYNC_HELD_NO_DESTINATIONS_NOTICE,
  formatFirstSyncDeadline,
  readFirstSyncDeadline,
} from '../../usage-policy/first_sync_hold.js'
import { stripSgr } from '../style.js'
import { isTty } from '../tui-router.js'

/**
 * How long the settle keeps waiting on the piped stderr after the child itself
 * is already gone. The pipe outlives its writer, so this is the only bound on
 * that wait.
 */
const STDERR_CLOSE_GRACE_MS = 250

/**
 * Run the real `hyp sync`, whose plan and confirm are the one question.
 *
 * Never throws and never changes the wizard's exit code: setup finished
 * before this ran, so a failed spawn or a child that exits non-zero
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
        // child's yes sends data off the machine, so it is started only where
        // a person can answer it. A piped or redirected run keeps the wait,
        // which is the state it would have had before this step existed.
        const canPrompt = opts.spawnFn !== undefined
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

        // One question, and it is `hyp sync`'s own: the child prints the
        // plan (every destination, what is withheld) and asks its Y/n. A no
        // is the wait. A lead line says what is starting, so the plan does
        // not read as a report the wizard forgot to introduce - an
        // introduction only, because the child's own warning opens on
        // "nothing has left this machine yet" a few lines later.
        // @ref LLP 0203#no-new-consent [implements]: the wizard asks nothing of its own; the informed prompt is the only one
        opts.stdout.write('\n`hyp sync` shows what would leave and asks before sending:\n\n')
        const result = await runSyncChild(opts)
        span.setAttribute('exit_code', result.code ?? -1)
        if (result.error) {
          span.setAttribute('status', 'error')
          span.setAttribute(Attr.ERROR_KIND, 'spawn_failed')
          opts.stderr?.write(`Could not start hyp sync: ${result.error}\n`)
          // The whole statement, not the short restatement: a child that never
          // started never printed its plan, so this is the same case as the
          // run that could not be asked at all, and the narration stood down
          // for both. `writeStillHeld` is for the run whose child did print.
          writeHeldStatement(opts, opts.deadline)
          return { asked: true, released: false, reason: /** @type {const} */ ('spawn-failed') }
        }

        // Whether the window actually ended is read off the marker, not off
        // the child's exit code: `hyp sync` exits 0 both for a release and for
        // a user who read the destination list and answered no, and telling
        // the second one their history is on its way would be a false claim
        // about the one thing this screen exists to be honest about.
        // @ref LLP 0203#read-back [implements]: the outcome is read from the hold marker, never inferred from the exit code
        const stillHeld = await readHold(opts)
        // The one exit code that outranks the marker, and only because it is
        // returned before the child touched an export: nothing was sent, so
        // no marker reading can make this a release. The re-read fails open
        // (LLP 0101: a corrupt or lapsed marker reads as absent), and taking
        // that as "released" here would be the false "your history is on its
        // way" this step exists to prevent.
        //
        // It also earns its own arm ahead of the generic non-zero one below:
        // a child that found no destination is not a run that broke, and the
        // held statement that arm writes would answer it with advice to
        // re-run the command that just found nothing to send.
        // @ref LLP 0203#read-back [implements]: the exit code separates the ways a run that sent nothing outlives the child
        // Read with the notice the child prints beside it, never alone: 3 is
        // not exclusively ours, and this screen is where a wrong explanation
        // gets stated as fact. The corroboration is deliberately not a second
        // look at the marker, whose read fails open.
        if (result.code === SYNC_HELD_NO_DESTINATIONS_EXIT && result.noDestinations) {
          span.setAttribute('released', false)
          writeNoDestinations(opts, stillHeld ?? opts.deadline)
          return { asked: true, released: false, reason: /** @type {const} */ ('no-destinations') }
        }
        span.setAttribute('released', stillHeld === null)
        if (stillHeld !== null) {
          // A decline exits 0 (`sync cancelled`), so a non-zero exit is a
          // child that never reached its plan: an empty sink set, a boot that
          // failed, a signal. That run saw none of what the narration stood
          // down for, so it takes the whole statement and its own reason -
          // reading it as a decline would also inflate the one rate this
          // step is measured by. The read-back still decides first: a child
          // that released and *then* failed must never be told it did not.
          if (result.code !== 0) {
            writeHeldStatement(opts, stillHeld)
            return { asked: true, released: false, reason: /** @type {const} */ ('child-failed') }
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
 * Spawn `hyp sync` on this terminal and wait for it.
 *
 * A child, not an in-process `ctx.commands.run('sync')`, and the reason is
 * not ergonomics: `hyp init` boots the `all-available` profile, which
 * withholds `@hypaware/central` (a CLI boot must not acquire a server
 * identity), so the wizard's own process has no central sink handle. An
 * in-process sync would render a plan missing the very destination the
 * release unblocks, which is exactly the misleading artifact
 * [LLP 0100 R2](../../../../llp/0100-enrollment-privacy-review.spec.md#requirements)
 * requires the plan to prevent. The child boots from the config setup just
 * wrote and sees the real sink set.
 *
 * stdin and stdout are inherited for the same reason the first ask inherits
 * them: the child owns a real prompt, and its plan is the screen the user
 * answers. It is safe here because the wizard's own prompt has resolved, so raw
 * mode and the cursor are already restored.
 *
 * stderr is the exception: it is piped so the caller can tell the one exit code
 * this child explains from the same code arriving for any other reason, which
 * nothing but the child's own words separates. Everything read is written
 * straight back out, so the terminal still shows the child's diagnostics.
 *
 * The echo is not decoration. `askYesNo` builds its readline over `ctx.stderr`
 * (`src/core/cli/confirm.js`), so the send confirm itself rides the piped
 * stream and this loop is its only path to the terminal. Two consequences,
 * both measured rather than assumed: readline sees a non-TTY output and so
 * builds with `terminal: false`, which still writes the query and still reads
 * the answer, but takes no raw mode and does no cursor bookkeeping, leaving
 * the tty canonical and the terminal itself echoing what is typed; and the
 * question ends without a newline, which leaves the parent's `colorizeStderr`
 * mid-line, so the next line the child writes reaches the user unpainted.
 * Anything that narrows this pipe further has to keep the first of those
 * true: the prompt it carries is the one gate on sending.
 *
 * @ref LLP 0203#child-process [implements]: the release runs in a fresh process so its plan names the real destinations
 * @param {RunWizardSyncNowOptions} opts
 * @returns {Promise<{ code: number | null, error?: string, noDestinations?: boolean }>}
 */
function runSyncChild(opts) {
  const spawnFn = opts.spawnFn ?? spawn
  const binPath = fileURLToPath(new URL('../../../../bin/hypaware.js', import.meta.url))
  return new Promise((resolve) => {
    let settled = false
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let grace
    // Whoever settles first cancels the wait, so the grace timer outlives the
    // result it was there to produce in no ordering: `error` can arrive with
    // the timer already armed, and `close` is only documented to follow `exit`,
    // not to be the last word.
    /** @param {{ code: number | null, error?: string, noDestinations?: boolean }} r */
    const done = (r) => { if (!settled) { settled = true; clearTimeout(grace); resolve(r) } }
    try {
      const child = spawnFn(process.execPath, [binPath, 'sync'], {
        stdio: ['inherit', 'inherit', 'pipe'],
        env: opts.env,
      })
      let noDestinations = false
      // Only the notice is retained, and only until it is seen: a loud failure
      // can write an unbounded amount here and none of it is evidence. The
      // carried tail catches a notice split across chunks, and is measured
      // against the raw text so a style escape straddling a boundary is
      // rejoined before it is stripped.
      let pending = ''
      const echo = opts.stderr ?? process.stderr
      child.stderr?.setEncoding('utf8')
      // Piping a stream means owning its failures. An unlistened `error` on
      // this pipe is an uncaught exception - no `try`/`catch` here can contain
      // an emitter event - and it would end a setup whose every act had
      // already succeeded, which is the defect `installStreamErrorHandlers`
      // exists for on the write side. Nothing can be done about it and nothing
      // needs to be: `close` still fires, so the exit code is still judged,
      // only without the corroboration the pipe was there to collect.
      child.stderr?.on('error', () => {})
      child.stderr?.on('data', (chunk) => {
        const text = String(chunk)
        echo.write(text)
        if (noDestinations) return
        pending += text
        // Compared without style escapes. `colorizeStderr` paints the
        // `hyp sync:` prefix of this very line, which drops a reset inside the
        // sentence and leaves the child writing something that no longer
        // contains the constant it was built from. Colour is TTY-gated and
        // this child's stderr is a pipe, so it does not happen today - but a
        // corroboration that quietly depended on that would fail the same
        // silent way the exit code alone did, which is the whole defect here.
        if (stripSgr(pending).includes(SYNC_HELD_NO_DESTINATIONS_NOTICE)) noDestinations = true
        else pending = pending.slice(-SYNC_HELD_NO_DESTINATIONS_NOTICE.length * 2)
      })
      child.on('error', (err) => done({ code: null, error: err instanceof Error ? err.message : 'spawn failed' }))
      // `close`, not `exit`: it fires once the piped stderr has closed too, so
      // the last thing the child said is in hand before the code is judged.
      // Bounded by `exit`, because the pipe outlives the process that wrote to
      // it: any descendant that inherited fd 2 holds it open for as long as it
      // lives, and `close` alone would leave setup's last step waiting on a
      // stranger. Nothing under `hyp sync` spawns today, so the bound decides
      // only how a future one fails.
      child.on('close', (code) => done({ code, noDestinations }))
      child.on('exit', (code) => {
        if (settled) return
        grace = setTimeout(() => done({ code, noDestinations }), STDERR_CLOSE_GRACE_MS)
      })
    } catch (err) {
      done({ code: null, error: err instanceof Error ? err.message : 'spawn failed' })
    }
  })
}

/**
 * Re-read the hold marker after the child exits. Unreadable state reads as
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
 * A failed spawn and an unforeseen throw land here for the same reason:
 * the child printed no plan, so nothing else on the run says any of this.
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
 * still the user's to end. Without it, a declined child prompt leaves setup
 * ending on `hyp sync: cancelled` with no statement of what that means for
 * the deadline, which on this path only the child's warning printed and
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
