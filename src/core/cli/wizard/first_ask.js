// @ts-check

/**
 * Suggested questions shared by onboarding and `hyp ask`, plus the
 * explicit command's client launcher.
 *
 * The first look (`first_look.js`) proves there are rows. Onboarding then
 * prints what the user can ask, while an explicit `hyp ask` can spend those
 * rows by starting a client later.
 *
 * @ref LLP 0198#onboarding-list [implements]: setup prints the shared questions without launching
 * @ref LLP 0198#first-ask [implements]: the explicit command keeps the live question menu
 *
 * @import { ChildProcess, SpawnOptions } from 'node:child_process'
 * @import { ClientDescriptor } from '../../../../src/core/types.js'
 * @import { FirstAskLauncher, FirstAskResult, RunWizardFirstAskOptions } from '../../../../src/core/cli/wizard/types.js'
 */

import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { Attr, withSpan } from '../../observability/index.js'
import { PromptCancelledError, select } from '../tui/index.js'
import { isPromptBackError } from '../tui/runtime.js'

/**
 * The questions setup offers.
 *
 * Every one asks what to *change*, not what happened: where the tokens
 * went, why agents stall, what repeated work deserves a skill, which
 * subagents would pay for themselves. A question whose best answer is a
 * number teaches the user that HypAware is a dashboard; a question whose
 * answer is a change teaches them it is a feedback loop, which is the
 * thing worth learning in the first minute.
 *
 * Phrased as a user would phrase them, never as skill invocations
 * (`@ref LLP 0011#no-architectural-names`): the skills' own `description`
 * fields do the routing, and a prompt naming one would teach the user a
 * vocabulary they should never need.
 *
 * Each does name HypAware, in a leading "From my HypAware history"
 * clause. The product name is not an architectural name - it is the thing
 * the user just installed, and the words they would reach for themselves.
 * What the earlier "Based on the hypaware logs." prefix got wrong was
 * naming the *artifact* (a dataset the user has never seen) in a sentence
 * fragment bolted on ahead of the question. The clause has to stay,
 * though: `hyp ask` opens a session with no context, and a question about
 * "my sessions" with nothing pointing at the history is one a cold client
 * may answer from its own conversation, or refuse for want of data.
 *
 * `which` and `what` are not interchangeable here. `which` presupposes a
 * set the reader could point at, so it is correct only for things already
 * in the recorded history (a task, a request, a stage of a workflow) and
 * wrong for a skill or a subagent that does not exist yet - "which skill
 * should I build" reads as a menu of skills the user already has. The
 * proposed thing takes `what`, the evidence it is proposed from takes
 * `which`, which is why the two forward-looking questions carry one of
 * each.
 *
 * Each is one subject with one criterion, closing on a short clause that
 * asks for the *mechanism* rather than restating the subject: "what drove
 * the cost", not "how much did it cost". The mechanism is the half only
 * the user's own sessions can answer, and the half that is actionable.
 * Each is scoped (a week, "across sessions", "over and over") so the
 * answer is a specific thing rather than a survey, which keeps it fast
 * under `@ref LLP 0054`'s bounded execution as well as pointed.
 *
 * `label` is what the menu shows; `prompt` is what the client is started
 * with. They differ because a menu row wants to be scannable and an
 * opening prompt wants to be specific.
 *
 * The labels are noun phrases rather than questions, and no two lean on
 * the same noun (spend, mistake, skill, subagent). The screen's own title already asks the question ("Ask
 * your first question"), so four rows repeating the interrogative spend
 * their first words on grammar the reader has had; and a set where three
 * rows said "tokens" scanned as one topic listed three times rather than
 * as four choices. Each row now differentiates on its own axis: spend,
 * friction, repetition, delegation.
 *
 * @ref LLP 0198#split [implements]: the questions are core's, because they are about core's datasets
 * @type {ReadonlyArray<{ id: string, label: string, prompt: string }>}
 */
