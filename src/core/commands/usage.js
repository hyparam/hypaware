// @ts-check

import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Attr, markSpanStatus, withSpan } from '../observability/index.js'
import { buildWalkthroughClientDescriptorMap } from '../cli/walkthrough.js'
import { parseCoreCommandArgv } from '../cli/command_args.js'
import { isTty } from '../cli/stdio.js'
import { hypHomeFromEnv, usageRoot } from '../runtime/paths.js'
import { launchClient, resolveLaunchers } from '../cli/wizard/first_ask.js'
import { askableClients, attachHint, pickLauncher } from './ask.js'

/**
 * @import { CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 * @import { RunWizardFirstAskOptions } from '../../../src/core/cli/wizard/types.js'
 */

/**
 * Where the usage-by-task instructions and scripts ship: inside the package,
 * beside the shared skill tree but not in it. Nothing here is registered as a
 * client skill, so nothing is installed into `~/.claude/skills` or Codex's
 * tree; the command hands the client a path into the package instead.
 */
export const USAGE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'hypaware-core', 'usage')

/** The instruction file each form of the command starts the client on. */
export const USAGE_INSTRUCTIONS = Object.freeze({
  chat: path.join(USAGE_DIR, 'hypaware-usage-by-task', 'SKILL.md'),
  page: path.join(USAGE_DIR, 'hypaware-usage-by-task-page', 'SKILL.md'),
})

/**
 * The prompt a client is started on.
 *
 * The instruction files are written as skills, and the client is told to
 * follow one by path because it has no skill of that name to load. The
 * dialog sentence is for clients with no pick-one tool: the instructions
 * name Claude Code's, and a client without it would otherwise skip the
 * questions or stall on a tool it does not have.
 *
 * @param {{ page: boolean, workDir: string, instructions?: string }} args
 * @returns {string}
 */
export function usagePrompt({ page, workDir, instructions = '' }) {
  const file = page ? USAGE_INSTRUCTIONS.page : USAGE_INSTRUCTIONS.chat
  const what = page
    ? 'Make the HTML page of my AI usage by task from this machine\'s HypAware recordings.'
    : 'Show me what my AI usage went into, by task, from this machine\'s HypAware recordings.'
  return `${what} Follow the instructions at ${JSON.stringify(file)} as you would an installed skill. ` +
    'They ship with the hyp CLI and are not installed as a skill, so read them from that path, ' +
    'and run the scripts from the scripts directory beside each instruction file. ' +
    'Where they call for a pick-one dialog and you have no such tool, list the choices in chat and ask which one. ' +
    `Your work directory for this run is ${JSON.stringify(workDir)}: it was emptied for this run, and the next run empties it again. ` +
    'Use the default window unless the instructions below specify one.' +
    (instructions ? `\n\nAdditional instructions from the user:\n${instructions}` : '')
}

/**
 * `hyp usage [--page] [instructions]`
 *
 * Starts a recorded client on the usage-by-task instructions the package
 * carries: the chart and its three questions in the chat, or with `--page`
 * the HTML page of the same view. Same launch as `hyp ask "question"`
 * (recorded clients only, a pick when more than one could run it), with the
 * client reading its instructions out of the package rather than from an
 * installed skill.
 *
 * The client starts in `<HYP_HOME>/usage`, not the caller's directory: the
 * view is about the person's history rather than any one repository, and a
 * fixed HypAware-owned folder is what lets setup run this as its last step.
 *
 * @ref LLP 0398#run-directory [constrained-by]: a session setup starts must not be rooted where setup was run
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @param {{
 *   select?: RunWizardFirstAskOptions['select'],
 *   pickDeadlineMs?: number,
 *   resolveLaunchers?: typeof resolveLaunchers,
 *   launchClient?: typeof launchClient,
 *   collectStatus?: NonNullable<Parameters<typeof askableClients>[1]>['collectStatus'],
 * }} [deps]
 * @returns {Promise<number>}
 */
export async function runUsage(argv, ctx, deps = {}) {
  const parsed = parseCoreCommandArgv('usage', argv, ctx)
  if (!parsed.ok) return parsed.code
  const page = parsed.params.page === true
  return withSpan('usage.launch', {
    [Attr.COMPONENT]: 'usage',
    [Attr.OPERATION]: 'usage.launch',
    status: 'error',
    page,
  }, async (span) => {
    const clients = await askableClients(ctx, deps.collectStatus ? { collectStatus: deps.collectStatus } : {})
    const descriptors = await buildWalkthroughClientDescriptorMap()
    const launchers = await (deps.resolveLaunchers ?? resolveLaunchers)({ clients, descriptors, env: ctx.env })
    span.setAttribute('launcher_count', launchers.length)
    if (launchers.length === 0) {
      span.setAttribute('error_kind', 'no-launcher')
      ctx.stderr.write('hyp usage: no recorded client can be started.\n')
      ctx.stderr.write(`  ${attachHint(descriptors)}\n`)
      return 1
    }
    const canPrompt = isTty(ctx.stdout) && isTty(ctx.stdin) && ctx.env.HYP_NO_TUI !== '1'
    const launcher = canPrompt ? await pickLauncher(launchers, ctx, deps) : launchers[0]
    if (!launcher) {
      markSpanStatus(span, 'cancelled')
      ctx.stdout.write('Nothing started.\n')
      return 0
    }
    span.setAttribute('client', launcher.client)
    ctx.stdout.write(`\nStarting ${launcher.label} on your usage by task...\n\n`)
    const cwd = usageRoot(hypHomeFromEnv(ctx.env, ctx.env.HOME || os.homedir()))
    await fsp.mkdir(cwd, { recursive: true, mode: 0o700 })
    // One folder, emptied before every run and left alone after it, the way
    // `hyp ask` rewrites its evidence folder. A run that found an earlier
    // run's labels reused its groupings and repeated its answers, which may
    // no longer be true, so the emptying is done here rather than asked of
    // the client. What a run wrote stays readable until the next one. It
    // sits inside the launch directory so the client writes to it as it
    // would to its own cwd.
    const workDir = path.join(cwd, 'latest')
    await fsp.rm(workDir, { recursive: true, force: true })
    await fsp.mkdir(workDir, { mode: 0o700 })
    const prompt = usagePrompt({ page, workDir, instructions: String(parsed.params.instructions ?? '') })
    const result = await (deps.launchClient ?? launchClient)({ launcher, prompt, cwd, env: ctx.env })
    if (!result.ok) {
      span.setAttribute('error_kind', 'client-launch')
      ctx.stderr.write(`hyp usage: could not start ${launcher.bin}: ${result.error ?? 'spawn failed'}\n`)
      return 1
    }
    markSpanStatus(span, 'ok')
    return 0
  })
}
