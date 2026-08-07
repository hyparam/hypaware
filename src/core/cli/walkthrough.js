// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline/promises'

import { Attr, getLogger, withSpan } from '../observability/index.js'
import { defaultConfigPath, loadConfigFile, prepareLocalConfigWrite } from '../config/schema.js'
import { resolveCentralLayerPath } from '../config/apply.js'
import { DEFAULT_GATEWAY_ENDPOINT, configuredGatewayEndpoint } from '../config/gateway_endpoint.js'
import { probeClientAttachFromDescriptor } from '../daemon/status.js'
import { readObservabilityEnv } from '../observability/env.js'
import { discoverBundledPlugins } from '../runtime/bundled.js'
import { materializeClientAssets } from '../runtime/client_assets.js'
import { buildPluginCatalog } from '../plugin_catalog.js'
import { detectPickerSources } from './detect.js'
import { multiselect, select } from './tui/index.js'
import { PromptBackRequestedError, PromptCancelledError, isPromptCancelledError } from './tui/runtime.js'
import { shouldUseTui } from './tui-router.js'

/**
 * Exit code returned when the user cancels the picker walkthrough
 * (escape / ctrl+c at any TUI prompt). 130 matches the POSIX
 * convention for SIGINT and keeps the dispatcher from reporting the
 * cancel as an unhandled exception.
 */
export const WALKTHROUGH_CANCEL_EXIT_CODE = 130

/**
 * @import { Interface } from 'node:readline/promises'
 * @import { AiGatewayCapability, CapabilityRegistry, HypAwareV2Config, PluginConfigInstance, PluginName, SinkConfigInstance } from '../../../hypaware-plugin-kernel-types.js'
 * @import { ClientDescriptor, PickerDescriptor } from '../../../src/core/types.js'
 * @import { DaemonInstallOptions } from '../../../src/core/daemon/types.js'
 */

/**
 * @import {
 *   AsyncBackfillConsentPrompt,
 *   AsyncConfirmSelectPrompt,
 *   AsyncPickPrompt,
 *   PickerBackfillRunner,
 *   PickerSource,
 *   PickerExport,
 *   PickerPicks,
 *   PickerFinaleActions,
 *   PickerWalkthroughResult,
 *   RunPickerWalkthroughOptions,
 *   FinaleSummary,
 *   WalkthroughOptions,
 * } from '../../../src/core/cli/types.js'
 */

// Onboarding never asks for a retention window; these are the pathway
// defaults the wizard applies instead. A team (or managed) install keeps
// the 90-day window because the org server holds the durable copy; a
// local-only install keeps 120 days because the local cache is the only
// copy of history. `hyp init --retention-days <n>` remains the override.
// @ref LLP 0137#pathway-defaults [implements]: no retention question; 90-day team / 120-day local defaults
export const DEFAULT_RETENTION_DAYS = 90
export const LOCAL_INSTALL_RETENTION_DAYS = 120

/**
 * Resolve the HYP_HOME root the same way the kernel does (matches
 * `readObservabilityEnv`). Defaults to `$HOME/.hyp` when not set.
 *
 * @param {NodeJS.ProcessEnv} env
 */
export function resolveHypHome(env) {
  if (env.HYP_HOME) return env.HYP_HOME
  const home = env.HOME ?? ''
  return path.join(home, '.hyp')
}

/**
 * How many extra times a question that opted in may re-ask after an
 * answer that names no row. One: enough to catch a typo, small enough
 * that a pipe of garbage costs a fixed two lines of output and then
 * moves on. Questions that do not opt in never re-ask at all.
 *
 * @ref LLP 0190#sync-gate [implements]: the malformed-answer re-ask is capped and gated
 */
const MAX_MALFORMED_REASKS = 1

/**
 * Ceiling on the answer lines held for a still-unasked prompt. An
 * interface asks at most `1 + MAX_MALFORMED_REASKS` questions and is
 * closed straight after, so anything past a handful is unreadable
 * backlog: a pipe that floods stdin (`yes |`) must not grow an array
 * for as long as the prompt is on screen.
 */
const MAX_QUEUED_LINES = 4

/**
 * Read answer lines off a readline interface without losing one and
 * without ever waiting on a stream that can no longer answer.
 *
 * `rl.question()` cannot do either job here. It registers its `line`
 * listener only when it is called, so a second answer line arriving in
 * the same chunk as the first ("y\n3\n" from a pipe) is emitted and
 * dropped before a re-ask can ask: readline emits both synchronously
 * and the next `question()` is a microtask away. And at EOF its promise
 * is left permanently unsettled - the interface closes, `question`
 * neither resolves nor rejects - which is a hang, or a silent
 * "unsettled top-level await" exit. Queueing every line from
 * construction fixes the first; resolving the pending ask as `null` on
 * `close` fixes the second.
 *
 * `close` alone is not enough for the second job. Readline registers its
 * `end` listener when the interface is built, so an interface built over
 * a stream that has ALREADY ended never sees an `end` and never emits
 * `close` - the second prompt asked on a spent stdin would wait forever
 * even though the first resolved. The stream's own `readableEnded` is
 * the answer readline can no longer give, so it seeds `closed` here.
 *
 * @param {Interface} rl
 * @param {NodeJS.ReadableStream} input
 * @param {NodeJS.WritableStream} output
 * @returns {(prompt: string) => Promise<string | null>} writes one prompt and takes the next line, `null` once the stream is spent
 */
function queuedLineAsker(rl, input, output) {
  /** @type {string[]} */
  const queued = []
  /** @type {((line: string | null) => void) | null} */
  let waiting = null
  let closed = /** @type {{ readableEnded?: boolean }} */ (input).readableEnded === true
  const take = () => {
    const resolve = waiting
    waiting = null
    return resolve
  }
  rl.on('line', (line) => {
    const resolve = take()
    if (resolve) resolve(line)
    else if (queued.length < MAX_QUEUED_LINES) queued.push(line)
  })
  rl.on('close', () => {
    closed = true
    const resolve = take()
    if (resolve) resolve(null)
  })
  return function askLine(prompt) {
    // Byte-identical to what `rl.question` writes: with `terminal: false`
    // readline puts the query straight on the output stream.
    output.write(prompt)
    if (queued.length > 0) return Promise.resolve(/** @type {string} */ (queued.shift()))
    if (closed) return Promise.resolve(null)
    return new Promise((resolve) => {
      waiting = resolve
    })
  }
}

/**
 * Build the default interactive prompt. Uses Node's `readline` against
 * the provided stdin/stdout. Accepts comma-separated indices (1-based)
 * or "all" for every option; a question with `enterKeepsChecked` also
 * shows each row's checked state, keeps it on a bare enter, takes
 * "none" as the word for a deliberate empty selection, and re-asks once
 * on an answer that names no row before keeping the checked state. A
 * question without the opt-in keeps its historical line and answers,
 * and a closed stdin cancels it rather than answering it.
 *
 * @param {Pick<WalkthroughOptions, 'stdin' | 'stdout'>} opts
 * @returns {AsyncPickPrompt}
 */
function legacyNumberedPromptFactory(opts) {
  const input = /** @type {NodeJS.ReadableStream} */ (opts.stdin ?? process.stdin)
  const output = /** @type {NodeJS.WritableStream} */ (opts.stdout)
  return async function ask(question) {
    const rl = readline.createInterface({ input, output, terminal: false })
    const askLine = queuedLineAsker(rl, input, output)
    try {
      // The plain-text form of the TUI's dim breadcrumb line: same text,
      // same position (above the title), no styling.
      // @ref LLP 0135#progress [implements]: the non-TUI fallback prints the position too
      if (question.progress) output.write(`\n${question.progress}`)
      output.write(`\n${question.title}\n`)
      question.options.forEach((opt, idx) => {
        // Locked (disabled) rows are shown for context but never selectable
        // by number - they are already in the central layer and are filtered
        // out of the returned picks downstream regardless.
        const box = question.enterKeepsChecked ? (opt.checked ? '[x] ' : '[ ] ') : ''
        output.write(`  ${idx + 1}) ${box}${opt.label}${opt.disabled ? ' (locked)' : ''}\n`)
        if (opt.summary && opt.summary !== opt.label) {
          output.write(`     ${opt.summary}\n`)
        }
      })
      // The opted-in question advertises "none": there, an empty
      // selection is a real answer (enter keeps the checked rows
      // instead), so the word for "yes, nothing" belongs on screen and
      // not only in a re-ask the user may never trigger. Every other
      // question keeps its historical line, byte for byte.
      // @ref LLP 0190#sync-gate [implements]: the opted-in prompt names the explicit empty selection
      const promptLine = question.enterKeepsChecked
        ? question.allowBack
          ? 'select (e.g. 1,3, "all", "none", enter keeps [x], or b to go back): '
          : 'select (e.g. 1,3, "all", "none", or enter to keep [x]): '
        : question.allowBack
          ? 'select (e.g. 1,3, "all", or b to go back): '
          : 'select (e.g. 1,3 or "all"): '
      // The default a question falls back to when there is no answer to
      // read: the rendered checked set where enter keeps it, else the
      // historical empty selection.
      const defaulted = () =>
        question.enterKeepsChecked ? question.options.filter((o) => o.checked).map((o) => o.value) : []
      // Only a question that opted in re-asks, and then only once. Every
      // other caller (the pick menus, `runPickerWalkthrough`) asks exactly
      // as many times as it did before: once.
      const attempts = 1 + (question.enterKeepsChecked ? MAX_MALFORMED_REASKS : 0)
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const answer = await askLine(promptLine)
        // Closed or exhausted stdin. The question can no longer be
        // answered either way, so it never waits on it - but "no answer"
        // is not the same as "answered nothing". Where enter keeps the
        // checked rows, keeping them is the stated default and a dropped
        // stdin lands on it. Everywhere else the historical default is
        // the EMPTY selection, and returning it would read a dropped
        // terminal as "the user picked nothing" and carry the wizard on
        // into the daemon install with no sources. That is a cancel, the
        // same one the TUI raises on ctrl+c, handled by the same callers.
        // @ref LLP 0190#sync-gate [implements]: EOF takes the stated default only where enter has one; elsewhere it cancels
        if (answer === null) {
          if (question.enterKeepsChecked) return defaulted()
          throw new PromptCancelledError()
        }
        const trimmed = answer.trim().toLowerCase()
        // The readline form of the TUI's escape (LLP 0191): same signal,
        // same caller handling, so both paths step back identically.
        if (question.allowBack && trimmed === 'b') throw new PromptBackRequestedError()
        // A bare enter keeps the rendered checked set when the question
        // opted in, mirroring the TUI multiselect's enter (checked rows,
        // disabled included; callers filter locked rows regardless).
        // Everywhere else it stays "select none", which scripted non-TTY
        // runs of the picker rely on.
        // @ref LLP 0190#sync-gate [implements]: the numbered fallback's enter keeps the checked defaults too
        if (!trimmed) return defaulted()
        if (trimmed === 'all') return question.options.map((o) => o.value)
        // The explicit empty selection. Every question already read it as
        // one (it names no row), naming it just gives the re-ask below a
        // word that means "yes, nothing".
        if (trimmed === 'none') return []
        const indices = trimmed
          .split(',')
          .map((s) => Number.parseInt(s.trim(), 10))
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= question.options.length)
        // A partially valid answer still wins outright.
        if (indices.length > 0) return indices.map((n) => question.options[n - 1].value)
        // An answer that names no row ("y", "0", "9" out of range) reads
        // as "select nothing", which in the sync menu silently opts every
        // candidate out. Say so and give the typo one correction; on the
        // last attempt say what is being kept instead, because a spent
        // budget that printed nothing would be the silence this whole
        // path exists to remove.
        // @ref LLP 0190#sync-gate [implements]: a malformed answer re-asks once, and the last one reports the fallback
        if (attempt < attempts) {
          output.write(`nothing matched '${answer.trim()}' - enter numbers like 1,3, "all", or "none"\n`)
        } else if (question.enterKeepsChecked) {
          const kept = defaulted()
          output.write(
            kept.length > 0
              ? `nothing matched '${answer.trim()}' - keeping the checked rows: ${kept.join(', ')}\n`
              : `nothing matched '${answer.trim()}' - nothing was checked, so nothing is selected\n`
          )
        }
      }
      // The budget is spent and every answer named a row that is not
      // there, so the question falls back rather than asking again: no
      // input can hold a scripted run at this prompt. It falls back to
      // the SAME default a bare enter takes, not to the empty selection,
      // which in the sync menu would opt every candidate out - issue
      // #634 one answer later, and the one thing this loop exists to
      // prevent. Questions without the opt-in still fall back to the
      // historical empty selection, because that is their enter too.
      // @ref LLP 0190#sync-gate [implements]: the spent budget lands on the stated default, not on an empty selection
      return defaulted()
    } finally {
      rl.close()
    }
  }
}

