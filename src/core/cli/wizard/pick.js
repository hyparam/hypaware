// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

import { Attr, getLogger, withSpan } from '../../observability/index.js'
import { readObservabilityEnv } from '../../observability/env.js'
import { defaultConfigPath, prepareLocalConfigWrite } from '../../config/schema.js'
import { isPromptBackError, isPromptCancelledError } from '../tui/runtime.js'
import { narrateAcceptedGate } from './express.js'
import {
  DEFAULT_RETENTION_DAYS,
  WALKTHROUGH_CANCEL_EXIT_CODE,
  buildWalkthroughClientDescriptorMap,
  composePickerConfig,
  configuredExportChoice,
  configuredPickerSources,
  defaultConfirmSelectPromptFactory,
  defaultOverwriteConfirmFactory,
  defaultPickerDetect,
  defaultPromptFactory,
  derivePickedClients,
  loadPickerCatalog,
  orderPickerDescriptors,
  resolveHypHome,
  visiblePickerDescriptors,
} from '../walkthrough.js'

/**
 * @import { HypAwareV2Config } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { PickerDescriptor } from '../../../../src/core/types.js'
 * @import { AsyncConfirmSelectPrompt, AsyncPickPrompt, PickerExport, PickerSource, WalkthroughOption } from '../../../../src/core/cli/types.js'
 * @import { RunWizardPickOptions, SeedOrigin, WizardPickResult } from '../../../../src/core/cli/wizard/types.js'
 */

/**
 * Label suffix applied to a central-layer-locked picker row. The row is
 * shown checked and disabled so a managed machine's org rows are never a
 * silent state, using the LLP 0031 provenance vocabulary. Exported so the
 * sync-scope lane labels the same rows the same way.
 */
export const LOCKED_LABEL_SUFFIX = ' · managed by your fleet'

/**
 * Everything the pick lane decides *before* it asks anything: the ordered
 * descriptors, the locked set, the config on disk, the detection pass, and
 * the seed those three produce (LLP 0183 #seed-from-config, LLP 0191
 * #re-entry-seeding, LLP 0011 #autodetect-vs-default), plus the
 * `defaultRows` a gate would state.
 *
 * Hoisted out of {@link runWizardPick} so the express gate (LLP 0201) can
 * name the same rows this lane would list without re-deriving them: two
 * computations of "the defaults" could disagree, and the one screen that
 * accepts them all is the worst place for that. The orchestrator passes a
 * detection function that runs once and is shared with the lane, so a
 * machine is probed once per run.
 *
 * Hidden rows (LLP 0202) are resolved here for the same reason: `visibleList`
 * is the single display filter's output, `defaultRows` is drawn from it so
 * neither gate can state a hidden row, and `carried` is the hidden-row
 * carry-through, decided off `seedOrigin` before any screen renders, so the
 * express gate's auto-accept and the pick lane's own screens preserve a
 * raw-only config the same way.
 *
 * @ref LLP 0201#gate [implements]: one computation of "the defaults", read by both the express gate and the pick lane
 * @ref LLP 0202#hidden-rows [implements]: a `hidden` row stays out of the gates and the menu
 * @param {RunWizardPickOptions} opts
 */
