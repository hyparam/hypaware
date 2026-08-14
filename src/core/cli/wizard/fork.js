// @ts-check

/**
 * @import { CollectStatusOptions, HypAwareStatusReport } from '../../../../src/core/daemon/types.js'
 * @import { ConfiguredMenuOption } from '../../../../src/core/cli/types.js'
 * @import { EvaluateReturningGateOptions, ReturningGateAction, ReturningGateResult, RunWizardForkOptions, WizardForkChoice } from '../../../../src/core/cli/wizard/types.js'
 */

import process from 'node:process'
import readline from 'node:readline/promises'

import { Attr, getLogger, withSpan } from '../../observability/index.js'
import { collectHypAwareStatus } from '../../daemon/status.js'
import { select } from '../tui/index.js'
import { isPromptBackError, isPromptCancelledError } from '../tui/runtime.js'
import { shouldUseTui } from '../tui-router.js'
import { useColor } from '../stdio.js'

const FORK_TITLE = 'How do you want to collect agent logs?'

const FORK_INTRO =
  'HypAware records the sessions, logs, and telemetry from your AI agents (Claude, Codex) into one queryable history.'

/**
 * The wizard's top-level pathway fork.
 *
 * Collect locally or collect shared, with quit as the safe default on a
 * bare enter or a cancelled prompt - the wizard never reconfigures by
 * accident. Every machine reaches this prompt, enrolled or not
 * (LLP 0182): a managed machine's Reconfigure comes through here too,
 * carrying its org rows in as a locked set.
 *
 * @ref LLP 0129#fork [implements]: the wizard's first question is the
 *   pathway fork (local vs shared collection); quit is the safe default
 *   on a bare enter.
 *
 * @param {RunWizardForkOptions} opts
 * @returns {Promise<WizardForkChoice>}
 */
export async function runWizardFork(opts) {
  const log = getLogger('wizard')
  // @ref LLP 0211#explain-first [implements]: the fork is the wizard's
  //   first screen, and its question only makes sense once the user
  //   knows what HypAware does, so one intro line precedes it.
  opts.stdout.write(`${FORK_INTRO}\n\n`)
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
 * Shared leads: it is the pathway that pays off across machines and
 * harnesses, not just for teams, and a menu that lists it second reads
 * as the advanced option. (An explicit "recommended" tag is held back
 * while shared collection is in beta; the ordering and summaries do
 * the guiding.) Each real row carries a one-line summary because the
 * labels alone cannot both guide the choice and disclose its cost:
 * the shared row's summary states the value and the sign-in it will
 * ask for, the local row's states the boundary and that the choice is
 * revisitable. Quit stays bare.
 *
 * @ref LLP 0211#collect-labels [implements]: shared first, with row
 *   summaries carrying the guidance and the sign-in disclosure.
 *
 * @returns {ConfiguredMenuOption[]}
 */
export function buildForkOptions() {
  return [
    {
      value: 'team',
      label: 'Collect shared agent logs',
      summary: 'One history that follows you across machines and harnesses, and can be shared with your team. You will be asked to sign in.',
    },
    {
      value: 'local',
      label: 'Collect agent logs locally',
      summary: 'Everything stays on this machine. You can switch to shared later by re-running hyp init.',
    },
    { value: 'quit', label: 'Quit' },
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
        ...(opts.allowBack ? { allowBack: true } : {}),
        stdin: opts.stdin ?? process.stdin,
        stdout: /** @type {any} */ (opts.stdout),
        env: opts.env,
      })
      return /** @type {WizardForkChoice} */ (String(choice))
    } catch (err) {
      // Reachable only under `allowBack`: escape returns to the screen
      // before the fork (the returning gate) instead of quitting.
      if (isPromptBackError(err)) return 'back'
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
  const choice = await legacyMenuPrompt(opts, options, FORK_TITLE, opts.allowBack === true)
  return /** @type {WizardForkChoice} */ (choice)
}

/**
 * The returning-install gate (LLP 0011), amended per LLP 0129
 * `#returning-gate` and again per LLP 0182.
 *
 * A missing or invalid config is the first-run path, not the gate: the
 * caller falls straight through to `runWizardFork` (no pathway preset).
 * `managed` is still reported truthfully on that path, so a machine with
 * a central layer keeps its org rows locked (see the derivation below).
 * Once a valid config exists, every machine gets the same `Reconfigure`,
 * which re-enters the wizard at the fork exactly as a first run does.
 * `managed` (the merged config carries a central layer, LLP 0031) is
 * still reported, because the caller locks the org's rows off it - but
 * it no longer changes what the menu offers. Quit stays the default on a
 * bare enter (LLP 0011's never-reconfigure-by-accident rule, untouched).
 *
 * This phase reads only the existing `hyp status` summary and its
 * central-layer check (`collectHypAwareStatus`); it has no dependency on
 * the picker-descriptor plumbing other wizard phases build on.
 *
 * @ref LLP 0182#one-reconfigure [implements]: one Reconfigure for every
 *   returning machine; `managed` survives as the locked-set input, not
 *   as a menu branch.
 *
 * @param {EvaluateReturningGateOptions} opts
 * @returns {Promise<ReturningGateResult>}
 */
