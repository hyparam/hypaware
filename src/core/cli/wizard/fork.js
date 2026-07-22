// @ts-check

/**
 * @import { CollectStatusOptions } from '../../../../src/core/daemon/types.js'
 * @import { ConfiguredMenuOption } from '../../../../src/core/cli/types.js'
 * @import { EvaluateReturningGateOptions, ReturningGateAction, ReturningGateResult, RunWizardForkOptions, WizardForkChoice } from '../../../../src/core/cli/wizard/types.js'
 */

import process from 'node:process'
import readline from 'node:readline/promises'

import { Attr, getLogger, withSpan } from '../../observability/index.js'
import { collectHypAwareStatus } from '../../daemon/status.js'
import { select } from '../tui/index.js'
import { isPromptCancelledError } from '../tui/runtime.js'
import { shouldUseTui } from '../tui-router.js'

const FORK_TITLE = 'Join a team, or set up HypAware locally?'

/**
 * The wizard's top-level pathway fork.
 *
 * "Join a team" or "Local install and configuration", with quit as the
 * safe default on a bare enter or a cancelled prompt - the wizard never
 * reconfigures by accident. An enrolled machine never reaches this
 * prompt: `evaluateReturningGate` below short-circuits straight to the
 * scoped re-entry instead of presenting the fork again.
 *
 * @ref LLP 0129#fork [implements]: the wizard's first question is the
 *   pathway fork ("Join a team" / "Local install and configuration");
 *   quit is the safe default on a bare enter.
 *
 * @param {RunWizardForkOptions} opts
 * @returns {Promise<WizardForkChoice>}
 */
export async function runWizardFork(opts) {
  const log = getLogger('wizard')
  const options = buildForkOptions()
  const choice = await withSpan(
    'wizard.fork',
    {
      [Attr.COMPONENT]: 'wizard',
      [Attr.OPERATION]: 'wizard.fork',
      status: 'ok',
    },
    () => promptForkChoice(opts, options),
    { component: 'wizard' }
  )
  log.info('wizard.fork', { [Attr.COMPONENT]: 'wizard', pathway: choice })
  return choice
}

/**
 * The fork's three rows, in display order. A plain data builder (no I/O)
 * so both the TUI and legacy prompts, and tests, share one source of
 * truth for the choices and their default.
 *
 * @returns {ConfiguredMenuOption[]}
 */
export function buildForkOptions() {
  return [
    {
      value: 'team',
      label: 'Join a team',
      summary: 'Enroll with your org and pick up its shared config.',
    },
    {
      value: 'local',
      label: 'Local install and configuration',
      summary: 'Set up HypAware on just this machine.',
    },
    {
      value: 'quit',
      label: 'Quit',
      summary: 'Leave everything untouched.',
    },
  ]
}

/**
 * @param {RunWizardForkOptions} opts
 * @param {ConfiguredMenuOption[]} options
 * @returns {Promise<WizardForkChoice>}
 */
async function promptForkChoice(opts, options) {
  if (shouldUseTui({ stdin: opts.stdin, stdout: opts.stdout, env: opts.env })) {
    try {
      const choice = await select({
        title: FORK_TITLE,
        options,
        default: 'quit',
        clearOnResolve: true,
        stdin: opts.stdin ?? process.stdin,
        stdout: /** @type {any} */ (opts.stdout),
        env: opts.env,
      })
      return /** @type {WizardForkChoice} */ (String(choice))
    } catch (err) {
      if (isPromptCancelledError(err)) return 'quit'
      throw err
    }
  }
  return legacyForkPrompt(opts, options)
}

/**
 * Numbered readline fallback for a non-TTY stdin or `HYP_NO_TUI=1`,
 * mirroring the returning gate's own legacy prompt shape below. An
 * empty answer takes the default (quit); an out-of-range answer also
 * quits rather than guessing.
 *
 * @param {RunWizardForkOptions} opts
 * @param {ConfiguredMenuOption[]} options
 * @returns {Promise<WizardForkChoice>}
 */
export async function legacyForkPrompt(opts, options) {
  const choice = await legacyMenuPrompt(opts, options, FORK_TITLE)
  return /** @type {WizardForkChoice} */ (choice)
}

/**
 * The returning-install gate (LLP 0011), amended per LLP 0129
 * `#returning-gate`.
 *
 * A missing or invalid config is the first-run path, not the gate: the
 * caller falls straight through to `runWizardFork` (no pathway preset).
 * Once a valid config exists, a **managed** machine (the merged config
 * carries a central layer, LLP 0031) offers a scoped "adjust what this
 * machine collects" entry instead of dropping Reconfigure outright - no
 * fork, `runInitWizard` presets `pathway` to `'scoped'`. A **solo**
 * machine keeps `Reconfigure`, which re-enters the wizard at the fork
 * exactly as a first run does. Quit stays the default on a bare enter
 * either way (LLP 0011's never-reconfigure-by-accident rule, untouched).
 *
 * This phase reads only the existing `hyp status` summary and its
 * central-layer check (`collectHypAwareStatus`); it has no dependency on
 * the picker-descriptor plumbing other wizard phases build on.
 *
 * @ref LLP 0129#returning-gate [implements]: a managed machine keeps a
 *   scoped re-entry instead of losing Reconfigure; a solo machine's
 *   Reconfigure re-enters the full fork.
 *
 * @param {EvaluateReturningGateOptions} opts
 * @returns {Promise<ReturningGateResult>}
 */