export async function resolvePickSeeding(opts) {
  const { env } = opts
  const interactive = !opts.picks

  // Riders (`compose_with`) ride the same catalog the descriptors come
  // from, so an injected catalog and a discovered one agree about them.
  // @ref LLP 0213#d1 [implements]: the graph plugins are composed by riding the gateway pick
  const loaded = opts.catalog
    ? { descriptors: orderPickerDescriptors(opts.catalog.pickerDescriptors), composeWith: opts.catalog.composeWith ?? new Map() }
    : await loadPickerCatalog()
  const descriptors = loaded.descriptors
  const composeWith = loaded.composeWith
  const descriptorList = [...descriptors.values()]

  // Locked ids come from the join phase's central-layer classification. A
  // Set for membership tests; the ordered id array is preserved for the
  // result so the finale/status can report exactly what was locked.
  const lockedSources = (opts.locked ?? []).filter((id) => descriptors.has(id))
  const lockedSet = new Set(lockedSources)

  const obsEnv = readObservabilityEnv(env)
  const configPath = env.HYP_CONFIG ? path.resolve(env.HYP_CONFIG) : defaultConfigPath(obsEnv.hypHome)

  // Interactive only: the local config this run replaces. Reading it up
  // front is what makes the phase a reconfigure rather than a fresh compose
  // that happens to land on an occupied path. Non-interactive callers
  // (`--yes`, presets, `--from-file`) state every input on the command line,
  // so they keep composing from scratch and their output stays byte-identical.
  const existing = interactive ? await readLocalConfig(configPath) : undefined
  const configured = existing ? configuredPickerSources(existing, descriptors) : undefined

  // Interactive only: detection seeds the pre-checked boxes on a **first
  // run**. Best-effort - a detector failure leaves the set empty rather than
  // blocking onboarding. On a reconfigure it only labels rows `· detected`:
  // "installed on this machine" is a suggestion, and letting it re-check a
  // client the user deliberately excluded would re-consent to capture on
  // their behalf.
  // @ref LLP 0011#autodetect-vs-default [implements]: detection only seeds the initial checkbox; never forces a source on
  /** @type {Set<PickerSource>} */
  let detected = new Set()
  if (interactive && !opts.initialSelection) {
    const detect = opts.detect ?? defaultPickerDetect
    try {
      detected = await detect({ env })
    } catch {
      detected = new Set()
    }
  }

  // What seeds the checked rows, most-recent answer first: a re-entry
  // after stepping back carries the previous run's confirmed selection;
  // a reconfigure carries the config on disk (the record of what the
  // user chose); a first run falls back to detection. The later tiers
  // never override the earlier - re-detecting would overwrite an answer
  // the user already gave, and re-checking a client the user deliberately
  // excluded would re-consent to capture on their behalf. The `· detected`
  // suffix stays tied to `detected`, so seeded rows carry it only when
  // detection put it there: elsewhere they are the user's picks, not a
  // guess.
  // @ref LLP 0191#re-entry-seeding [implements]: stepping back into pick shows the answer previously confirmed, not a fresh detection pass
  // @ref LLP 0183#seed-from-config [implements]: on a reconfigure the config decides the checkboxes; detection only labels
  /** @type {ReadonlySet<string>} */
  const seed = opts.initialSelection
    ? new Set(opts.initialSelection.filter((id) => descriptors.has(id)))
    : configured ?? detected

  // Which of the three tiers above produced `seed`. The set itself does not
  // say, and hidden-row carry-through reads differently off each: a
  // re-entry's selection was already confirmed by a previous pass, the
  // config on disk is a record whose hidden rows may be derivative, and
  // detection is a guess about the machine that is never a choice at all.
  // @ref LLP 0011#autodetect-vs-default [implements]: a detected row is a pre-checked box the user can still clear, never a source composed on their behalf
  /** @type {SeedOrigin} */
  const seedOrigin = opts.initialSelection ? 'selection' : configured !== undefined ? 'config' : 'detected'

  const visibleList = visiblePickerDescriptors(descriptorList)
  // A hidden row never renders, so no screen downstream can return one.
  // Carrying one through the selection is right when the config on disk
  // collects nothing the menu can show: then every row it does collect is
  // hidden, and an interactive pass would silently strip a setup the picker
  // has no way to represent (a `--source raw-anthropic` install being
  // reconfigured).
  //
  // Carrying whenever a hidden row is merely seeded would be wrong, because
  // `configuredPickerSources` seeds a hidden row DERIVATIVELY: `raw-openai`
  // reads as configured whenever codex's `openai` upstream is present, per
  // the "composition is lossy" note on that function. Seeding off the config
  // is therefore not evidence the user ever chose the row, and carrying on it
  // would resurrect the `openai` upstream the moment someone unchecked codex -
  // breaking the guarantee that unchecking a row removes its upstream.
  //
  // `seedOrigin` is what keeps "the config on disk" from widening to "the
  // seed, whatever produced it", in both directions:
  //
  //   - `detected` never carries. On a first run the seed is a DETECTION
  //     result, and carrying off that would compose a source the user was
  //     never shown and cannot uncheck, purely because a probe found it -
  //     exactly what LLP 0011 #autodetect-vs-default forbids. No bundled
  //     hidden row declares a `detect` probe today, but `hidden` is a
  //     kernel-contract field any plugin can set beside one, so the gate is
  //     stated rather than assumed.
  //   - `selection` always carries, without the "nothing visible seeded"
  //     test. A re-entry's seed is the selection a previous pass already
  //     confirmed, and nothing derives a hidden id into it: read-back never
  //     reaches this tier, so a hidden row is in the previous answer only
  //     because that pass carried it under the rule below. Re-applying the
  //     rule against a seed that now also holds the visible rows the user
  //     just added would drop the row, so `back` then `enter` would delete
  //     the very upstream the carry exists to preserve.
  // @ref LLP 0191#re-entry-seeding [implements]: a re-entry starts from the answer previously confirmed, carried rows included
  // @ref LLP 0202#carry-through [implements]: it rides through the selection when the config collects nothing the menu can show, and stays there across a back-and-forward
  const seededHidden = descriptorList.filter((d) => d.hidden === true && seed.has(d.id)).map((d) => d.id)
  const seededVisible = visibleList.some((d) => seed.has(d.id))
  const carries = seedOrigin === 'selection' || (seedOrigin === 'config' && !seededVisible)
  const carried = carries ? seededHidden : []

  return {
    descriptors,
    composeWith,
    descriptorList,
    visibleList,
    lockedSources,
    lockedSet,
    configPath,
    existing,
    configured,
    detected,
    seed,
    carried,
    interactive,
    defaultRows: visibleList.filter((d) => seed.has(d.id) || lockedSet.has(d.id)),
  }
}

