// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

import { Attr, getLogger, withSpan } from '../../observability/index.js'
import { readObservabilityEnv } from '../../observability/env.js'
import { defaultConfigPath, prepareLocalConfigWrite } from '../../config/schema.js'
import { isPromptCancelledError } from '../tui/runtime.js'
import {
  DEFAULT_RETENTION_DAYS,
  WALKTHROUGH_CANCEL_EXIT_CODE,
  composePickerConfig,
  defaultOverwriteConfirmFactory,
  defaultPickerDetect,
  defaultPromptFactory,
  defaultRetentionPromptFactory,
  loadPickerDescriptors,
  orderPickerDescriptors,
  resolveHypHome,
} from '../walkthrough.js'

/**
 * @import { HypAwareV2Config } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { PickerDescriptor } from '../../../../src/core/types.js'
 * @import { PickerExport, PickerSource, WalkthroughOption } from '../../../../src/core/cli/types.js'
 * @import { RunWizardPickOptions, WizardPickResult } from '../../../../src/core/cli/wizard/types.js'
 */

/**
 * Label suffix applied to a central-layer-locked picker row. The row is
 * shown checked and disabled so a managed machine's org rows are never a
 * silent state, using the LLP 0031 provenance vocabulary.
 */
const LOCKED_LABEL_SUFFIX = ' · managed by your fleet'

/**
 * Label suffix applied to every non-locked row on a managed machine: a
 * source the dev adds beyond the org-configured set is collected but
 * never forwarded, and the picker must say so up front rather than the
 * dev discovering the split later in `hyp status`.
 */
const LOCAL_ONLY_LABEL_SUFFIX = ' · stays on this machine'

/**
 * The wizard pick phase (LLP 0135 #pick). Keeps `runPickerWalkthrough`'s
 * prompt/write/guard/overwrite-confirm shape but sources its rows from the
 * catalog's picker descriptors (LLP 0130) instead of the retired hardcoded
 * `PICKER_SOURCES` table, and understands central-layer-locked rows.
 *
 * A row's initial checked state is `detected.has(id) || locked.includes(id)`.
 * A locked id renders `disabled: true` with the `· managed by your fleet`
 * suffix and is filtered out of the returned sources before composition: it
 * is already in the central layer, so composing it again into the local
 * layer would be the exact collision join-before-pick exists to avoid
 * (`@ref LLP 0129#join-before-picker`). Locked-source membership itself is
 * computed upstream by the join phase (T3's `classifyClientProvenance`); this
 * phase only consumes the resulting id list.
 *
 * Composition itself is the descriptor-driven `composePickerConfig` fold
 * (T6), unchanged from the walkthrough. This phase does not run the finale
 * (daemon install / attach / backfill) or the configure phase; the wizard
 * orchestrator invokes those separately.
 *
 * Non-interactive callers (`--yes`, `--dry-run`, presets, `--from-file`) set
 * `opts.picks` and skip prompting and detection entirely, matching today's
 * `interactive = !opts.picks` split so every existing non-interactive picker
 * test keeps its shape.
 *
 * @ref LLP 0130#picker-block [implements]: picker rows and composition read the manifest-sourced descriptors, not a core switch
 * @ref LLP 0031#status-provenance [implements]: a locked row renders with the fleet-managed provenance label rather than silently
 * @ref LLP 0132#never-silent [implements]: on a managed machine, non-locked rows are labeled "stays on this machine"
 *
 * @param {RunWizardPickOptions} opts
 * @returns {Promise<WizardPickResult>}
 */
