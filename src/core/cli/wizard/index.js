// @ts-check

/**
 * @import { PluginCatalog } from '../../../../src/core/types.js'
 * @import { FinaleSummary } from '../../../../src/core/cli/types.js'
 * @import { CollectStatusOptions, HypAwareStatusReport } from '../../../../src/core/daemon/types.js'
 * @import {
 *   InitWizardResult,
 *   RunInitWizardOptions,
 *   WizardJoinResult,
 *   WizardPathway,
 *   WizardPickResult,
 * } from '../../../../src/core/cli/wizard/types.js'
 */

import { Attr, getLogger, withSpan } from '../../observability/index.js'
import { readObservabilityEnv } from '../../observability/env.js'
import { discoverBundledPlugins } from '../../runtime/bundled.js'
import { buildPluginCatalog } from '../../plugin_catalog.js'
import { collectHypAwareStatus } from '../../daemon/status.js'
import { formatFirstSyncDeadline, readFirstSyncDeadline } from '../../usage-policy/first_sync_hold.js'
import { LOCAL_INSTALL_RETENTION_DAYS, runPickerFinale, writeWalkthroughRunSummary } from '../walkthrough.js'
import { LOGIN_ORG_SELECTION_MESSAGE } from '../remote_commands.js'
import { useColor } from '../stdio.js'
import { evaluateReturningGate, runWizardFork } from './fork.js'
import { firstLookNoticeSink, firstLookRunnerFromCtx, runWizardFirstLook } from './first_look.js'
import { computeCentralLockedSources, runWizardJoin } from './join.js'
import { runWizardPick } from './pick.js'
import { runConfigurePhase } from './configure.js'
import { wizardStepProgress } from './steps.js'

/**
 * The `hyp init` wizard orchestrator: the fork -> join -> pick ->
 * configure -> finale -> first look -> privacy state machine (LLP 0135
 * #orchestration).
 *
 * Interactive runs front the phases with the returning gate (LLP 0129
 * #returning-gate): a configured solo machine's `Reconfigure` re-enters
 * the full fork exactly as a first run does, while a managed machine gets
 * only the scoped re-entry (org rows locked, local additions editable).
 * A failed or abandoned join returns to the fork rather than deciding for
 * the user (`@ref LLP 0129#failed-join-returns-to-fork` below).
 *
 * Non-interactive callers (`--yes`, `--dry-run`, presets, `--from-file`)
 * set `opts.picks` and short-circuit straight to the pick phase and
 * finale: no gate, no fork, no join, no configure phase (LLP 0131
 * #attended-only), matching the walkthrough's `interactive = !opts.picks`
 * split so every existing non-interactive shape is preserved.
 *
 * @ref LLP 0129#failed-join-returns-to-fork [implements]: an incomplete join prints why and re-presents the fork; the wizard never falls through to a pathway the user did not choose
 *
 * @param {RunInitWizardOptions} opts
 * @returns {Promise<InitWizardResult>}
 */