/**
 * Build the interactive "overwrite existing config?" confirm. Defaults
 * to **no** (a bare Enter keeps the existing config), so a stray
 * keystroke never destroys a working install. On yes the caller backs
 * the file up before replacing it.
 *
 * The question says the file is *rewritten from the picks*, not merely
 * "overwritten": the write is a whole-file regeneration, and a user whose
 * mental model is "I am adjusting checkboxes" needs to know that before
 * the y/N. It also names what survives the regeneration, so the answer is
 * a decision about the picks rather than a bet on how much is lost.
 *
 * @param {{ stdin?: NodeJS.ReadableStream, stdout: { write(chunk: string): unknown } }} opts
 * @returns {(targetPath: string) => Promise<boolean>}
 * @ref LLP 0183#say-so [implements]: the overwrite confirm states that the config is regenerated and what is carried over
 */
export function defaultOverwriteConfirmFactory(opts) {
  const input = /** @type {NodeJS.ReadableStream} */ (opts.stdin ?? process.stdin)
  const output = /** @type {NodeJS.WritableStream} */ (opts.stdout)
  return async function (targetPath) {
    const rl = readline.createInterface({ input, output, terminal: false })
    try {
      const answer = await rl.question(
        `The config at ${targetPath} will be rewritten from your picks. ` +
        'Your retention window, export destinations, hand-edited settings, and any ' +
        'plugins the picker does not manage are carried over; a backup is kept. ' +
        'Continue? [y/N]: '
      )
      return /^y(es)?$/i.test(answer.trim())
    } finally {
      rl.close()
    }
  }
}

/**
 * Render each pick category through the new TUI multiselect prompt.
 *
 * @param {Pick<WalkthroughOptions, 'stdin' | 'stdout' | 'env'>} opts
 * @returns {AsyncPickPrompt}
 */
function tuiPromptFactory(opts) {
  return async function ask(question) {
    const result = await multiselect({
      title: question.title,
      ...(question.progress ? { progress: question.progress } : {}),
      ...(question.allowBack ? { allowBack: true } : {}),
      options: question.options.map((o) => ({
        value: o.value,
        label: o.label,
        ...(o.summary && o.summary !== o.label ? { summary: o.summary } : {}),
        ...(o.checked ? { checked: true } : {}),
        ...(o.disabled ? { disabled: true } : {}),
      })),
      ...(question.bounds ? { bounds: question.bounds } : {}),
      clearOnResolve: true,
      stdin: opts.stdin ?? process.stdin,
      stdout: /** @type {NodeJS.WritableStream} */ (/** @type {unknown} */ (opts.stdout)),
      env: opts.env,
    })
    return /** @type {string[]} */ (result)
  }
}

/**
 * Route between the TUI and legacy prompts. Tests and CI keep getting
 * the legacy numbered list, but only real TTYs without `HYP_NO_TUI=1` see
 * the new interactive multiselect.
 *
 * @param {Pick<WalkthroughOptions, 'stdin' | 'stdout' | 'env'>} opts
 * @returns {AsyncPickPrompt}
 */
export function defaultPromptFactory(opts) {
  if (shouldUseTui(opts)) return tuiPromptFactory(opts)
  return legacyNumberedPromptFactory(opts)
}

/**
 * Build the wizard's defaults-gate prompt (LLP 0190): a single-select
 * between accepting a lane's stated defaults and opening its full menu.
 * Routes to the TUI select on a real TTY, else a numbered readline
 * fallback where a bare enter takes the question's default.
 *
 * @param {Pick<WalkthroughOptions, 'stdin' | 'stdout' | 'env'>} opts
 * @returns {AsyncConfirmSelectPrompt}
 */
export function defaultConfirmSelectPromptFactory(opts) {
  if (shouldUseTui(opts)) return tuiConfirmSelectPromptFactory(opts)
  return legacyConfirmSelectPromptFactory(opts)
}

/**
 * @param {Pick<WalkthroughOptions, 'stdin' | 'stdout' | 'env'>} opts
 * @returns {AsyncConfirmSelectPrompt}
 */
function tuiConfirmSelectPromptFactory(opts) {
  return async function ask(question) {
    const choice = await select({
      title: question.title,
      ...(question.progress ? { progress: question.progress } : {}),
      ...(question.items ? { items: question.items } : {}),
      ...(question.allowBack ? { allowBack: true } : {}),
      options: question.options.map((o) => ({
        value: o.value,
        label: o.label,
        ...(o.summary && o.summary !== o.label ? { summary: o.summary } : {}),
      })),
      ...(question.default !== undefined ? { default: question.default } : {}),
      clearOnResolve: true,
      stdin: opts.stdin ?? process.stdin,
      stdout: /** @type {NodeJS.WritableStream} */ (/** @type {unknown} */ (opts.stdout)),
      env: opts.env,
    })
    return String(choice)
  }
}

/**
 * @param {Pick<WalkthroughOptions, 'stdin' | 'stdout'>} opts
 * @returns {AsyncConfirmSelectPrompt}
 */
function legacyConfirmSelectPromptFactory(opts) {
  const input = /** @type {NodeJS.ReadableStream} */ (opts.stdin ?? process.stdin)
  const output = /** @type {NodeJS.WritableStream} */ (opts.stdout)
  return async function ask(question) {
    const rl = readline.createInterface({ input, output, terminal: false })
    try {
      // @ref LLP 0135#progress [implements]: the non-TUI fallback prints the position too
      if (question.progress) output.write(`\n${question.progress}`)
      output.write(`\n${question.title}\n`)
      for (const item of question.items ?? []) output.write(`${item}\n`)
      question.options.forEach((opt, idx) => {
        output.write(`  ${idx + 1}) ${opt.label}\n`)
        if (opt.summary && opt.summary !== opt.label) {
          output.write(`     ${opt.summary}\n`)
        }
      })
      const fallback = question.default ?? question.options[0].value
      const fallbackIdx = question.options.findIndex((o) => o.value === fallback)
      const answer = await rl.question(
        question.allowBack ? `select [${fallbackIdx + 1}, b back]: ` : `select [${fallbackIdx + 1}]: `
      )
      // The readline form of the TUI's escape (LLP 0191).
      if (question.allowBack && answer.trim().toLowerCase() === 'b') throw new PromptBackRequestedError()
      const n = Number.parseInt(answer.trim(), 10)
      if (Number.isInteger(n) && n >= 1 && n <= question.options.length) {
        return question.options[n - 1].value
      }
      return fallback
    } finally {
      rl.close()
    }
  }
}

/**
 * Build the interactive backfill-consent prompt. Routes to the TUI
 * arrow-navigable yes/no select on a real TTY, else a legacy readline
 * yes/no. Both default to yes, so a bare enter opts in: the design
 * is "default backfill to enabled, but let the user choose no".
 *
 * @param {Pick<WalkthroughOptions, 'stdin' | 'stdout' | 'env'>} opts
 * @returns {AsyncBackfillConsentPrompt}
 */
// @ref LLP 0174#prompt [implements]: exported so the interactive attach
// flow can ask the identical backfill question instead of re-implementing it
export function defaultBackfillConsentPromptFactory(opts) {
  if (shouldUseTui(opts)) return tuiBackfillConsentPromptFactory(opts)
  return legacyBackfillConsentPromptFactory(opts)
}

/**
 * Render the backfill consent as a `select` so it matches the look and
 * feel of the source picker (arrow keys + pointer) rather than a plain
 * y/n confirm. Cursor defaults to "Yes" so a bare enter opts in.
 *
 * @param {Pick<WalkthroughOptions, 'stdin' | 'stdout' | 'env'>} opts
 * @returns {AsyncBackfillConsentPrompt}
 */
function tuiBackfillConsentPromptFactory(opts) {
  return async function ({ providers, retentionDays }) {
    const choice = await select({
      title: backfillConsentTitle(providers, retentionDays),
      options: [
        { value: 'yes', label: 'Yes - import it now', summary: 'Reads local transcripts into the query cache.' },
        { value: 'no', label: 'No - skip for now', summary: 'You can import later with hyp backfill.' },
      ],
      default: 'yes',
      clearOnResolve: true,
      stdin: opts.stdin ?? process.stdin,
      stdout: /** @type {NodeJS.WritableStream} */ (/** @type {unknown} */ (opts.stdout)),
      env: opts.env,
    })
    return choice === 'yes'
  }
}

/**
 * @param {Pick<WalkthroughOptions, 'stdin' | 'stdout'>} opts
 * @returns {AsyncBackfillConsentPrompt}
 */
function legacyBackfillConsentPromptFactory(opts) {
  const input = /** @type {NodeJS.ReadableStream} */ (opts.stdin ?? process.stdin)
  const output = /** @type {NodeJS.WritableStream} */ (opts.stdout)
  return async function ({ providers, retentionDays }) {
    const rl = readline.createInterface({ input, output, terminal: false })
    try {
      const answer = await rl.question(`${backfillConsentTitle(providers, retentionDays)} [Y/n]: `)
      const trimmed = answer.trim().toLowerCase()
      // Default yes: only an explicit no opts out.
      return !(trimmed === 'n' || trimmed === 'no')
    } finally {
      rl.close()
    }
  }
}

