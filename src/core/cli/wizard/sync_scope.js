// @ts-check

import { Attr, withSpan } from '../../observability/index.js'
import { readObservabilityEnv } from '../../observability/env.js'
import { joinNames } from './express.js'
import {
  ClientSyncListUnreadableError,
  clientSyncListPath,
  optedOutClientSourceIds,
  readClientSyncEntries,
  writeClientSyncEntries,
} from '../../usage-policy/index.js'

/**
 * @import { RunWizardSyncScopeOptions, WizardSyncScopeResult } from '../../../../src/core/cli/wizard/types.js'
 * @import { ClientSyncEntry } from '../../../../src/core/usage-policy/types.js'
 * @import { PickerDescriptor } from '../../../../src/core/types.js'
 */

const SERVER = "your team's server"

/**
 * The wizard's sync lane, on every enrolled run after the picker. It asks
 * nothing: the picker's answer is also the sharing answer (LLP 0396
 * #combined-selection). It states what syncs, as one line for the recap
 * (LLP 0437 #recap), and returns the picked sources whose standing opt-outs
 * the wizard clears once the config has committed.
 *
 * Locked (org-configured) sources always sync (LLP 0188 #locked), so the
 * line counts them and names them as the team's. `opts.locked` and
 * `candidates` arrive display-filtered (LLP 0276 #sync-gate): a hidden row
 * is never named, but the line may not claim nothing syncs while one
 * stands, which is why the hidden picks arrive as ids and the hidden locked
 * rows as a count (LLP 0289 #ask-the-store).
 *
 * A corrupt existing store skips the step with a warning naming the file:
 * never overwrite an uninterpretable privacy signal; the export seam fails
 * closed on it and `hyp status` names it too.
 *
 * @ref LLP 0188#never-silent [implements]: the enrolled wizard's sync-scope step names what syncs before anything ships
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
    // This arm's documented contract is to warn and skip rather than
    // fail the run, and the warning write was the one way it could
    // still fail it. Best-effort, like the folder-ask lane's arms: a
    // warning that cannot be written must not unmake the skip it
    // qualifies. The facts it carries are not lost with it - the
    // export seam fails closed on this store and `hyp status` names it.
    // @ref LLP 0341#warnings [implements]: a warn-and-continue arm guards its own warning so its contract holds for direct callers too
    try {
      opts.stderr.write(
        `warning: the client policy store at '${clientSyncListPath(stateDir)}' is unreadable; ` +
        'skipping the sync-scope step (exports fail until it is repaired or removed)\n'
      )
    } catch {
      // best-effort: stderr might be closed during cleanup
    }
    return await finishSpan({ skipped: true, noQuestion: true }, opts)
  }

  const candidateIds = new Set(opts.candidates.map((d) => d.id))
  // The one question the lane may ask about a row it may not show: does a
  // hidden pick still ship? A hidden row is addressable in the store all
  // the same
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
    const said = opts.statement ?? opts.stdout
    const locked = opts.locked ?? []
    // Five ways to reach this line, and they are not the same fact. With
    // org rows to name, they sync. With none nameable but locked rows still
    // standing - the enrolled machine whose locked set is entirely hidden
    // (LLP 0276 #sync-gate) - the fleet's own capture still ships, so the
    // line may not claim nothing syncs; it just has no row to attribute it
    // to. With no locked row but a hidden row among the picks that the store
    // does not already withhold - a carried raw source (LLP 0202
    // #carry-through) on a run whose org config has not converged - capture
    // still ships and the fleet does not own it, so the line names neither
    // the row nor an owner. Only with nothing standing at all does nothing
    // sync. The locked branch needs no such check: an org row always syncs
    // (LLP 0188 #locked) and the export seam drops opt-out entries for
    // central-classified sources, so a store entry for one is inert.
    // @ref LLP 0276#no-candidates [implements]: the no-candidates line states the fleet only when there is a visible org row to name, and never claims nothing syncs while a filtered-out row stands
    // @ref LLP 0289#ask-the-store [implements]: a hidden pick the store withholds is not standing, so this branch reads "nothing syncs" instead of promising an export that will not happen
    if (locked.length === 0) {
      if ((opts.lockedHidden ?? 0) > 0) {
        said.write(`✓ Capture your team manages still syncs to ${SERVER}\n`)
      } else if (hiddenCandidateSyncs) {
        said.write(`✓ Capture already set up on this machine still syncs to ${SERVER}\n`)
      } else {
        said.write(`✓ Nothing syncs to ${SERVER}\n`)
      }
      return await finishSpan({ noQuestion: true }, opts, { hidden_picks_syncing: hiddenCandidateSyncs })
    }
    // A hidden pick beside the org rows is the machine's own capture, not
    // the fleet's: the org rows get their line, and the hidden pick gets a
    // fact, never a name, and only when the store does not withhold it.
    // @ref LLP 0281#visible-org-row [implements]: a visible org row stops standing in for a hidden pick beside it, withheld or not
    // @ref LLP 0289#ask-the-store [implements]: the store answers whether the machine's own capture ships, not whether the fleet owns it
    stateSyncing(said, locked, [])
    if (hiddenCandidates.length > 0 && hiddenCandidateSyncs) {
      said.write(`✓ Capture already set up on this machine also syncs to ${SERVER}\n`)
    }
    // A statement, not a screen: `noQuestion` is what tells the lane after
    // this one that there is nothing here to step back *to* (LLP 0191
    // #back-edges).
    return await finishSpan({ noQuestion: true }, opts, { hidden_picks_syncing: hiddenCandidateSyncs })
  }

  // The statement that names what leaves the machine (LLP 0188
  // #never-silent); the picker's line names what is recorded. The answer is
  // applied after the config commits (`commitWizardSyncScope`).
  // @ref LLP 0396#combined-selection [implements]: the collection answer also enables sharing, with no second picker
  stateSyncing(opts.statement ?? opts.stdout, opts.locked ?? [], opts.candidates)
  return await finishSpan({ noQuestion: true, pendingSources: [...candidateIds] }, opts, {
    hidden_picks_syncing: hiddenCandidateSyncs,
  })
}

/**
 * Apply only the final confirmed selection to the current policy store.
 * Re-reading preserves unrelated edits made while the wizard was open and
 * refuses to replace a store that became unreadable since the preview.
 * @ref LLP 0396#combined-selection [implements]: clearing waits until the config has committed
 * @param {{ env: NodeJS.ProcessEnv, stdout: RunWizardSyncScopeOptions['stdout'], sources: string[] }} opts
 * @returns {Promise<number>} Number of standing opt-outs cleared.
 */
