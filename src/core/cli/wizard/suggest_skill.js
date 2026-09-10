// @ts-check

/**
 * The wizard's closing offer: would you like HypAware to suggest a skill?
 * A yes runs `hyp ask` for the user, which gathers the evidence and starts
 * their AI client on it. A no names the verb and ends the run.
 *
 * This replaces the printed question list. A list of things to ask is
 * output the reader has to act on later; an offer is the act itself, made
 * at the moment the first look has just shown them their own rows. The
 * launch is safe here now: `hyp ask` starts the client in a fixed folder
 * under the system temp directory (LLP 0398 #run-directory), never in
 * the directory setup was run from, which was the reason setup used to
 * print and stop.
 *
 * @ref LLP 0398#setup-offer [implements]: setup offers the recommendation instead of listing questions
 * @ref LLP 0398#run-directory [constrained-by]: the client starts in the evidence folder, so setup may start it
 *
 * @import { RunWizardSuggestSkillOptions, WizardSuggestSkillResult } from '../../../../src/core/cli/wizard/types.js'
 */

import { spawn } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { Attr, withSpan } from '../../observability/index.js'
import { isPromptCancelledError } from '../tui/runtime.js'
import { isTty } from '../tui-router.js'
import { defaultConfirmSelectPromptFactory } from '../walkthrough.js'

/**
 * Ask, and on a yes run the real `hyp ask` as a child on this terminal.
 *
 * Never throws and never changes the wizard's exit code: setup finished
 * before this ran, so a declined offer, a failed spawn, or a child that
 * exits non-zero all end on the one line that names the verb.
 *
 * @param {RunWizardSuggestSkillOptions} opts
 * @returns {Promise<WizardSuggestSkillResult>}
 */
export async function runWizardSuggestSkill(opts) {
  return withSpan(
    'wizard.suggest_skill',
    {
      [Attr.COMPONENT]: 'wizard',
      [Attr.OPERATION]: 'wizard.suggest_skill',
      status: 'ok',
    },
    async (span) => {
      try {
        // The recommendation is measured from recorded history, so a cache
        // with nothing in it gets the offer framed as something to come back
        // to, prefaced by the one fact that makes the emptiness make sense:
        // capture starts now, not retroactively.
        // @ref LLP 0198#empty-cache [implements]: no rows means no launch, and the reason is stated
        if (opts.hasRows === false) {
          span.setAttribute('status', 'skipped')
          span.setAttribute('skip_reason', 'no-rows')
          opts.stdout.write(
            '\nNothing recorded yet: HypAware captures from your next session onward.\n' +
            'Once you have some history, run `hyp ask`: HypAware suggests the one skill worth adding first.\n'
          )
          return { asked: false, reason: /** @type {const} */ ('no-rows') }
        }
        // A real terminal on both ends, or an injected prompt: the yes hands
        // the terminal to a client, so it is offered only where a person can
        // answer. A piped run gets the verb instead.
        const canPrompt = opts.confirm !== undefined
          || (isTty(opts.stdin ?? process.stdin) && isTty(opts.stdoutStream ?? opts.stdout))
        if (opts.interactive === false || !canPrompt) {
          span.setAttribute('status', 'skipped')
          span.setAttribute('skip_reason', 'not-interactive')
          writeVerb(opts)
          return { asked: false, reason: /** @type {const} */ ('not-interactive') }
        }

        const confirm = opts.confirm ?? defaultConfirmSelectPromptFactory({
          ...(opts.stdin ? { stdin: opts.stdin } : {}),
          stdout: /** @type {any} */ (opts.stdoutStream ?? opts.stdout),
          env: opts.env,
        })
        /** @type {string} */
        let answer
        try {
          answer = await confirm({
            title: 'Would you like HypAware to suggest a skill?',
            items: [
              '  It reads your last 30 days of sessions for the one skill worth adding first,',
              '  then starts your AI client on the evidence to explain and write it.',
            ],
            options: [
              { value: 'yes', label: 'Yes, suggest one' },
              { value: 'no', label: 'Not now' },
            ],
            default: 'yes',
            // The default acts (it starts a client), so a spent stdin must
            // not take it (LLP 0299 #eof-declines).
            eofValue: 'no',
          })
        } catch (err) {
          // Past the finale the run is committed and its acts done, so a
          // ctrl+c here is "not now", not a cancelled setup.
          if (!isPromptCancelledError(err)) throw err
          answer = 'no'
        }
        span.setAttribute('answer', answer)
        if (answer !== 'yes') {
          writeVerb(opts)
          return { asked: true, launched: false, reason: /** @type {const} */ ('declined') }
        }

        const result = await runAskChild(opts)
        if (result.error) {
          span.setAttribute('status', 'error')
          span.setAttribute(Attr.ERROR_KIND, 'spawn_failed')
          opts.stderr?.write(`Could not start hyp ask: ${result.error}\n`)
          writeVerb(opts)
          return { asked: true, launched: false, reason: /** @type {const} */ ('spawn-failed') }
        }
        span.setAttribute('exit_code', result.code ?? -1)
        // `hyp ask` has already said why when it exits non-zero (nothing
        // launchable, no evidence); the verb is the only thing to add.
        if (result.code !== 0) {
          writeVerb(opts)
          return { asked: true, launched: false, reason: /** @type {const} */ ('child-failed') }
        }
        return { asked: true, launched: true }
      } catch (err) {
        span.setAttribute('status', 'error')
        span.setAttribute(Attr.ERROR_KIND, err instanceof Error ? err.name : 'unknown')
        try {
          writeVerb(opts)
        } catch {
          // the stream itself is failing; the line is a courtesy, not a gate
        }
        return { asked: false, reason: /** @type {const} */ ('error') }
      }
    },
    { component: 'wizard' }
  )
}

/**
 * Spawn `hyp ask` on this terminal and wait for it.
 *
 * A child rather than an in-process call, for the reason `hyp sync` is
 * (`sync_now.js`): the wizard's own boot withholds registries the command
 * needs, and the child boots from the config setup just wrote and sees the
 * real attached clients. All three stdio are inherited: the ask draws its
 * client pick on this terminal and then hands it to the client.
 *
 * @param {RunWizardSuggestSkillOptions} opts
 * @returns {Promise<{ code: number | null, error?: string }>}
 */
function runAskChild(opts) {
  const spawnFn = opts.spawnFn ?? spawn
  const binPath = fileURLToPath(new URL('../../../../bin/hypaware.js', import.meta.url))
  return new Promise((resolve) => {
    let settled = false
    /** @param {{ code: number | null, error?: string }} r */
    const done = (r) => { if (!settled) { settled = true; resolve(r) } }
    try {
      const child = spawnFn(process.execPath, [binPath, 'ask'], {
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
 * The one line every path that did not launch ends on: the offer stays
 * open, and the verb is how to take it later.
 *
 * @param {RunWizardSuggestSkillOptions} opts
 */
function writeVerb(opts) {
  opts.stdout.write('\nRun `hyp ask` any time: HypAware suggests the one skill worth adding first.\n')
}