/**
 * @param {string[]} providers
 * @param {number} retentionDays
 * @returns {string}
 */
export function backfillConsentTitle(providers, retentionDays) {
  return `Import local ${providers.join(', ')} history now (last ${retentionDays} days)?`
}

/**
 * Presentation order for the manifest-sourced picker rows. The row DATA
 * (label, summary, detection, and composition rules) lives in each
 * plugin's `contributes.picker` manifest now (`@ref LLP 0130#picker-block`);
 * core no longer owns that list. This array fixes only the ORDER the rows
 * are shown in, a UX policy core still keeps: first-class client
 * integrations first, then raw/advanced API-proxy modes, then infra
 * receivers. A descriptor whose id is absent here sorts after all known
 * ids (preserving catalog order among them), so a newly-contributed picker
 * row still appears rather than being dropped.
 *
 * `raw-anthropic` / `raw-openai` are listed here but no longer render:
 * their manifest marks them `hidden` (LLP 0200). Keep the ids in this
 * array and their descriptors in the catalog - see
 * {@link visiblePickerDescriptors} for what still depends on them.
 *
 * @type {string[]}
 */
const PICKER_DISPLAY_ORDER = ['claude', 'codex', 'raw-anthropic', 'raw-openai', 'otel']

/**
 * Phase 5 export options.
 *
 * @type {{ value: PickerExport, label: string, summary: string }[]}
 */
const PICKER_EXPORTS = [
  {
    value: 'keep-local',
    label: 'keep local query cache only',
    summary: 'Stores recent rows locally for hyp query; nothing is exported elsewhere.',
  },
  {
    value: 'local-parquet',
    label: 'export local Parquet files',
    summary: 'Writes scheduled Parquet exports under HYP_HOME/exports for external tools.',
  },
  {
    value: 'configure-later',
    label: 'configure later',
    summary: 'Writes capture config now and leaves export sinks for a later config edit.',
  },
]


/**
 * Drive the Phase 5 first-run picker walkthrough.
 *
 * The picker offers a
 * fixed set of user-facing source labels (Claude Code / Codex / raw
 * Anthropic / raw OpenAI / OTEL) and a fixed set of export labels
 * (`keep-local` / `local-parquet` / `configure-later`). These are
 * translated into a v2 config via {@link composePickerConfig}.
 *
 * When `opts.finale` is provided, the walkthrough also runs the
 * post-write actions described by the bead:
 *   - daemon install (dry-run or real)
 *   - attach for each picked client
 *   - skill install for each picked client
 *   - daemon restart (skipped in dry-run)
 *
 * Spans: `walkthrough.start`, `walkthrough.pick` (logs),
 * `walkthrough.write_config`, `daemon.install`, `client.attach`,
 * `skills.install`, `walkthrough.finish`.
 *
 * Superseded as `hyp init`'s entry point by `runInitWizard`
 * (LLP 0135 #orchestration), which drives the same pick/write/finale
 * machinery through the wizard's pick phase. Kept as the direct
 * programmatic surface existing tests and smokes exercise.
 *
 * @param {RunPickerWalkthroughOptions} opts
 * @returns {Promise<PickerWalkthroughResult>}
 * @ref LLP 0011#interactive-walkthrough [implements]: the pre-wizard walkthrough shape; hyp init now fronts it with runInitWizard
 */
export async function runPickerWalkthrough(opts) {
  const { capabilities, stdout, env } = opts
  const log = getLogger('walkthrough')

  // Autodetect installed client tools so the picker can pre-check them.
  // Interactive only: when `picks` are supplied (`--yes` / `--dry-run` /
  // presets) the selection is explicit and must stay deterministic, so
  // detection is skipped entirely. Best-effort: a detector failure
  // leaves the set empty rather than blocking onboarding.
  // @ref LLP 0011#autodetect-vs-default [implements]: detection only seeds the initial checkbox; never forces a source on
  const interactive = !opts.picks
  /** @type {Set<PickerSource>} */
  let detected = new Set()
  if (interactive) {
    const detect = opts.detect ?? defaultPickerDetect
    try {
      detected = await detect({ env })
    } catch {
      detected = new Set()
    }
  }

  // The picker table is manifest-sourced now: each plugin declares its
  // rows in `contributes.picker` (`@ref LLP 0130#picker-block`), replacing
  // the retired hardcoded PICKER_SOURCES list. Both the interactive prompt
  // options and `composePickerConfig`'s fold read from these descriptors.
  const pickerDescriptors = await loadPickerDescriptors()
  const descriptorList = [...pickerDescriptors.values()]

  await withSpan(
    'walkthrough.start',
    {
      [Attr.COMPONENT]: 'walkthrough',
      [Attr.OPERATION]: 'walkthrough.start',
      sources_available: descriptorList.length,
      exports_available: PICKER_EXPORTS.length,
      sources_detected: detected.size,
      detected_sources: [...detected].join(','),
      status: 'ok',
    },
    async () => {},
    { component: 'walkthrough' }
  )

  /** @type {PickerPicks} */
  let picks
  // Provenance of the export choice, for telemetry. Export is no longer
  // asked interactively (local-parquet is the out-of-the-box default),
  // so the origin is `user` only when an explicit `--export` flag was
  // threaded in on the pre-baked path; otherwise the pick was defaulted.
  let exportOrigin = 'default'
  if (opts.picks) {
    picks = opts.picks
    exportOrigin = opts.exportOrigin ?? 'default'
  } else {
    const ask = opts.prompt ?? defaultPromptFactory(opts)

    stdout.write('Welcome to HypAware - the local logs+telemetry collector.\n\n')

    try {
      const sourceRaw = await ask({
        pickType: 'sources',
        title: 'What do you want to collect? (space to toggle, enter to confirm)',
        // Hidden rows are absent from the menu but still pickable via
        // `--source` (which takes the `opts.picks` path above and never
        // reaches this prompt). They are never detected, so nothing is
        // silently unchecked by leaving them out here.
        options: visiblePickerDescriptors(descriptorList).map((d) => ({
          value: d.id,
          label: detected.has(/** @type {PickerSource} */ (d.id)) ? `${d.label} · detected` : d.label,
          ...(d.summary ? { summary: d.summary } : {}),
          ...(detected.has(/** @type {PickerSource} */ (d.id)) ? { checked: true } : {}),
        })),
      })
      const sources = /** @type {PickerSource[]} */ (
        sourceRaw.filter((v) => descriptorList.some((d) => d.id === v))
      )

      // Export destination is not asked interactively. A local query
      // cache is always kept; on top of it we default to scheduled local
      // Parquet exports so `npx hypaware` produces durable files out of
      // the box. Other destinations (keep-local only, configure-later,
      // S3, …) remain available via `hyp init --export <choice>` and by
      // editing the written config later.
      const exportChoice = /** @type {PickerExport} */ ('local-parquet')

      // Retention is not asked either (LLP 0137): this legacy surface has
      // no pathway fork, so it takes the flat default. The wizard applies
      // the pathway-aware defaults; `--retention-days` overrides via picks.
      picks = { sources, exportChoice, retentionDays: DEFAULT_RETENTION_DAYS }
    } catch (err) {
      if (isPromptCancelledError(err)) {
        return await cancelledResult(opts)
      }
      throw err
    }
  }

  for (const value of picks.sources) {
    log.info('walkthrough.pick', {
      [Attr.COMPONENT]: 'walkthrough',
      pick_type: 'sources',
      pick_value: value,
    })
  }
  log.info('walkthrough.pick', {
    [Attr.COMPONENT]: 'walkthrough',
    pick_type: 'exports',
    pick_value: picks.exportChoice,
    pick_origin: exportOrigin,
  })

  const hypHome = resolveHypHome(env)
  const config = composePickerConfig({
    sources: picks.sources,
    descriptors: pickerDescriptors,
    exportChoice: picks.exportChoice,
    retentionDays: picks.retentionDays,
    hypHome,
  })

  const obsEnv = readObservabilityEnv(env)
  const configPath = env.HYP_CONFIG
    ? path.resolve(env.HYP_CONFIG)
    : defaultConfigPath(obsEnv.hypHome)

  // Guard against clobbering an existing local config (the non-destructive
  // half of #111). Interactive runs prompt for confirmation;
  // non-interactive runs require `--force`. Either path backs up the
  // existing file before replacing it.
  // @ref LLP 0031#local-layer-writers [implements]: init overwrite safety on the walkthrough write path
  const overwriteConfirm = interactive
    ? (opts.confirmOverwrite ?? defaultOverwriteConfirmFactory({ stdin: opts.stdin, stdout }))
    : undefined
  const guard = await prepareLocalConfigWrite({
    targetPath: configPath,
    force: opts.force,
    ...(overwriteConfirm ? { confirmOverwrite: overwriteConfirm } : {}),
  })
  if (!guard.proceed) {
    opts.stderr.write(`hyp init: ${guard.message}\n`)
    return overwriteAbortedResult({ opts, configPath, config, picks })
  }
  if (guard.backupPath) {
    stdout.write(`Backed up existing config to ${guard.backupPath}\n`)
  }

  await withSpan(
    'walkthrough.write_config',
    {
      [Attr.COMPONENT]: 'walkthrough',
      [Attr.OPERATION]: 'walkthrough.write_config',
      config_path: configPath,
      plugin_count: config.plugins?.length ?? 0,
      ...(guard.backupPath ? { config_backed_up: true } : {}),
      status: 'ok',
    },
    async () => {
      await fs.mkdir(path.dirname(configPath), { recursive: true })
      await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8')
    },
    { component: 'walkthrough' }
  )

  // @ref LLP 0180#decision [implements]: client-ness is read from the picked
  // rows' manifest client contributions, not a name list copied per call site
  const clientsPicked = derivePickedClients(
    picks.sources,
    pickerDescriptors,
    await buildWalkthroughClientDescriptorMap()
  )

  /** @type {FinaleSummary | undefined} */
  let finaleSummary
  if (opts.finale) {
    finaleSummary = await runPickerFinale({
      finale: opts.finale,
      clientsPicked,
      capabilities,
      sources: opts.sources,
      skills: opts.skills,
      agents: opts.agents,
      config,
      configPath,
      env,
      stdout,
      stderr: opts.stderr,
      retentionDays: picks.retentionDays,
      // Interactive mode is the absence of pre-baked picks: only then do
      // we prompt for backfill consent. `--yes` / `--dry-run` carry picks
      // and backfill runs automatically.
      interactive: !opts.picks,
      ...(opts.stdin ? { stdin: opts.stdin } : {}),
      ...(opts.backfill ? { backfill: opts.backfill } : {}),
      ...(opts.backfillConsentPrompt ? { backfillConsentPrompt: opts.backfillConsentPrompt } : {}),
    })
  }

  const cancelled = finaleSummary?.cancelled === true
  const exitCode = cancelled ? WALKTHROUGH_CANCEL_EXIT_CODE : 0

  await withSpan(
    'walkthrough.finish',
    {
      [Attr.COMPONENT]: 'walkthrough',
      [Attr.OPERATION]: 'walkthrough.finish',
      sources_picked: picks.sources.length,
      export_picked: picks.exportChoice,
      clients_picked: clientsPicked.length,
      retention_days: picks.retentionDays,
      config_path: configPath,
      ...(cancelled ? { exit_code: WALKTHROUGH_CANCEL_EXIT_CODE } : {}),
      status: cancelled ? 'cancelled' : 'ok',
    },
    async () => {},
    { component: 'walkthrough' }
  )

  if (cancelled) writeCancelledNotice(opts.stderr)

  writeWalkthroughRunSummary({ stdout, configPath, finaleSummary })

  return {
    exitCode,
    configPath,
    config,
    sourcesPicked: picks.sources,
    exportPicked: picks.exportChoice,
    clientsPicked,
    retentionDays: picks.retentionDays,
    ...(finaleSummary ? { finale: finaleSummary } : {}),
  }
}