export const SUGGESTED_PROMPTS = Object.freeze([
  {
    id: 'tokens',
    label: "Last week's biggest token spend",
    prompt: 'From my HypAware history, which task took the biggest share of my tokens last week, and what drove the cost?',
  },
  {
    id: 'errors',
    label: 'The mistake my agents repeat',
    prompt: 'From my HypAware history, what mistake do my agents keep repeating across sessions, and what triggers it?',
  },
  {
    id: 'skills',
    label: "The skill I'm missing",
    prompt: 'From my HypAware history, what additional skill would save me the most repeated work, and which requests would it replace?',
  },
  {
    id: 'subagents',
    label: 'The subagent worth adding',
    prompt: 'From my HypAware history, what subagent could I add to cut the most wasted effort, and which tasks would I delegate to it?',
  },
])

/** Menu value for the row that declines. Not a prompt id. */
const NOT_NOW = '__not_now__'

/**
 * Resolve an executable name against `$PATH`, returning its absolute
 * path or `undefined`.
 *
 * A name containing a separator is already a path and is probed as-is,
 * so a manifest may name an absolute binary. Everything else walks
 * `PATH` in order, honouring `PATHEXT` on Windows.
 *
 * Best-effort in the same sense as the picker's detection probes: any
 * failure means "not found", never a throw.
 *
 * @ref LLP 0198#path-probe [implements]: launchability is a PATH question, distinct from the picker's presence probe
 * @param {string} bin
 * @param {NodeJS.ProcessEnv} env
 * @param {string} [platform]
 * @returns {Promise<string | undefined>}
 */
export async function resolveOnPath(bin, env, platform = process.platform) {
  if (!bin) return undefined
  const win = platform === 'win32'
  const exts = win
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  const candidates = bin.includes(path.sep) || bin.includes('/')
    ? [bin]
    : (env.PATH ?? '').split(win ? ';' : ':').filter(Boolean).map((dir) => path.join(dir, bin))
  for (const candidate of candidates) {
    for (const ext of exts) {
      const full = candidate + ext
      try {
        await fsp.access(full, fsConstants.X_OK)
        return full
      } catch {
        // not here, or not executable: keep walking
      }
    }
  }
  return undefined
}

/**
 * The launchable clients for this run: eligible *and* resolvable.
 *
 * Both conditions are required and neither is redundant. An ineligible
 * client is one HypAware is not recording, so starting it would open a
 * session the user never consented to capture. An eligible client with no
 * binary on `$PATH` cannot be started at all - which is the ordinary
 * state of Claude Desktop, a client that is detectable, pickable, and
 * capture-enabled but carries no `launch` block because it has no prompt
 * argument to carry one for.
 *
 * @ref LLP 0198#path-probe [implements]: offer only what is attached and resolves
 * @param {{
 *   clients: string[],
 *   descriptors: Map<string, ClientDescriptor>,
 *   env: NodeJS.ProcessEnv,
 *   platform?: string,
 *   resolve?: (bin: string, env: NodeJS.ProcessEnv, platform?: string) => Promise<string | undefined>,
 * }} args
 * @returns {Promise<FirstAskLauncher[]>}
 */
export async function resolveLaunchers({ clients, descriptors, env, platform, resolve = resolveOnPath }) {
  /** @type {FirstAskLauncher[]} */
  const out = []
  for (const client of clients) {
    const descriptor = descriptors.get(client)
    const launch = descriptor?.launch
    if (!launch) continue
    let binPath
    try {
      binPath = await resolve(launch.bin, env, platform)
    } catch {
      binPath = undefined
    }
    if (!binPath) continue
    out.push({
      client,
      label: launch.label ?? client,
      bin: launch.bin,
      binPath,
      args: launch.args,
    })
  }
  return out
}