export async function evaluateReturningGate(opts) {
  const log = getLogger('wizard')
  const collectStatus = opts.collectStatus ?? collectHypAwareStatus
  const report = await collectStatus(/** @type {CollectStatusOptions} */ ({ env: opts.env, runtime: opts.runtime }))

  if (!report.configExists || !report.configValid) {
    log.info('wizard.returning_gate', { [Attr.COMPONENT]: 'wizard', action: 'first-run', managed: false })
    return { action: 'first-run', managed: false, report }
  }

  const managed = !!(report.layered && report.layered.hasCentral)
  const options = buildReturningGateOptions(managed)
  const action = await promptReturningGateChoice(opts, options, managed)
  log.info('wizard.returning_gate', { [Attr.COMPONENT]: 'wizard', action, managed })
  return { action, managed, report }
}

/**
 * The returning gate's menu, in display order. Managed machines never
 * see a bare `Reconfigure` (a local re-run would be a no-op against a
 * centrally-locked config); they get the scoped entry instead. Solo
 * machines keep `Reconfigure` as the full re-entry point.
 *
 * @param {boolean} managed
 * @returns {ConfiguredMenuOption[]}
 */
export function buildReturningGateOptions(managed) {
  /** @type {ConfiguredMenuOption[]} */
  const options = managed
    ? [
      {
        value: 'scoped-reconfigure',
        label: 'Adjust what this machine collects',
        summary: "Open the picker with your org's rows locked; local additions stay editable.",
      },
    ]
    : [
      {
        value: 'reconfigure',
        label: 'Reconfigure',
        summary: 'Re-run the setup wizard from the top, including joining a team.',
      },
    ]
  options.push({ value: 'status', label: 'See full status', summary: 'Print the detailed status report.' })
  options.push({ value: 'quit', label: 'Quit', summary: 'Leave the current setup untouched.' })
  return options
}

/**
 * @param {EvaluateReturningGateOptions} opts
 * @param {ConfiguredMenuOption[]} options
 * @param {boolean} managed
 * @returns {Promise<ReturningGateAction>}
 */
async function promptReturningGateChoice(opts, options, managed) {
  const title = managed
    ? 'This machine is managed by your fleet. What would you like to do?'
    : 'What would you like to do?'
  if (shouldUseTui({ stdin: opts.stdin, stdout: opts.stdout, env: opts.env })) {
    try {
      const choice = await select({
        title,
        options,
        default: 'quit',
        clearOnResolve: true,
        stdin: opts.stdin ?? process.stdin,
        stdout: /** @type {any} */ (opts.stdout),
        env: opts.env,
      })
      return /** @type {ReturningGateAction} */ (String(choice))
    } catch (err) {
      if (isPromptCancelledError(err)) return 'quit'
      throw err
    }
  }
  return legacyReturningGatePrompt(opts, options, title)
}

/**
 * Numbered readline fallback for the returning gate, mirroring
 * `legacyForkPrompt`'s shape and default-to-quit behavior.
 *
 * @param {EvaluateReturningGateOptions} opts
 * @param {ConfiguredMenuOption[]} options
 * @param {string} [title]
 * @returns {Promise<ReturningGateAction>}
 */
export async function legacyReturningGatePrompt(opts, options, title = 'What would you like to do?') {
  const choice = await legacyMenuPrompt(opts, options, title)
  return /** @type {ReturningGateAction} */ (choice)
}

/**
 * Shared numbered-menu readline prompt behind both `legacyForkPrompt` and
 * `legacyReturningGatePrompt`: prints the title and each option, reads one
 * line, and resolves to `quit` on an empty, unparseable, or out-of-range
 * answer so a non-TTY caller never reconfigures by accident.
 *
 * @param {{ stdin?: NodeJS.ReadableStream, stdout: RunWizardForkOptions['stdout'] }} opts
 * @param {ConfiguredMenuOption[]} options
 * @param {string} title
 * @returns {Promise<string>}
 */
async function legacyMenuPrompt(opts, options, title) {
  const input = /** @type {NodeJS.ReadableStream} */ (opts.stdin ?? process.stdin)
  const output = /** @type {NodeJS.WritableStream} */ (/** @type {any} */ (opts.stdout))
  const defaultIdx = Math.max(0, options.findIndex((o) => o.value === 'quit'))
  const rl = readline.createInterface({ input, output, terminal: false })
  try {
    output.write(`${title}\n`)
    options.forEach((opt, i) => output.write(`  ${i + 1}) ${opt.label}\n`))
    const answer = await rl.question(`Choose [1-${options.length}, default ${defaultIdx + 1}]: `)
    const trimmed = answer.trim()
    if (trimmed === '') return options[defaultIdx]?.value ?? 'quit'
    const n = Number.parseInt(trimmed, 10)
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].value
    return 'quit'
  } finally {
    rl.close()
  }
}
