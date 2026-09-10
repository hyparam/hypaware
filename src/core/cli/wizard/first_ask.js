// @ts-check

/**
 * The one question `hyp ask` puts, and the command's client launcher.
 *
 * The first look (`first_look.js`) proves there are rows; setup then
 * offers to run this (`suggest_skill.js`), and an explicit `hyp ask`
 * spends those rows: it gathers the evidence and starts a client on it.
 *
 * @ref LLP 0198#first-ask [implements]: the explicit command owns the launch; the only pick left is the client
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
import { RECOMMEND_LAUNCH_PROMPT, RECOMMEND_PROMPT_ID } from '../../query/first_ask_evidence.js'

/**
 * The question setup offers, and `hyp ask` starts.
 *
 * One question, whose answer is a skill rather than a number: which
 * skill would be the most useful to add first. A question whose
 * best answer is a number teaches the user that HypAware is a dashboard;
 * one whose answer is a change teaches them it is a feedback loop, which
 * is the thing worth learning in the first minute. The four earlier
 * questions (token spend, repeated mistakes, a missing skill, a subagent
 * worth adding) are answered by the one that gathers first: what the
 * person types again and again, and what ran after it, instead of a
 * cold client guessing at SQL (LLP 0398 #one-question).
 *
 * Phrased as a user would phrase it, never as a skill invocation
 * (`@ref LLP 0011#no-architectural-names`), and opening with "From my
 * HypAware history" because `hyp ask` opens a session with no context.
 *
 * `label` is the question as printed; `prompt` is what the client is
 * started with. They differ because the prompt names the evidence folder
 * the client is started in, which does not exist for a reader who is
 * only shown the list, so the prompt is never printed as something to
 * type.
 *
 * @ref LLP 0198#split [implements]: the question is core's, because it is about core's datasets
 * @ref LLP 0398#one-question [implements]: one question, answered from gathered evidence, replaces the list
 * @type {ReadonlyArray<{ id: string, label: string, prompt: string }>}
 */