export async function commitWizardSyncScope(opts) {
  return await withSpan('wizard.sync_scope.commit', {
    [Attr.COMPONENT]: 'wizard',
    [Attr.OPERATION]: 'wizard.sync_scope.commit',
    candidates: opts.sources.length,
  }, async (span) => {
    const stateDir = readObservabilityEnv(opts.env).stateDir
    const existing = (await readClientSyncEntries({ stateDir })) ?? []
    const selected = new Set(opts.sources)
    const entries = existing.filter((entry) => !selected.has(entry.source))
    const cleared = existing.filter((entry) => selected.has(entry.source)).map((entry) => entry.source).sort()
    // Materialize even an empty store so legacy migration cannot restore opt-outs.
    await writeClientSyncEntries({ stateDir, entries })
    span.setAttribute('sources_cleared', cleared.length)
    // @ref LLP 0188#no-retroactive-ship [constrained-by]: clearing is future-only and names the standing control to reverse it
    if (cleared.length > 0) {
      opts.stdout.write(
        `No longer local-only: ${cleared.join(' · ')}. Future rows sync to your team's server; ` +
        "rows already recorded are not sent. Change back with 'hyp privacy client <name> local-only'.\n"
      )
    }
    return cleared.length
  }, { component: 'wizard' })
}

/**
 * The lane's one-line statement of what syncs, for the wizard's recap (LLP
 * 0435 #recap). The rows are the ones the recording line just named, so it
 * counts them rather than naming them again, and names only the team's.
 *
 * @param {{ write(chunk: string): unknown }} said
 * @param {PickerDescriptor[]} locked
 * @param {PickerDescriptor[]} candidates
 */
function stateSyncing(said, locked, candidates) {
  const total = locked.length + candidates.length
  const what = total === 1 ? 'it' : total === 2 ? 'both' : `all ${total}`
  const team = locked.length === 0
    ? ''
    : candidates.length === 0
      ? ' (set by your team)'
      : ` (${joinNames(locked.map((d) => d.label))} ${locked.length === 1 ? 'is' : 'are'} set by your team)`
  said.write(`✓ Syncing ${what} to ${SERVER}${team}\n`)
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
 * @param {{ hidden_picks_syncing?: boolean, sources_cleared?: number }} [extra]
 *   attributes only the caller knows, folded in when present
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
      status: result.skipped ? 'skipped' : 'ok',
    },
    async () => {},
    { component: 'wizard' }
  )
  return result
}
