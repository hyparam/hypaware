// @ts-check

import { collectHypAwareStatus } from '../daemon/status.js'
import { buildWalkthroughClientDescriptorMap } from '../cli/walkthrough.js'
import { parseCoreCommandArgv } from '../cli/command_args.js'
import { isTty } from '../cli/stdio.js'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { OVERVIEW_DATASET, OVERVIEW_PROBE_SQL, overviewRunnerFromCtx } from '../query/overview.js'
import { RECOMMEND_COLD_PROMPT, prepareFirstAskEvidence } from '../query/first_ask_evidence.js'
import { firstLookNoticeSink } from '../cli/wizard/first_look.js'
import {
  SUGGESTED_PROMPTS,
  chooseLauncher,
  launchClient,
  resolveLaunchers,
  runWizardFirstAsk,
} from '../cli/wizard/first_ask.js'

/**
 * @import { CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 * @import { ClientDescriptor } from '../../../src/core/types.js'
 * @import { FirstAskEvidence } from '../../../src/core/query/types.js'
 * @import { FirstAskLauncher, RunWizardFirstAskOptions } from '../../../src/core/cli/wizard/types.js'
 */

/**
 * How long the client picker waits for a first keypress before deciding
 * nobody is at the terminal.
 *
 * A TTY says a terminal is attached, never that a person is reading it: a
 * pty with nothing typed into it (`docker run -t`, a tty-allocating CI
 * runner, expect) answers `isTTY` exactly as a human's does, so a picker
 * gated on that alone waits for a keypress that never arrives and the
 * question the user did name is never asked. The first keypress lifts the
 * deadline, so it only ever ends a run nobody is answering.
 *
 * `hyp report generate` and `hyp report fix` put the same picker on the
 * same gate, so they take this deadline and its notice rather than a second
 * pair of their own.
 */
export const PICK_DEADLINE_MS = 10_000

/**
 * What an expired deadline says before it launches. An expired deadline is
 * not a cancel (nobody declined anything), so the run continues into the
 * client a run that cannot prompt would have started anyway, and discloses
 * that the client was not chosen.
 */
export const PICK_DEADLINE_NOTICE = '\nNo answer at the client prompt - starting the first one.\n'

/**
 * Arm the picker deadline against `stdin`, and hand back the disarm its caller
 * runs when the prompt settles. Both client pickers arm through this rather
 * than keeping a copy, for the same reason they share the deadline above.
 *
 * The first keypress lifts the deadline for good, which is what keeps someone
 * still reading the options from being cut off mid-decision. But a keypress is
 * not proof of a keyboard: a pty whose input has reached EOF
 * (`script ... < /dev/null`) is sent a NUL byte, and readline decodes it into
 * a keypress like any other. Measured under exactly that pty on node 22, it
 * arrives once carrying the sequence `\0` under a ctrl-chord name nobody
 * pressed, and lifting on it hands a run nobody is at precisely the unbounded
 * wait the deadline exists to end, so it is the one keypress that does not
 * count. The escape `\0` and not the character: a literal NUL would make this
 * file read as binary to grep.
 *
 * The listener is `on`, not `once`: a `once` listener is spent by the byte it
 * declines to act on, and the genuine keystroke behind it would then find
 * nothing left to lift.
 *
 * @param {unknown} stdin
 * @param {AbortController} controller
 * @param {number} [deadlineMs]
 * @returns {() => void}
 */
export function armPickDeadline(stdin, controller, deadlineMs) {
  const timer = setTimeout(() => controller.abort(), deadlineMs ?? PICK_DEADLINE_MS)
  const io = /** @type {{ on?: (e: string, l: typeof lift) => unknown, off?: (e: string, l: typeof lift) => unknown }} */ (stdin)
  /**
   * @param {string} [str]
   * @param {{ sequence?: string }} [key]
   * @returns {void}
   */
  function lift(str, key) {
    if ((key?.sequence ?? str) === '\0') return
    disarm()
  }
  /** @returns {void} */
  function disarm() {
    clearTimeout(timer)
    io?.off?.('keypress', lift)
  }
  io?.on?.('keypress', lift)
  return disarm
}