/**
 * Print the closing run summary: the written config path plus one line
 * per finale action that ran (daemon target, attaches, skills/agents
 * counts). Shared by `runPickerWalkthrough` and the wizard orchestrator so
 * both entry points end a run identically.
 *
 * No "next: hyp query sql ..." hint: it named the `logs` dataset, which
 * only exists when `@hypaware/otel` is configured, so most installs ended
 * on a command that failed. The wizard now runs real queries instead
 * (LLP 0135 #first-look).
 *
 * @param {{
 *   stdout: NodeJS.WritableStream | { write(chunk: string): unknown },
 *   configPath: string,
 *   finaleSummary?: FinaleSummary | undefined,
 * }} args
 */
export function writeWalkthroughRunSummary({ stdout, configPath, finaleSummary }) {
  stdout.write('\n')
  stdout.write(`✓ Wrote ${configPath}\n`)
  if (finaleSummary?.daemonInstall && !finaleSummary.daemonInstall.skipped) {
    const tag = finaleSummary.daemonInstall.dryRun ? '(dry-run) ' : ''
    if (finaleSummary.daemonInstall.targetPath) {
      stdout.write(`${tag}daemon target: ${finaleSummary.daemonInstall.targetPath}\n`)
    }
    const plan = finaleSummary.daemonInstall.plan
    const planBin = plan && typeof plan === 'object' ? /** @type {Record<string, unknown>} */ (plan).binPath : undefined
    if (typeof planBin === 'string' && planBin.length > 0) {
      stdout.write(`${tag}daemon bin: ${planBin}\n`)
    }
  }
  for (const a of finaleSummary?.attach ?? []) {
    if (a.skipped) {
      stdout.write(`attach: ${a.client} already attached\n`)
      continue
    }
    // An adapterless client contribution never entered the attach lane, so
    // there is nothing to report ok or failed about (LLP 0180).
    if (a.noAdapter) continue
    const tag = a.dryRun ? '(dry-run) ' : ''
    stdout.write(`${tag}attach: ${a.client} ${a.ok ? 'ok' : 'failed'}\n`)
  }
  if (finaleSummary?.skillsInstalled && finaleSummary.skillsInstalled.length > 0) {
    const tag = finaleSummary.skillsInstalled[0].dryRun ? '(dry-run) ' : ''
    stdout.write(`${tag}skills: ${finaleSummary.skillsInstalled.length} copied\n`)
  }
  if (finaleSummary?.agentsInstalled && finaleSummary.agentsInstalled.length > 0) {
    const tag = finaleSummary.agentsInstalled[0].dryRun ? '(dry-run) ' : ''
    stdout.write(`${tag}agents: ${finaleSummary.agentsInstalled.length} copied\n`)
  }
}

/**
 * Compose a v2 config from Phase 5 picker selections.
 *
 * The source half of composition is a fold over each picked descriptor's
 * own `compose` contribution (`@ref LLP 0130#picker-block`), sourced from
 * the plugin manifests rather than a hardcoded core switch:
 *   - `@hypaware/ai-gateway` is included once when any picked descriptor
 *     sets `requires_gateway`.
 *   - Its `upstreams` are the union of every picked descriptor's requested
 *     `gateway_upstream`(s), deduped by `name` in descriptor iteration
 *     order (so Anthropic precedes OpenAI precedes the ChatGPT
 *     subscription upstream, matching the retired switch's fixed order).
 *   - Each picked descriptor's `plugin` (the adapter plugin instance, e.g.
 *     `@hypaware/claude`, `@hypaware/otel`) is included, followed by any
 *     `plugins[]` it composes beside it (the Claude Desktop row composes
 *     `@hypaware/claude-account` beside its own adapter, whose manifest
 *     requires the credential capability only that plugin provides). A
 *     gateway-requiring plugin lands after the export sink plugins; a
 *     gateway-independent one before them, preserving the retired switch's
 *     plugin order.
 *
 * The export half is unchanged (it is the sink-choice layer, not
 * plugin-picker territory): `@hypaware/local-fs` + `@hypaware/format-parquet`
 * plus a `local` sink writing parquet under `<HYP_HOME>/exports` are
 * included when `exportChoice === 'local-parquet'`.
 *
 * `existing` is the local config this composition replaces, supplied only
 * on a reconfigure. With it the result is the composition folded *over*
 * what is already on disk rather than a fresh file: see
 * {@link carryForwardExistingConfig} for the split between what the
 * composer manages and what it merely passes through.
 *
 * @param {{
 *   sources: PickerSource[],
 *   descriptors: Map<string, PickerDescriptor>,
 *   exportChoice: PickerExport,
 *   retentionDays: number,
 *   hypHome: string,
 *   existing?: HypAwareV2Config | undefined,
 * }} args
 * @returns {HypAwareV2Config}
 * @ref LLP 0011#no-architectural-names [implements]: user picks what/where; HypAware derives the explicit plugin set, no role labels
 * @ref LLP 0130#picker-block [implements]: composition folds each picked descriptor's manifest `compose` data instead of a hardcoded switch
 */
export function composePickerConfig(args) {
  const picked = /** @type {Set<string>} */ (new Set(args.sources))

  let requiresGateway = false
  /** @type {{ name: string, base_url: string, path_prefix: string, provider?: string }[]} */
  const upstreams = []
  // Gateway-independent adapter plugins (e.g. `@hypaware/otel`) land before
  // the export sink plugins; gateway-requiring ones (`@hypaware/claude`,
  // `@hypaware/codex`) land after, matching the retired switch's order.
  /** @type {PluginConfigInstance[]} */
  const preExportPlugins = []
  /** @type {PluginConfigInstance[]} */
  const postExportPlugins = []

  for (const descriptor of args.descriptors.values()) {
    if (!picked.has(descriptor.id)) continue
    const compose = descriptor.compose
    if (!compose) continue
    if (compose.requires_gateway) requiresGateway = true
    for (const up of requestedUpstreams(compose)) {
      if (!upstreams.some((existing) => existing.name === up.name)) upstreams.push({ ...up })
    }
    // A row may contribute one plugin (`plugin`) or several (`plugins`), all
    // under the same gateway-relative placement. Several is what a row needs
    // when its adapter cannot activate alone: composing only half of a
    // dependency set writes a config whose own `configure_command` fails to
    // resolve, which is a dead end rather than an error (issue: the Desktop
    // row composed nothing and its catch-up command failed identically
    // forever).
    // @ref LLP 0139#compose-the-whole-dependency-set [implements]: a picker row composes every plugin its configure_command needs, not just its own adapter
    for (const plugin of contributedPlugins(compose)) {
      if (compose.requires_gateway) postExportPlugins.push(plugin)
      else preExportPlugins.push(plugin)
    }
  }

  /** @type {PluginConfigInstance[]} */
  const plugins = []

  if (requiresGateway) {
    // No `listen`: a wizard-written address is indistinguishable from a
    // user-stated one, and an explicit listen is exactly what forfeits the
    // default-only EADDRINUSE fallback (LLP 0114 #explicit-listen-fails-loudly).
    // @ref LLP 0114#init-writes-no-listen [implements]: the picker leaves listen unset so the default install keeps its fallback
    plugins.push({
      name: GATEWAY_PLUGIN,
      config: { upstreams },
    })
  }

  plugins.push(...preExportPlugins)

  /** @type {Record<string, SinkConfigInstance>} */
  const sinks = {}
  if (args.exportChoice === 'local-parquet') {
    plugins.push({ name: LOCAL_FS_PLUGIN })
    plugins.push({ name: PARQUET_PLUGIN })
    sinks['local'] = {
      writer: PARQUET_PLUGIN,
      destination: LOCAL_FS_PLUGIN,
      config: {
        dir: path.join(args.hypHome, 'exports'),
        schedule: '*/5 * * * *',
      },
    }
  }

  plugins.push(...postExportPlugins)

  /** @type {HypAwareV2Config} */
  const config = {
    version: 2,
    plugins,
    query: {
      cache: {
        retention: { default_days: args.retentionDays },
      },
    },
  }
  if (Object.keys(sinks).length > 0) config.sinks = sinks
  if (!args.existing) return config
  return carryForwardExistingConfig(config, args.existing, args.descriptors)
}

/** The gateway plugin every `requires_gateway` row composes behind. */
const GATEWAY_PLUGIN = /** @type {PluginName} */ ('@hypaware/ai-gateway')

/** The two plugins the `local-parquet` export half composes. */
const LOCAL_FS_PLUGIN = /** @type {PluginName} */ ('@hypaware/local-fs')
const PARQUET_PLUGIN = /** @type {PluginName} */ ('@hypaware/format-parquet')

/**
 * The upstreams one descriptor's `compose` contribution requests, as a
 * list whether the manifest wrote one object or an array.
 *
 * @param {NonNullable<PickerDescriptor['compose']>} compose
 * @returns {{ name: string, base_url: string, path_prefix: string, provider?: string }[]}
 */
function requestedUpstreams(compose) {
  if (compose.gateway_upstream === undefined) return []
  return Array.isArray(compose.gateway_upstream) ? compose.gateway_upstream : [compose.gateway_upstream]
}

/**
 * The plugin instances one descriptor's `compose` contribution adds: its
 * own adapter (`plugin`) plus anything it composes beside it (`plugins`).
 *
 * @param {NonNullable<PickerDescriptor['compose']>} compose
 * @returns {PluginConfigInstance[]}
 */
function contributedPlugins(compose) {
  return [
    ...(compose.plugin ? [compose.plugin] : []),
    ...(Array.isArray(compose.plugins) ? compose.plugins : []),
  ]
}

/**
 * Every plugin name composition is entitled to add or remove: the gateway,
 * the export half's two plugins, and every plugin any picker row in the
 * catalog contributes. A plugin outside this set is in the config because
 * someone put it there by hand (`@hypaware/gascity`, `@hypaware/central`),
 * so a reconfigure carries it forward untouched.
 *
 * @param {Map<string, PickerDescriptor>} descriptors
 * @returns {Set<string>}
 */