export async function runInitWizard(opts) {
  const log = getLogger('wizard')
  const interactive = !opts.picks
  const catalog = opts.catalog ?? (await loadWizardCatalog())

  /** @type {WizardPathway | undefined} */
  let pathway
  /** @type {string[] | undefined} */
  let locked
  let managed = false

  if (interactive) {
    const gateFn = opts.gate ?? evaluateReturningGate
    const gate = await gateFn({
      stdout: opts.stdout,
      stderr: opts.stderr,
      ...(opts.stdin ? { stdin: opts.stdin } : {}),
      env: opts.env,
      runtime: statusRuntimeFrom(opts),
    })
    if (gate.action === 'quit') return { exitCode: 0 }
    if (gate.action === 'status') {
      const code = opts.runStatus ? await opts.runStatus() : 0
      return { exitCode: code }
    }
    if (gate.action === 'scoped-reconfigure') {
      // Managed re-entry: no fork, org rows locked from the on-disk
      // central layer, additions editable (LLP 0129 #returning-gate).
      pathway = 'scoped'
      managed = true
      locked = await computeLockedSafe(catalog, opts)
    } else if (gate.action === 'first-run' && gate.managed) {
      // A managed machine whose config is missing or fails to merge lands
      // on the first-run path (the gate has no config to summarise), but
      // the central layer on disk still owns its rows. Lock them here too:
      // an editable org row that the user picks composes into the local
      // layer, and the next central pull overrides or collides with it.
      // The pathway stays unset, so the fork still runs.
      // @ref LLP 0129#join-before-picker [implements]: the first-run path locks the org rows from the on-disk central layer rather than offering them for composition
      managed = true
      locked = await computeLockedSafe(catalog, opts)
    }

    // 'first-run' and a solo machine's 'reconfigure' both enter here.
    while (!pathway) {
      const forkFn = opts.fork ?? runWizardFork
      const choice = await forkFn({
        stdout: opts.stdout,
        stderr: opts.stderr,
        ...(opts.stdin ? { stdin: opts.stdin } : {}),
        env: opts.env,
      })
      if (choice === 'quit') return { exitCode: 0 }
      if (choice === 'local') {
        pathway = 'local'
        break
      }
      // The fork itself carries no counter: the pathway it asks for is what
      // fixes the total. One line later the answer is `team`, so from here
      // the itinerary is known and every remaining lane can state its
      // position. A failed join drops back to the fork, which again states
      // nothing, so a retry onto a different pathway never contradicts a
      // total already on screen.
      // @ref LLP 0135#progress [implements]: the denominator resolves the moment the fork does, not before
      const joinProgress = wizardStepProgress('team', 'join')
      const joinFn = opts.join ?? runWizardJoin
      const join = await joinFn({
        stdout: opts.stdout,
        stderr: opts.stderr,
        ...(opts.stdin ? { stdin: opts.stdin } : {}),
        env: opts.env,
        catalog,
        ctx: opts.ctx,
        ...(joinProgress ? { progress: joinProgress } : {}),
      })
      if (join.status !== 'ok') {
        printJoinFailure(opts, join)
        continue
      }
      pathway = 'team'
      locked = join.lockedSources
      managed = join.managed === true
    }
  }

  // Every remaining lane's position, resolved once. `pathway` is undefined
  // on non-interactive runs, so these are undefined too and nothing is
  // threaded: the scripted `--yes` / `--dry-run` / preset / `--from-file`
  // output is byte-identical to what it was before the breadcrumb existed
  // (LLP 0131 #attended-only).
  const pickProgress = wizardStepProgress(pathway, 'pick')
  const finaleProgress = wizardStepProgress(pathway, 'finale')

  const pickFn = opts.pick ?? runWizardPick
  const picked = await pickFn({
    stdout: opts.stdout,
    stderr: opts.stderr,
    ...(opts.stdin ? { stdin: opts.stdin } : {}),
    env: opts.env,
    ...(pickProgress ? { progress: pickProgress } : {}),
    ...(catalog ? { catalog } : {}),
    ...(locked ? { locked } : {}),
    ...(managed ? { managed } : {}),
    ...(pathway === 'scoped' ? { scoped: true } : {}),
    ...(opts.picks ? { picks: opts.picks } : {}),
    ...(opts.exportOrigin ? { exportOrigin: opts.exportOrigin } : {}),
    ...(opts.force ? { force: opts.force } : {}),
    ...(opts.prompt ? { prompt: opts.prompt } : {}),
    // Retention is never asked; the pathway decides the default. A local
    // install keeps the longer 120-day window (the cache is the only copy
    // of history); team and scoped runs fall through to the pick phase's
    // 90-day default (the org server holds the durable copy).
    // @ref LLP 0137#pathway-defaults [implements]: 90-day team / 120-day local retention defaults
    ...(pathway === 'local' ? { retentionDefault: LOCAL_INSTALL_RETENTION_DAYS } : {}),
    ...(opts.detect ? { detect: opts.detect } : {}),
    ...(opts.confirmOverwrite ? { confirmOverwrite: opts.confirmOverwrite } : {}),
  })
  if (picked.cancelled || picked.exitCode !== 0) {
    return {
      exitCode: picked.exitCode,
      ...(picked.cancelled ? { cancelled: true } : {}),
      ...(pathway ? { pathway } : {}),
    }
  }

  // Attended-only (LLP 0131): the configure phase itself no-ops when
  // `picks` is set, so threading it through keeps the rule in one place.
  const configureFn = opts.configure ?? runConfigurePhase
  const configured = await configureFn(picked, {
    stdout: opts.stdout,
    ctx: opts.ctx,
    ...(opts.printCommands ? { printCommands: true } : {}),
    ...(opts.picks ? { picks: opts.picks } : {}),
  })

  /** @type {FinaleSummary | undefined} */
  let finaleSummary
  if (opts.finale) {
    finaleSummary = await runWizardFinale({
      opts,
      picked,
      joinedAlready: pathway === 'team',
      ...(finaleProgress ? { progress: finaleProgress } : {}),
    })
  }

  const cancelled = finaleSummary?.cancelled === true
  if (cancelled) {
    try {
      opts.stderr.write('hyp init: cancelled\n')
    } catch {
      // best-effort: stderr might be closed during cleanup
    }
  }
  writeWalkthroughRunSummary({ stdout: opts.stdout, configPath: picked.configPath, finaleSummary })

  // End an attended setup on the user's own rows, not on a command they
  // still have to type. Attended and non-dry-run only: a scripted `--yes`
  // install gets no extra output, and a dry run has no writes to look at.
  // @ref LLP 0135#first-look [implements]: placed after the finale (backfill has landed) and before the privacy narration, which stays the last words
  if (interactive && !cancelled && opts.finale?.dryRun !== true) {
    const notices = firstLookNoticeSink(opts.stderr)
    await runWizardFirstLook({
      runner: opts.firstLook ?? firstLookRunnerFromCtx(opts.ctx, notices),
      stdout: opts.stdout,
      color: useColor(opts.stdout, opts.env),
    })
    // The abandoned queries from an expired deadline keep running and can
    // still resolve with a withheld-row report. Close the sink so that
    // report cannot land after the privacy narration below, which is
    // documented to be the last thing on screen.
    notices.close()
  }

  // The wizard's last words on the team pathway: when the first upload
  // happens and that nothing has shipped yet (LLP 0100/0101, narration
  // only - the hold itself was written by the join lane's login).
  if (pathway === 'team') await narratePrivacyIfTeamPath(opts)

  log.info('wizard.finish', {
    [Attr.COMPONENT]: 'wizard',
    pathway: pathway ?? 'non-interactive',
    sources_picked: picked.sourcesPicked.length,
    locked_count: picked.lockedSources.length,
    cancelled,
  })

  return {
    exitCode: cancelled ? 130 : 0,
    ...(pathway ? { pathway } : {}),
    ...(cancelled ? { cancelled: true } : {}),
    configPath: picked.configPath,
    config: picked.config,
    sourcesPicked: picked.sourcesPicked,
    clientsPicked: picked.clientsPicked,
    lockedSources: picked.lockedSources,
    configureResults: configured.results,
    ...(finaleSummary ? { finale: finaleSummary } : {}),
  }
}