/**
 * The rows a defaults gate lists, one label per line, locked rows
 * fleet-suffixed. Shared so the pick gate (LLP 0190 #pick-gate) and the
 * express gate (LLP 0201 #gate) can never disagree about what "the
 * defaults" are: the express gate names exactly the rows accepting it will
 * record.
 *
 * @ref LLP 0201#gate [implements]: the express gate lists the pick gate's own rows, from one computation
 * @param {{ defaultRows: PickerDescriptor[], lockedSet: Set<string> }} seeding
 * @returns {string[]}
 */
export function defaultRowLabels({ defaultRows, lockedSet }) {
  return defaultRows.map((d) => `  ${d.label}${lockedSet.has(d.id) ? LOCKED_LABEL_SUFFIX : ''}`)
}

/**
 * The wizard pick phase (LLP 0135 #pick). Keeps `runPickerWalkthrough`'s
 * prompt/write/guard/overwrite-confirm shape but sources its rows from the
 * catalog's picker descriptors (LLP 0130) instead of the retired hardcoded
 * `PICKER_SOURCES` table, and understands central-layer-locked rows. When
 * detection or the locked set yields a default selection, a defaults gate
 * (LLP 0190 #pick-gate) states it first and a bare enter accepts it; the
 * full menu opens only on request.
 *
 * A row's initial checked state is `locked.includes(id)`, then whatever the
 * local config on disk already collects, and only on a first run (no config
 * yet) `detected.has(id)`. A locked id renders `disabled: true` with the
 * `· managed by your fleet`
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
 * On a reconfigure the local config already on disk is read first and is
 * what the phase starts from: the rows it collects, the retention window it
 * carries, and the export destination it expresses (LLP 0183). The wizard
 * asks about none of those three, so re-deriving them would silently
 * discard answers the user gave on a previous run.
 *
 * @ref LLP 0130#picker-block [implements]: picker rows and composition read the manifest-sourced descriptors, not a core switch
 * @ref LLP 0031#status-provenance [implements]: a locked row renders with the fleet-managed provenance label rather than silently
 * @ref LLP 0183#seed-from-config [implements]: a reconfigure starts from the config on disk, not from detection and pathway defaults
 * @ref LLP 0202#hidden-rows [implements]: a `hidden` row stays out of every screen but remains a source
 *
 * @param {RunWizardPickOptions} opts
 * @returns {Promise<WizardPickResult>}
 */
