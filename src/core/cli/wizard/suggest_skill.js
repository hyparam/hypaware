// @ts-check

/**
 * The wizard's closing offer: see what your AI usage went into?
 * A yes runs `hyp usage` for the user, which starts their AI client on the
 * usage-by-task view. A no names the verb and ends the run.
 *
 * The offer used to be a skill suggestion (`hyp ask`); the file and its
 * telemetry names keep that history so the measurement stays one series.
 *
 * This replaces the printed question list. A list of things to ask is
 * output the reader has to act on later; an offer is the act itself, made
 * at the moment the first look has just shown them their own rows. The
 * launch is safe here now: `hyp usage` starts the client in a fixed folder
 * under `HYP_HOME` (LLP 0398 #run-directory), never in the directory
 * setup was run from, which was the reason setup used to print and stop.
 *
 * @ref LLP 0398#setup-offer-usage [implements]: setup offers `hyp usage` where it offered the recommendation
 * @ref LLP 0398#run-directory [constrained-by]: the client starts in a folder under HYP_HOME, so setup may start it
 *
 * @import { ClientDescriptor } from '../../../../src/core/types.js'
 * @import { FinaleSummary } from '../../../../src/core/cli/types.js'
 * @import { RunWizardSuggestSkillOptions, WizardSuggestSkillResult } from '../../../../src/core/cli/wizard/types.js'
 */

import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { Attr, withSpan } from '../../observability/index.js'
import { isPromptCancelledError } from '../tui/runtime.js'
import { isTty } from '../tui-router.js'
import { buildWalkthroughClientDescriptorMap, defaultConfirmSelectPromptFactory } from '../walkthrough.js'
import { resolveLaunchers } from './first_ask.js'

/**
 * Ask, and on a yes run the real `hyp usage` as a child on this terminal.
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
        // The view is measured from recorded history, so a cache
        // with nothing in it gets the offer framed as something to come back
        // to, prefaced by the one fact that makes the emptiness make sense:
        // capture starts now, not retroactively.
        // @ref LLP 0198#empty-cache [implements]: no rows means no launch, and the reason is stated
        if (opts.hasRows === false) {
          span.setAttribute('status', 'skipped')
          span.setAttribute('skip_reason', 'no-rows')
          opts.stdout.write('\nNothing recorded yet: HypAware captures from your next session onward.\n')
          // The emptiness is still worth stating, but the verb is not: with
          // nothing to start, it names a command that would only fail later.
          if (opts.launchable !== false) {
            opts.stdout.write('Once you have some history, run `hyp usage`: HypAware shows what your AI usage went into, by task.\n')
          }
          return { asked: false, reason: 'no-rows' }
        }
        // No client `hyp usage` could start is on PATH, so the step is silent:
        // a yes would spawn a child that finds nothing to launch, and the
        // line naming the verb would send the reader to that same dead end.
        // @ref LLP 0398#setup-offer [implements]: nothing launchable means no offer and no mention of the verb
        if (opts.launchable === false) {
          span.setAttribute('status', 'skipped')
          span.setAttribute('skip_reason', 'no-launcher')
          return { asked: false, reason: 'no-launcher' }
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
          return { asked: false, reason: 'not-interactive' }
        }

        const confirm = opts.confirm ?? defaultConfirmSelectPromptFactory({
          ...(opts.stdin ? { stdin: opts.stdin } : {}),
          stdout: /** @type {any} */ (opts.stdoutStream ?? opts.stdout),
          env: opts.env,
        })
        /** @type {string} */
        let answer
        try {
          // A blank line separates the offer from whatever the step before
          // it printed. The legacy prompt adds its own; the TUI does not.
          opts.stdout.write('\n')
          answer = await confirm({
            title: 'See what your AI usage went into?',
            items: ['HypAware can chart your recent Claude Code and Codex sessions by the tasks they went into and the pull requests tied to them, then offer up to three suggestions to pick from.'],
            options: [
              { value: 'yes', label: 'Show my usage by task', summary: 'Starts an agent in a separate folder.' },
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
          return { asked: true, launched: false, reason: 'declined' }
        }

        const result = await runAskChild(opts)
        if (result.error) {
          span.setAttribute('status', 'error')
          span.setAttribute(Attr.ERROR_KIND, 'spawn_failed')
          opts.stderr?.write(`Could not start hyp usage: ${result.error}\n`)
          writeVerb(opts)
          return { asked: true, launched: false, reason: 'spawn-failed' }
        }
        span.setAttribute('exit_code', result.code ?? -1)
        // `hyp usage` has already said why when it exits non-zero (nothing
        // launchable); the verb is the only thing to add.
        if (result.code !== 0) {
          writeVerb(opts)
          return { asked: true, launched: false, reason: 'child-failed' }
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
        return { asked: false, reason: 'error' }
      }
    },
    { component: 'wizard' }
  )
}