export async function evaluateReturningGate(opts) {
  const log = getLogger('wizard')
  const collectStatus = opts.collectStatus ?? collectHypAwareStatus
  const report = await collectStatus(/** @type {CollectStatusOptions} */ ({ env: opts.env, runtime: opts.runtime }))

  // Read `managed` before the first-run early return: a central layer on
  // disk is a property of the machine (LLP 0031), not of whether the
  // merged config currently validates. A central layer that stops merging
  // cleanly (a server-side config change, client/server schema drift)
  // still owns its rows, and the caller reads `managed` to decide whether
  // to compute the locked set at all. Reporting `false` here left the
  // org's rows editable, so picking one composed it into the local layer.
  // @ref LLP 0129#join-before-picker [implements]: central rows lock whenever a central layer exists, invalid merge included
  const managed = !!(report.layered && report.layered.hasCentral)

  if (!report.configExists || !report.configValid) {
    log.info('wizard.returning_gate', { [Attr.COMPONENT]: 'wizard', action: 'first-run', managed })
    return { action: 'first-run', managed, report }
  }

  renderConfigSummary({ report, locked: managed, stdout: opts.stdout, env: opts.env })
  const options = buildReturningGateOptions()
  const action = await promptReturningGateChoice(opts, options)
  log.info('wizard.returning_gate', { [Attr.COMPONENT]: 'wizard', action, managed })
  return { action, managed, report }
}

/**
 * The returning gate's menu, in display order. One `Reconfigure` for
 * every returning machine, managed or solo: an enrolled user who re-runs
 * `hyp init` is usually there for the same reasons a solo user is, and a
 * second entry that differed only in what it silently skipped taught
 * nobody anything. What a managed machine cannot edit is shown where it
 * is true - the picker dims the org's rows - rather than by removing the
 * menu row that leads there.
 *
 * Bare labels, no per-row summaries. This is a returning user on a
 * working install: three self-describing verbs, each of which shows its
 * own detail on the next screen (the picker dims the org-locked rows;
 * status prints itself). A gloss under each row tripled the menu's
 * height to restate the label, and the screen above it is the part
 * worth reading.
 *
 * @ref LLP 0182#one-reconfigure [implements]: the gate's menu no longer
 *   branches on `managed`
 *
 * @returns {ConfiguredMenuOption[]}
 */
export function buildReturningGateOptions() {
  return [
    { value: 'reconfigure', label: 'Reconfigure' },
    { value: 'status', label: 'See full status' },
    { value: 'quit', label: 'Quit' },
  ]
}

/**
 * @param {EvaluateReturningGateOptions} opts
 * @param {ConfiguredMenuOption[]} options
 * @returns {Promise<ReturningGateAction>}
 */
