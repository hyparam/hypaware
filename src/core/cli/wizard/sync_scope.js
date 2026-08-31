// @ts-check

import { Attr, withSpan } from '../../observability/index.js'
import { readObservabilityEnv } from '../../observability/env.js'
import { isPromptBackError, isPromptCancelledError } from '../tui/runtime.js'
import { defaultPromptFactory } from '../walkthrough.js'
import { narrateAcceptedGate } from './express.js'
import { LOCKED_LABEL_SUFFIX } from './pick.js'
import {
  ClientSyncListUnreadableError,
  clientSyncListPath,
  optedOutClientSourceIds,
  readClientSyncEntries,
  writeClientSyncEntries,
} from '../../usage-policy/index.js'

/**
 * @import { AsyncPickPrompt } from '../../../../src/core/cli/types.js'
 * @import { RunWizardSyncScopeOptions, WizardSyncScopeResult } from '../../../../src/core/cli/wizard/types.js'
 * @import { ClientSyncEntry } from '../../../../src/core/usage-policy/types.js'
 */

const SYNC_SCOPE_MENU_TITLE = 'Choose what syncs. Unchecked sources stay on this machine.'

/**
 * The wizard's sync-scope step (LLP 0188 #never-silent, LLP 0190
 * #sync-gate): after the picker on every enrolled run, a multiselect
 * over the picked, non-locked sources. Checked means "syncs"; everything
 * is checked by default on a fresh join (default-sync is the point), and
 * a re-entry renders the sources already opted out unchecked so
 * re-running the wizard round-trips the store instead of resetting it.
 * The lane's former defaults gate is retired (LLP 0201 #decline); the
 * express gate's accept auto-answers this lane and narrates the split.
 *
 * Locked (org-configured) sources are shown but never editable: they
 * always sync (LLP 0188 #locked), so the menu renders them checked and
 * disabled, keeping "choose what syncs" the whole picture rather than
 * the editable slice. `opts.locked`
 * arrives already display-filtered (LLP 0276 #sync-gate): a hidden row is
 * locked on every enrolled machine and was never offered, so naming it
 * here would label a screen the user cannot connect to anything they did.
 * `candidates` is the pick result's locked-filtered descriptor list, put
 * through that same display filter; when it is empty the step prints its
 * position plus the always-sync fact - or, with no org row to name
 * either, the nothing-picked fact, which only reads "nothing syncs" when
 * `lockedHidden` and `candidatesHiddenIds` both say no filtered-out row is
 * standing - instead of prompting, so the counter never skips a number. A
 * hidden pick the store already withholds is not standing, which is why
 * the picks arrive as ids and the locked rows as a count (LLP 0289
 * #ask-the-store).
 *
 * The write has editor semantics over the shown candidates only: entries
 * for sources not shown (a previously opted-out source the user unpicked
 * this run) are kept, never silently dropped - unpicking a source disables
 * its plugin, which is a stronger state than an opt-out, and re-picking it
 * later should find the opt-out still standing. The store, not this
 * prompt, is what the export seam enforces (LLP 0188 #opt-out).
 *
 * A corrupt existing store skips the step with a warning naming the file:
 * never overwrite an uninterpretable privacy signal; the export seam fails
 * closed on it and `hyp status` names it too.
 *
 * @ref LLP 0188#never-silent [implements]: the enrolled wizard's sync-scope step names what syncs before anything ships
 * @ref LLP 0190#sync-gate [implements]: the menu checks what syncs, with locked rows leading read-only
 * @param {RunWizardSyncScopeOptions} opts
 * @returns {Promise<WizardSyncScopeResult>}
 */