export const SUGGESTED_PROMPTS = Object.freeze([
  {
    // The one question (LLP 0398 #one-question). Its launch is preceded by
    // a gather, and the prompt names the folder because the client is
    // started inside it. The earlier four rows asked the same things a
    // cold client could not answer well from SQL it wrote itself; they are
    // answered from what the gather finds the person typing again and again.
    id: RECOMMEND_PROMPT_ID,
    label: 'Which one skill would be the most useful to add first?',
    prompt: RECOMMEND_LAUNCH_PROMPT,
  },
])

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
 * The question, in every framing that prints it.
 *
 * One renderer rather than one per caller: the question, the
 * empty-history preamble, and the footers are a single surface, and a
 * second copy of them is how the "nothing recorded yet" sentence drifts
 * out of agreement with itself. Same one-place grounds as the frame
 * helper ([LLP 0189 #palette](../../../../llp/0189-cli-severity-colour.decision.md#palette)).
 *
 * What prints is the `label`, never the `prompt`: the prompt tells the
 * client to read a folder that only `hyp ask` creates, so typed into a
 * cold session it fails in exactly the way the gather exists to prevent.
 *
 * `hasRows === false` swaps the preamble: the question is about recorded
 * history, so a cache with nothing in it gets it framed as something to
 * come back to, prefaced by the one fact that makes the emptiness make
 * sense - capture starts now, not retroactively. `undefined` means the
 * caller could not tell, which never withholds the ordinary framing.
 *
 * `footer` says who is reading:
 *
 * - `ask`: a launch is possible, and this run is not doing one (declined,
 *   piped, or `--list`). Names the verb that would.
 * - `no-launch`: this run could not start a client (none attached and on
 *   PATH, a spawn failure, an unforeseen error). There is no manual
 *   route, because the answer needs the evidence only the verb gathers,
 *   so it names what has to be true before the verb is worth running again.
 *
 * Setup no longer prints this: it offers to run the ask instead
 * (`suggest_skill.js`), and carries its own empty-history note.
 *
 * @ref LLP 0198#empty-cache [implements]: no rows reframes the list, and the reason is stated
 * @param {{
 *   stdout: { write(chunk: string): unknown },
 *   footer: 'ask' | 'no-launch',
 *   hasRows?: boolean,
 * }} args
 */
export function writeSuggestedPrompts({ stdout, footer, hasRows }) {
  if (hasRows === false) {
    stdout.write('\nNothing recorded yet: HypAware captures from your next session onward.\n')
    stdout.write('Once you have some history, this is worth asking your AI client:\n')
  } else {
    stdout.write('\nWorth asking your AI client about this data:\n')
  }
  for (const p of SUGGESTED_PROMPTS) {
    stdout.write(`  ${p.label}\n`)
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
 * @param {'ask' | 'no-launch'} footer
 * @param {boolean | undefined} hasRows
 * @returns {string}
 */
function promptListFooter(footer, hasRows) {
  switch (footer) {
    case 'no-launch':
      // The reader just ran `hyp ask` and nothing started, so a bare "run
      // `hyp ask`" would point at the screen they are looking at. The
      // sentence names the condition instead, and the verb only as what
      // to run once it holds.
      return 'Nothing was started. Once an attached client can be started here (see `hyp status`), run `hyp ask` again: it gathers the evidence first.'
    default:
      return hasRows === false
        ? 'Run `hyp ask` then, to start your client on it.'
        : 'Run `hyp ask` to start your client on it.'
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
 * @ref LLP 0198#first-ask [implements]: the explicit command owns the gather and the launch
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
        // @ref LLP 0198#empty-cache [implements]: an empty cache suppresses the launch, not just the printed question
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
          writeSuggestedPrompts({ stdout, footer: 'no-launch' })
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
        // The gather runs to completion, every file on disk, before the
        // client is spawned. No evidence means no launch: a client started
        // on the bare question would answer it the cold way, which is the
        // failure this ask exists to remove, so the run reports and stops.
        // @ref LLP 0398#run-directory [implements]: the client starts inside the evidence, never before it and never without it
        /** @type {string | undefined} */
        let cwd
        if (chosen.prompt.id === RECOMMEND_PROMPT_ID) {
          try {
            const evidence = opts.prepareEvidence ? await opts.prepareEvidence() : undefined
            if (evidence) {
              cwd = evidence.dir
              span.setAttribute('evidence_enough', evidence.enough !== false)
            }
          } catch (err) {
            span.setAttribute('evidence_error', err instanceof Error ? err.name : 'unknown')
            opts.stderr?.write(`Could not gather the evidence: ${err instanceof Error ? err.message : 'error'}\n`)
          }
          if (!cwd) {
            span.setAttribute('status', 'skipped')
            span.setAttribute('skip_reason', 'no-evidence')
            opts.stderr?.write('Nothing was started: the question is answered from evidence HypAware gathers first, and none could be gathered. Check `hyp status`, then run `hyp ask` again.\n')
            return { launched: false, reason: /** @type {const} */ ('no-evidence') }
          }
        }
        stdout.write(`\nStarting ${chosen.launcher.label}${cwd ? ` in ${cwd}` : ''}...\n\n`)
        const result = await launchClient({
          launcher: chosen.launcher,
          prompt: chosen.prompt.prompt,
          env,
          // Every other row keeps the caller's cwd: where the client starts
          // is the boundary that made this a separate command
          // (`@ref LLP 0198#onboarding-list`).
          ...(cwd ? { cwd } : {}),
          ...(opts.spawnFn ? { spawnFn: opts.spawnFn } : {}),
        })
        if (!result.ok) {
          span.setAttribute('status', 'error')
          span.setAttribute(Attr.ERROR_KIND, 'spawn_failed')
          span.setAttribute('launched', false)
          opts.stderr?.write(`Could not start ${chosen.launcher.bin}: ${result.error ?? 'spawn failed'}\n`)
          writeSuggestedPrompts({ stdout, footer: 'no-launch' })
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
          writeSuggestedPrompts({ stdout, footer: 'no-launch' })
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
 * Which client answers, when that is genuinely ambiguous. There is one
 * question (LLP 0398 #one-question), so there is nothing to pick among
 * and no screen for it: `hyp ask` goes straight from the gather to the
 * launch. A machine with two launchable clients still gets asked which,
 * framed as its own screen; cancelling that is "not now".
 *
 * @ref LLP 0398#one-question [implements]: no question menu; the only prompt left is the client pick
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
  const prompt = SUGGESTED_PROMPTS[0]
  if (launchers.length === 1) return { prompt, launcher: launchers[0] }
  /** @type {string | number} */
  let client
  try {
    client = await ask({
      // The only screen: there is no question menu ahead of it, so the
      // title names the job rather than pointing back at one.
      box: true,
      title: 'Which client should recommend a skill?',
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