/**
 * `hyp ask [question]`
 *
 * The verb that makes setup's closing question runnable. Setup prints it
 * and stops there, deliberately: it may have been invoked from an
 * installer, so the launch waits for a command the user runs themselves.
 *
 * With no argument it asks the one question worth asking first (which
 * skill to add): HypAware gathers the evidence into a folder under
 * `HYP_HOME` and starts an attached client inside it, asking
 * which client only when more than one could be started. With a question
 * it skips the gather and starts a client on that question in the
 * current directory, which is the shape a user reaches for once they know
 * what they want: `hyp ask "which sessions touched the auth module"`.
 *
 * `deps` are the prompt seams `hyp report fix` already carries, so a test
 * can reach the multi-client branch with no terminal to drive.
 *
 * @ref LLP 0198#re-runnable [implements]: the question needs a verb, or it is a sentence to retype
 * @ref LLP 0398#run-directory [implements]: the recommendation starts in the evidence folder, a free-form question where it was typed
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @param {{ select?: RunWizardFirstAskOptions['select'], pickDeadlineMs?: number }} [deps]
 * @returns {Promise<number>}
 */
export async function runAsk(argv, ctx, deps = {}) {
  const parsed = parseCoreCommandArgv('ask', argv, ctx)
  if (!parsed.ok) return parsed.code
  const clients = await askableClients(ctx)
  const descriptors = await buildWalkthroughClientDescriptorMap()
  const question = String(parsed.params.question ?? '').trim()

  if (question.length > 0) {
    // A named question wants a launch, not the gather: resolve directly
    // and say plainly when nothing can answer it, rather than falling back
    // to the one question the user did not ask.
    const launchers = await resolveLaunchers({ clients, descriptors, env: ctx.env })
    if (launchers.length === 0) {
      const canPaste = await recordedClientReadsQuerySkill(ctx, descriptors, clients)
      await writeNoLauncher(ctx, descriptors, canPaste ? framedQuestion(question) : undefined)
      return 1
    }
    // Same client pick as the recommendation ask when more than one could
    // answer. A run that cannot prompt (piped, or `HYP_NO_TUI`) takes the
    // first rather than failing: the user named a question, not a client.
    const canPrompt = isTty(ctx.stdout) && isTty(ctx.stdin) && ctx.env.HYP_NO_TUI !== '1'
    const launcher = canPrompt ? await pickLauncher(launchers, ctx, deps) : launchers[0]
    // Cancelling is "not now", not a failure, but it still has to be said:
    // a run that exits 0 printing nothing reads as a client that started and
    // vanished. Same sentence `hyp report fix` uses on the same cancel.
    if (!launcher) {
      ctx.stdout.write('Nothing started.\n')
      return 0
    }
    ctx.stdout.write(`\nStarting ${launcher.label}...\n\n`)
    const result = await launchClient({ launcher, prompt: framedQuestion(question), env: ctx.env })
    if (!result.ok) {
      ctx.stderr.write(`hyp ask: could not start ${launcher.bin}: ${result.error ?? 'spawn failed'}\n`)
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
    prepareEvidence: (client) => prepareEvidenceFromCtx(ctx, descriptors, client),
  })
  // `no-launcher` and `no-evidence` are the outcomes that are a failed
  // invocation rather than a choice: the user asked for the recommendation and
  // nothing could produce it. Declining, a piped run that printed the question, and an empty
  // cache are all 0 - in the last case nothing is broken, there is just
  // no history yet.
  if (outcome.launched === false && outcome.reason === 'no-launcher') {
    // The cold form of the question, and only where there is history to
    // answer it from: on an empty cache it would send a desktop app looking
    // through nothing.
    const canPaste = hasRows !== false && await recordedClientReadsQuerySkill(ctx, descriptors, clients)
    await writeNoLauncher(ctx, descriptors, canPaste ? RECOMMEND_COLD_PROMPT : undefined)
  }
  return outcome.launched === false && (outcome.reason === 'no-launcher' || outcome.reason === 'no-evidence') ? 1 : 0
}