export async function runWizardSyncScope(opts) {
  const stateDir = readObservabilityEnv(opts.env).stateDir

  /** @type {ClientSyncEntry[]} */
  let existing
  try {
    existing = (await readClientSyncEntries({ stateDir })) ?? []
  } catch (err) {
    if (!(err instanceof ClientSyncListUnreadableError)) throw err
    opts.stderr.write(
      `warning: the client policy store at '${clientSyncListPath(stateDir)}' is unreadable; ` +
      'skipping the sync-scope step (exports fail until it is repaired or removed)\n'
    )
    return await finishSpan({ skipped: true, noQuestion: true, optedOut: [] }, opts)
  }

  const candidateIds = new Set(opts.candidates.map((d) => d.id))
  const optedOutBefore = new Set(existing.filter((e) => candidateIds.has(e.source)).map((e) => e.source))
  // The one question the lane may ask about a row it may not show: does a
  // hidden pick still ship? `optedOutBefore` cannot answer it - it is
  // computed over `candidateIds`, the *visible* candidates - and a hidden
  // row is addressable in the store all the same
  // (`hyp policy client raw-anthropic local-only`), so the ids go to the
  // store and never to the screen.
  // The store's answer, not the seam's: the seam also drops opt-out
  // entries for central-classified sources, which this cannot see. That
  // costs nothing while a hidden pick is non-central by construction, and
  // the run where it is not is recorded as accepted in LLP 0289 #not-done.
  // @ref LLP 0289#ask-the-store [implements]: the hidden picks reach the lane as ids so their sentence can be checked against the store the export seam reads
  const optedOutAll = new Set(optedOutClientSourceIds(existing))
  const hiddenCandidates = opts.candidatesHiddenIds ?? []
  const hiddenCandidateSyncs = hiddenCandidates.some((id) => !optedOutAll.has(id))

  if (opts.candidates.length === 0) {
    // Led by a blank line like every other block this lane prints, so the
    // no-question path is not the one that runs into its neighbour.
    opts.stdout.write('\n')
    if (opts.progress) opts.stdout.write(`${opts.progress}\n`)
    // Five ways to reach this line, and they are not the same fact. With
    // org rows to name and nothing else standing, everything picked is the
    // fleet's and always syncs; with a hidden pick standing beside them the
    // fleet sentence narrows to the rows it owns (below).
    // With none nameable but locked rows still standing - the enrolled
    // machine whose locked set is entirely hidden (LLP 0276 #sync-gate) -
    // the fleet's own capture still ships, so the line may not claim
    // nothing syncs; it just has no row to attribute it to. With no locked
    // row but a hidden row among the picks that the store does not already
    // withhold - a carried raw source (LLP 0202 #carry-through) on a run
    // whose org config has not converged - capture still ships and the
    // fleet does not own it, so the line names neither the row nor an
    // owner. Only with nothing standing at all is nothing picked and
    // nothing synced. The locked branch needs no such check: an org row
    // always syncs (LLP 0188 #locked) and the export seam drops opt-out
    // entries for central-classified sources, so a store entry for one is
    // inert.
    // @ref LLP 0276#no-candidates [implements]: the no-candidates line states the fleet only when there is a visible org row to name, and never claims nothing syncs while a filtered-out row stands
    // @ref LLP 0289#ask-the-store [implements]: a hidden pick the store withholds is not standing, so this branch reads "nothing syncs" instead of promising an export that will not happen
    if ((opts.locked ?? []).length === 0) {
      if ((opts.lockedHidden ?? 0) > 0) {
        opts.stdout.write(
          'You picked nothing to record, but capture your fleet manages directly still syncs to your server.\n'
        )
      } else if (hiddenCandidateSyncs) {
        opts.stdout.write(
          'You picked nothing to record, but capture already set up on this machine still syncs to your server.\n'
        )
      } else {
        opts.stdout.write('You picked nothing to record, so nothing syncs to your server.\n')
      }
      return await finishSpan({ noQuestion: true, optedOut: [] }, opts, { hidden_picks_syncing: hiddenCandidateSyncs })
    }
    // A hidden pick standing beside the org rows breaks the exhaustive
    // reading of the fleet sentence: the carried row (LLP 0202
    // #carry-through) is in `sources`, composes into the *local* layer, and
    // syncs, so "everything you picked is managed by your fleet" hands the
    // fleet an owner's claim over capture it does not own. The org rows get
    // a sentence scoped to themselves, and the machine's own capture gets
    // the line the no-locked branch already uses - a fact, never a name.
    // Two claims, two questions. *Ownership* is not the store's to answer:
    // a hidden pick the store withholds is still not the fleet's, so the
    // fleet sentence narrows whenever such a row exists, which is the count
    // LLP 0281 settled on. *Shipping* is the store's, so the second line -
    // the one that promises an export - prints only when a hidden pick is
    // not already withheld. That is the same question the no-locked branch
    // asks, so the two agree about what leaves the machine without this one
    // re-acquiring an owner's claim it gave up.
    // @ref LLP 0281#visible-org-row [implements]: a visible org row stops standing in for a hidden pick beside it, withheld or not
    // @ref LLP 0289#ask-the-store [implements]: the store answers whether the machine's own capture ships, not whether the fleet owns it
    if (hiddenCandidates.length > 0) {
      opts.stdout.write('Your fleet manages these and they always sync:\n')
      for (const d of opts.locked ?? []) opts.stdout.write(`  ${d.label}\n`)
      if (hiddenCandidateSyncs) {
        opts.stdout.write('Capture already set up on this machine also syncs to your server.\n')
      }
      return await finishSpan({ noQuestion: true, optedOut: [] }, opts, { hidden_picks_syncing: hiddenCandidateSyncs })
    }
    opts.stdout.write('Everything you picked is managed by your fleet and always syncs.\n')
    for (const d of opts.locked ?? []) opts.stdout.write(`  ${d.label}\n`)
    // A statement, not a screen: `noQuestion` is what tells the lane after
    // this one that there is nothing here to step back *to* (LLP 0191
    // #back-edges).
    return await finishSpan({ noQuestion: true, optedOut: [] }, opts, { hidden_picks_syncing: hiddenCandidateSyncs })
  }

  const ask = opts.prompt ?? defaultPromptFactory(opts)
  /** @type {{ optedOut: string[] } | { back: true }} */
  let selection
  try {
    selection = await promptSyncScopeSelection({ opts, ask, optedOutBefore })
  } catch (err) {
    if (!isPromptCancelledError(err)) throw err
    try {
      opts.stderr.write('hyp setup: cancelled\n')
    } catch {
      // best-effort: stderr might be closed during cleanup
    }
    return await finishSpan({ cancelled: true, optedOut: [] }, opts)
  }
  // Stepping back leaves the store unwritten, exactly like never reaching
  // the lane: the orchestrator re-presents the pick lane and this one runs
  // again afterwards.
  if ('back' in selection) return await finishSpan({ back: true, optedOut: [] }, opts)
  const optedOut = selection.optedOut

  const kept = existing.filter((e) => !candidateIds.has(e.source))
  await writeClientSyncEntries({
    stateDir,
    entries: [
      ...kept,
      ...optedOut.map((source) => ({ source, class: /** @type {'local-only'} */ ('local-only') })),
    ],
  })
  if (optedOut.length > 0) {
    opts.stdout.write(
      `Keeping local-only: ${optedOut.join(' · ')}. Change later with 'hyp privacy client <name> sync|local-only'.\n`
    )
  }
  return await finishSpan({ optedOut }, opts)
}