/**
 * The question list, in every framing that prints it.
 *
 * One renderer rather than one per caller: the questions, the
 * empty-history preamble, and the footers are a single surface, and a
 * second copy of them is how the "nothing recorded yet" sentence drifts
 * out of agreement with itself. Same one-place grounds as the frame
 * helper ([LLP 0189 #palette](../../../../llp/0189-cli-severity-colour.decision.md#palette)).
 *
 * `hasRows === false` swaps the preamble: every suggested question is
 * about recorded history, so a cache with nothing in it gets the list
 * framed as something to come back to, prefaced by the one fact that
 * makes the emptiness make sense - capture starts now, not
 * retroactively. `undefined` means the caller could not tell, which
 * never withholds the ordinary framing.
 *
 * `footer` says who is reading:
 *
 * - `ask`: a launch is possible, and this run is not doing one (declined,
 *   piped, or `--list`). Names the verb that would.
 * - `paste`: nothing here can be launched, so the questions still work
 *   typed into a session the user opens themselves.
 * - `onboarding`: setup, which never launches. Names what the verb is
 *   *for* (putting one of these to a client) before naming the directory
 *   it must be run from, because a footer that only states the
 *   constraint leaves the reader to infer what they would be running it
 *   to do. The client binaries are named outright: a user who has just
 *   picked one in the wizard still has no reason to know the verb starts
 *   the same program they picked.
 *
 * @ref LLP 0198#empty-cache [implements]: no rows reframes the list, and the reason is stated
 * @ref LLP 0198#onboarding-list [implements]: setup's footer names `hyp ask` and the directory to run it from
 * @param {{
 *   stdout: { write(chunk: string): unknown },
 *   footer: 'ask' | 'paste' | 'onboarding',
 *   hasRows?: boolean,
 * }} args
 */
export function writeSuggestedPrompts({ stdout, footer, hasRows }) {
  if (hasRows === false) {
    stdout.write('\nNothing recorded yet: HypAware captures from your next session onward.\n')
    stdout.write('Once you have some history, these are worth asking your AI client:\n')
  } else {
    stdout.write('\nQuestions worth asking your AI client about this data:\n')
  }
  for (const p of SUGGESTED_PROMPTS) {
    stdout.write(`  ${p.prompt}\n`)
  }
  stdout.write(`\n${promptListFooter(footer, hasRows)}\n`)
}

/**
 * The closing line for a printed list.
 *
 * `ask` under an empty cache is the one combination that is not a
 * straight lookup: the verb is still the right one, but "run it" is
 * wrong advice until there is something to run it against, so the
 * sentence becomes "run it *then*".
 *
 * @param {'ask' | 'paste' | 'onboarding'} footer
 * @param {boolean | undefined} hasRows
 * @returns {string}
 */
function promptListFooter(footer, hasRows) {
  switch (footer) {
    case 'paste':
      // Must not name `hyp ask`: the reader either just ran it, or is
      // being told nothing here can be started. Either way it would
      // point at the screen they are already looking at.
      return 'Paste one into a Claude Code or Codex session to get started.'
    case 'onboarding':
      return 'To ask any of these, run `hyp ask` from the directory where you want your AI client (claude or codex) to start.'
    default:
      return hasRows === false
        ? 'Run `hyp ask` then, to pick one and start your client on it.'
        : 'Run `hyp ask` to pick one of these and start your client on it.'
  }
}

/**
 * Start `launcher` on `prompt`, handing it the real terminal.
 *
 * `stdio: 'inherit'` is the whole point: the child draws its own UI on
 * the terminal `hyp` was using, and ctrl+c reaches the child rather than
 * this process. It is safe here only because every TUI prompt has
 * already resolved - `run()`'s `cleanup()` restores raw mode and the
 * cursor on every exit path - so the child inherits the terminal in the
 * mode it started in. Spawning from inside a prompt would hand a child
 * a raw-mode terminal, which renders as a client that opens broken.
 *
 * The child's exit code is deliberately dropped. `hyp ask` reports whether
 * it could start the client; a user who later quits that client with ctrl+c
 * has not made the launch itself fail.
 *
 * @ref LLP 0198#real-launch [implements]: inherit the terminal and do not reinterpret the client's eventual exit as a launch failure
 * @param {{
 *   launcher: FirstAskLauncher,
 *   prompt: string,
 *   cwd?: string,
 *   env: NodeJS.ProcessEnv,
 *   spawnFn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess,
 * }} args
 * @returns {Promise<{ ok: boolean, code?: number | null, error?: string }>}
 */
