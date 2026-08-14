// @ts-check

/**
 * The wizard's closing "send now" offer: after the privacy narration has
 * printed the first-sync deadline, an enrolled attended run asks whether to
 * wait it out or send immediately, and starts `hyp sync` for the user on the
 * second answer.
 *
 * The narration already names `hyp sync` as the way out
 * ([LLP 0101 #no-release](../../../../llp/0101-first-sync-review-window.decision.md#no-release)),
 * and naming a verb is not the same as offering it: the user who wants their
 * logs on the server tonight has to notice the sentence, remember the command,
 * and run it in a terminal the wizard is about to hand to a client.
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
import { formatFirstSyncDeadline, readFirstSyncDeadline } from '../../usage-policy/first_sync_hold.js'
import { isPromptCancelledError } from '../tui/runtime.js'
import { isTty } from '../tui-router.js'
import { defaultConfirmSelectPromptFactory } from '../walkthrough.js'

/** Menu values. Not user-visible. */
const WAIT = 'wait'
const NOW = 'now'

/**
 * Ask, and on "send now" run the real `hyp sync`.
 *
 * Never throws and never changes the wizard's exit code: setup finished
 * before this ran, so a cancelled prompt, a failed spawn, or a child that
 * exits non-zero all degrade to the wait the user already had.
 *
 * @ref LLP 0203#offer [implements]: the closing sync offer, attended-only, defaulting to wait
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
        // A real terminal on both ends, not merely an "interactive" flag: this
        // is the one wizard question whose yes sends data off the machine, so
        // it is asked only where a person can actually answer it. A piped or
        // redirected run keeps the wait, which is the state it would have had
        // before this step existed. (`HYP_NO_TUI` is not a veto here - the
        // confirm factory falls back to the numbered prompt on its own.)
        const canPrompt = opts.confirm !== undefined
          || (isTty(opts.stdin ?? process.stdin) && isTty(opts.stdoutStream ?? opts.stdout))
        if (opts.interactive === false || !canPrompt) {
          span.setAttribute('status', 'skipped')
          span.setAttribute('skip_reason', 'not-interactive')
          // The privacy narration above dropped its `hyp sync` sentence on
          // the expectation this step would offer the release as a choice.
          // A run that cannot prompt still owes the reader the way out, so
          // the skip states it instead of asking (LLP 0188 #never-silent).
          opts.stdout.write('To send it sooner, run `hyp sync`: it shows what would leave and asks first.\n')
          return { asked: false, reason: /** @type {const} */ ('not-interactive') }
        }

        const choice = await askSendNow(opts, opts.deadline)
        span.setAttribute('choice', choice)
        if (choice !== NOW) {
          return { asked: true, released: false, reason: /** @type {const} */ ('declined') }
        }

        // The child prints the plan and asks its own y/N, so say what is
        // starting: two prompts in a row with no seam between them reads as
        // one prompt that ignored the answer.
        opts.stdout.write('\nStarting `hyp sync`...\n\n')
        const result = await runSyncChild(opts)
        span.setAttribute('exit_code', result.code ?? -1)
        if (result.error) {
          span.setAttribute('status', 'error')
          span.setAttribute(Attr.ERROR_KIND, 'spawn_failed')
          opts.stderr?.write(`Could not start hyp sync: ${result.error}\n`)
          writeStillHeld(opts, opts.deadline)
          return { asked: true, released: false, reason: /** @type {const} */ ('spawn-failed') }
        }

        // Whether the window actually ended is read off the marker, not off
        // the child's exit code: `hyp sync` exits 0 both for a release and for
        // a user who read the destination list and answered no, and telling
        // the second one their history is on its way would be a false claim
        // about the one thing this screen exists to be honest about.
        // @ref LLP 0203#read-back [implements]: the outcome is read from the hold marker, never inferred from the exit code
        const stillHeld = await readHold(opts)
        span.setAttribute('released', stillHeld === null)
        if (stillHeld !== null) {
          writeStillHeld(opts, stillHeld)
          return { asked: true, released: false, reason: /** @type {const} */ ('sync-declined') }
        }
        return { asked: true, released: true }
      } catch (err) {
        if (isPromptCancelledError(err)) {
          span.setAttribute('choice', WAIT)
          return { asked: true, released: false, reason: /** @type {const} */ ('declined') }
        }
        span.setAttribute('status', 'error')
        span.setAttribute(Attr.ERROR_KIND, err instanceof Error ? err.name : 'unknown')
        return { asked: false, reason: /** @type {const} */ ('error') }
      }
    },
    { component: 'wizard' }
  )
}

/**
 * The question. Two rows, waiting first and selected by default, so a stray
 * enter can only ever choose the slower, reversible answer - the same
 * polarity the overwrite confirm and the `hyp sync` prompt itself use.
 *
 * The rows say what each answer does rather than yes/no: "send now" is the
 * kind of choice a reader should not have to reconstruct from the question.
 *
 * @param {RunWizardSyncNowOptions} opts
 * @param {number} deadline
 * @returns {Promise<string>}
 */
async function askSendNow(opts, deadline) {
  const confirm = opts.confirm ?? defaultConfirmSelectPromptFactory({
    stdout: /** @type {NodeJS.WritableStream} */ (opts.stdoutStream ?? opts.stdout),
    env: opts.env,
    ...(opts.stdin ? { stdin: opts.stdin } : {}),
  })
  return String(await confirm({
    title: 'Send your recorded history to the server now, or wait?',
    options: [
      {
        value: WAIT,
        label: `Wait until ${formatFirstSyncDeadline(deadline)}`,
        summary: 'Nothing leaves this machine before then',
      },
      {
        value: NOW,
        label: 'Send now',
        summary: 'Runs `hyp sync`: it lists every destination and asks before sending',
      },
    ],
    default: WAIT,
  }))
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
 * `stdio: 'inherit'` for the same reason the first ask uses it: the child
 * owns a real prompt. It is safe here because the wizard's own prompt has
 * resolved, so raw mode and the cursor are already restored.
 *
 * @ref LLP 0203#child-process [implements]: the release runs in a fresh process so its plan names the real destinations
 * @param {RunWizardSyncNowOptions} opts
 * @returns {Promise<{ code: number | null, error?: string }>}
 */
function runSyncChild(opts) {
  const spawnFn = opts.spawnFn ?? spawn
  const binPath = fileURLToPath(new URL('../../../../bin/hypaware.js', import.meta.url))
  return new Promise((resolve) => {
    let settled = false
    /** @param {{ code: number | null, error?: string }} r */
    const done = (r) => { if (!settled) { settled = true; resolve(r) } }
    try {
      const child = spawnFn(process.execPath, [binPath, 'sync'], {
        stdio: 'inherit',
        env: opts.env,
      })
      child.on('error', (err) => done({ code: null, error: err instanceof Error ? err.message : 'spawn failed' }))
      child.on('close', (code) => done({ code }))
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
 * The line for every path that did not send: the wait is intact, and it is
 * still the user's to end. Without it, a declined child prompt leaves setup
 * ending on `hyp sync: cancelled` with no statement of what that means for
 * the deadline the narration just printed.
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