/**
 * The sync lane's question screen: the multiselect that checks what
 * syncs, directly (LLP 0201 #decline - the lane's former defaults gate
 * is retired; the express gate's accept auto-answers this lane, and a
 * user who declined it has already asked for the menu). The lane
 * propagates `back` to the caller; the pick lane is always behind it.
 * Cancellation propagates as the prompt's own throw.
 *
 * @param {{
 *   opts: RunWizardSyncScopeOptions,
 *   ask: AsyncPickPrompt,
 *   optedOutBefore: Set<string>,
 * }} args
 * @returns {Promise<{ optedOut: string[] } | { back: true }>}
 */
async function promptSyncScopeSelection({ opts, ask, optedOutBefore }) {
  // The express gate already accepted this lane (LLP 0201): state the
  // split the menu would have shown, then take it. Never silent -
  // LLP 0188 #never-silent binds the statement, not the keypress. The
  // statement is the full sync picture, not only the editable slice: the
  // org's locked sources always sync (LLP 0188 #locked), so they lead
  // it, fleet-suffixed. A fresh run is a single list under the title; a
  // re-entry with standing opt-outs shows both halves of the split.
  // @ref LLP 0201#narrate [implements]: an auto-accepted lane prints its statement instead of prompting
  if (opts.autoAccept) {
    const locked = (opts.locked ?? []).map((d) => `${d.label}${LOCKED_LABEL_SUFFIX}`)
    const syncing = [
      ...locked,
      ...opts.candidates.filter((d) => !optedOutBefore.has(d.id)).map((d) => d.label),
    ]
    const local = opts.candidates.filter((d) => optedOutBefore.has(d.id)).map((d) => d.label)
    narrateAcceptedGate({
      stdout: opts.stdout,
      title: syncing.length > 0 ? 'These will sync to your server:' : 'Staying local-only:',
      items: [
        ...syncing.map((label) => `  ${label}`),
        ...(local.length > 0 && syncing.length > 0 ? ['Staying local-only:'] : []),
        ...local.map((label) => `  ${label}`),
      ],
    })
    return { optedOut: [...optedOutBefore].sort() }
  }
  try {
    const checked = await ask({
      pickType: 'clients',
      title: SYNC_SCOPE_MENU_TITLE,
      ...(opts.progress ? { progress: opts.progress } : {}),
      options: [
        // Locked rows lead the menu as read-only context, exactly as the
        // picker renders them: checked, disabled, fleet-labeled. The menu
        // is the whole sync picture (LLP 0188 #locked): a screen that
        // omitted sources that do sync would understate what the server
        // sees. They are not candidates, so they never reach the opt-out
        // computation.
        ...(opts.locked ?? []).map((d) => ({
          value: d.id,
          label: `${d.label}${LOCKED_LABEL_SUFFIX}`,
          ...(d.summary ? { summary: d.summary } : {}),
          checked: true,
          disabled: true,
        })),
        ...opts.candidates.map((d) => ({
          value: d.id,
          label: d.label,
          ...(d.summary ? { summary: d.summary } : {}),
          ...(optedOutBefore.has(d.id) ? {} : { checked: true }),
        })),
      ],
      // The pick lane is always behind this one.
      allowBack: true,
      // In this menu checked means "syncs", so the numbered non-TTY
      // fallback must keep the checked rows on a bare enter; its
      // historical enter-selects-none would silently opt every
      // candidate out, the exact inverse of the TUI default.
      enterKeepsChecked: true,
    })
    const checkedSet = new Set(checked)
    return { optedOut: opts.candidates.map((d) => d.id).filter((id) => !checkedSet.has(id)).sort() }
  } catch (err) {
    if (isPromptBackError(err)) return { back: true }
    throw err
  }
}