/**
 * Explain an incomplete join before the fork is re-presented. The login
 * lane already printed its own detailed error (the join phase tees it
 * through), so this adds only the wizard-level consequence: what the
 * failure class means for the user's next choice. A multi-org account
 * (`org_selection_required`) is definitive for the wizard - the bare
 * login it wraps cannot pass `--org` - so the fix is the manual login,
 * after which re-running `hyp init` re-enters as an enrolled machine.
 *
 * @param {RunInitWizardOptions} opts
 * @param {WizardJoinResult} join
 */
function printJoinFailure(opts, join) {
  if (join.status !== 'failed') {
    opts.stderr.write('Sign-in did not complete. You can try again, or set up locally for now.\n')
    return
  }
  if (join.detail?.includes(LOGIN_ORG_SELECTION_MESSAGE)) {
    opts.stderr.write('Joining failed: this account belongs to more than one org. Run `hyp remote login --org <name>` first, then re-run `hyp init`.\n')
    return
  }
  opts.stderr.write('Joining failed: an admin needs to grant this account access before this machine can enroll.\n')
}

/**
 * The wizard finale: the walkthrough's finale machinery plus the team
 * pathway's skips. When the machine joined in this run, `hyp status` is
 * consulted once so steps enrollment already performed are skipped rather
 * than re-run: an installed daemon skips only the install step (the
 * restart still runs so the just-written local config takes effect), and
 * already-attached clients skip attach (LLP 0134 #login-lane: the finale
 * detects and skips what enrollment already did).
 *
 * @param {{
 *   opts: RunInitWizardOptions,
 *   picked: WizardPickResult,
 *   joinedAlready: boolean,
 *   progress?: string,
 * }} args
 * @returns {Promise<FinaleSummary>}
 */