/**
 * Whether any recorded client can read the `hypaware-query` skill, which is
 * what makes a pasted prompt worth offering: both prompts tell the app to
 * look the answer up with that skill, so handing one to a client that was
 * never shipped it (OpenCode, Pi) points the reader at instructions their
 * app does not have.
 *
 * Read off disk, the way `hyp report generate` checks for its own skill,
 * rather than from a list of client names: a desktop app shares its CLI's
 * skill tree (Claude Desktop reads `~/.claude/skills`), and a client that
 * gains the skill later qualifies with no edit here.
 *
 * @param {CommandRunContext} ctx
 * @param {Map<string, ClientDescriptor>} descriptors
 * @param {string[]} clients the recorded clients
 * @returns {Promise<boolean>}
 */
async function recordedClientReadsQuerySkill(ctx, descriptors, clients) {
  const homeDir = ctx.env.HOME || os.homedir()
  for (const client of clients) {
    const skillDir = descriptors.get(client)?.skillDir
    if (!skillDir) continue
    try {
      await fsp.access(path.join(homeDir, skillDir, 'hypaware-query', 'SKILL.md'))
      return true
    } catch {
      // not installed for this client: keep looking
    }
  }
  return false
}

/**
 * The one thing `hyp ask` says when no recorded client can be started,
 * with or without a question. One writer rather than a sentence per form:
 * the bare ask used to answer this with the question it could not ask and
 * no repair, while the question form named the fix.
 *
 * Which fix it names depends on which half of launchability is missing,
 * and the two halves are separate facts. A CLI on PATH that HypAware is
 * not recording is repaired by an attach, so the attach command is named.
 * No CLI on PATH is not: attaching Codex on a machine that has only Codex
 * Desktop succeeds and still leaves nothing to start, so that case names
 * the binaries looked for and never an attach.
 *
 * Called only once the recorded clients resolved to nothing, so whatever
 * resolves among all launch-declaring clients here is on PATH and not
 * recorded.
 *
 * `paste` is the third case: a client that has the HypAware skills is
 * recorded and has no CLI, which is someone using a desktop app. Nothing here can start that app, but it can
 * be asked by hand, so the prompt is handed over to paste. The explanation
 * goes to stderr and the prompt alone to stdout, so `hyp ask | pbcopy`
 * copies exactly what to paste.
 *
 * @ref LLP 0198#path-probe [implements]: nothing recorded and resolvable is one refusal, said the same way by every form of the verb
 * @ref LLP 0139#repair-must-be-runnable [implements]: an attach is named only where an attach is the repair
 * @param {CommandRunContext} ctx
 * @param {Map<string, ClientDescriptor>} descriptors
 * @param {string} [paste] the prompt to offer for a desktop app, when a recorded client has no CLI
 * @returns {Promise<void>}
 */
async function writeNoLauncher(ctx, descriptors, paste) {
  const unrecorded = await resolveLaunchers({ clients: [...descriptors.keys()], descriptors, env: ctx.env })
  if (unrecorded.length > 0) {
    const one = unrecorded.length === 1
    const names = unrecorded.map((l) => l.label).sort()
    const labels = one ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
    const [first, ...rest] = unrecorded.map((l) => l.client).sort()
    const alternatives = rest.length > 0 ? ` (or ${rest.join(', ')})` : ''
    ctx.stderr.write(`hyp ask: ${labels} ${one ? 'is' : 'are'} installed, but HypAware is not recording ${one ? 'it' : 'them'}.\n`)
    ctx.stderr.write(`  Run \`hyp client attach ${first}\`${alternatives}, then run \`hyp ask\` again.\n`)
    return
  }
  const bins = [...descriptors.values()].flatMap((d) => (d.launch ? [d.launch.bin] : [])).sort()
  const looked = bins.length > 0 ? ` (looked for ${bins.join(', ')})` : ''
  ctx.stderr.write(`hyp ask: no client CLI found on your PATH${looked}.\n`)
  // Two different readers: one has no CLI, one has a CLI the shell does not
  // find. "Install one, or add it to your PATH" read as a choice the first
  // reader could make without installing anything.
  ctx.stderr.write('  You can install one, then run `hyp ask` again. If one is already installed, add its folder to your PATH.\n')
  if (paste) {
    // The blank line is stderr's, so stdout carries the prompt and nothing else.
    ctx.stderr.write('  Using a desktop app instead? You can paste this in:\n\n')
    ctx.stdout.write(`${paste}\n`)
  }
}

