// @ts-check

/**
 * The wizard's closing "first ask": a short list of questions worth
 * asking of the data setup just captured, and the launcher that starts
 * the user's own client on the chosen one.
 *
 * The first look (`first_look.js`) proves there are rows. This spends
 * them. Between the two, a user finishing setup goes from "something was
 * recorded" to having asked their first question without opening a second
 * terminal or retyping anything.
 *
 * @ref LLP 0195#first-ask [implements]: setup closes on a live question list, not a printed hint
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
 * Phrased as a user would phrase them, never as skill invocations: the
 * skills' own `description` fields do the routing, and a prompt that
 * named one would teach the user a vocabulary they should never need
 * (`@ref LLP 0011#no-architectural-names`).
 *
 * `label` is what the menu shows; `prompt` is what the client is started
 * with. They differ because a menu row wants to be scannable and an
 * opening prompt wants to be specific.
 *
 * The labels are noun phrases rather than questions, and no two lean on
 * the same noun. The screen's own title already asks the question ("Ask
 * your first question"), so four rows repeating the interrogative spend
 * their first words on grammar the reader has had; and a set where three
 * rows said "tokens" scanned as one topic listed three times rather than
 * as four choices. Each row now differentiates on its own axis: spend,
 * friction, repetition, delegation.
 *
 * @ref LLP 0195#split [implements]: the questions are core's, because they are about core's datasets
 * @type {ReadonlyArray<{ id: string, label: string, prompt: string }>}
 */
export const SUGGESTED_PROMPTS = Object.freeze([
  {
    id: 'tokens',
    label: 'Biggest token costs this week',
    prompt: 'Based on the hypaware logs. What AI tasks cost the most tokens this week?',
  },
  {
    id: 'errors',
    label: 'Where agents stall or waste effort',
    prompt: 'Based on the hypaware logs. What are the most common reasons for my AI agents getting stuck, wasting tokens, or failing to complete a task?',
  },
  {
    id: 'skills',
    label: 'Repeated work worth turning into a skill',
    prompt: 'Based on the hypaware logs. What repeated tasks do my AI agents run that should be made into a skill?',
  },
  {
    id: 'subagents',
    label: 'Where a subagent would pay off',
    prompt: 'Based on the hypaware logs. What subagents could I add to my workflow to improve efficiency and token cost?',
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
 * @ref LLP 0195#path-probe [implements]: launchability is a PATH question, distinct from the picker's presence probe
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
 * The launchable clients for this run: picked *and* resolvable.
 *
 * Both conditions are required and neither is redundant. An unpicked
 * client is one HypAware is not recording, so starting it would open a
 * session the user never consented to capture. A picked client with no
 * binary on `$PATH` cannot be started at all - which is the ordinary
 * state of Claude Desktop, a client that is detectable, pickable, and
 * attachable but carries no `launch` block because it has no prompt
 * argument to carry one for.
 *
 * @ref LLP 0195#path-probe [implements]: offer only what was picked and resolves
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
 * The printed fallback: the same questions as copyable text.
 *
 * Reached whenever the launch cannot happen or the user declines, and it
 * is never silent about which. A user with no launchable client is told
 * the questions still work, just typed into their own session; a user who
 * declined keeps the list to come back to.
 *
 * @param {{
 *   stdout: { write(chunk: string): unknown },
 *   launchable: boolean,
 * }} args
 */
export function writeSuggestedPrompts({ stdout, launchable }) {
  stdout.write('\nQuestions worth asking your AI client about this data:\n')
  for (const p of SUGGESTED_PROMPTS) {
    stdout.write(`  ${p.prompt}\n`)
  }
  // The unlaunchable variant must not name `hyp ask`: the reader either
  // just ran it, or is being told setup could not start anything. Either
  // way it would point at the screen they are already looking at.
  stdout.write(
    launchable
      ? '\nRun `hyp ask` to pick one of these and start your client on it.\n'
      : '\nPaste one into a Claude Code or Codex session to get started.\n'
  )
}

/**
 * The empty-cache variant: the questions, held back until they have
 * something to answer from.
 *
 * A fresh install with nothing backfilled is the common case for someone
 * new to Claude or Codex, and every suggested question is about recorded
 * history. Launching one against an empty cache spends the user's first
 * impression on an empty answer and teaches them the tool does not work.
 *
 * So the list is still printed - it is the clearest statement of what
 * HypAware is for - but framed as something to come back to, with the
 * one fact that makes the emptiness make sense: capture starts now, not
 * retroactively.
 *
 * @ref LLP 0195#empty-cache [implements]: no rows means no launch, and the reason is stated
 * @param {{ stdout: { write(chunk: string): unknown } }} args
 */
export function writeEmptyCacheNote({ stdout }) {
  stdout.write('\nNothing recorded yet: HypAware captures from your next session onward.\n')
  stdout.write('Once you have some history, these are worth asking your AI client:\n')
  for (const p of SUGGESTED_PROMPTS) {
    stdout.write(`  ${p.prompt}\n`)
  }
  stdout.write('\nRun `hyp ask` then, to pick one and start your client on it.\n')
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
 * The child's exit code is deliberately dropped. `hyp init` reports
 * whether *setup* succeeded, and a user who quits the client with ctrl+c
 * has not failed an install that finished minutes earlier.
 *
 * @ref LLP 0195#real-launch [implements]: inherit the terminal, keep the wizard's own exit code
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
 * Run the closing first ask. Never throws: setup has already succeeded by
 * the time this runs, so a missing binary, a spawn failure, a cancelled
 * prompt, or an unforeseen error all degrade to the printed list.
 *
 * @ref LLP 0195#first-ask [implements]: the closing step, and that it can never fail a finished install
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
        // @ref LLP 0195#empty-cache [implements]: an empty cache suppresses the launch, not just the menu
        if (opts.hasRows === false) {
          span.setAttribute('status', 'skipped')
          span.setAttribute('skip_reason', 'no-rows')
          writeEmptyCacheNote({ stdout })
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
          writeSuggestedPrompts({ stdout, launchable: false })
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
          writeSuggestedPrompts({ stdout, launchable: true })
          return { launched: false, reason: /** @type {const} */ ('not-interactive') }
        }

        // One blank line so the frame does not sit flush against the
        // privacy narration above it.
        stdout.write('\n')
        const chosen = await chooseQuestion(opts, launchers)
        if (!chosen) {
          span.setAttribute('status', 'skipped')
          span.setAttribute('skip_reason', 'declined')
          writeSuggestedPrompts({ stdout, launchable: true })
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
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
          ...(opts.spawnFn ? { spawnFn: opts.spawnFn } : {}),
        })
        if (!result.ok) {
          span.setAttribute('status', 'error')
          span.setAttribute(Attr.ERROR_KIND, 'spawn_failed')
          span.setAttribute('launched', false)
          opts.stderr?.write(`Could not start ${chosen.launcher.bin}: ${result.error ?? 'spawn failed'}\n`)
          writeSuggestedPrompts({ stdout, launchable: false })
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
          writeSuggestedPrompts({ stdout, launchable: false })
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
      // Framed, unlike every other prompt in the wizard. Those arrive one
      // per screen with nothing above them; this one lands under the first
      // look's tables and rules, at the end of a long scroll, and an
      // unframed list of sentences there reads as more output rather than
      // as the thing still waiting for a keypress.
      // @ref LLP 0195#frame [implements]: the closing ask is drawn as its own screen
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