function composerManagedPlugins(descriptors) {
  const managed = new Set([GATEWAY_PLUGIN, LOCAL_FS_PLUGIN, PARQUET_PLUGIN])
  for (const descriptor of descriptors.values()) {
    if (!descriptor.compose) continue
    for (const plugin of contributedPlugins(descriptor.compose)) managed.add(plugin.name)
  }
  return managed
}

/**
 * Fold a fresh composition over the local config it replaces, so a
 * reconfigure edits the file instead of regenerating it.
 *
 * The split is deliberate rather than a general merge, because a general
 * merge would resurrect exactly what the user just unchecked (issue #603):
 *
 * - **Composer-managed plugins** ({@link composerManagedPlugins}) live and
 *   die by the picks. One the picks no longer compose is dropped, unless a
 *   carried-forward sink names it as its `writer`/`destination` - dropping
 *   a plugin out from under a sink the composer chose to keep would write
 *   a config that cannot activate.
 * - **Every other plugin is passed through** in its existing order. The
 *   composer never chose it, so it is not the composer's to drop.
 * - **Per-plugin config is the user's**, merged over the manifest's
 *   composed values key by key, so a hand-edited otel `listen_port`
 *   survives. The one exception is the gateway's `upstreams`: that list is
 *   derived from the picks, not a preference, so composition owns it
 *   outright and unchecking a row really removes its upstream.
 * - **Sinks** the composition names are merged the same way (a hand-edited
 *   `schedule` or `dir` wins), but only onto the same sink ({@link sameSink});
 *   sinks it does not name are passed through. A composed sink an existing
 *   sink already provides under another id is dropped rather than added
 *   beside it ({@link sinkAlreadyProvided}), and a different sink sitting on
 *   a composed id keeps the id rather than being overwritten.
 * - **Retention** is written at `query.cache.retention.default_days` and
 *   nothing else under `query` is touched.
 * - **Unknown top-level keys are passed through** untouched.
 *
 * @param {HypAwareV2Config} composed
 * @param {HypAwareV2Config} existing
 * @param {Map<string, PickerDescriptor>} descriptors
 * @returns {HypAwareV2Config}
 * @ref LLP 0183#carry-forward [implements]: a reconfigure keeps what the composer does not own; only the picked set is recomposed
 */
function carryForwardExistingConfig(composed, existing, descriptors) {
  const existingPlugins = existing.plugins ?? []
  const existingSinks = existing.sinks ?? {}
  const composedSinks = composed.sinks ?? {}

  // Sinks first: which ones survive decides which export plugins are still
  // load-bearing, which decides what may be dropped from the plugin list.
  /** @type {Record<string, SinkConfigInstance>} */
  const sinks = {}
  for (const [id, sink] of Object.entries(composedSinks)) {
    const prior = existingSinks[id]
    // Only the same sink merges: same union member, same plugins. Folding a
    // blob sink over a request sink of the same id keeps `plugin` beside
    // `writer`/`destination`, which matches neither sink shape and which
    // cross-validation rejects outright (`request_sink_invalid_keys`);
    // folding the parquet export over a jsonl one rewrites where the user's
    // data goes and in what format. Both are different sinks that happen to
    // share an id, not two versions of one sink.
    if (prior && sameSink(sink, prior)) {
      sinks[id] = mergeSink(sink, prior)
      continue
    }
    // A different sink at the id is not evicted either: replacing it would
    // silently delete a sink the composer never wrote, the same defect as
    // regenerating the file. And composition always names its export sink
    // `local`, while the config may already run the same writer to the same
    // destination under a name the user chose; adding `local` beside it
    // would export every dataset twice on two schedules. Either way the
    // sinks already on disk win.
    if (prior || sinkAlreadyProvided(sink, existingSinks)) continue
    sinks[id] = sink
  }
  /** @type {Set<string>} */
  const pinnedPlugins = new Set()
  for (const [id, sink] of Object.entries(existingSinks)) {
    if (id in sinks) continue
    sinks[id] = sink
    for (const name of sinkPluginNames(sink)) pinnedPlugins.add(name)
  }

  const managed = composerManagedPlugins(descriptors)
  const composedNames = new Set((composed.plugins ?? []).map((p) => p.name))
  const plugins = (composed.plugins ?? []).map((entry) =>
    mergePlugin(entry, existingPlugins.find((p) => p.name === entry.name))
  )
  for (const prior of existingPlugins) {
    if (composedNames.has(prior.name)) continue
    if (managed.has(prior.name) && !pinnedPlugins.has(prior.name)) continue
    plugins.push(prior)
  }

  const query = {
    ...(existing.query ?? {}),
    cache: {
      ...(existing.query?.cache ?? {}),
      retention: {
        ...(existing.query?.cache?.retention ?? {}),
        default_days: composed.query?.cache?.retention?.default_days,
      },
    },
  }

  /** @type {HypAwareV2Config} */
  const merged = { ...existing, version: 2, plugins, query: /** @type {HypAwareV2Config['query']} */ (query) }
  if (Object.keys(sinks).length > 0) merged.sinks = sinks
  else delete merged.sinks
  return merged
}

/**
 * Merge one composed plugin instance with the entry of the same name
 * already in the config: the user's keys win, except the gateway's
 * pick-derived `upstreams`.
 *
 * @param {PluginConfigInstance} composed
 * @param {PluginConfigInstance | undefined} prior
 * @returns {PluginConfigInstance}
 */
function mergePlugin(composed, prior) {
  if (!prior) return composed
  const config = { ...(composed.config ?? {}), ...(prior.config ?? {}) }
  const upstreams = composed.config?.upstreams
  if (composed.name === GATEWAY_PLUGIN && upstreams !== undefined) config.upstreams = upstreams
  const merged = { ...prior, ...composed }
  if (Object.keys(config).length > 0) merged.config = config
  // Composing a plugin is what picking its row means, so a prior
  // `enabled: false` does not carry over: the pick would otherwise write a
  // config whose row reads picked and whose plugin never activates.
  if (merged.enabled === false && composed.enabled === undefined) delete merged.enabled
  return merged
}

/**
 * The plugin names one sink entry depends on, across both sink shapes: a
 * blob sink names a `writer` and a `destination`, a request sink a single
 * `plugin`.
 *
 * @param {SinkConfigInstance} sink
 * @returns {string[]}
 */
function sinkPluginNames(sink) {
  if ('plugin' in sink) return [sink.plugin]
  return [sink.writer, sink.destination]
}

/**
 * A sink entry's identity for carry-forward: which plugins it runs, in the
 * per-shape canonical order {@link sinkPluginNames} yields (a blob sink's
 * `writer` then `destination`, a request sink's single `plugin`). Two
 * entries with the same signature do the same job, whatever id they sit
 * under.
 *
 * @param {SinkConfigInstance} sink
 * @returns {string}
 */
function sinkSignature(sink) {
  return sinkPluginNames(sink).join(',')
}

/**
 * Whether two sink entries are the same sink: the same union member of
 * `SinkConfigInstance` (blob: `writer` + `destination`; request: `plugin`)
 * running the same plugins. Entries that disagree are different sinks that
 * happen to share an id rather than two versions of one sink, so neither
 * the shape check nor the plugin check may be dropped: merging across
 * shapes writes a config cross-validation rejects, and merging a parquet
 * export over a jsonl one silently rewrites the format and destination of
 * data the composer never chose.
 *
 * @param {SinkConfigInstance} a
 * @param {SinkConfigInstance} b
 * @returns {boolean}
 */
function sameSink(a, b) {
  if (('plugin' in a) !== ('plugin' in b)) return false
  return sinkSignature(a) === sinkSignature(b)
}

/**
 * Whether the config already runs this composed sink's plugins under some
 * id. Sink ids are the user's to choose, so the composer's `local` export
 * and a hand-renamed `exports` running the same writer to the same
 * destination are one export, not two: composing both would write every
 * dataset twice, on two schedules, into the same tree.
 *
 * @param {SinkConfigInstance} composed
 * @param {Record<string, SinkConfigInstance>} existingSinks
 * @returns {boolean}
 */
function sinkAlreadyProvided(composed, existingSinks) {
  const signature = sinkSignature(composed)
  return Object.values(existingSinks).some((sink) => sinkSignature(sink) === signature)
}

/**
 * Merge one composed sink with the same sink already at that id in the
 * config: the user's `config` keys (a hand-edited `schedule`, a moved
 * `dir`) win over the composed defaults. Callers must have checked
 * {@link sameSink} first.
 *
 * @param {SinkConfigInstance} composed
 * @param {SinkConfigInstance | undefined} prior
 * @returns {SinkConfigInstance}
 */
function mergeSink(composed, prior) {
  if (!prior) return composed
  return { ...prior, ...composed, config: { ...(composed.config ?? {}), ...(prior.config ?? {}) } }
}

/**
 * The picker rows an existing local config already collects: the inverse
 * of {@link composePickerConfig}'s per-descriptor fold. A row counts as
 * configured when everything its `compose` contribution asks for is
 * already there - its contributed plugins present, the gateway present if
 * it requires one, and every upstream it requests already configured.
 *
 * This is what a reconfigure's checkboxes are seeded from. Detection
 * cannot stand in for it: detection answers "is this client installed on
 * the machine", which is neither what an undetectable row (otel, the raw
 * API rows) collects today nor what a deliberately excluded client should
 * come back as.
 *
 * Composition is lossy for a row whose whole contribution is an upstream
 * some other row also contributes (`raw-anthropic` beside `claude`): the
 * two compose to the same bytes, so such a row reads as configured
 * whenever its upstream is. Its checked state is then cosmetic - checking
 * or clearing it composes the identical config.
 *
 * An `enabled: false` plugin does not count: the row is off, whichever
 * way it was turned off.
 *
 * @param {HypAwareV2Config} config
 * @param {Map<string, PickerDescriptor>} descriptors
 * @returns {Set<string>}
 * @ref LLP 0183#seed-from-config [implements]: the reconfigure picker's checked rows are read back out of the config, not re-detected
 */
export function configuredPickerSources(config, descriptors) {
  const active = (config.plugins ?? []).filter((p) => p.enabled !== false)
  const pluginNames = new Set(active.map((p) => p.name))
  const gateway = active.find((p) => p.name === GATEWAY_PLUGIN)
  const upstreams = /** @type {{ name?: string }[]} */ (gateway?.config?.upstreams ?? [])
  const upstreamNames = new Set(upstreams.map((u) => u.name))

  /** @type {Set<string>} */
  const configured = new Set()
  for (const descriptor of descriptors.values()) {
    const compose = descriptor.compose
    if (!compose) continue
    const contributed = contributedPlugins(compose)
    const requested = requestedUpstreams(compose)
    // A row that composes nothing at all can never be read back; leaving it
    // unchecked is the conservative answer.
    if (contributed.length === 0 && requested.length === 0 && !compose.requires_gateway) continue
    if (!contributed.every((p) => pluginNames.has(p.name))) continue
    if (compose.requires_gateway && !pluginNames.has(GATEWAY_PLUGIN)) continue
    if (!requested.every((u) => upstreamNames.has(u.name))) continue
    configured.add(descriptor.id)
  }
  return configured
}