/**
 * Whether any client `hyp usage` could start resolves on `$PATH`, as the
 * closing offer's `launchable`.
 *
 * Probes every client that declares a `launch` block, not only the recorded
 * ones: which clients are recorded is the child's question, since this boot
 * cannot see attach state (see `runAskChild`). That makes the probed set a
 * superset of what the child accepts, so `false` is certain (the child would
 * find nothing either) while `true` only says the offer is worth making.
 *
 * `undefined` means it could not tell (discovery came back empty, or the
 * probe threw), which never withholds the offer.
 *
 * @ref LLP 0198#path-probe [constrained-by]: launchability is a PATH question, not the picker's presence probe
 * @param {NodeJS.ProcessEnv} env
 * @param {{
 *   descriptors?: Map<string, ClientDescriptor>,
 *   resolve?: (bin: string, env: NodeJS.ProcessEnv, platform?: string) => Promise<string | undefined>,
 * }} [deps]
 * @returns {Promise<boolean | undefined>}
 */
export async function anyClientLaunchable(env, deps = {}) {
  try {
    const descriptors = deps.descriptors ?? await buildWalkthroughClientDescriptorMap()
    if (descriptors.size === 0) return undefined
    const launchers = await resolveLaunchers({
      clients: [...descriptors.keys()],
      descriptors,
      env,
      ...(deps.resolve ? { resolve: deps.resolve } : {}),
    })
    return launchers.length > 0
  } catch {
    return undefined
  }
}

/**
 * Whether a client this setup run left recorded can answer a question put
 * to `hyp ask`: its attach succeeded (or was already in place), nothing was
 * a dry run, its CLI resolves on `$PATH`, and its `hypaware-query` skill is
 * on disk. The CLI is the command's own check, and the skill is what the
 * question is answered with, so setup names the command only where it
 * would start a client that can look the answer up.
 *
 * Reads the finale's own results rather than probing attach state: this
 * boot cannot see it (see `runAskChild`), and the finale's record is the
 * install that just ran. A failed daemon install or any doubt reads as
 * `false`, which only withholds a pointer.
 *
 * @param {FinaleSummary | undefined} summary
 * @param {NodeJS.ProcessEnv} env
 * @param {{
 *   descriptors?: Map<string, ClientDescriptor>,
 *   resolve?: (bin: string, env: NodeJS.ProcessEnv, platform?: string) => Promise<string | undefined>,
 * }} [deps]
 * @returns {Promise<boolean>}
 */
export async function recordedAskClientLaunchable(summary, env, deps = {}) {
  try {
    if (!summary || summary.daemonInstall.failed === true) return false
    const clients = summary.attach
      .filter((a) => a.ok && !a.dryRun && a.notRecording !== true)
      .map((a) => a.client)
    if (clients.length === 0) return false
    const descriptors = deps.descriptors ?? await buildWalkthroughClientDescriptorMap()
    const launchers = await resolveLaunchers({
      clients,
      descriptors,
      env,
      ...(deps.resolve ? { resolve: deps.resolve } : {}),
    })
    const homeDir = env.HOME || os.homedir()
    for (const { client } of launchers) {
      const skillDir = descriptors.get(client)?.skillDir
      if (!skillDir) continue
      try {
        await fsp.access(path.join(homeDir, skillDir, 'hypaware-query', 'SKILL.md'))
        return true
      } catch { // This client was not shipped the skill the answer needs.
      }
    }
    return false
  } catch {
    return false
  }
}

/**
 * Spawn `hyp usage` on this terminal and wait for it.
 *
 * A child rather than an in-process call, for the reason `hyp sync` is
 * (`sync_now.js`): the wizard's own boot withholds registries the command
 * needs, and the child boots from the config setup just wrote and sees the
 * real attached clients. All three stdio are inherited: the command draws
 * its client pick on this terminal and then hands it to the client.
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
      const child = spawnFn(process.execPath, [binPath, 'usage'], {
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
  opts.stdout.write('\nRun `hyp usage` any time: HypAware shows what your AI usage went into, by task.\n')
}