export async function runWizardPick(opts) {
  const { env } = opts
  const log = getLogger('wizard')
  const seeding = await resolvePickSeeding(opts)
  const {
    descriptors, composeWith, descriptorList, visibleList, lockedSources, lockedSet,
    configPath, existing, configured, detected, seed, carried, interactive, defaultRows,
  } = seeding

  await withSpan(
    'wizard.pick.start',
    {
      [Attr.COMPONENT]: 'wizard',
      [Attr.OPERATION]: 'wizard.pick.start',
      sources_available: descriptorList.length,
      sources_detected: detected.size,
      sources_locked: lockedSources.length,
      managed: opts.managed === true,
      sources_configured: configured?.size ?? 0,
      reconfigure: existing !== undefined,
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
    const confirm = opts.confirm ?? defaultConfirmSelectPromptFactory(opts)

    /** @type {{ rawSources: PickerSource[] } | { back: true }} */
    let selection
    try {
      selection = await promptPickSelection({ opts, ask, confirm, visibleList, descriptors, seed, detected, lockedSet, defaultRows, carried })
    } catch (err) {
      if (isPromptCancelledError(err)) return cancelledResult(opts)
      throw err
    }
    if ('back' in selection) return backResult(opts)
    rawSources = selection.rawSources
    // Export destination is not asked interactively: a local query cache
    // is always kept, and on top of it we default to scheduled local
    // Parquet exports so the first run produces durable files out of the
    // box. Other destinations remain available via `hyp init --export`.
    // A reconfigure reads the answer back off disk instead: a question
    // that is never asked cannot be re-answered by defaulting it again.
    exportChoice = existing ? configuredExportChoice(existing) : /** @type {PickerExport} */ ('local-parquet')
    // Retention is not asked either: the orchestrator supplies the
    // pathway default (90-day team / 120-day local), overridable only
    // via `hyp init --retention-days` on the non-interactive path. On a
    // reconfigure the window already in the config wins over the pathway
    // default - shortening it here would hand the next retention sweep
    // history to purge as a side effect of a menu walk.
    // @ref LLP 0137#pathway-defaults [implements]: the retention question is removed from onboarding
    // @ref LLP 0183#retention [implements]: an existing retention window survives a reconfigure onto another pathway
    retentionDays = configuredRetentionDays(existing) ?? opts.retentionDefault ?? DEFAULT_RETENTION_DAYS
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
  const config = composePickerConfig({
    sources,
    descriptors,
    exportChoice,
    retentionDays,
    hypHome,
    composeWith,
    ...(existing ? { existing } : {}),
  })

  // The wizard orchestrator defers the write until every question lane has
  // run (LLP 0190 #commit-point): the overwrite confirm then lands after
  // the sync lane, and a cancel there leaves the existing config untouched.
  // Without `deferWrite` the write (and its guard) happens here, keeping
  // the standalone shape every direct caller and test relies on.
  if (!opts.deferWrite) {
    const committed = await commitWizardPickedConfig({
      stdout: opts.stdout,
      stderr: opts.stderr,
      ...(opts.stdin ? { stdin: opts.stdin } : {}),
      interactive,
      ...(opts.force !== undefined ? { force: opts.force } : {}),
      ...(opts.confirmOverwrite ? { confirmOverwrite: opts.confirmOverwrite } : {}),
      configPath,
      config,
    })
    if (!committed.ok) {
      return overwriteAbortedResult({ configPath, config, sources, exportChoice, retentionDays, lockedSources })
    }
  }

  // clientsPicked drives the finale's per-machine LOCAL work (client attach and
  // the client-asset install). That work is not in the central layer, so
  // it must still run for org-locked clients on a fleet-managed machine: the
  // central layer supplies the daemon config, but each machine's client
  // settings, skills, and agents are local. Derive it from the pre-filter
  // selection (locked rows included), not the composition-filtered `sources`
  // that (correctly) drops locked ids. Deriving it from `sources` left it empty
  // on a fully managed machine, silently no-op'ing the whole finale (issue #380).
  // @ref LLP 0135#finale [implements]: the client-asset install iterates clientsPicked, which must include org-locked clients
  const clientCandidates = new Set([...rawSources, ...lockedSources])
  // @ref LLP 0180#decision [implements]: client-ness is read from the picked
  // rows' manifest client contributions, not a name list copied per call site
  const clientDescriptors = opts.catalog
    ? opts.catalog.clientDescriptors
    : await buildWalkthroughClientDescriptorMap()
  const clientsPicked = derivePickedClients([...clientCandidates], descriptors, clientDescriptors)

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
    ...(opts.deferWrite ? { configPending: true } : {}),
  }
}

/**
 * Commit a composed pick config to disk: the overwrite guard (LLP 0031),
 * the backup notice, and the write itself. Split out of `runWizardPick` so
 * the wizard orchestrator can run it after the sync lane (LLP 0190
 * #commit-point) - the last thing before the wizard starts acting - while
 * the non-deferred pick keeps calling it inline. Interactive runs prompt
 * for confirmation; non-interactive runs require `--force`. Either path
 * backs the file up before replacing it. A refusal is reported here
 * (message to stderr) and returned as `ok: false` for the caller to turn
 * into its exit-1 result.
 *
 * @ref LLP 0031#local-layer-writers [implements]: pick-phase overwrite safety on the config write path
 * @ref LLP 0190#commit-point [implements]: the config write is callable after the question lanes, not only inside pick
 *
 * @param {{
 *   stdout: { write(chunk: string): unknown },
 *   stderr: { write(chunk: string): unknown },
 *   stdin?: NodeJS.ReadableStream,
 *   interactive: boolean,
 *   force?: boolean,
 *   confirmOverwrite?: (targetPath: string) => Promise<boolean>,
 *   configPath: string,
 *   config: HypAwareV2Config,
 * }} args
 * @returns {Promise<{ ok: boolean }>}
 */
export async function commitWizardPickedConfig(args) {
  const overwriteConfirm = args.interactive
    ? (args.confirmOverwrite ?? defaultOverwriteConfirmFactory({ ...(args.stdin ? { stdin: args.stdin } : {}), stdout: args.stdout }))
    : undefined
  const guard = await prepareLocalConfigWrite({
    targetPath: args.configPath,
    force: args.force,
    ...(overwriteConfirm ? { confirmOverwrite: overwriteConfirm } : {}),
  })
  if (!guard.proceed) {
    args.stderr.write(`hyp init: ${guard.message}\n`)
    await withSpan(
      'wizard.pick.write_config',
      {
        [Attr.COMPONENT]: 'wizard',
        [Attr.OPERATION]: 'wizard.pick.write_config',
        config_path: args.configPath,
        status: 'aborted',
        hyp_reason: 'config_exists',
      },
      async () => {},
      { component: 'wizard' }
    )
    return { ok: false }
  }
  if (guard.backupPath) {
    args.stdout.write(`Backed up existing config to ${guard.backupPath}\n`)
  }

  await withSpan(
    'wizard.pick.write_config',
    {
      [Attr.COMPONENT]: 'wizard',
      [Attr.OPERATION]: 'wizard.pick.write_config',
      config_path: args.configPath,
      plugin_count: args.config.plugins?.length ?? 0,
      ...(guard.backupPath ? { config_backed_up: true } : {}),
      status: 'ok',
    },
    async () => {
      await fs.mkdir(path.dirname(args.configPath), { recursive: true })
      await fs.writeFile(args.configPath, JSON.stringify(args.config, null, 2) + '\n', 'utf8')
    },
    { component: 'wizard' }
  )
  return { ok: true }
}

/**
 * The pick lane's question screens: the defaults gate (LLP 0190
 * #pick-gate), shown when the seed or the locked set yields default rows,
 * and the full multiselect. The two screens loop rather than fall
 * through: the menu's back returns to the gate whenever the gate exists,
 * and only the lane's *first* screen propagates `back` to the caller -
 * and only when the orchestrator said there is somewhere to go
 * (`opts.allowBack`). A back with no target is not offered at all.
 * Cancellation propagates as the prompt's own throw.
 *
 * Both screens draw from `visibleList` and every selection they return is
 * widened by `carried`, so a hidden row (LLP 0202) is never shown and a
 * carried raw-only setup survives whichever screen confirms the selection,
 * the express auto-accept included.
 *
 * @ref LLP 0191#lane-loops [implements]: menu backs to gate; the lane's first screen backs out to the previous wizard step
 * @ref LLP 0202#carry-through [implements]: every confirming screen returns the carried hidden rows with the picks
 *
 * @param {{
 *   opts: RunWizardPickOptions,
 *   ask: AsyncPickPrompt,
 *   confirm: AsyncConfirmSelectPrompt,
 *   visibleList: PickerDescriptor[],
 *   descriptors: Map<string, PickerDescriptor>,
 *   seed: ReadonlySet<string>,
 *   detected: Set<PickerSource>,
 *   lockedSet: Set<string>,
 *   defaultRows: PickerDescriptor[],
 *   carried: string[],
 * }} args
 * @returns {Promise<{ rawSources: PickerSource[] } | { back: true }>}
 */
async function promptPickSelection({ opts, ask, confirm, visibleList, descriptors, seed, detected, lockedSet, defaultRows, carried }) {
  const withCarried = (/** @type {string[]} */ picked) =>
    /** @type {PickerSource[]} */ ([...new Set([...picked, ...carried])])
  // Defaults gate (LLP 0190 #pick-gate): when the seed (detection, or a
  // re-entry's previous selection) or the org's locked set yields a
  // usable default, state it in one line and let a bare enter accept it;
  // the full menu opens only on request. With no default there is
  // nothing to confirm, so the menu shows directly. `defaultRows` arrives
  // from `resolvePickSeeding` rather than being re-derived here: the
  // express gate accepts these exact rows, and LLP 0201 #gate is explicit
  // that "the defaults" must have one definition, not two that happen to
  // agree.
  const hasGate = defaultRows.length > 0
  // One source per line; the locked suffix matches the menu rows'. Built by
  // the shared labeller, so the express gate lists these exact rows.
  const gateItems = defaultRowLabels({ defaultRows, lockedSet })
  // The express gate already accepted this lane (LLP 0201): state the rows
  // the gate would have shown and take them. With no gate there is no
  // default to take, so the menu opens as it always would.
  // @ref LLP 0201#narrate [implements]: an auto-accepted gate prints its statement instead of prompting
  if (hasGate && opts.autoAccept) {
    narrateAcceptedGate({ stdout: opts.stdout, title: 'HypAware will record:', items: gateItems })
    return { rawSources: withCarried(defaultRows.map((d) => d.id)) }
  }
  let screen = hasGate ? 'gate' : 'menu'
  while (true) {
    if (screen === 'gate') {
      let choice
      try {
        choice = await confirm({
          title: 'HypAware will record:',
          ...(opts.progress ? { progress: opts.progress } : {}),
          items: gateItems,
          options: [
            {
              value: 'accept',
              label: 'Record all',
              // The gate is the happy path (enter, enter, finale), so it is
              // where the side-effect disclosure has to live: the rows stay
              // bare, but accepting must say the machine is being changed.
              // The per-row specifics stay on the menu rows' summaries.
              // @ref LLP 0190#pick-gate [implements]: the accept option carries the one-line configures-your-tools disclosure
              summary: 'Configures these tools to record through HypAware; the menu rows say how.',
            },
            { value: 'customize', label: 'Select what to record' },
          ],
          default: 'accept',
          ...(opts.allowBack ? { allowBack: true } : {}),
        })
      } catch (err) {
        if (isPromptBackError(err)) return { back: true }
        throw err
      }
      if (choice === 'accept') {
        return { rawSources: withCarried(defaultRows.map((d) => d.id)) }
      }
      screen = 'menu'
    } else {
      try {
        const sourceRaw = await ask({
          pickType: 'sources',
          // No keys in the title: the TUI's hint line and the numbered
          // fallback's own select instructions each carry their controls,
          // so a parenthetical here said it twice on every terminal.
          title: 'What do you want to collect?',
          // Carried on the question rather than composed into the title, so
          // the TUI paints it dim on its own line and the legacy numbered
          // fallback prints the same text as plain text.
          // @ref LLP 0135#progress [implements]: the pick lane's position rides the prompt spec, not the title
          ...(opts.progress ? { progress: opts.progress } : {}),
          options: visibleList.map((d) => buildPickOption(d, seed, detected, lockedSet)),
          ...(hasGate || opts.allowBack ? { allowBack: true } : {}),
        })
        return {
          rawSources: withCarried(sourceRaw.filter((v) => descriptors.has(v))),
        }
      } catch (err) {
        if (isPromptBackError(err)) {
          if (hasGate) {
            screen = 'gate'
            continue
          }
          return { back: true }
        }
        throw err
      }
    }
  }
}

/**
 * Build one picker row's prompt option from its descriptor. A locked row
 * is checked and disabled with the `· managed by your fleet` suffix; a
 * seeded row (from the config on a reconfigure, a prior confirmed
 * selection on a re-entry, or detection on a first run) is checked,
 * carrying the ` · detected` suffix only when detection put it there;
 * otherwise the bare descriptor label. The retired `· stays on this
 * machine` suffix is deliberately absent: under LLP 0188 an addition on a
 * managed machine syncs by default, and the sync-scope step after this
 * prompt is where local-only is offered.
 *
 * @param {PickerDescriptor} d
 * @param {ReadonlySet<string>} seed
 * @param {Set<PickerSource>} detected
 * @param {Set<string>} lockedSet
 * @returns {WalkthroughOption}
 */
function buildPickOption(d, seed, detected, lockedSet) {
  const locked = lockedSet.has(d.id)
  const seeded = seed.has(d.id)
  let label = d.label
  if (locked) {
    label += LOCKED_LABEL_SUFFIX
  } else if (detected.has(/** @type {PickerSource} */ (d.id))) {
    label += ' · detected'
  }
  return {
    value: d.id,
    label,
    ...(d.summary ? { summary: d.summary } : {}),
    ...(locked || seeded ? { checked: true } : {}),
    ...(locked ? { disabled: true } : {}),
  }
}

/**
 * Read the local config layer this run replaces, or `undefined` when there
 * is none to read. Deliberately forgiving: a missing, unreadable, or
 * unparseable file simply means "first run" for seeding purposes, and the
 * overwrite guard (which backs the file up) still runs over whatever is on
 * disk. Only the local layer is read - carrying central-layer plugins into
 * the local layer is exactly the collision join-before-pick avoids
 * (LLP 0129 #join-before-picker), and locked rows already arrive from the
 * join phase.
 *
 * @param {string} configPath
 * @returns {Promise<HypAwareV2Config | undefined>}
 */
async function readLocalConfig(configPath) {
  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(await fs.readFile(configPath, 'utf8'))
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const config = /** @type {HypAwareV2Config} */ (parsed)
  if (config.version !== 2) return undefined
  return config
}

/**
 * The retention window an existing config carries, when it states one.
 * A config without the key falls through to the pathway default: there is
 * no answer to preserve.
 *
 * @param {HypAwareV2Config | undefined} config
 * @returns {number | undefined}
 */
function configuredRetentionDays(config) {
  const days = config?.query?.cache?.retention?.default_days
  return typeof days === 'number' && Number.isFinite(days) ? days : undefined
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
 * Build the result returned when the user steps back out of the lane
 * (LLP 0191). Unlike a cancel this is not an exit: nothing is composed
 * or written, no notice is printed (the previous step redraws
 * immediately), and the orchestrator re-presents the step before pick.
 *
 * @param {RunWizardPickOptions} opts
 * @returns {Promise<WizardPickResult>}
 */
async function backResult(opts) {
  await withSpan(
    'wizard.pick.finish',
    {
      [Attr.COMPONENT]: 'wizard',
      [Attr.OPERATION]: 'wizard.pick.finish',
      sources_picked: 0,
      export_picked: '',
      clients_picked: 0,
      retention_days: opts.retentionDefault ?? DEFAULT_RETENTION_DAYS,
      config_path: '',
      status: 'backed',
    },
    async () => {},
    { component: 'wizard' }
  )
  return {
    exitCode: 0,
    back: true,
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
