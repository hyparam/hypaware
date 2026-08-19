// @ts-check

/**
 * @import { PluginCatalog } from '../../../../src/core/types.js'
 * @import { FinaleSummary, PickerSource } from '../../../../src/core/cli/types.js'
 * @import { CollectStatusOptions, HypAwareStatusReport } from '../../../../src/core/daemon/types.js'
 * @import {
 *   FirstAskResult,
 *   FirstLookOutcome,
 *   FirstLookResult,
 *   InitWizardResult,
 *   RunInitWizardOptions,
 *   WizardJoinResult,
 *   WizardPathway,
 *   WizardPickResult,
 *   WizardSyncNowResult,
 * } from '../../../../src/core/cli/wizard/types.js'
 * @import { FolderAskMode } from '../../../../src/core/usage-policy/types.js'
 */

import { Attr, getLogger, withSpan } from '../../observability/index.js'
import { readObservabilityEnv } from '../../observability/env.js'
import { discoverBundledPlugins } from '../../runtime/bundled.js'
import { buildPluginCatalog } from '../../plugin_catalog.js'
import { collectHypAwareStatus } from '../../daemon/status.js'
import { formatFirstSyncDeadline, readFirstSyncDeadline } from '../../usage-policy/first_sync_hold.js'
import { readFolderAskModeSafe } from '../../usage-policy/folder_ask.js'
import {
  LOCAL_INSTALL_RETENTION_DAYS,
  buildWalkthroughClientDescriptorMap,
  defaultConfirmSelectPromptFactory,
  defaultPickerDetect,
  runPickerFinale,
  writeAttachedNotConfiguredReminder,
  writeWalkthroughRunSummary,
} from '../walkthrough.js'
import { isPromptBackError, isPromptCancelledError } from '../tui/runtime.js'
import { useColor } from '../stdio.js'
import { evaluateReturningGate, runWizardFork } from './fork.js'
import { runWizardFirstAsk } from './first_ask.js'
import { firstLookNoticeSink, firstLookRunnerFromCtx, runWizardFirstLook } from './first_look.js'
import { computeCentralLockedSources, runWizardJoin } from './join.js'
import { commitWizardPickedConfig, defaultRowLabels, resolvePickSeeding, runWizardPick } from './pick.js'
import { runWizardSyncNow } from './sync_now.js'
import { runWizardSyncScope } from './sync_scope.js'
import { runWizardFolderAsk } from './folder_ask.js'
import { runWizardExpressGate } from './express.js'
import { runConfigurePhase } from './configure.js'
import { wizardStepProgress } from './steps.js'