async function runWizardFinale({ opts, picked, joinedAlready, progress }) {
  const finaleActions = { ...(opts.finale ?? {}) }
  /** @type {Set<string> | undefined} */
  let skipAttachClients
  if (joinedAlready) {
    const report = await collectStatusSafe(opts)
    if (report?.daemon?.installed) finaleActions.skipDaemonInstall = true
    const attached = (report?.clients ?? []).filter((c) => c.attached).map((c) => c.name)
    if (attached.length > 0) skipAttachClients = new Set(attached)
  }

  const runFinale = opts.finaleRunner ?? runPickerFinale
  return withSpan(
    'wizard.finale',
    {
      [Attr.COMPONENT]: 'wizard',
      [Attr.OPERATION]: 'wizard.finale',
      joined_already: joinedAlready,
      skip_daemon_install: finaleActions.skipDaemonInstall === true,
      skip_attach_count: skipAttachClients?.size ?? 0,
      status: 'ok',
    },
    () =>
      runFinale({
        finale: finaleActions,
        clientsPicked: picked.clientsPicked,
        capabilities: opts.capabilities,
        ...(opts.sources ? { sources: opts.sources } : {}),
        ...(opts.skills ? { skills: opts.skills } : {}),
        ...(opts.agents ? { agents: opts.agents } : {}),
        config: picked.config,
        configPath: picked.configPath,
        env: opts.env,
        stdout: opts.stdout,
        stderr: opts.stderr,
        retentionDays: picked.retentionDays,
        interactive: !opts.picks,
        ...(opts.stdin ? { stdin: opts.stdin } : {}),
        ...(opts.backfill ? { backfill: opts.backfill } : {}),
        ...(opts.backfillConsentPrompt ? { backfillConsentPrompt: opts.backfillConsentPrompt } : {}),
        ...(skipAttachClients ? { skipAttachClients } : {}),
        ...(progress ? { progress } : {}),
      }),
    { component: 'wizard' }
  )
}

/**
 * State, clearly, that nothing has been uploaded and when the first
 * upload happens. Reads the first-sync hold the join lane's login wrote
 * (LLP 0101); when no hold is live (solo servers, or an already-elapsed
 * deadline) it stays silent rather than inventing a claim.
 *
 * @ref LLP 0101#deadline [constrained-by]: narration only; the hold marker and its absolute deadline are the login lane's
 *
 * @param {Pick<RunInitWizardOptions, 'stdout' | 'env'>} opts
 */
async function narratePrivacyIfTeamPath(opts) {
  let deadline = null
  try {
    const obsEnv = readObservabilityEnv(opts.env)
    deadline = await readFirstSyncDeadline({ stateDir: obsEnv.stateDir })
  } catch {
    // Unreadable state dir: skip the narration rather than fail the run.
  }
  if (typeof deadline !== 'number') return
  opts.stdout.write(
    '\n' +
    'Nothing has been uploaded yet - nothing leaves this machine before\n' +
    `${formatFirstSyncDeadline(deadline)}. That first sync includes your imported history.\n` +
    'To review or exclude anything before then, run the hypaware-privacy\n' +
    'skill in Claude or Codex. `hyp status` shows the countdown.\n' +
    'To send it sooner, run `hyp sync`: it shows what would leave and asks\n' +
    'before sending anything.\n'
  )
}

/**
 * Build the bundled-plugin catalog the join and pick phases read.
 * Discovery failure degrades to an empty catalog (the pick phase then
 * shows no rows and the join phase locks nothing) instead of aborting
 * onboarding.
 *
 * @returns {Promise<PluginCatalog>}
 */
async function loadWizardCatalog() {
  try {
    const bundled = await discoverBundledPlugins()
    return buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
  } catch {
    return {
      plugins: new Map(),
      pluginMetadata: new Map(),
      knownDatasets: new Set(),
      clientDescriptors: new Map(),
      pickerDescriptors: new Map(),
    }
  }
}

/**
 * The locked-set computation for every entry that reaches the picker on
 * an already-managed machine without a join (the scoped re-entry, and the
 * first-run path a managed machine falls to when its merged config no
 * longer validates), guarded: a resolution failure renders an unlocked
 * picker (additions still compose; the export seam, not the picker,
 * enforces the org boundary, LLP 0132).
 *
 * @param {PluginCatalog} catalog
 * @param {Pick<RunInitWizardOptions, 'env'>} opts
 * @returns {Promise<string[]>}
 */
async function computeLockedSafe(catalog, opts) {
  try {
    return await computeCentralLockedSources({ env: opts.env, catalog })
  } catch {
    return []
  }
}

/**
 * The kernel-registry bundle `collectHypAwareStatus` reads, built from
 * the command context when its members are present.
 *
 * @param {RunInitWizardOptions} opts
 * @returns {CollectStatusOptions['runtime']}
 */
function statusRuntimeFrom(opts) {
  const ctx = /** @type {any} */ (opts.ctx ?? {})
  return {
    sources: ctx.sources,
    sinks: ctx.sinks,
    capabilities: ctx.capabilities ?? opts.capabilities,
    query: ctx.query,
    storage: ctx.storage,
  }
}

/**
 * Status collection for the finale's joined-already skips, best-effort: a
 * status failure means nothing is skipped and the idempotent finale steps
 * simply re-run.
 *
 * @param {RunInitWizardOptions} opts
 * @returns {Promise<HypAwareStatusReport | undefined>}
 */
async function collectStatusSafe(opts) {
  try {
    return await collectHypAwareStatus({ env: opts.env, runtime: statusRuntimeFrom(opts) })
  } catch {
    return undefined
  }
}