/**
 * The export choice an existing local config already expresses. The wizard
 * stopped asking about export (LLP 0137's sibling default), so on a
 * reconfigure it must read the answer back rather than re-decide it: a
 * cache-only install stays cache-only, and an install exporting somewhere
 * else keeps its own sinks instead of gaining a second, unasked-for one.
 *
 * @param {HypAwareV2Config} config
 * @returns {PickerExport}
 * @ref LLP 0183#carry-forward [implements]: export is carried forward, not re-defaulted, on a reconfigure
 */
export function configuredExportChoice(config) {
  const sinks = Object.values(config.sinks ?? {})
  const hasLocalParquet = sinks.some((sink) => {
    const names = sinkPluginNames(sink)
    return names.includes(PARQUET_PLUGIN) && names.includes(LOCAL_FS_PLUGIN)
  })
  return /** @type {PickerExport} */ (hasLocalParquet ? 'local-parquet' : 'keep-local')
}

/**
 * Resolve the plugin dependency set a single picker descriptor's `compose`
 * contribution requires, without the multi-descriptor union / upstream-merge
 * machinery {@link composePickerConfig}'s fold needs across a whole picked
 * set. This is the "same composition the picker uses (`requires_gateway`
 * and friends)" the manual-attach enable prompt reuses to list what
 * enabling a single client's adapter would add
 * (`buildAttachPluginCatalog(ctx).pickerDescriptors.get(name)` supplies the
 * descriptor).
 *
 * @param {PickerDescriptor} descriptor
 * @returns {{ requiresGateway: boolean, pluginNames: string[], entries: PluginConfigInstance[] }}
 * @ref LLP 0174#prompt [implements]: "the dependency list comes from the
 * same composition the picker uses (`requires_gateway` and friends)",
 * as a one-descriptor slice of composePickerConfig's per-descriptor fold
 * rather than a re-derivation of it.
 */
export function resolveSingleSourceEnablement(descriptor) {
  const compose = descriptor.compose
  const requiresGateway = compose?.requires_gateway === true

  /** @type {PluginConfigInstance[]} */
  const entries = [
    ...(requiresGateway ? [{ name: /** @type {PluginName} */ ('@hypaware/ai-gateway') }] : []),
    ...(compose?.plugin ? [compose.plugin] : []),
    ...(Array.isArray(compose?.plugins) ? compose.plugins : []),
  ]

  return {
    requiresGateway,
    pluginNames: entries.map((entry) => entry.name),
    entries,
  }
}

/**
 * Run the picker finale: daemon install, attach, client-asset install
 * (skills and subagents together, LLP 0138), daemon restart. Each step
 * emits its own span (`daemon.install`, `client.attach` (via the
 * adapter), `skills.install`).
 *
 * Exported for the wizard orchestrator (LLP 0135 #finale), which wraps
 * it with the team-pathway skips: `finale.skipDaemonInstall` skips only
 * the install step (the restart still runs so the just-written local
 * config takes effect), and `skipAttachClients` names picked clients the
 * join lane already attached.
 *
 * @param {{
 *   finale: PickerFinaleActions,
 *   clientsPicked: string[],
 *   capabilities: CapabilityRegistry,
 *   sources?: { stopAll?: () => Promise<void> },
 *   skills?: { list(): { name: string, clients: string[], sourceDir: string }[] },
 *   agents?: { list(): { name: string, clients: string[], sourceFile: string }[] },
 *   config: HypAwareV2Config,
 *   configPath: string,
 *   env: NodeJS.ProcessEnv,
 *   stdout: NodeJS.WritableStream | { write(chunk: string): unknown },
 *   stderr: NodeJS.WritableStream | { write(chunk: string): unknown },
 *   retentionDays: number,
 *   interactive: boolean,
 *   stdin?: NodeJS.ReadableStream,
 *   backfill?: PickerBackfillRunner,
 *   backfillConsentPrompt?: AsyncBackfillConsentPrompt,
 *   skipAttachClients?: Set<string>,
 *   progress?: string,
 * }} args
 * @returns {Promise<FinaleSummary>}
 */
export async function runPickerFinale(args) {
  const { finale, clientsPicked, capabilities, sources, skills, agents, config, configPath, env, stdout, stderr } = args
  const dryRun = finale.dryRun === true
  // Like the join lane, the finale is one step made of several actions
  // (install, attach, assets, backfill consent, restart), so it states its
  // position once where the lane starts rather than per action. Only the
  // wizard sets this; `runPickerWalkthrough` and non-interactive runs leave
  // it unset and the line is not printed.
  // @ref LLP 0135#progress [implements]: the finale lane counts once, and prints its position where it starts
  if (args.progress) stdout.write(`${args.progress}\n`)
  const homeDir = env.HOME ?? ''
  const skipInstall = finale.skipDaemon === true || finale.skipDaemonInstall === true

  // The attach/start cutoff: backfill imports history strictly before
  // this instant so it never overlaps with live gateway capture, which
  // takes over once clients are attached and the daemon (re)starts below.
  const backfillUntil = new Date().toISOString()

  /** @type {FinaleSummary} */
  const summary = {
    daemonInstall: { skipped: skipInstall, dryRun },
    globalInstall: { skipped: true, installed: false },
    attach: [],
    skillsInstalled: [],
    agentsInstalled: [],
    daemonRestart: { skipped: true, dryRun, ok: false },
    backfill: [],
  }

  if (!skipInstall) {
    if (!dryRun) await stopFinaleStartedSources(sources)
    await withSpan(
      'daemon.install',
      {
        [Attr.COMPONENT]: 'walkthrough',
        [Attr.OPERATION]: 'daemon.install',
        dry_run: dryRun,
        config_path: configPath,
        status: 'ok',
      },
      async (span) => {
        const installMod = await import('../daemon/install.js')
        const binPath = finale.binPath ?? (process.argv[1] ?? '')
        /** @type {DaemonInstallOptions} */
        const options = {
          binPath,
          configPath,
          // The npx->durable global-bin upgrade now lives inside
          // installDaemon so every enrollment path inherits it; the
          // walkthrough only signals whether binPath came from an
          // explicit --bin and reads the result back off the plan.
          binExplicit: finale.binPath !== undefined,
          durableBin: { env, stdout, stderr },
          ...(homeDir ? { homeDir } : {}),
        }
        if (dryRun) {
          const plan = installMod.renderDaemonInstall(options)
          summary.daemonInstall = {
            skipped: false,
            dryRun: true,
            targetPath: plan.targetPath,
            plan: /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (plan)),
          }
          if (span && typeof span.setAttribute === 'function') {
            span.setAttribute('target_path', plan.targetPath)
            span.setAttribute('bin_path', plan.binPath)
            span.setAttribute('platform', plan.platform)
          }
        } else {
          const plan = await installMod.installDaemon(options)
          summary.daemonInstall = {
            skipped: false,
            dryRun: false,
            targetPath: plan.targetPath,
          }
          const durable = plan.globalInstall
          if (durable) {
            summary.globalInstall = {
              skipped: durable.skipped,
              installed: durable.installed,
              binPath: durable.binPath,
              ...(durable.packageSpec ? { packageSpec: durable.packageSpec } : {}),
            }
          }
          if (span && typeof span.setAttribute === 'function') {
            span.setAttribute('target_path', plan.targetPath)
            span.setAttribute('bin_path', plan.binPath)
            span.setAttribute('platform', plan.platform)
            if (durable) {
              span.setAttribute('global_install_skipped', durable.skipped)
              span.setAttribute('global_install_installed', durable.installed)
            }
          }
        }
      },
      { component: 'walkthrough' }
    )
  }

  if (clientsPicked.length > 0 && capabilities.has('hypaware.ai-gateway')) {
    /** @type {AiGatewayCapability} */
    const gateway = capabilities.require('hyp-core/walkthrough', 'hypaware.ai-gateway', '^2.0.0')
    for (const client of clientsPicked) {
      if (args.skipAttachClients?.has(client)) {
        summary.attach.push({ client, dryRun, ok: true, skipped: true })
        continue
      }
      const adapter = gateway.getClient(client)
      if (!adapter) {
        // Not attachable, not failed: `contributes.client` also covers plugins
        // that own skill/agent dirs but deliberately register no runtime
        // adapter (Claude Desktop, LLP 0115#no-attach-on-join); their setup
        // path is their picker row's configure_command, which the wizard's
        // configure phase runs.
        // @ref LLP 0180#decision [implements]: an adapterless client contribution skips the attach lane as not applicable
        summary.attach.push({ client, dryRun, ok: true, noAdapter: true })
        continue
      }
      // The walkthrough attaches before the finale restarts the daemon, so the
      // gateway is usually not bound in this process yet. With no configured
      // `listen` the daemon's gateway will bind the fixed default, which is a
      // usable address where the old `:0` placeholder was not; a fallback boot
      // is corrected by the LLP 0086 drift re-attach on the next start.
      // @ref LLP 0114#fixed-default-port [implements]: an unpinned install attaches at the known default rather than a port nothing can bind
      let endpoint = configuredGatewayEndpoint(config) ?? DEFAULT_GATEWAY_ENDPOINT
      try {
        endpoint = gateway.localEndpoint()
      } catch {}
      try {
        await adapter.attach({
          endpoint,
          config: {},
          stdout,
          stderr,
          dryRun,
        })
        summary.attach.push({ client, dryRun, ok: true })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        stderr.write(`attach ${client} failed: ${message}\n`)
        summary.attach.push({ client, dryRun, ok: false })
      }
    }
  }

  const descriptorMap = clientsPicked.length > 0 && (skills || agents)
    ? await buildWalkthroughClientDescriptorMap()
    : new Map()

  if (clientsPicked.length > 0 && (skills || agents)) {
    // Span name kept from when skills and agents were two steps: this is now
    // the one client-asset materialization, and it is what the release smoke
    // battery asserts on.
    // @ref LLP 0138#one-materializer [implements]: the finale materializes both
    //   kinds through the shared routine instead of two hand-rolled copy loops.
    await withSpan(
      'skills.install',
      {
        [Attr.COMPONENT]: 'walkthrough',
        [Attr.OPERATION]: 'skills.install',
        dry_run: dryRun,
        client_count: clientsPicked.length,
        status: 'ok',
      },
      async (span) => {
        const framed = framedStream(stdout)
        const installed = await materializeClientAssets({
          clients: clientsPicked,
          descriptors: descriptorMap,
          homeDir,
          ...(skills ? { skills } : {}),
          ...(agents ? { agents } : {}),
          dryRun,
          stdout: framed,
          stderr,
        })
        for (const item of installed) {
          const entry = {
            name: item.name,
            client: item.client,
            dest: item.dest,
            dryRun: item.dryRun,
          }
          if (item.kind === 'skill') summary.skillsInstalled.push(entry)
          else summary.agentsInstalled.push(entry)
        }
        // Trailing blank line so the next step (backfill prompt) stands apart.
        if (framed.wrote()) stdout.write('\n')
        if (span && typeof span.setAttribute === 'function') {
          span.setAttribute('installed_count', installed.length)
        }
      },
      { component: 'walkthrough' }
    )
  }

  // Backfill: import each picked client's local history after the config
  // write and before the daemon (re)start that resumes live capture.
  // Runs independent of the daemon (`--no-daemon` still backfills, since
  // it is a local file import) and is bounded by the retention window and
  // the `backfillUntil` cutoff so it never double-counts live rows.
  await runFinaleBackfill({
    ...(args.backfill ? { backfill: args.backfill } : {}),
    ...(args.backfillConsentPrompt ? { backfillConsentPrompt: args.backfillConsentPrompt } : {}),
    clientsPicked,
    interactive: args.interactive,
    dryRun,
    retentionDays: args.retentionDays,
    until: backfillUntil,
    ...(args.stdin ? { stdin: args.stdin } : {}),
    stdout,
    stderr,
    env,
    summary,
  })

  // Re-running the picker regenerates the config from the picks alone, so a
  // client the previous run attached and this run left unchecked keeps routing
  // through the gateway that no longer collects it. Nothing here undoes that:
  // the finale only attaches, and the reconciler's reverse lane covers only the
  // config-named org/central keys, never a wizard attach on the local layer.
  // Naming the stranded clients before the restart is what keeps the breakage
  // visible; the undo stays the user's to run.
  // @ref LLP 0185#warn-do-not-detach [implements]: the finale names what it left attached and stops there
  summary.attachedNotConfigured = await findAttachedNotConfiguredClients({
    clientsPicked,
    config,
    env,
    homeDir,
  })
  if (summary.attachedNotConfigured.length > 0) {
    writeAttachedNotConfiguredWarning({ clients: summary.attachedNotConfigured, stdout, dryRun })
  }

  if (!finale.skipDaemon && !finale.skipDaemonRestart && !dryRun) {
    try {
      const { restartServiceDaemon } = await import('../daemon/install.js')
      await restartServiceDaemon({ ...(homeDir ? { homeDir } : {}) })
      summary.daemonRestart = { skipped: false, dryRun: false, ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      stderr.write(`daemon restart failed: ${message}\n`)
      summary.daemonRestart = { skipped: false, dryRun: false, ok: false }
    }
  } else if (dryRun && !finale.skipDaemon) {
    summary.daemonRestart = { skipped: false, dryRun: true, ok: true }
    stdout.write(`(dry-run) Would restart the daemon\n`)
  }

  return summary
}