async function promptReturningGateChoice(opts, options) {
  if (shouldUseTui({ stdin: opts.stdin, stdout: opts.stdout, env: opts.env })) {
    try {
      // No title: `renderConfigSummary` already printed the gate's one
      // headline just above, and the TUI's cursor + hint line make a
      // second "what would you like to do?" restatement noise. The
      // readline fallback below still asks the question, because a
      // numbered list with no prompt reads as output, not a choice.
      const choice = await select({
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
  return legacyReturningGatePrompt(opts, options)
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
 * Compact, friendly one-screen summary of an existing install, rendered
 * by the returning gate before its menu. The full diagnostic surface
 * stays in `hyp status`; this is just enough to recognise the setup
 * before deciding whether to reconfigure. Moved here from
 * `commands/init.js`'s retired configured-entry gate; defensive against
 * partial reports because gate tests drive it with minimal fixtures.
 *
 * The headline is the gate's only statement of where you stand, and it
 * carries the prompt's bold weight because the menu below it renders
 * without a title of its own: "set up" here plus "already configured" on
 * the menu were two lines saying one thing.
 *
 * @param {{ report: HypAwareStatusReport, locked: boolean, stdout: RunWizardForkOptions['stdout'], env?: NodeJS.ProcessEnv }} args
 */
export function renderConfigSummary({ report, locked, stdout, env }) {
  const title = 'HypAware is already configured.'
  stdout.write(`${useColor(stdout, env) ? `\x1b[1m${title}\x1b[0m` : title}\n\n`)
  stdout.write(`  Collecting:  ${summariseCollecting(report)}\n`)
  stdout.write(`  Daemon:      ${summariseDaemon(report.daemon)}\n`)
  stdout.write(
    `  Cache:       ${formatBytesShort(report.cache?.totalBytes ?? 0)} · ${report.retention?.days ?? '?'}-day retention\n`
  )
  stdout.write('\n')
}

/**
 * What's being collected, in human terms: configured AI clients first
 * (Claude, Codex, OpenClaw), falling back to raw source names (OTEL,
 * proxies). On a managed machine each client carries its reach - synced
 * to the org, or collected but kept on this machine - since that split
 * (not the sink list) is what a returning user actually needs to
 * recognise; a solo host has no split and renders the plain list.
 *
 * @ref LLP 0188#never-silent [implements]: the gate summary marks each
 *   client synced vs local only, so an opted-out client on an enrolled
 *   machine is never silent
 *
 * @param {HypAwareStatusReport} report
 * @returns {string}
 */
function summariseCollecting(report) {
  const clients = (report.clients ?? []).filter((c) => c.configured)
  if (clients.length > 0) {
    const sync = report.clientSync
    return clients
      .map((c) => {
        const label = FRIENDLY_CLIENT_LABELS[c.name] ?? c.name.charAt(0).toUpperCase() + c.name.slice(1)
        if (sync?.localOnly.includes(c.name)) return `${label} (local only)`
        if (sync?.syncing.includes(c.name)) return `${label} (synced)`
        return label
      })
      .join(', ')
  }
  const sources = (report.sources ?? []).map((s) => s.name)
  if (sources.length > 0) return sources.join(', ')
  return 'nothing yet'
}

/**
 * One-word daemon state for the summary; `hyp status` carries the detail.
 *
 * @param {HypAwareStatusReport['daemon'] | undefined} daemon
 * @returns {string}
 */
function summariseDaemon(daemon) {
  if (daemon?.running) return 'running'
  if (daemon?.installed) return 'installed, not running'
  return 'not installed'
}

/**
 * Short human byte count for the cache line (e.g. `65 MB`). Rounds to
 * whole MB/KB so the summary stays glanceable.
 *
 * @param {number} bytes
 * @returns {string}
 */
function formatBytesShort(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${Math.round(bytes)} B`
}

const FRIENDLY_CLIENT_LABELS = /** @type {Record<string, string>} */ ({
  claude: 'Claude',
  codex: 'Codex',
  openclaw: 'OpenClaw',
})

/**
 * Shared numbered-menu readline prompt behind both `legacyForkPrompt` and
 * `legacyReturningGatePrompt`: prints the title and each option (with its
 * summary indented beneath, when the option carries one), reads one
 * line, and resolves to `quit` on an empty, unparseable, or out-of-range
 * answer so a non-TTY caller never reconfigures by accident. With
 * `allowBack`, a `b` answer resolves to `back` (the readline form of the
 * TUI's escape, LLP 0191); any other stray answer still quits.
 *
 * @param {{ stdin?: NodeJS.ReadableStream, stdout: RunWizardForkOptions['stdout'] }} opts
 * @param {ConfiguredMenuOption[]} options
 * @param {string} title
 * @param {boolean} [allowBack]
 * @returns {Promise<string>}
 */
async function legacyMenuPrompt(opts, options, title, allowBack = false) {
  const input = /** @type {NodeJS.ReadableStream} */ (opts.stdin ?? process.stdin)
  const output = /** @type {NodeJS.WritableStream} */ (/** @type {any} */ (opts.stdout))
  const defaultIdx = Math.max(0, options.findIndex((o) => o.value === 'quit'))
  const rl = readline.createInterface({ input, output, terminal: false })
  try {
    output.write(`${title}\n`)
    options.forEach((opt, i) => {
      output.write(`  ${i + 1}) ${opt.label}\n`)
      if (opt.summary) output.write(`     ${opt.summary}\n`)
    })
    const answer = await rl.question(
      `Choose [1-${options.length}, default ${defaultIdx + 1}${allowBack ? ', b back' : ''}]: `
    )
    const trimmed = answer.trim()
    if (allowBack && trimmed.toLowerCase() === 'b') return 'back'
    if (trimmed === '') return options[defaultIdx]?.value ?? 'quit'
    const n = Number.parseInt(trimmed, 10)
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].value
    return 'quit'
  } finally {
    rl.close()
  }
}