/**
 * The lane's one span. `hidden_picks` and `hidden_picks_syncing` carry the
 * store answer the no-candidates sentence turns on (LLP 0289
 * #ask-the-store) so a later "it said nothing syncs but rows shipped" is
 * triageable from the signal: the count separates "no hidden pick" from
 * "hidden picks, all withheld", which print the same line. Counts and a
 * boolean, never the ids - the lane holds them to ask the store, not to
 * record them (LLP 0202).
 *
 * @param {WizardSyncScopeResult} result
 * @param {RunWizardSyncScopeOptions} opts
 * @param {{ hidden_picks_syncing?: boolean }} [extra] attributes only the
 *   caller knows, folded in when present
 * @returns {Promise<WizardSyncScopeResult>}
 */
async function finishSpan(result, opts, extra) {
  await withSpan(
    'wizard.sync_scope.finish',
    {
      [Attr.COMPONENT]: 'wizard',
      [Attr.OPERATION]: 'wizard.sync_scope.finish',
      candidates: opts.candidates.length,
      hidden_picks: (opts.candidatesHiddenIds ?? []).length,
      ...(extra ?? {}),
      sources_opted_out: result.optedOut.length,
      status: result.cancelled ? 'cancelled' : result.back ? 'backed' : result.skipped ? 'skipped' : 'ok',
    },
    async () => {},
    { component: 'wizard' }
  )
  return result
}