/**
 * The `hyp init` wizard orchestrator: the fork -> join -> pick ->
 * configure -> finale -> first look -> privacy state machine (LLP 0135
 * #orchestration).
 *
 * Interactive runs front the phases with the returning gate (LLP 0129
 * #returning-gate, amended by LLP 0182): a configured machine's
 * `Reconfigure` re-enters the full fork exactly as a first run does,
 * managed or not. Being managed no longer picks a different pathway; it
 * only pre-locks the org's picker rows, leaving local additions editable.
 * A failed or abandoned join returns to the fork rather than deciding for
 * the user (`@ref LLP 0129#failed-join-returns-to-fork` below).
 *
 * Non-interactive callers (`--yes`, `--dry-run`, presets, `--from-file`)
 * set `opts.picks` and short-circuit straight to the pick phase and
 * finale: no gate, no fork, no join, no configure phase (LLP 0131
 * #attended-only), matching the walkthrough's `interactive = !opts.picks`
 * split so every existing non-interactive shape is preserved.
 *
 * Attended runs open the question lanes with the express gate (LLP 0201):
 * one yes accepts every lane's stated default, so the lanes narrate what
 * their gates would have said instead of prompting. Declining runs them
 * as they are.
 *
 * Attended runs can also step *back* (LLP 0191): escape at a question
 * lane returns to the lane before it (folders to sync, sync to pick, pick
 * to the express gate - or to the fork when this pass showed no gate - and
 * the gate itself to the fork, the fork to a reconfigure run's gate), with
 * a completed join reused rather than re-run and confirmed picks
 * re-seeding the re-entered lane. Ctrl+C stays the cancel.
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
  let gateShown = false

  /**
   * Run the returning gate and absorb its terminal choices. Returns the
   * wizard result when the gate ended the run, else null to continue to
   * the fork. A closure because back-navigation re-presents it: escape
   * at the fork of a reconfigure run returns here (LLP 0191).
   *
   * @returns {Promise<InitWizardResult | null>}
   */
  const runGate = async () => {
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
    // Only a configured machine's gate showed a menu; a first run falls
    // straight through, so its fork has no screen to back into.
    gateShown = gate.action === 'reconfigure'
    if (gate.managed) {
      // A managed machine reconfigures through the same fork as anyone
      // else (LLP 0182), but carries its org's rows in as a locked set:
      // the central layer wins the merge (LLP 0031), so an editable row
      // would only write a local entry the next pull overrides. This
      // covers the first-run path too - a managed machine whose config is
      // missing or fails to merge has no config to summarise, but the
      // central layer on disk still owns its rows.
      // @ref LLP 0182#one-reconfigure [implements]: `managed` decides the locked set, not the pathway
      // @ref LLP 0129#join-before-picker [implements]: the first-run path locks the org rows from the on-disk central layer rather than offering them for composition
      managed = true
      locked = await computeLockedSafe(catalog, opts)
    }
    return null
  }

  if (interactive) {
    const gateExit = await runGate()
    if (gateExit) return gateExit
  }

  /**
   * A completed join, remembered across back-navigation: the sign-in is
   * a completed transaction (LLP 0063 D3), so stepping back past the
   * join and forward again reuses it instead of re-running the login.
   * Cleared only by the fork's explicit disconnect, which is `hyp leave`.
   * @type {{ lockedSources: string[], managed: boolean } | undefined}
   */
  let joined
  /**
   * The last selection the pick lane confirmed, so a back into pick
   * re-seeds the boxes with the user's answer instead of re-detecting.
   * @type {PickerSource[] | undefined}
   */
  let pickSeed
  /** @type {WizardPickResult | undefined} */
  let picked
  /** @type {string[]} */
  let sourcesOptedOut = []
  /**
   * The standing new-folder answer this run left behind (LLP 0200), for
   * the finish log. Undefined on runs that never reach the lane.
   * @type {FolderAskMode | undefined}
   */
  let folderAsk
  /**
   * The question lanes' policy writes, held until the config commit
   * (LLP 0279 #one-commit-point). Each lane answers, states its answer,
   * and hands its write back; the orchestrator runs them once the config
   * this run composed is on disk, so an abandoned run leaves every store
   * as it found it. Re-assigned, never appended: a back through the lanes
   * re-answers them, and only the last answer is the one to write.
   *
   * Both commits resolve to what the write actually left in force rather
   * than to the answer, so a write that fails is reported as the state
   * that stands and not as the one it could not keep.
   * @type {(() => Promise<string[]>) | undefined}
   */
  let syncCommit
  /** @type {(() => Promise<FolderAskMode>) | undefined} */
  let folderCommit
  /**
   * Did this pass through the lanes accept the express gate (LLP 0201)?
   * Re-answered on every pass, so stepping back to the fork and forward
   * again can answer it differently, and read after the loop so the
   * finale's position line stays consistent with the lanes'.
   */
  let express = false
  /**
   * Detection, run at most once per wizard run and shared by the express
   * gate's row list and the pick lane that consumes the same rows: two
   * probes could return different sets, and the gate would then be
   * accepting rows the lane never offers.
   * @type {Promise<Set<PickerSource>> | undefined}
   */
  let detectOnce
  /** @type {(args: { env: NodeJS.ProcessEnv }) => Promise<Set<PickerSource>>} */
  const detect = (args) => {
    if (!detectOnce) detectOnce = (opts.detect ?? defaultPickerDetect)(args)
    return detectOnce
  }

  /**
   * Is this machine enrolled right now? The property every enrolled-state
   * decision below actually needs, which `managed` alone is not: `managed`
   * says "a central layer owns rows here", and the two diverge on a join
   * whose org-config converge timed out. That join still returns
   * `status: 'ok'` with no `managed` (`runWizardJoin`, the "didn't hear
   * back from your org's config" return), because nothing landed to lock -
   * but the sign-in completed, so the machine is enrolled and its export
   * seam goes live as soon as the central layer arrives. Keying the
   * disconnect offer and the sync lane on `managed` let that machine step
   * back to the fork, pick Local, and finish with neither question asked.
   * The remembered join is the enrollment record (cleared only by the
   * fork's `hyp leave`), so it is what these decisions read.
   *
   * @ref LLP 0191#join-not-undone [implements]: choosing Local after a completed join keeps the disconnect offer and the sync lane, keyed on the remembered join rather than the final pathway
   * @returns {boolean}
   */
  const enrolled = () => managed || joined !== undefined

  // The question lanes and their back edges (LLP 0191 #back-edges):
  // escape steps one *screen* back - folders to sync (`continue atSync`,
  // or past it to pick when the sync lane asked nothing), sync to pick
  // (`continue atPick`), pick to the express gate (`continue atExpress`,
  // or straight to the fork when that pass has no gate to show),
  // the express gate to the fork (`continue atFork`), the fork to the
  // returning gate -
  // while ctrl+c keeps cancelling the run. A lane that narrates instead of
  // asking is not a screen, so the edges step past it rather than re-running
  // it: landing on one is how escape stops being a step and becomes a
  // redraw. Everything after the loop
  // (config commit, configure, finale) acts rather than asks, so
  // back-navigation ends at the commit point (LLP 0190 #commit-point).
  // @ref LLP 0191#back-edges [implements]: the orchestrator's loop carries every step-level back transition
  atFork: while (true) {
    if (interactive) {
      pathway = undefined
      // 'first-run' and 'reconfigure' both enter here, managed or not.
      while (!pathway) {
        const forkFn = opts.fork ?? runWizardFork
        const choice = await forkFn({
          stdout: opts.stdout,
          stderr: opts.stderr,
          ...(opts.stdin ? { stdin: opts.stdin } : {}),
          env: opts.env,
          ...(gateShown ? { allowBack: true } : {}),
        })
        if (choice === 'back') {
          // Offered only when the gate showed its menu; re-present it.
          const gateExit = await runGate()
          if (gateExit) return gateExit
          continue
        }
        if (choice === 'quit') return { exitCode: 0 }
        if (choice === 'team' && joined) {
          // Stepped back past a completed join and forward again: the
          // enrollment stands (LLP 0063 D3), so say so instead of
          // re-opening the login.
          // @ref LLP 0191#join-not-undone [implements]: a remembered join is reused, never re-run
          opts.stdout.write('Already signed in - continuing.\n')
          pathway = 'team'
          locked = joined.lockedSources
          managed = joined.managed
          break
        }
        if (choice === 'local') {
          // A managed machine choosing local is stating a destination, and
          // "local" can honestly mean two things: adjust this machine while
          // the org's config stays, or actually switch to local-only. One
          // yes/no at the moment of intent decides which; yes runs the real
          // `hyp leave` teardown, so disconnection stays a named act rather
          // than a side effect. Declining keeps the fleet connection and
          // the org's rows locked, exactly as before; escape steps back to
          // the fork and ctrl+c ends the run, neither of them disconnecting.
          // @ref LLP 0190#fork-disconnect [implements]: local-on-managed asks "disconnect?" once; yes is hyp leave, no is the managed local pathway
          if (enrolled()) {
            const confirm = opts.confirm ?? defaultConfirmSelectPromptFactory(opts)
            /** @type {string | number} */
            let disconnect
            try {
              disconnect = await confirm({
                title: 'This machine syncs to your team server. Disconnect and go local-only?',
                options: [
                  { value: 'stay', label: 'No, stay connected' },
                  { value: 'disconnect', label: 'Yes, disconnect' },
                ],
                default: 'stay',
                // The fork is always behind this question, so escape backs
                // into it instead of cancelling (LLP 0191).
                allowBack: true,
              })
            } catch (err) {
              if (isPromptBackError(err)) continue
              if (!isPromptCancelledError(err)) throw err
              // Ctrl+C ends the run; it does not step back. Sharing the
              // back arm's `continue` re-presented the fork, which is
              // exactly the "mouse-path through N back-steps" LLP 0191
              // #esc-back says ctrl+c exists to avoid, and left the only
              // way out of a two-screen loop as a second ctrl+c. Nothing
              // is disconnected on this path, which is all LLP 0190
              // #fork-disconnect asks of a cancel; the exit code and the
              // narration are the wizard's standard cancel (LLP 0191
              // #consequences: a cancelled run still exits 130).
              // @ref LLP 0191#esc-back [implements]: ctrl+c cancels the run at the disconnect question rather than acting as a back-step
              if (joined) await narrateEnrolledAbort(opts)
              opts.stderr.write('hyp init: cancelled\n')
              return { exitCode: 130, cancelled: true }
            }
            if (disconnect === 'disconnect') {
              const leaveFn = opts.leave ?? (() => opts.ctx.commands.run('leave', []))
              const code = await leaveFn()
              if (code !== 0) {
                opts.stderr.write('hyp init: leaving the server failed - this machine is still connected. Retry, or continue without disconnecting.\n')
                continue
              }
              // Disconnected: the org's rows are no longer locked and the
              // rest of the run is a true solo install (no sync lane, the
              // local 120-day retention default). A join earlier in this
              // run is undone by the leave, so it is forgotten too.
              managed = false
              locked = undefined
              joined = undefined
            }
          }
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
        joined = { lockedSources: join.lockedSources ?? [], managed: join.managed === true }
      }
    }

    // The express gate (LLP 0201) is a screen in its own right, so it gets
    // a loop level of its own between the fork and the pick lane. Back
    // edges mirror the forward edges one screen at a time (LLP 0191
    // #back-edges): inserting a question into the forward chain without
    // inserting it into the back chain would make both of its neighbours
    // overshoot - escape at pick would reach past the gate to the fork,
    // and escape at sync would land on the gate instead of the picker.
    // @ref LLP 0201#edges [implements]: the gate sits on the back chain - it backs to the fork, and the lane after it backs to the gate
    //
    // Did the pick lane's escape bring us to this pass? The gate's rows are
    // the picker's own defaults, so a pass that follows a confirmed empty
    // selection has nothing left to accept and shows no gate - and falling
    // forward into the picker again would make that escape a redraw rather
    // than a step. Behind a gate that cannot render is the fork.
    let backFromPick = false
    atExpress: while (true) {
      // One question, before the lanes, that accepts every lane's stated
      // default. Asked once per pass through the lanes and only on an
      // attended run; declining runs the lanes exactly as before. Like the
      // fork, it carries no counter - it is what decides how many
      // questions remain, so it cannot state a total (LLP 0135
      // #progress), and an express run suppresses the remaining position
      // lines because nothing after it is a question.
      // @ref LLP 0201#gate [implements]: the express gate precedes the lanes and answers all of them
      express = false
      // Did this pass actually show the gate? With nothing detected and
      // nothing locked there is none (LLP 0201 #no-default-no-accept), and
      // the pick lane's back edge then reaches the fork directly, exactly
      // as it did before the gate existed.
      let expressShown = false
      // Enrolled runs are the runs with several gates to collapse: their
      // itineraries add the sync and new-folder lanes. A solo local run's
      // only question is the pick gate, which offers these same rows
      // itself, so fronting it with this gate asked the same question
      // twice - declining "Record all of these" landed on "Record all".
      // The condition is the sync lane's own condition (see `pathway ===
      // 'team' || enrolled()` below), restated here so the two can only
      // drift apart if someone edits one and forgets the other.
      // @ref LLP 0201#one-lane-no-gate [implements]: the gate is shown only when it collapses more than one lane's gate
      if (interactive && (pathway === 'team' || enrolled())) {
        // The rows accepting would record: the pick lane's own default
        // rows, computed once here and listed verbatim on the gate, so
        // "all of these" names something the user can read rather than an
        // abstract "defaults". Resolution failure degrades to no gate.
        const rows = await expressRowsSafe({ opts, catalog, locked, pickSeed, detect })
        // Nothing detected and nothing locked is nothing to accept, so
        // there is no gate to show; the pick lane opens its menu as it
        // always would (LLP 0201 #no-default-no-accept).
        if (rows.length > 0) {
          const expressFn = opts.express ?? runWizardExpressGate
          // The standing new-folder answer, so the gate's one line of
          // consequence names what accepting leaves in force rather than
          // the shipped default (LLP 0279 #standing-answer). Read here and
          // not in the lane: the gate has to state it before the lane
          // runs, and the safe read never throws.
          const standingFolderAsk = await readFolderAskModeSafe({
            stateDir: readObservabilityEnv(opts.env).stateDir,
          })
          const choice = await expressFn({
            stdout: opts.stdout,
            stderr: opts.stderr,
            ...(opts.stdin ? { stdin: opts.stdin } : {}),
            env: opts.env,
            rows,
            enrolled: enrolled(),
            folderAsk: standingFolderAsk,
            // The fork is always behind this question.
            allowBack: true,
            ...(opts.confirm ? { confirm: opts.confirm } : {}),
          })
          if (choice === 'back') continue atFork
          if (choice === 'cancelled') {
            if (joined) await narrateEnrolledAbort(opts)
            opts.stderr.write('hyp init: cancelled\n')
            return { exitCode: 130, cancelled: true, ...(pathway ? { pathway } : {}) }
          }
          expressShown = true
          express = choice === 'defaults'
        } else if (backFromPick) {
          // Stepped back out of the picker onto a gate this pass cannot
          // show: the screen behind it is the fork (LLP 0201 #edges).
          continue atFork
        }
      }
      backFromPick = false

      atPick: while (true) {
        // A pass that re-answers the lanes replaces their held writes, and
        // a pass that never reaches them (a back through the fork onto a
        // solo local run) must not carry the previous pass's answers
        // forward. `sourcesOptedOut` and `folderAsk` go with them: they are
        // what the finish log reports, and now that the writes are held
        // rather than made on the spot, an abandoned pass's answers were
        // never recorded anywhere - so carrying them forward would report a
        // policy this machine was never put under.
        syncCommit = undefined
        folderCommit = undefined
        sourcesOptedOut = []
        folderAsk = undefined
        // The lanes' positions, resolved when their pathway is: a back
        // through the fork can land on the other pathway, whose itinerary
        // then states its own positions - exactly as a failed join's retry
        // does. `pathway` is undefined on non-interactive runs, so the lines
        // are undefined too and nothing is threaded: the scripted `--yes` /
        // `--dry-run` / preset / `--from-file` output is byte-identical to
        // what it was before the breadcrumb existed (LLP 0131
        // #attended-only). `managed` is part of the itinerary: it adds the
        // sync lane to a managed machine's local-pathway run (LLP 0188).
        // An express run answers no more questions, so it states no more
        // positions: a "Step 3 of 5" above a narration would count screens
        // nobody is answering.
        const step = (/** @type {'pick' | 'sync' | 'folders' | 'finale'} */ name) =>
          express ? undefined : wizardStepProgress(pathway, name, { managed: enrolled() })
        const pickProgress = step('pick')
        const syncProgress = step('sync')
        const foldersProgress = step('folders')

        const pickFn = opts.pick ?? runWizardPick
        picked = await pickFn({
          stdout: opts.stdout,
          stderr: opts.stderr,
          ...(opts.stdin ? { stdin: opts.stdin } : {}),
          env: opts.env,
          ...(pickProgress ? { progress: pickProgress } : {}),
          ...(catalog ? { catalog } : {}),
          ...(locked ? { locked } : {}),
          ...(managed ? { managed } : {}),
          ...(opts.picks ? { picks: opts.picks } : {}),
          ...(opts.exportOrigin ? { exportOrigin: opts.exportOrigin } : {}),
          ...(opts.force ? { force: opts.force } : {}),
          ...(opts.prompt ? { prompt: opts.prompt } : {}),
          ...(opts.confirm ? { confirm: opts.confirm } : {}),
          // Retention is never asked; the default follows where the durable
          // copy lives. Only an unmanaged local install keeps the longer
          // 120-day window (its cache is the only copy of history); a team run,
          // and a managed machine that reconfigures down the local path, fall
          // through to the pick phase's 90-day default because the org server
          // holds the durable copy either way.
          // @ref LLP 0137#pathway-defaults [implements]: 90-day team / 120-day local retention defaults
          // @ref LLP 0182#one-reconfigure [constrained-by]: a managed machine can now reach the local pathway, so enrollment and not the pathway label decides
          ...(pathway === 'local' && !enrolled() ? { retentionDefault: LOCAL_INSTALL_RETENTION_DAYS } : {}),
          // The shared, run-once detector (never `opts.detect` directly), so
          // the pick lane's rows are the rows the express gate listed.
          ...(interactive ? { detect } : opts.detect ? { detect: opts.detect } : {}),
          ...(opts.confirmOverwrite ? { confirmOverwrite: opts.confirmOverwrite } : {}),
          // Back-navigation is attended-only by construction (it takes a
          // keypress); the lane's first screen backs out to the fork.
          ...(interactive ? { allowBack: true } : {}),
          ...(express ? { autoAccept: true } : {}),
          ...(pickSeed ? { initialSelection: pickSeed } : {}),
          // The write commits below, after the sync lane: the overwrite confirm
          // is then the last question, and a cancel at the sync lane leaves the
          // existing config untouched (LLP 0190 #commit-point).
          deferWrite: true,
        })
        // One screen back is the express gate when this pass showed one,
        // and the fork when it did not (LLP 0191 #back-edges).
        if (picked.back) {
          if (expressShown) {
            backFromPick = true
            continue atExpress
          }
          continue atFork
        }
        if (picked.cancelled || picked.exitCode !== 0) {
          // A join this run has already enrolled this machine; the abort
          // cannot undo that, so it must not be silent about it.
          if (joined) await narrateEnrolledAbort(opts)
          return {
            exitCode: picked.exitCode,
            ...(picked.cancelled ? { cancelled: true } : {}),
            ...(pathway ? { pathway } : {}),
          }
        }
        // Remember the confirmed selection: a back into pick - from the sync
        // lane, or a later pass through the fork - re-seeds with it.
        pickSeed = picked.sourcesPicked

        // The sync-scope step (LLP 0188 #never-silent): on every enrolled run -
        // the team pathway, or an already-enrolled machine on any pathway - ask
        // which of the picked, non-locked sources stay local-only. Whether the
        // run is enrolled is `enrolled()`, not `managed`: see its definition for
        // the join whose org-config converge timed out, which is enrolled with
        // no central layer yet. Default-sync means an
        // untouched prompt opts nothing out. Non-interactive runs skip it
        // (LLP 0131 #attended-only): default-sync is the correct scripted
        // outcome, and `hyp policy client` is the standing control.
        if (interactive && (pathway === 'team' || enrolled())) {
          // The two enrolled-only questions, in order and with a back edge
          // between them: which adapters ship (LLP 0188), then what happens
          // in folders nobody has classified (LLP 0200). Separate lanes
          // because they answer different axes; a back out of the folder
          // question re-presents the sync lane, not the picker.
          // @ref LLP 0200#wizard [implements]: the new-folder step follows the sync lane and backs into it
          atSync: while (true) {
            const syncFn = opts.syncScope ?? runWizardSyncScope
            // The locked descriptors ride along so the lane can state the whole
            // sync picture: org rows always sync and are shown read-only there.
            const lockedDescriptors = picked.lockedSources
              .map((id) => catalog.pickerDescriptors.get(id))
              .filter((d) => d !== undefined)
            const syncScope = await syncFn({
              stdout: opts.stdout,
              stderr: opts.stderr,
              ...(opts.stdin ? { stdin: opts.stdin } : {}),
              env: opts.env,
              candidates: picked.descriptors,
              locked: lockedDescriptors,
              ...(syncProgress ? { progress: syncProgress } : {}),
              ...(opts.confirm ? { confirm: opts.confirm } : {}),
              ...(express ? { autoAccept: true } : {}),
              // The pick lane is always behind this one.
              allowBack: true,
              // The store write commits below with the config, so a
              // declined overwrite leaves this run's opt-outs unwritten
              // too (LLP 0279 #one-commit-point).
              deferWrite: true,
            })
            if (syncScope.back) continue atPick
            if (syncScope.cancelled) {
              // Cancelling here leaves the store unwritten, so default-sync
              // stands; on an enrolled run that must be said, not implied
              // (LLP 0188).
              if (joined) await narrateEnrolledAbort(opts)
              return { exitCode: 130, cancelled: true, ...(pathway ? { pathway } : {}) }
            }
            sourcesOptedOut = syncScope.optedOut
            syncCommit = syncScope.commit

            const folderFn = opts.folderAsk ?? runWizardFolderAsk
            const folders = await folderFn({
              stdout: opts.stdout,
              stderr: opts.stderr,
              ...(opts.stdin ? { stdin: opts.stdin } : {}),
              env: opts.env,
              ...(foldersProgress ? { progress: foldersProgress } : {}),
              ...(opts.confirm ? { confirm: opts.confirm } : {}),
              ...(express ? { autoAccept: true } : {}),
              // The sync lane is always behind this one.
              allowBack: true,
              // As above: the preference lands with the config or not at
              // all (LLP 0279 #one-commit-point).
              deferWrite: true,
            })
            // One screen back is the sync lane only when the sync lane was
            // a screen. On a fully fleet-managed machine (nothing left to
            // opt out) and on an unreadable store it states its outcome and
            // asks nothing, so backing "into" it re-ran it and re-asked this
            // question: escape became a redraw the user could never get out
            // of. Past a lane that asked nothing, the last screen is the
            // picker.
            // @ref LLP 0191#back-edges [implements]: escape reaches the previous screen, skipping a lane that rendered a statement rather than a question
            if (folders.back) {
              if (syncScope.noQuestion) continue atPick
              continue atSync
            }
            if (folders.cancelled) {
              // Same shape as the sync lane's cancel: nothing new was
              // written, and the enrolled consequence is narrated rather
              // than left implied.
              if (joined) await narrateEnrolledAbort(opts)
              return { exitCode: 130, cancelled: true, ...(pathway ? { pathway } : {}) }
            }
            folderAsk = folders.mode
            folderCommit = folders.commit
            break atSync
          }
        }
        break atFork
      }
    }
  }

  // Loop invariant, restated for the type system: the only way out of the
  // lanes above, other than returning, assigns `picked` first.
  if (!picked) throw new Error('hyp init: internal error: the pick lane did not run')

  const finaleProgress = express ? undefined : wizardStepProgress(pathway, 'finale', { managed: enrolled() })

  // Every question lane has run; commit the composed config to disk before
  // the acting phases (configure and the finale both read/edit the file).
  // A refusal mirrors pick's old overwrite-refusal exit (1, not cancelled),
  // and on the team pathway narrates the enrolled state it leaves behind.
  // Scripted phase stubs (tests) return no `configPending` and skip this.
  // @ref LLP 0190#commit-point [implements]: the overwrite confirm is the wizard's last question, after the sync lane
  if (picked.configPending) {
    const committed = await commitWizardPickedConfig({
      stdout: opts.stdout,
      stderr: opts.stderr,
      ...(opts.stdin ? { stdin: opts.stdin } : {}),
      interactive,
      ...(opts.force !== undefined ? { force: opts.force } : {}),
      ...(opts.confirmOverwrite ? { confirmOverwrite: opts.confirmOverwrite } : {}),
      configPath: picked.configPath,
      config: picked.config,
    })
    if (!committed.ok) {
      // The lanes stated their answers on screen and the refusal message
      // only speaks for the config, so the run says the rest of the answer
      // set went with it. Naming only the lanes that actually asked: a sync
      // lane with nothing left to opt out of made a statement and handed
      // back no commit, and an express pass narrated the standing state on
      // both lanes rather than taking an answer, so it has no answer to
      // have lost.
      // @ref LLP 0279#one-commit-point [implements]: a refusal reports the held policy writes it also dropped
      const held = express
        ? []
        : [...(syncCommit ? ['sync'] : []), ...(folderCommit ? ['new-folder'] : [])]
      if (held.length > 0) {
        opts.stderr.write(
          held.length > 1
            ? `hyp init: the ${held.join(' and ')} answers from this run were not recorded either\n`
            : `hyp init: the ${held[0]} answer from this run was not recorded either\n`
        )
      }
      if (joined) await narrateEnrolledAbort(opts)
      return { exitCode: 1, ...(pathway ? { pathway } : {}) }
    }
  }

  // The question lanes' policy stores land here, with the config they
  // belong to: they hold this run's answers, and this run's answers are
  // either all recorded or none of them are (LLP 0279 #one-commit-point).
  // Both commits resolve to what they left in force rather than to the
  // answer, so a write that failed is reported by the finish log as the
  // state that stands. That is the signal that separates a recorded
  // opt-out from one whose warning scrolled past under the configure
  // phase, so it must not claim the answer landed.
  // @ref LLP 0279#one-commit-point [implements]: the lanes' policy writes run once the config commits, never before
  if (syncCommit) sourcesOptedOut = await syncCommit()
  if (folderCommit) folderAsk = await folderCommit()

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
      // Keyed on the remembered join, not the final pathway: a join this
      // run enrolled the machine even if the user then stepped back and
      // finished down the local path (LLP 0191 #join-not-undone).
      joinedAlready: joined !== undefined,
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
  const firstLookRan = interactive && !cancelled && opts.finale?.dryRun !== true
  // `firstLookResult.wrote` is whether the step put text on the screen, which
  // is neither "it ran" nor "the block rendered". The step is documented to
  // degrade rather than fail a finished install (LLP 0135 #first-look), and it
  // degrades in two different ways: an unregistered dataset, an unreadable
  // cache or a render that throws leave `firstLookRan` true and stdout
  // untouched, while an expired deadline with nothing renderable writes two
  // lines saying so and still reports `shown: false`. `runWizardFirstLook`
  // measures the writes, so this is the fact itself rather than an inference
  // from which branch it took, and a branch added later reports itself without
  // a change here.
  /** @type {FirstLookResult | undefined} */
  let firstLookResult
  if (firstLookRan) {
    const notices = firstLookNoticeSink(opts.stderr)
    firstLookResult = await runWizardFirstLook({
      runner: opts.firstLook ?? firstLookRunnerFromCtx(opts.ctx, notices),
      stdout: opts.stdout,
      color: useColor(opts.stdout, opts.env),
      ...(opts.firstLookBudgetMs !== undefined ? { budgetMs: opts.firstLookBudgetMs } : {}),
    })
    // The abandoned queries from an expired deadline keep running and can
    // still resolve with a withheld-row report. Close the sink so that
    // report cannot land after the privacy narration below, which is
    // documented to be the last thing on screen.
    notices.close()
  }

  // The finale already named these, before the daemon restart that strands
  // them (LLP 0185 #warn-do-not-detach). That print is no longer on screen by
  // the time this run ends: the summary, then the first look's block, then
  // the narration below all follow it without a pause. Repeat it here, short,
  // and only when this closing sequence actually wrote something, so the
  // direct `runPickerWalkthrough` entry point (whose summary follows the
  // finale with nothing in between) keeps its single print.
  //
  // `firstLookResult.wrote` is the whole condition, the team pathway included.
  // It is read rather than `firstLookRan` because a first look that wrote
  // nothing buried nothing, rather than `shown` because a skip that explains
  // itself on stdout (the expired deadline) buried the finale's print exactly
  // as a full render would, and rather than `pathway` because a `pathway` is
  // only ever resolved on an interactive run: a team run that is neither
  // cancelled nor a dry run has already run the first look, so
  // `|| pathway === 'team'` would widen this to exactly the runs where the
  // first look did *not* run (cancelled at the backfill consent, or a dry
  // run). Every run either of those conditions would add wrote nothing
  // between the finale and here, so the repeat would land a few lines under
  // the print it repeats.
  // @ref LLP 0230#when [constrained-by]: nothing written in between, no repeat
  // @ref LLP 0230#repeat-at-the-end [implements]: the wizard repeats what its own closing output buried
  const stranded = finaleSummary?.attachedNotConfigured ?? []
  if (stranded.length > 0 && firstLookResult?.wrote === true) {
    writeAttachedNotConfiguredReminder({
      clients: stranded,
      stdout: opts.stdout,
      dryRun: opts.finale?.dryRun === true,
    })
  }

  // The wizard's last words on a run that enrolled: when the first upload
  // happens and that nothing has shipped yet (LLP 0100/0101, narration
  // only - the hold itself was written by the join lane's login). Keyed
  // on the remembered join, like the abort narration above: enrollment
  // survives a back through the fork (LLP 0191 #join-not-undone).
  // `offerFollows` mirrors the sync offer's own gate below, so the
  // narration drops its `hyp sync` sentence exactly when the offer is
  // about to state the same thing as a choice.
  const offerFollows = interactive && !cancelled && opts.finale?.dryRun !== true
  const holdDeadline = joined ? await narratePrivacyIfTeamPath(opts, { offerFollows }) : null

  // ...and then the offer to end the wait. It sits between the narration
  // and the first ask because it is an action on what the narration just
  // said, and because the first ask may take the terminal for good.
  // @ref LLP 0203#offer [implements]: the enrolled closing sequence offers the release, after stating the wait
  /** @type {WizardSyncNowResult | undefined} */
  let syncNow
  if (holdDeadline !== null && interactive && !cancelled && opts.finale?.dryRun !== true) {
    syncNow = await runWizardSyncNow({
      deadline: holdDeadline,
      stdout: opts.stdout,
      stderr: opts.stderr,
      env: opts.env,
      interactive: true,
      ...(opts.stdin ? { stdin: opts.stdin } : {}),
      ...(opts.syncNow ?? {}),
    })
  }

  // The exit door. Placed after the privacy narration on purpose: the
  // narration stays the wizard's last *words* (LLP 0135 #privacy), and
  // this is what the user does next rather than one more thing to read.
  // Attended, non-dry-run, non-cancelled, same as the first look - and it
  // may take the terminal for good, so nothing may follow it but the
  // return.
  // @ref LLP 0198#first-ask [implements]: the closing question list, after the narration, last of all
  /** @type {FirstAskResult | undefined} */
  let firstAsk
  if (interactive && !cancelled && opts.finale?.dryRun !== true) {
    firstAsk = await runWizardFirstAsk({
      clients: picked.clientsPicked,
      descriptors: opts.catalog
        ? opts.catalog.clientDescriptors
        : await buildWalkthroughClientDescriptorMap(),
      stdout: opts.stdout,
      stderr: opts.stderr,
      env: opts.env,
      interactive: true,
      hasRows: firstLookHadRows(firstLookResult),
      ...(opts.stdin ? { stdin: opts.stdin } : {}),
      ...(opts.firstAsk ?? {}),
    })
  }

  log.info('wizard.finish', {
    [Attr.COMPONENT]: 'wizard',
    pathway: pathway ?? 'non-interactive',
    sources_picked: picked.sourcesPicked.length,
    locked_count: picked.lockedSources.length,
    sources_opted_out: sourcesOptedOut.length,
    folder_ask: folderAsk ?? 'not-asked',
    express,
    cancelled,
    first_ask: firstAsk ? (firstAsk.launched ? `launched:${firstAsk.client}` : firstAsk.reason) : 'skipped',
    // How often an enrolled install chooses not to wait is the measurement
    // that says whether the window is sized for the people in it.
    sync_now: syncNow ? (syncNow.asked && syncNow.released ? 'released' : syncNow.reason) : 'skipped',
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
 * Whether the first look found anything, as the first ask's `hasRows`.
 *
 * The two "did not show" reasons are not the same answer, and collapsing
 * them would be the bug:
 *
 * - `no-dataset` is a definite no. No gateway source is configured, so
 *   there is nothing for a question about recorded sessions to read.
 * - `slow` is a definite *yes*: the block was abandoned precisely because
 *   summarizing this much history would have held up setup.
 * - `error` is unknown, and unknown must not withhold the offer: a
 *   launch against a cache that turns out to be full is fine, while
 *   suppressing one against a cache that was merely unreadable is not.
 *
 * A shown block with zero rows in both counted sections is an empty
 * cache: the dataset exists and holds nothing yet, which is exactly the
 * fresh-install case (LLP 0198#empty-cache).
 *
 * Takes the outcome half, not the whole {@link FirstLookResult}: this
 * question is answered from what the step found, and `wrote` (LLP 0230
 * #when) says nothing about whether the cache has rows.
 *
 * @ref LLP 0198#empty-cache [tests]: `no-dataset`, `slow`, and `error` each resolve to a distinct answer; collapsing any two is the bug
 * @param {FirstLookOutcome | undefined} result
 * @returns {boolean | undefined}
 */
export function firstLookHadRows(result) {
  if (!result) return undefined
  if (result.shown) return result.providerRows > 0 || result.dayRows > 0
  if (result.reason === 'no-dataset') return false
  if (result.reason === 'slow') return true
  return undefined
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
 * @ref LLP 0179#no-prose-control-flow [implements]: the multi-org branch reads the lane's reason code, not its sentence
 * @param {RunInitWizardOptions} opts
 * @param {WizardJoinResult} join
 */
function printJoinFailure(opts, join) {
  if (join.status !== 'failed') {
    opts.stderr.write('Sign-in did not complete. You can try again, or set up locally for now.\n')
    return
  }
  if (join.reason === 'org_selection_required') {
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
        // A boot with a broken plugin contributes a partial asset set. The
        // finale still copies it; it must not read the hole as a retirement.
        ...(opts.ctx.failedPlugins?.length ? { failedPlugins: opts.ctx.failedPlugins } : {}),
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
 * Returns the deadline it narrated, so the closing sync offer (LLP 0203)
 * runs off the same read rather than racing a second one against a marker
 * `hyp sync` may have cleared in between.
 *
 * `offerFollows` trims the `hyp sync` sentence: when the closing sync
 * offer is about to render (the ordinary attended close), its "Send now"
 * row states the same command and the same asks-first promise, so the
 * sentence read as the wizard saying one thing twice in a row. Every path
 * that ends without the offer (aborts, non-interactive, dry runs) keeps
 * the sentence, because there it is the only sighting of the way out.
 *
 * @param {Pick<RunInitWizardOptions, 'stdout' | 'env'>} opts
 * @param {{ offerFollows?: boolean }} [flags]
 * @returns {Promise<number | null>} the live deadline, or null when no hold applies
 */
async function narratePrivacyIfTeamPath(opts, { offerFollows = false } = {}) {
  /** @type {number|null} */
  let deadline = null
  try {
    const obsEnv = readObservabilityEnv(opts.env)
    deadline = await readFirstSyncDeadline({ stateDir: obsEnv.stateDir })
  } catch {
    // Unreadable state dir: skip the narration rather than fail the run.
  }
  if (typeof deadline !== 'number') return null
  opts.stdout.write(
    '\n' +
    'Nothing has been uploaded yet - nothing leaves this machine before\n' +
    `${formatFirstSyncDeadline(deadline)}. That first sync includes your imported history.\n` +
    'To review or exclude anything before then, run the hypaware-privacy\n' +
    'skill in Claude or Codex. `hyp status` shows the countdown.\n' +
    (offerFollows
      ? ''
      : 'To send it sooner, run `hyp sync`: it shows what would leave and asks\n' +
        'before sending anything.\n')
  )
  return deadline
}

/**
 * The abort seam for a run that already enrolled: the join lane's
 * enrollment is a completed transaction the moment the sign-in finishes
 * (LLP 0063 D3: the sign-in is the accepting act; `hyp leave` is the
 * exit), so a pick or sync-scope abort cannot roll it back - but exiting
 * silently would leave the user unaware their existing config now syncs
 * by default once the hold lapses. Degrade to the never-silent floor the
 * scripted path already uses: name the state, the standing control, and
 * the deadline when a hold is live. Never another prompt - an abort
 * means "get me out", not "ask me differently".
 *
 * @ref LLP 0190#abort-narration [implements]: an abandoned enrolled run narrates the default-sync consequence and the standing control instead of re-prompting
 *
 * @param {Pick<RunInitWizardOptions, 'stdout' | 'env'>} opts
 */
async function narrateEnrolledAbort(opts) {
  try {
    opts.stdout.write(
      '\n' +
      'This machine is enrolled: its configured sources sync to your server by default.\n' +
      "Keep any local-only with 'hyp policy client <name> local-only'.\n"
    )
    await narratePrivacyIfTeamPath(opts)
  } catch {
    // best-effort: stdout might be closed during cleanup
  }
}

/**
 * The rows the express gate lists: the pick lane's own default rows
 * (LLP 0201 #gate), labelled by the shared labeller so the two screens
 * cannot disagree about what "all of these" means.
 *
 * Best-effort like every other pre-question probe here: a catalog or
 * config read that throws yields no rows, which the caller reads as "no
 * gate" and falls through to the lanes' own questions. Losing a shortcut
 * is the right failure; guessing at a list the user is about to accept is
 * not.
 *
 * @ref LLP 0201#gate [implements]: the gate names the pick lane's rows, from one computation, or is not shown
 * @param {{
 *   opts: RunInitWizardOptions,
 *   catalog: PluginCatalog,
 *   locked: string[] | undefined,
 *   pickSeed: PickerSource[] | undefined,
 *   detect: (args: { env: NodeJS.ProcessEnv }) => Promise<Set<PickerSource>>,
 * }} args
 * @returns {Promise<string[]>}
 */
async function expressRowsSafe({ opts, catalog, locked, pickSeed, detect }) {
  try {
    const seeding = await resolvePickSeeding(/** @type {any} */ ({
      env: opts.env,
      catalog,
      ...(locked ? { locked } : {}),
      ...(pickSeed ? { initialSelection: pickSeed } : {}),
      detect,
    }))
    return defaultRowLabels(seeding)
  } catch {
    return []
  }
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
 * an already-managed machine without a join (the returning gate's single
 * Reconfigure re-entry, LLP 0182, and the first-run path a managed
 * machine falls to when its merged config no longer validates), guarded:
 * a resolution failure renders an unlocked picker (additions still
 * compose; the export seam, not the picker, enforces the org boundary,
 * LLP 0188 #locked - LLP 0132, which used to state this, is superseded).
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