/**
 * Which client answers a named question, asked on a terminal.
 *
 * The screen is the same one `hyp report fix` puts up, under a deadline
 * the picker itself has no reason to carry: a run nobody is at must still
 * end. An expired deadline is not a cancel - the person did not decline
 * anything - so it falls through to the pick a run that cannot prompt
 * already makes, and says so, rather than reporting a choice nobody made.
 * An escape still means "not now" and returns `undefined`.
 *
 * @param {FirstAskLauncher[]} launchers
 * @param {CommandRunContext} ctx
 * @param {{ select?: RunWizardFirstAskOptions['select'], pickDeadlineMs?: number }} deps
 * @returns {Promise<FirstAskLauncher | undefined>}
 */
async function pickLauncher(launchers, ctx, deps) {
  if (launchers.length < 2) return launchers[0]
  const controller = new AbortController()
  const disarm = armPickDeadline(ctx.stdin, controller, deps.pickDeadlineMs)
  /** @type {FirstAskLauncher | undefined} */
  let picked
  try {
    picked = await chooseLauncher({
      launchers,
      title: 'Which client should answer?',
      env: ctx.env,
      signal: controller.signal,
      ...(deps.select ? { select: deps.select } : {}),
      ...(ctx.stdin ? { stdin: ctx.stdin } : {}),
      // The prompt draws where the gate looked: `isTty(ctx.stdout)` decided
      // there was a terminal, so that is the stream the frame belongs on.
      stdout: /** @type {NodeJS.WritableStream} */ (/** @type {unknown} */ (ctx.stdout)),
    })
  } finally {
    disarm()
  }
  if (picked) return picked
  if (!controller.signal.aborted) return undefined
  ctx.stdout.write(PICK_DEADLINE_NOTICE)
  return launchers[0]
}

/**
 * The recommendation ask's gather (LLP 0398), run in-process against the
 * same runner the overview uses. The evidence lives in `<HYP_HOME>/ask/`,
 * one folder rewritten on every ask: the client is started inside it, so
 * its transcript label, cwd, and any test file it writes belong to this
 * ask rather than to whatever repo `hyp ask` was typed in. The path is
 * fixed rather than random because Claude Code asks once whether to trust
 * a new folder; a fresh random path would ask on every run. It is under
 * `HYP_HOME`, not the system temp directory, because every parent of the
 * folder is then the person's own: on Linux the temp directory is shared
 * by every account on the host, and a parent another account created
 * first is a folder another account controls, files and cwd both.
 *
 * `client` is the one the wizard is about to start. Its descriptor carries
 * the skill and agent trees that client actually reads, which is what the
 * instructions and the on-disk listing name: Codex does not load
 * `~/.claude/skills`.
 *
 * @ref LLP 0398#run-directory [implements]: a fixed folder under HYP_HOME owns the ask, not the caller's cwd and not a shared temp directory
 * @param {CommandRunContext} ctx
 * @param {Map<string, ClientDescriptor>} descriptors
 * @param {string} client
 * @returns {Promise<FirstAskEvidence | undefined>}
 */