export function launchClient({ launcher, prompt, cwd, env, spawnFn = spawn }) {
  const args = launcher.args.map((a) => a.replaceAll('{prompt}', prompt))
  return new Promise((resolve) => {
    let settled = false
    /** @param {{ ok: boolean, code?: number | null, error?: string }} r */
    const done = (r) => { if (!settled) { settled = true; resolve(r) } }
    try {
      const child = spawnFn(launcher.binPath, args, {
        stdio: 'inherit',
        ...(cwd ? { cwd } : {}),
        env,
      })
      child.on('error', (err) => done({ ok: false, error: err instanceof Error ? err.message : 'spawn failed' }))
      child.on('close', (code) => done({ ok: true, code }))
    } catch (err) {
      done({ ok: false, error: err instanceof Error ? err.message : 'spawn failed' })
    }
  })
}

/**
 * Run the explicit first ask. Never throws: a missing binary, a spawn
 * failure, a cancelled prompt, or an unforeseen error all degrade to the
 * printed list.
 *
 * @ref LLP 0198#first-ask [implements]: the explicit command owns the live menu and launch
 * @param {RunWizardFirstAskOptions} opts
 * @returns {Promise<FirstAskResult>}
 */
export async function runWizardFirstAsk(opts) {
  return withSpan(
    'wizard.first_ask',
    {
      [Attr.COMPONENT]: 'wizard',
      [Attr.OPERATION]: 'wizard.first_ask',
      status: 'ok',
    },
    async (span) => {
      const { stdout, env, clients, descriptors } = opts
      try {
        // Checked before launchability, because it subsumes it: with no
        // rows the answer is the same whether or not a client could have
        // been started, and "nothing recorded yet" is the more useful
        // half of it. `undefined` means the caller could not tell, which
        // is never a reason to withhold the offer.
        // @ref LLP 0198#empty-cache [implements]: an empty cache suppresses the launch, not just the menu
        if (opts.hasRows === false) {
          span.setAttribute('status', 'skipped')
          span.setAttribute('skip_reason', 'no-rows')
          writeSuggestedPrompts({ stdout, footer: 'ask', hasRows: false })
          return { launched: false, reason: /** @type {const} */ ('no-rows') }
        }

        const launchers = await resolveLaunchers({
          clients,
          descriptors,
          env,
          ...(opts.platform ? { platform: opts.platform } : {}),
          ...(opts.resolve ? { resolve: opts.resolve } : {}),
        })
        span.setAttribute('launcher_count', launchers.length)

        if (launchers.length === 0) {
          span.setAttribute('status', 'skipped')
          span.setAttribute('skip_reason', 'no-launcher')
          writeSuggestedPrompts({ stdout, footer: 'paste' })
          return { launched: false, reason: /** @type {const} */ ('no-launcher') }
        }
        // `HYP_NO_TUI` is the same veto the prompt runtime honours. Reading
        // it here rather than letting `select()` throw keeps a deliberate
        // no-TUI run reported as what it is (a run that cannot prompt)
        // instead of as an error.
        const canPrompt = opts.select !== undefined || env.HYP_NO_TUI !== '1'
        if (opts.interactive === false || !canPrompt) {
          span.setAttribute('status', 'skipped')
          span.setAttribute('skip_reason', 'not-interactive')
          writeSuggestedPrompts({ stdout, footer: 'ask' })
          return { launched: false, reason: /** @type {const} */ ('not-interactive') }
        }

        // One blank line so the frame does not sit flush against the
        // privacy narration above it.
        stdout.write('\n')
        const chosen = await chooseQuestion(opts, launchers)
        if (!chosen) {
          span.setAttribute('status', 'skipped')
          span.setAttribute('skip_reason', 'declined')
          writeSuggestedPrompts({ stdout, footer: 'ask' })
          return { launched: false, reason: /** @type {const} */ ('declined') }
        }

        span.setAttribute('client', chosen.launcher.client)
        span.setAttribute('prompt_id', chosen.prompt.id)
        // Say what is about to happen before the terminal stops being
        // ours: a client that takes ~2s to draw its first frame reads as
        // a hang if nothing announced it.
        stdout.write(`\nStarting ${chosen.launcher.label}...\n\n`)
        const result = await launchClient({
          launcher: chosen.launcher,
          prompt: chosen.prompt.prompt,
          env,
          // No cwd override: the client starts where the user ran `hyp
          // ask`, which is the boundary that made this a separate command
          // (`@ref LLP 0198#onboarding-list`).
          ...(opts.spawnFn ? { spawnFn: opts.spawnFn } : {}),
        })
        if (!result.ok) {
          span.setAttribute('status', 'error')
          span.setAttribute(Attr.ERROR_KIND, 'spawn_failed')
          span.setAttribute('launched', false)
          opts.stderr?.write(`Could not start ${chosen.launcher.bin}: ${result.error ?? 'spawn failed'}\n`)
          writeSuggestedPrompts({ stdout, footer: 'paste' })
          return { launched: false, reason: /** @type {const} */ ('spawn-failed') }
        }
        span.setAttribute('launched', true)
        return {
          launched: true,
          client: chosen.launcher.client,
          promptId: chosen.prompt.id,
          ...(typeof result.code === 'number' ? { exitCode: result.code } : {}),
        }
      } catch (err) {
        span.setAttribute('status', 'error')
        span.setAttribute(Attr.ERROR_KIND, err instanceof Error ? err.name : 'unknown')
        try {
          writeSuggestedPrompts({ stdout, footer: 'paste' })
        } catch {
          // the stream itself is failing; the step is a courtesy, not a gate
        }
        return { launched: false, reason: /** @type {const} */ ('error') }
      }
    },
    { component: 'wizard' }
  )
}

