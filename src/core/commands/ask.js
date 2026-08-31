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
 * @import { ClientDescriptor } from '../../../src/core/types.js'
 */

/**
 * `hyp ask [question]`
 *
 * The verb that makes setup's closing questions runnable. Setup prints
 * them and stops there, deliberately: it may have been invoked from an
 * installer or a directory the user does not want an agent session rooted
 * in, so the launch waits for a command run from a directory they chose.
 *
 * With no argument it renders the same four questions and starts the
 * chosen client on the pick. With a question it skips the menu entirely,
 * which is the shape a user reaches for once they know what they want:
 * `hyp ask "which sessions touched the auth module"`.
 *
 * The working directory is `process.cwd()` by construction: nothing here
 * overrides it, because where the client starts is the whole reason this
 * is a separate command.
 *
 * @ref LLP 0198#re-runnable [implements]: the questions need a verb, or they are four sentences to retype
 * @ref LLP 0198#onboarding-list [constrained-by]: the launch boundary is where the user chose the directory
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
    writeSuggestedPrompts({ stdout: ctx.stdout, footer: launchers.length > 0 ? 'ask' : 'paste' })
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
      ctx.stderr.write(`  ${attachHint(descriptors)}\n`)
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

/**
 * The repair line printed when nothing here can be launched.
 *
 * The client names come from the descriptors rather than a literal, on
 * the same grounds the printed footers went generic: launchability is
 * manifest-contributed, so a new adapter must not need a second hardcoded
 * list here. But the line still has to *name* one. A hint reading
 * `hyp client attach <client>` is not a command a reader can run: pasted
 * into a shell it is an input redirection from a file called `client`, and
 * typed literally it answers `unknown client`.
 *
 * The first name carries the runnable command and the rest follow as
 * alternatives, so the sentence stays one line however many adapters
 * declare a `launch` block.
 *
 * @ref LLP 0139#repair-must-be-runnable [implements]: the repair we print is a command that runs
 * @ref LLP 0198#split [constrained-by]: the launchable set is whatever declares `contributes.client.launch`
 * @param {Map<string, ClientDescriptor>} descriptors
 * @returns {string}
 */
function attachHint(descriptors) {
  const launchable = [...descriptors.values()].filter((d) => d.launch).map((d) => d.name).sort()
  if (launchable.length === 0) {
    return 'Attach a client with `hyp client attach`, and make sure its CLI is on your PATH.'
  }
  const [first, ...rest] = launchable
  const alternatives = rest.length > 0 ? ` (or ${rest.join(', ')})` : ''
  return `Attach one with \`hyp client attach ${first}\`${alternatives}, and make sure its CLI is on your PATH.`
}

export { SUGGESTED_PROMPTS }