async function prepareEvidenceFromCtx(ctx, descriptors, client) {
  // The same notice sink the first look passes, for the same reason: the
  // runner filters local-only rows whether or not anyone listens, so a
  // withheld row nobody discloses turns `Recorded: N sessions` into a claim
  // about a record the reader was never told is partial. The advisory
  // debounce line is dropped; the degrade warning is not.
  // @ref LLP 0105 [implements]: the gather inherits both halves - the filter and the disclosure that it filtered
  const runner = overviewRunnerFromCtx(ctx, firstLookNoticeSink(ctx.stderr))
  if (!runner || !runner.hasDataset(OVERVIEW_DATASET)) return undefined
  const homeDir = ctx.env.HOME || os.homedir()
  const hypHome = ctx.env.HYP_HOME || path.join(homeDir, '.hyp')
  const descriptor = descriptors.get(client)
  return prepareFirstAskEvidence({
    runner,
    root: path.join(hypHome, 'ask'),
    homeDir,
    ...(descriptor?.skillDir ? { client: { skillDir: descriptor.skillDir, ...(descriptor.agentDir ? { agentDir: descriptor.agentDir } : {}) } } : {}),
    say: (line) => ctx.stdout.write(`${line}\n`),
  })
}

/**
 * The free-form question as the client is started on it.
 *
 * The client opens with no context, and a question like "which sessions
 * touched the auth module" reads to it as one about the current repo, so
 * it greps the tree or answers from nothing. Naming HypAware and the
 * query command points it at the recorded history the verb exists to
 * reach; the person's words follow verbatim.
 *
 * @param {string} question
 * @returns {string}
 */
export function framedQuestion(question) {
  return 'Answer this from my HypAware history: look it up in the recorded sessions with `hyp query` '
    + '(the hypaware-query skill explains how) before answering, rather than from this directory or memory.\n\n'
    + `Question: ${question}`
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
 * The clients `hyp ask` may start: those HypAware is recording, as far as a
 * status probe can tell.
 *
 * This is the command's analogue of the wizard's "picked" list
 * (`@ref LLP 0198#path-probe`): starting a client nothing captures would
 * open a session the question is then answered without, so the predicate
 * is evidence of capture rather than mere presence. Two things count as
 * that evidence: an attach marker, and a capture mode that writes no
 * marker to find. A status failure degrades to every launchable client
 * rather than to none, because a probe that cannot read a settings file is
 * not evidence of detachment.
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
    //
    // A configured client whose attach is n/a (`attachable: false`) has no
    // settings marker to miss - Codex in its default transcript mode, for
    // one - so a missing marker there is not detachment. `configured` is the
    // strongest thing the status report carries for such a client: it says
    // the plugin is enabled, not that its lane is running, so a codex whose
    // sweep is switched off (`backfill.on_join: false`, #2076) still reaches
    // the offer. Clients with no `launch` block (Claude Desktop) are
    // still dropped later by `resolveLaunchers`.
    // @ref LLP 0429#status [constrained-by]: a probe whose marker this capture mode never writes is n/a, not missing
    return report.clients.filter((c) => c.attached || (c.configured && c.attachable === false)).map((c) => c.name)
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
 * Used by `hyp report fix` and `hyp report generate`, which launch through
 * the same seams. `hyp ask` words its own refusal (`writeNoLauncher`),
 * which names an attach only when a CLI is on PATH to attach.
 *
 * @ref LLP 0139#repair-must-be-runnable [implements]: the repair we print is a command that runs
 * @ref LLP 0198#split [constrained-by]: the launchable set is whatever declares `contributes.client.launch`
 * @param {Map<string, ClientDescriptor>} descriptors
 * @returns {string}
 */
export function attachHint(descriptors) {
  const launchable = [...descriptors.values()].filter((d) => d.launch).map((d) => d.name).sort()
  if (launchable.length === 0) {
    return 'Attach a client with `hyp client attach`, and make sure its CLI is on your PATH.'
  }
  const [first, ...rest] = launchable
  const alternatives = rest.length > 0 ? ` (or ${rest.join(', ')})` : ''
  return `Attach one with \`hyp client attach ${first}\`${alternatives}, and make sure its CLI is on your PATH.`
}

export { SUGGESTED_PROMPTS }