/**
 * The menu half: which question, and (only when it is genuinely
 * ambiguous) which client answers it.
 *
 * Cancel is not a failure here. Escape and ctrl+c both mean "not now",
 * the same as the menu's own last row, because there is nothing left to
 * abandon: this runs after the last durable write.
 *
 * @param {RunWizardFirstAskOptions} opts
 * @param {FirstAskLauncher[]} launchers
 * @returns {Promise<{ prompt: (typeof SUGGESTED_PROMPTS)[number], launcher: FirstAskLauncher } | undefined>}
 */
async function chooseQuestion(opts, launchers) {
  const ask = opts.select ?? select
  const io = {
    ...(opts.stdin ? { stdin: opts.stdin } : {}),
    ...(opts.stdoutStream ? { stdout: opts.stdoutStream } : {}),
    env: opts.env,
  }
  /** @type {string | number} */
  let picked
  try {
    picked = await ask({
      // Framed so the explicit command's interactive menu is visually
      // distinct from its plain printed-list mode.
      // @ref LLP 0198#frame [implements]: the explicit ask is drawn as its own screen
      box: true,
      title: 'Ask your first question',
      items: launchers.length === 1
        ? [`Starts ${launchers[0].label} on the question you pick.`]
        : ['Starts your AI client on the question you pick.'],
      // The default hint says "esc cancel", which is wrong here: there is
      // nothing left to cancel, and escape means the same as the last row.
      hint: 'up/down · enter start · esc not now',
      options: [
        ...SUGGESTED_PROMPTS.map((p) => ({ value: p.id, label: p.label })),
        { value: NOT_NOW, label: 'Not now' },
      ],
      ...io,
    })
  } catch (err) {
    if (err instanceof PromptCancelledError || isPromptBackError(err) || (err instanceof Error && err.name === 'PromptCancelledError')) {
      return undefined
    }
    throw err
  }
  if (picked === NOT_NOW) return undefined
  const prompt = SUGGESTED_PROMPTS.find((p) => p.id === picked)
  if (!prompt) return undefined

  if (launchers.length === 1) return { prompt, launcher: launchers[0] }
  /** @type {string | number} */
  let client
  try {
    client = await ask({
      // The follow-up half of the same screen, so it keeps the same frame.
      box: true,
      title: 'Which client should answer it?',
      options: launchers.map((l) => ({ value: l.client, label: l.label })),
      ...io,
    })
  } catch (err) {
    if (err instanceof PromptCancelledError || isPromptBackError(err) || (err instanceof Error && err.name === 'PromptCancelledError')) {
      return undefined
    }
    throw err
  }
  const launcher = launchers.find((l) => l.client === client)
  return launcher ? { prompt, launcher } : undefined
}
