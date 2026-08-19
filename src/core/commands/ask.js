// @ts-check

import { collectHypAwareStatus } from '../daemon/status.js'
import { buildWalkthroughClientDescriptorMap } from '../cli/walkthrough.js'
import { parseCoreCommandArgv } from '../cli/command_args.js'
import { isTty } from '../cli/stdio.js'
import { OVERVIEW_DATASET, OVERVIEW_PROBE_SQL, overviewRunnerFromCtx } from '../query/overview.js'
import {
  SUGGESTED_PROMPTS,
  launchClient,
  resolveLaunchers,
  runWizardFirstAsk,
  writeSuggestedPrompts,
} from '../cli/wizard/first_ask.js'

/**
 * @import { CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 */

/**
 * `hyp ask [question]`
 *
 * The wizard's closing first ask, made durable. Setup teaches every other
 * closing surface as something you can get back to (the first look prints
 * "See this again anytime: hyp query overview"); a question menu reachable
 * only by re-running `hyp init` would be the exception.
 *
 * With no argument it renders the same four questions and starts the
 * chosen client on the pick. With a question it skips the menu entirely,
 * which is the shape a user reaches for once they know what they want:
 * `hyp ask "which sessions touched the auth module"`.
 *
 * @ref LLP 0198#re-runnable [implements]: the closing list is a verb, not a one-off screen
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runAsk(argv, ctx) {
  const parsed = parseCoreCommandArgv('ask', argv, ctx)
  if (!parsed.ok) return parsed.code
  const clients = await askableClients(ctx)
  const descriptors = await buildWalkthroughClientDescriptorMap()

  if (parsed.params.list === true) {
    const launchers = await resolveLaunchers({ clients, descriptors, env: ctx.env })
    writeSuggestedPrompts({ stdout: ctx.stdout, launchable: launchers.length > 0 })
    return 0
  }
  const question = String(parsed.params.question ?? '').trim()

  if (question.length > 0) {
    // A named question wants a launch, not a menu: resolve directly and
    // say plainly when nothing can answer it, rather than falling back to
    // a list of four questions the user did not ask for.
    const launchers = await resolveLaunchers({ clients, descriptors, env: ctx.env })
    if (launchers.length === 0) {
      ctx.stderr.write('hyp ask: no attached client can be started here.\n')
      ctx.stderr.write('  Attach one with `hyp client attach claude` (or `codex`), and make sure its CLI is on your PATH.\n')
      return 1
    }
    ctx.stdout.write(`\nStarting ${launchers[0].label}...\n\n`)
    const result = await launchClient({ launcher: launchers[0], prompt: question, env: ctx.env })
    if (!result.ok) {
      ctx.stderr.write(`hyp ask: could not start ${launchers[0].bin}: ${result.error ?? 'spawn failed'}\n`)
      return 1
    }
    return 0
  }

  const hasRows = await cacheHasRows(ctx)
  const outcome = await runWizardFirstAsk({
    clients,
    descriptors,
    stdout: ctx.stdout,
    stderr: ctx.stderr,
    env: ctx.env,
    interactive: isTty(ctx.stdout) && isTty(ctx.stdin),
    ...(hasRows === undefined ? {} : { hasRows }),
    ...(ctx.stdin ? { stdin: ctx.stdin } : {}),
  })
  // `no-launcher` is the one outcome that is a failed invocation rather
  // than a choice: the user asked for the menu and there is nothing to
  // put in it. Declining, a piped run that printed the list, and an empty
  // cache are all 0 - in the last case nothing is broken, there is just
  // no history yet.
  return outcome.launched === false && outcome.reason === 'no-launcher' ? 1 : 0
}

/**
 * Whether the local cache holds any gateway rows.
 *
 * The wizard gets this for free from the first look it just ran; `hyp
 * ask` has to establish it, and does so with the overview's own probe -
 * the cheapest statement that answers the question, and already the
 * thing the block itself opens with. An unavailable dataset is a
 * definite no; a failed query is unknown, which never withholds the
 * offer (`@ref LLP 0198#empty-cache`).
 *
 * @param {CommandRunContext} ctx
 * @returns {Promise<boolean | undefined>}
 */
async function cacheHasRows(ctx) {
  const runner = overviewRunnerFromCtx(ctx)
  if (!runner) return undefined
  if (!runner.hasDataset(OVERVIEW_DATASET)) return false
  try {
    const probe = await runner.run(OVERVIEW_PROBE_SQL)
    return probe.rows.length > 0
  } catch {
    return undefined
  }
}

/**
 * The clients `hyp ask` may start: those HypAware is actually recording.
 *
 * Attachment is this command's analogue of the wizard's "picked" list
 * (`@ref LLP 0198#path-probe`): starting an unattached client would open
 * a session nothing captures, so the question it was started on would be
 * answered against data that excludes the asking. A status failure
 * degrades to every launchable client rather than to none, because a
 * probe that cannot read a settings file is not evidence of detachment.
 *
 * `collectStatus` defaults to the real status collector; tests inject a
 * stub to exercise the throw path without faking a filesystem failure.
 *
 * @param {CommandRunContext} ctx
 * @param {{ collectStatus?: typeof collectHypAwareStatus }} [options]
 * @returns {Promise<string[]>}
 */
export async function askableClients(ctx, { collectStatus = collectHypAwareStatus } = {}) {
  try {
    const report = await collectStatus({
      env: ctx.env,
      runtime: {
        sources: /** @type {any} */ (ctx.sources),
        sinks: /** @type {any} */ (ctx.sinks),
        capabilities: ctx.capabilities,
        query: ctx.query,
        storage: ctx.storage,
      },
    })
    // A successful probe reporting zero attached clients is still
    // evidence of detachment, not grounds to fall through: only a
    // thrown probe (one that could not read a settings file) is unknown
    // rather than a "no".
    return report.clients.filter((c) => c.attached).map((c) => c.name)
  } catch {
    // fall through to the unfiltered list
  }
  const descriptors = await buildWalkthroughClientDescriptorMap()
  return [...descriptors.values()].filter((d) => d.launch).map((d) => d.name)
}

export { SUGGESTED_PROMPTS }