export async function runWizardPick(opts) {
  const { env } = opts
  const log = getLogger('wizard')
  const interactive = !opts.picks

  const descriptors = opts.catalog
    ? orderPickerDescriptors(opts.catalog.pickerDescriptors)
    : await loadPickerDescriptors()
  const descriptorList = [...descriptors.values()]

  // Locked ids come from the join phase's central-layer classification. A
  // Set for membership tests; the ordered id array is preserved for the
  // result so the finale/status can report exactly what was locked.
  const lockedSources = (opts.locked ?? []).filter((id) => descriptors.has(id))
  const lockedSet = new Set(lockedSources)

  // Interactive only: detection seeds the pre-checked boxes. Best-effort -
  // a detector failure leaves the set empty rather than blocking onboarding.
  // @ref LLP 0011#autodetect-vs-default [implements]: detection only seeds the initial checkbox; never forces a source on
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

  await withSpan(
    'wizard.pick.start',
    {
      [Attr.COMPONENT]: 'wizard',
      [Attr.OPERATION]: 'wizard.pick.start',
      sources_available: descriptorList.length,
      sources_detected: detected.size,
      sources_locked: lockedSources.length,
      scoped: opts.scoped === true,
      status: 'ok',
    },
    async () => {},
    { component: 'wizard' }
  )

  /** @type {PickerSource[]} */
  let rawSources
  /** @type {PickerExport} */
  let exportChoice
  let retentionDays
  let exportOrigin = 'default'

  if (opts.picks) {
    rawSources = opts.picks.sources
    exportChoice = opts.picks.exportChoice
    retentionDays = opts.picks.retentionDays
    exportOrigin = opts.exportOrigin ?? 'default'
  } else {
    const ask = opts.prompt ?? defaultPromptFactory(opts)
    const retentionAsk = opts.retentionPrompt ?? defaultRetentionPromptFactory(opts)

    opts.stdout.write('Welcome to HypAware - the local logs+telemetry collector.\n\n')

    try {
      const sourceRaw = await ask({
        pickType: 'sources',
        title: 'What do you want to collect? (space to toggle, enter to confirm)',
        options: descriptorList.map((d) => buildPickOption(d, detected, lockedSet, opts.managed === true)),
      })
      rawSources = /** @type {PickerSource[]} */ (
        sourceRaw.filter((v) => descriptors.has(v))
      )
      // Export destination is not asked interactively: a local query cache
      // is always kept, and on top of it we default to scheduled local
      // Parquet exports so the first run produces durable files out of the
      // box. Other destinations remain available via `hyp init --export`.
      exportChoice = /** @type {PickerExport} */ ('local-parquet')
      retentionDays = await retentionAsk('Cache retention (days)', DEFAULT_RETENTION_DAYS)
    } catch (err) {
      if (isPromptCancelledError(err)) return cancelledResult(opts)
      throw err
    }
  }

  // Filter locked ids out of the picks before composition: they are already
  // in the central layer, so composing them again would collide with it.
  // @ref LLP 0129#join-before-picker [implements]: locked (central) sources are dropped from the local-layer composition
  const sources = rawSources.filter((id) => !lockedSet.has(id))

  for (const value of sources) {
    log.info('wizard.pick', { [Attr.COMPONENT]: 'wizard', pick_type: 'sources', pick_value: value })
  }
  log.info('wizard.pick', {
    [Attr.COMPONENT]: 'wizard',
    pick_type: 'exports',
    pick_value: exportChoice,
    pick_origin: exportOrigin,
  })

  const hypHome = resolveHypHome(env)
  const config = composePickerConfig({ sources, descriptors, exportChoice, retentionDays, hypHome })

  const obsEnv = readObservabilityEnv(env)
  const configPath = env.HYP_CONFIG ? path.resolve(env.HYP_CONFIG) : defaultConfigPath(obsEnv.hypHome)

  // Guard against clobbering an existing local config (LLP 0031). Interactive
  // runs prompt for confirmation; non-interactive runs require `--force`.
  // Either path backs the file up before replacing it.
  // @ref LLP 0031#local-layer-writers [implements]: pick-phase overwrite safety on the config write path
  const overwriteConfirm = interactive
    ? (opts.confirmOverwrite ?? defaultOverwriteConfirmFactory({ ...(opts.stdin ? { stdin: opts.stdin } : {}), stdout: opts.stdout }))
    : undefined
  const guard = await prepareLocalConfigWrite({
    targetPath: configPath,
    force: opts.force,
    ...(overwriteConfirm ? { confirmOverwrite: overwriteConfirm } : {}),
  })
  if (!guard.proceed) {
    opts.stderr.write(`hyp init: ${guard.message}\n`)
    return overwriteAbortedResult({ configPath, config, sources, exportChoice, retentionDays, lockedSources })
  }
  if (guard.backupPath) {
    opts.stdout.write(`Backed up existing config to ${guard.backupPath}\n`)
  }

  await withSpan(
    'wizard.pick.write_config',
    {
      [Attr.COMPONENT]: 'wizard',
      [Attr.OPERATION]: 'wizard.pick.write_config',
      config_path: configPath,
      plugin_count: config.plugins?.length ?? 0,
      ...(guard.backupPath ? { config_backed_up: true } : {}),
      status: 'ok',
    },
    async () => {
      await fs.mkdir(path.dirname(configPath), { recursive: true })
      await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8')
    },
    { component: 'wizard' }
  )

  /** @type {('claude'|'codex')[]} */
  const clientsPicked = []
  if (sources.includes(/** @type {PickerSource} */ ('claude'))) clientsPicked.push('claude')
  if (sources.includes(/** @type {PickerSource} */ ('codex'))) clientsPicked.push('codex')

  /** @type {PickerDescriptor[]} */
  const pickedDescriptors = sources
    .map((id) => descriptors.get(id))
    .filter((d) => d !== undefined)

  await withSpan(
    'wizard.pick.finish',
    {
      [Attr.COMPONENT]: 'wizard',
      [Attr.OPERATION]: 'wizard.pick.finish',
      sources_picked: sources.length,
      sources_locked: lockedSources.length,
      export_picked: exportChoice,
      clients_picked: clientsPicked.length,
      retention_days: retentionDays,
      config_path: configPath,
      status: 'ok',
    },
    async () => {},
    { component: 'wizard' }
  )

  return {
    exitCode: 0,
    configPath,
    config,
    sourcesPicked: sources,
    exportPicked: exportChoice,
    clientsPicked,
    retentionDays,
    descriptors: pickedDescriptors,
    lockedSources,
  }
}