/**
 * The plugin names the org's central layer declares, read-only and
 * best-effort. A centrally named client is attached and reversed by the
 * reconciler, not by the wizard, so it must never be counted as stranded by
 * the local layer's picks. Any failure to read the layer degrades to "no
 * central plugins", which can only cost an extra warning, never a wrong undo.
 *
 * Deliberately *not* filtered by `enabled`, unlike the local set the caller
 * builds: what matters here is that the org named the plugin at all, because a
 * name is what makes the attach the reconciler's to reverse. Adding the filter
 * would hand the operator a detach for an org-owned client.
 *
 * @ref LLP 0185#scope [constrained-by]: a centrally named adapter is never counted stranded, whatever its enabled flag says
 * @ref LLP 0031#central-layer-is-sacrosanct [constrained-by]: the central layer is read here, never written or interpreted beyond its plugin names
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<Set<string>>}
 */
async function readCentralPluginNames(env) {
  try {
    const { stateDir } = readObservabilityEnv(env)
    const centralPath = resolveCentralLayerPath({ stateRoot: stateDir })
    if (!centralPath) return new Set()
    const loaded = await loadConfigFile(centralPath)
    if (!loaded.ok) return new Set()
    return new Set((loaded.config.plugins ?? []).map((entry) => entry.name))
  } catch {
    return new Set()
  }
}

/**
 * The clients this run leaves stranded: their settings still carry a HypAware
 * attach marker, they are not among this run's picks, and neither the config
 * the finale just wrote nor the org's central layer enables their adapter. The
 * marker is read through the same descriptor-driven probe `hyp status` uses, so
 * "still attached" means exactly what the status surface means by it.
 *
 * @param {{
 *   clientsPicked: string[],
 *   config: HypAwareV2Config,
 *   env: NodeJS.ProcessEnv,
 *   homeDir: string,
 * }} args
 * @returns {Promise<string[]>} stranded client names, in catalog order
 * @ref LLP 0045#part-3-reverse-runs-from-disk-the-marker-is-a-self-describing-undo-record [constrained-by]: the on-disk marker is the only evidence of a prior attach, so it is what the check reads
 */
export async function findAttachedNotConfiguredClients({ clientsPicked, config, env, homeDir }) {
  if (!homeDir) return []
  const picked = new Set(clientsPicked)
  // `enabled: false` is what `hyp status` reads as "not active" when it builds
  // the same set, and an entry left in the file with the switch off collects
  // exactly as little as an absent one. Reading it as configured here would
  // make the two surfaces disagree about the same config.
  // @ref LLP 0185#not-configured-means-not-active [implements]: a disabled plugin entry strands its client exactly as an absent one does
  const configured = new Set(
    (config.plugins ?? []).filter((entry) => entry.enabled !== false).map((entry) => entry.name)
  )
  for (const name of await readCentralPluginNames(env)) configured.add(name)

  const descriptors = await buildWalkthroughClientDescriptorMap()
  /** @type {string[]} */
  const stranded = []
  for (const [clientName, descriptor] of descriptors) {
    if (picked.has(clientName) || configured.has(descriptor.plugin)) continue
    if (!descriptor.attachProbe) continue
    const probe = await probeClientAttachFromDescriptor({ descriptor, homeDir, env })
    if (probe.attached) stranded.push(clientName)
  }
  return stranded
}

/**
 * Name the stranded clients and the one command that clears each. The wizard
 * says what it found and what to run; it does not run it, because rewriting a
 * client's settings is not something a menu confirm asked for.
 *
 * A dry run carries the same tag the rest of the finale uses: the clients
 * really are attached, but the config that strands them was not written.
 *
 * @param {{
 *   clients: string[],
 *   stdout: NodeJS.WritableStream | { write(chunk: string): unknown },
 *   dryRun: boolean,
 * }} args
 */
function writeAttachedNotConfiguredWarning({ clients, stdout, dryRun }) {
  stdout.write('\n')
  stdout.write(`${dryRun ? '(dry-run) ' : ''}Still attached, no longer collected: ${clients.join(', ')}\n`)
  stdout.write('These tools still send their requests through the HypAware gateway,\n')
  stdout.write('but this setup no longer collects them, so their requests can start\n')
  stdout.write('failing. Point each one back at its provider with:\n')
  for (const client of clients) stdout.write(`  hyp detach --client ${client}\n`)
}

/**
 * Run the onboarding backfill step. For each picked client that has a
 * registered backfill provider (intersection of `clientsPicked` and
 * `backfill.available`), import its local history into the query cache.
 *
 * Consent rules mirror the bead contract:
 *   - interactive (no pre-baked picks): prompt, defaulting to yes;
 *   - `--yes` / `--dry-run` (picks supplied): run automatically;
 *   - `--dry-run`: scan and report a plan but write nothing;
 *   - `--no-daemon`: still backfill (it is a local file import).
 *
 * Each provider's outcome is pushed onto `summary.backfill` and a
 * one-line status is written to stdout. Wrapped in a `walkthrough.backfill`
 * span so the step is observable even when no provider runs.
 *
 * @param {{
 *   backfill?: PickerBackfillRunner,
 *   backfillConsentPrompt?: AsyncBackfillConsentPrompt,
 *   clientsPicked: string[],
 *   interactive: boolean,
 *   dryRun: boolean,
 *   retentionDays: number,
 *   until: string,
 *   stdin?: NodeJS.ReadableStream,
 *   stdout: NodeJS.WritableStream | { write(chunk: string): unknown },
 *   stderr: NodeJS.WritableStream | { write(chunk: string): unknown },
 *   env: NodeJS.ProcessEnv,
 *   summary: FinaleSummary,
 * }} args
 * @returns {Promise<void>}
 */
async function runFinaleBackfill(args) {
  const { backfill, clientsPicked, interactive, dryRun, retentionDays, until, stdout, stderr, env, summary } = args
  if (!backfill) return
  const available = new Set(backfill.available)
  const providers = clientsPicked.filter((c) => available.has(c))
  if (providers.length === 0) return

  // A sweep-backed provider is never asked: the pick already enabled the
  // daemon sweep that imports its history on schedule (LLP 0170), so a
  // "skip for now" answer would promise a control the wizard does not
  // have. It gets a disclosure and its first import runs below instead.
  // @ref LLP 0180#decision [implements]: only non-sweep providers reach the consent question
  const sweeping = new Set(backfill.sweeping ?? [])
  const asked = providers.filter((p) => !sweeping.has(p))

  let consent = true
  let cancelled = false
  if (interactive && asked.length > 0) {
    const ask = args.backfillConsentPrompt ?? defaultBackfillConsentPromptFactory({
      ...(args.stdin ? { stdin: args.stdin } : {}),
      stdout,
      env,
    })
    try {
      consent = await ask({ providers: asked, retentionDays })
    } catch (err) {
      if (!isPromptCancelledError(err)) throw err
      cancelled = true
      consent = false
      summary.cancelled = true
    }
  }

  await withSpan(
    'walkthrough.backfill',
    {
      [Attr.COMPONENT]: 'walkthrough',
      [Attr.OPERATION]: 'walkthrough.backfill',
      provider_count: providers.length,
      providers: providers.join(','),
      dry_run: dryRun,
      interactive,
      consent,
      consent_cancelled: cancelled,
      retention_days: retentionDays,
      until,
      ...(cancelled ? { exit_code: WALKTHROUGH_CANCEL_EXIT_CODE } : {}),
      status: cancelled ? 'cancelled' : 'ok',
    },
    async (span) => {
      // A cancel means "stop the wizard", not "skip the question", so it
      // takes the sweep-backed providers down with it; a decline skips
      // only what was actually asked.
      if (cancelled) {
        stdout.write('backfill: skipped (cancelled)\n')
        return
      }
      if (!consent) stdout.write('backfill: skipped (declined)\n')
      const toRun = providers.filter((p) => consent || sweeping.has(p))
      // Guard each provider so one failure neither aborts sibling
      // providers nor the daemon (re)start that resumes live capture.
      // This matches the attach/restart resilience above.
      for (const provider of toRun) {
        if (sweeping.has(provider)) {
          stdout.write(
            `backfill ${provider}: the enabled periodic sweep imports its history on schedule; running the first import now\n`
          )
        }
        try {
          // Importing local history reads and writes potentially
          // thousands of rows with no other output. Without this line
          // the resolved consent frame is the last thing on screen, so a
          // multi-second import looks like the prompt is stuck. Announce
          // the work before it starts so the wizard visibly moves on.
          const startTag = dryRun ? '(dry-run) ' : ''
          stdout.write(`${startTag}backfill ${provider}: importing local history…\n`)
          const entry = await backfill.run({ provider, dryRun, retentionDays, until })
          summary.backfill.push(entry)
          const tag = entry.dryRun ? '(dry-run) ' : ''
          stdout.write(
            `${tag}backfill ${entry.provider}: ${entry.ok ? 'ok' : 'failed'} ` +
            `(scanned ${entry.scanned}, wrote ${entry.rowsWritten}, skipped ${entry.skipped})\n`
          )
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          stderr.write(`backfill ${provider} failed: ${message}\n`)
          summary.backfill.push({ provider, dryRun, ok: false, scanned: 0, rowsWritten: 0, skipped: 0 })
        }
      }
      if (span && typeof span.setAttribute === 'function') {
        span.setAttribute('providers_run', summary.backfill.length)
        span.setAttribute(
          'rows_written',
          summary.backfill.reduce((acc, r) => acc + r.rowsWritten, 0)
        )
      }
    },
    { component: 'walkthrough' }
  )
}