/**
 * Build one picker row's prompt option from its descriptor. A locked row
 * is checked and disabled with the `· managed by your fleet` suffix; a
 * merely detected row is checked with the ` · detected` suffix; otherwise
 * the bare descriptor label. On a managed machine every non-locked row
 * additionally carries `· stays on this machine`, so a dev toggling a box
 * beyond the org set knows the addition is local-only before picking it
 * (LLP 0132 #never-silent).
 *
 * @param {PickerDescriptor} d
 * @param {Set<PickerSource>} detected
 * @param {Set<string>} lockedSet
 * @param {boolean} managed
 * @returns {WalkthroughOption}
 */
function buildPickOption(d, detected, lockedSet, managed) {
  const locked = lockedSet.has(d.id)
  const isDetected = detected.has(/** @type {PickerSource} */ (d.id))
  let label = d.label
  if (locked) {
    label += LOCKED_LABEL_SUFFIX
  } else {
    if (isDetected) label += ' · detected'
    if (managed) label += LOCAL_ONLY_LABEL_SUFFIX
  }
  return {
    value: d.id,
    label,
    ...(d.summary ? { summary: d.summary } : {}),
    ...(locked || isDetected ? { checked: true } : {}),
    ...(locked ? { disabled: true } : {}),
  }
}

/**
 * Build the cancel result returned when the user cancels at a prompt. Mirrors
 * `runPickerWalkthrough`'s cancel shape: a cancel notice to stderr, the
 * deterministic 130 exit code, and an empty config the orchestrator ignores
 * once it sees `cancelled`.
 *
 * @param {RunWizardPickOptions} opts
 * @returns {Promise<WizardPickResult>}
 */
async function cancelledResult(opts) {
  await withSpan(
    'wizard.pick.finish',
    {
      [Attr.COMPONENT]: 'wizard',
      [Attr.OPERATION]: 'wizard.pick.finish',
      sources_picked: 0,
      export_picked: '',
      clients_picked: 0,
      retention_days: DEFAULT_RETENTION_DAYS,
      config_path: '',
      exit_code: WALKTHROUGH_CANCEL_EXIT_CODE,
      status: 'cancelled',
    },
    async () => {},
    { component: 'wizard' }
  )
  try {
    opts.stderr.write('hyp init: cancelled\n')
  } catch {
    // best-effort: stderr might be closed during cleanup
  }
  return {
    exitCode: WALKTHROUGH_CANCEL_EXIT_CODE,
    cancelled: true,
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
    descriptors: [],
    lockedSources: [],
  }
}

/**
 * Result returned when the overwrite guard refuses (non-interactive,
 * `--force` absent) or the user declines the interactive prompt. No config
 * is written; exit code 1 surfaces the refusal. `cancelled` is not set, so
 * the orchestrator distinguishes a refusal (exit 1) from a cancel (exit 130).
 *
 * @param {{
 *   configPath: string,
 *   config: HypAwareV2Config,
 *   sources: PickerSource[],
 *   exportChoice: PickerExport,
 *   retentionDays: number,
 *   lockedSources: string[],
 * }} args
 * @returns {Promise<WizardPickResult>}
 */
async function overwriteAbortedResult(args) {
  await withSpan(
    'wizard.pick.finish',
    {
      [Attr.COMPONENT]: 'wizard',
      [Attr.OPERATION]: 'wizard.pick.finish',
      config_path: args.configPath,
      exit_code: 1,
      status: 'aborted',
      hyp_reason: 'config_exists',
    },
    async () => {},
    { component: 'wizard' }
  )
  return {
    exitCode: 1,
    configPath: args.configPath,
    config: args.config,
    sourcesPicked: args.sources,
    exportPicked: args.exportChoice,
    clientsPicked: [],
    retentionDays: args.retentionDays,
    descriptors: [],
    lockedSources: args.lockedSources,
  }
}