/**
 * Init boots bundled plugins so it can discover clients and presets.
 * Some plugins bind listeners during activation; release those before
 * launchd starts the freshly installed daemon or the daemon can race
 * the init process for the same configured ports.
 *
 * @param {{ stopAll?: () => Promise<void> } | undefined} sources
 */
async function stopFinaleStartedSources(sources) {
  if (typeof sources?.stopAll !== 'function') return
  try {
    await sources.stopAll()
  } catch {
    // Best-effort. The dispatcher cleanup will make the same call on
    // command exit; this early stop is only to avoid daemon port races.
  }
}

/**
 * Default detector for the interactive picker: builds a catalog from
 * bundled plugins and runs the descriptor-driven `detectPickerSources`
 * (`@ref LLP 0130#picker-block [implements]`) against it in place of
 * the old hardcoded `detectClientSources` table. Detected ids are cast
 * to `PickerSource`; the descriptor-sourced picker table filters any
 * unrecognized id back out downstream, so a picker-only id the current
 * descriptors do not recognize is silently dropped rather than surfaced.
 *
 * @param {{ env: NodeJS.ProcessEnv }} opts
 * @returns {Promise<Set<PickerSource>>}
 */
export async function defaultPickerDetect(opts) {
  const bundled = await discoverBundledPlugins()
  const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
  const detected = await detectPickerSources(catalog, opts.env)
  return /** @type {Set<PickerSource>} */ (detected)
}

/**
 * Load the manifest-sourced picker descriptors (`@ref LLP 0130#picker-block`)
 * from the bundled plugin catalog, in `PICKER_DISPLAY_ORDER`. This is the
 * replacement for the retired hardcoded `PICKER_SOURCES` table: the picker
 * prompt options and `composePickerConfig`'s fold both read from it.
 * Discovery failure yields an empty map rather than blocking init.
 *
 * @returns {Promise<Map<string, PickerDescriptor>>}
 */
export async function loadPickerDescriptors() {
  try {
    const bundled = await discoverBundledPlugins()
    const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
    return orderPickerDescriptors(catalog.pickerDescriptors)
  } catch {
    return new Map()
  }
}

/**
 * The descriptors the interactive picker menu renders: everything except
 * the rows whose manifest marks them `hidden` (`@ref LLP 0200#hidden-rows`).
 *
 * Display is the ONLY thing this filters. A hidden row keeps every other
 * property of a picker source, and each one is load-bearing somewhere:
 * `hyp init --source raw-anthropic` still composes it, `configuredPickerSources`
 * still reads it back off a config that collects it, and - the one that
 * bites hardest if the row is deleted outright rather than hidden - its id
 * still reaches `datasetOwnedSourceIdsFromCatalog`, which folds picker
 * descriptors into the dataset-owner map that arms the export seam's
 * unattributed-row withholding (LLP 0192 #fail-closed). Drop the
 * descriptors and `ai_gateway_messages` gets an empty owner list, which
 * both withhold rules read as "never withhold": a privacy guard turned off
 * by what looks like a UI cleanup.
 *
 * @param {Iterable<PickerDescriptor>} descriptors
 * @returns {PickerDescriptor[]}
 */
export function visiblePickerDescriptors(descriptors) {
  return [...descriptors].filter((d) => d.hidden !== true)
}

/**
 * Sort picker descriptors into `PICKER_DISPLAY_ORDER`, keeping any
 * unlisted id after the known ones in catalog order (Array.prototype.sort
 * is stable). Returns a fresh insertion-ordered map so both the prompt
 * option list and `composePickerConfig`'s fold iterate the same order.
 *
 * @param {Map<string, PickerDescriptor>} descriptors
 * @returns {Map<string, PickerDescriptor>}
 */
export function orderPickerDescriptors(descriptors) {
  const rank = (/** @type {string} */ id) => {
    const i = PICKER_DISPLAY_ORDER.indexOf(id)
    return i === -1 ? PICKER_DISPLAY_ORDER.length : i
  }
  const ordered = [...descriptors.values()].sort((a, b) => rank(a.id) - rank(b.id))
  return new Map(ordered.map((d) => [d.id, d]))
}

/**
 * Derive the finale's client list from the picked rows: a picked source
 * is a client pick iff its row's owning plugin contributes a client, and
 * the finale then works in that client's name. Replaces the hardcoded
 * claude/codex pair whose staleness dropped a picked OpenClaw from the
 * attach lane (LLP 0177); a future adapter joins the finale by declaring
 * `contributes.client`, with no edit here.
 *
 * @param {string[]} sources  picked picker source ids
 * @param {Map<string, PickerDescriptor>} pickerDescriptors
 * @param {Map<string, ClientDescriptor>} clientDescriptors
 * @returns {string[]}
 * @ref LLP 0180#decision [implements]: derivation from client contributions, not enumeration
 */
export function derivePickedClients(sources, pickerDescriptors, clientDescriptors) {
  /** @type {Set<string>} */
  const pickedPlugins = new Set()
  for (const id of sources) {
    const row = pickerDescriptors.get(id)
    if (row) pickedPlugins.add(row.plugin)
  }
  /** @type {string[]} */
  const clients = []
  for (const descriptor of clientDescriptors.values()) {
    if (pickedPlugins.has(descriptor.plugin)) clients.push(descriptor.name)
  }
  return clients
}

/**
 * @returns {Promise<Map<string, ClientDescriptor>>}
 */
export async function buildWalkthroughClientDescriptorMap() {
  /** @type {Map<string, ClientDescriptor>} */
  const map = new Map()
  try {
    const bundled = await discoverBundledPlugins()
    const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
    for (const [clientName, descriptor] of catalog.clientDescriptors) {
      map.set(clientName, descriptor)
    }
  } catch { /* discovery failure → empty map */ }
  return map
}

/**
 * Wrap a finale stream so the first write is preceded by a blank line,
 * separating this step's output from the previous step's. A step that turns
 * out to print nothing (no assets matched the picked clients) leaves no empty
 * gap behind, which a plain leading `write('\n')` would.
 *
 * @param {{ write(chunk: string): unknown }} stdout
 * @returns {{ write(chunk: string): unknown, wrote(): boolean }}
 */
function framedStream(stdout) {
  let wrote = false
  return {
    write(chunk) {
      if (!wrote) {
        stdout.write('\n')
        wrote = true
      }
      return stdout.write(chunk)
    },
    wrote() { return wrote },
  }
}

/**
 * Result returned when the overwrite guard refuses (non-interactive,
 * `--force` absent) or the user declines the interactive prompt. No
 * config is written; exit code 1 surfaces the refusal to the caller.
 *
 * @param {{
 *   opts: RunPickerWalkthroughOptions,
 *   configPath: string,
 *   config: HypAwareV2Config,
 *   picks: PickerPicks,
 * }} args
 * @returns {Promise<PickerWalkthroughResult>}
 */
async function overwriteAbortedResult({ opts, configPath, config, picks }) {
  await withSpan(
    'walkthrough.finish',
    {
      [Attr.COMPONENT]: 'walkthrough',
      [Attr.OPERATION]: 'walkthrough.finish',
      config_path: configPath,
      exit_code: 1,
      status: 'aborted',
      hyp_reason: 'config_exists',
    },
    async () => {},
    { component: 'walkthrough' }
  )
  return {
    exitCode: 1,
    configPath,
    config,
    sourcesPicked: picks.sources,
    exportPicked: picks.exportChoice,
    clientsPicked: [],
    retentionDays: picks.retentionDays,
  }
}

/**
 * Build the canonical cancel result returned by {@link runPickerWalkthrough}
 * when the user cancels via escape / ctrl+c. Writes a one-line cancel
 * notice to stderr so the dispatcher does not eat it silently, and
 * surfaces {@link WALKTHROUGH_CANCEL_EXIT_CODE} (130, matching SIGINT
 * convention) as the exit code. The returned object satisfies the
 * required shape of {@link PickerWalkthroughResult} but contains no
 * config (callers that key off `exitCode` already short-circuit on
 * non-zero values).
 *
 * @param {RunPickerWalkthroughOptions} opts
 * @returns {Promise<PickerWalkthroughResult>}
 */
async function cancelledResult(opts) {
  await withSpan(
    'walkthrough.finish',
    {
      [Attr.COMPONENT]: 'walkthrough',
      [Attr.OPERATION]: 'walkthrough.finish',
      sources_picked: 0,
      export_picked: '',
      clients_picked: 0,
      retention_days: DEFAULT_RETENTION_DAYS,
      config_path: '',
      exit_code: WALKTHROUGH_CANCEL_EXIT_CODE,
      status: 'cancelled',
    },
    async () => {},
    { component: 'walkthrough' }
  )
  writeCancelledNotice(opts.stderr)
  return {
    exitCode: WALKTHROUGH_CANCEL_EXIT_CODE,
    configPath: '',
    config: /** @type {HypAwareV2Config} */ ({
      version: 2,
      plugins: [],
      query: { cache: { retention: { default_days: DEFAULT_RETENTION_DAYS } } },
    }),
    sourcesPicked: [],
    exportPicked: 'keep-local',
    clientsPicked: [],
    retentionDays: DEFAULT_RETENTION_DAYS,
  }
}

/**
 * @param {NodeJS.WritableStream | { write(chunk: string): unknown }} stderr
 */
function writeCancelledNotice(stderr) {
  try {
    stderr.write('hyp init: cancelled\n')
  } catch {
    // best-effort: stderr might be closed during cleanup
  }
}
