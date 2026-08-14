// @ts-check

import { Attr, withSpan } from '../../observability/index.js'
import { readObservabilityEnv } from '../../observability/env.js'
import { isPromptBackError, isPromptCancelledError } from '../tui/runtime.js'
import { defaultConfirmSelectPromptFactory, defaultPromptFactory } from '../walkthrough.js'
import { narrateAcceptedGate } from './express.js'
import { LOCKED_LABEL_SUFFIX } from './pick.js'
import {
  ClientSyncListUnreadableError,
  clientSyncListPath,
  readClientSyncEntries,
  writeClientSyncEntries,
} from '../../usage-policy/index.js'

/**
 * @import { AsyncConfirmSelectPrompt, AsyncPickPrompt } from '../../../../src/core/cli/types.js'
 * @import { RunWizardSyncScopeOptions, WizardSyncScopeResult } from '../../../../src/core/cli/wizard/types.js'
 * @import { ClientSyncEntry } from '../../../../src/core/usage-policy/types.js'
 */

const SYNC_SCOPE_MENU_TITLE = 'Choose what syncs. Unchecked sources stay on this machine.'

/**
 * The wizard's sync-scope step (LLP 0188 #never-silent, LLP 0190
 * #sync-gate): after the picker on every enrolled run, first a defaults
 * gate that states what will sync in one line and accepts on a bare
 * enter, then - only when the user asks to change it - a multiselect
 * over the picked, non-locked sources. Checked means "syncs"; everything
 * is checked by default on a fresh join (default-sync is the point), and
 * a re-entry renders the sources already opted out unchecked so
 * re-running the wizard round-trips the store instead of resetting it.
 *
 * Locked (org-configured) sources are shown but never editable: they
 * always sync (LLP 0188 #locked), so the gate lists them - fleet-suffixed
 * - and the menu renders them checked and disabled, keeping "these will
 * sync" the whole picture rather than the editable slice. `candidates` is
 * the pick result's locked-filtered descriptor list; when it is empty the
 * step prints its position plus the always-sync fact instead of
 * prompting, so the counter never skips a number.
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
 * @ref LLP 0190#sync-gate [implements]: defaults gate first, menu on request; the menu checks what syncs
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

  if (opts.candidates.length === 0) {
    // Led by a blank line like every other block this lane prints, so the
    // no-question path is not the one that runs into its neighbour.
    opts.stdout.write('\n')
    if (opts.progress) opts.stdout.write(`${opts.progress}\n`)
    opts.stdout.write('Everything you picked is managed by your fleet and always syncs.\n')
    for (const d of opts.locked ?? []) opts.stdout.write(`  ${d.label}\n`)
    // A statement, not a screen: `noQuestion` is what tells the lane after
    // this one that there is nothing here to step back *to* (LLP 0191
    // #back-edges).
    return await finishSpan({ noQuestion: true, optedOut: [] }, opts)
  }

  const ask = opts.prompt ?? defaultPromptFactory(opts)
  const confirm = opts.confirm ?? defaultConfirmSelectPromptFactory(opts)
  /** @type {{ optedOut: string[] } | { back: true }} */
  let selection
  try {
    selection = await promptSyncScopeSelection({ opts, ask, confirm, optedOutBefore })
  } catch (err) {
    if (!isPromptCancelledError(err)) throw err
    try {
      opts.stderr.write('hyp init: cancelled\n')
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
      `Keeping local-only: ${optedOut.join(' · ')}. Change later with 'hyp policy client <name> sync|local-only'.\n`
    )
  }
  return await finishSpan({ optedOut }, opts)
}

/**
 * The sync lane's question screens: the defaults gate stating the sync
 * split, then - on request - the multiselect that checks what syncs. The
 * two screens loop (LLP 0191 #lane-loops): the menu's back returns to
 * the gate, and the gate's back - offered only when the orchestrator
 * said there is somewhere to go (`opts.allowBack`) - propagates `back`
 * to the caller. Cancellation propagates as the prompt's own throw.
 *
 * @param {{
 *   opts: RunWizardSyncScopeOptions,
 *   ask: AsyncPickPrompt,
 *   confirm: AsyncConfirmSelectPrompt,
 *   optedOutBefore: Set<string>,
 * }} args
 * @returns {Promise<{ optedOut: string[] } | { back: true }>}
 */
async function promptSyncScopeSelection({ opts, ask, confirm, optedOutBefore }) {
  // The full sync picture, not only the editable slice: the org's locked
  // sources always sync (LLP 0188 #locked), so a gate that omitted them
  // would understate what the server sees. They keep the fleet suffix
  // and are never editable here.
  const locked = (opts.locked ?? []).map((d) => `${d.label}${LOCKED_LABEL_SUFFIX}`)
  const syncing = [
    ...locked,
    ...opts.candidates.filter((d) => !optedOutBefore.has(d.id)).map((d) => d.label),
  ]
  const local = opts.candidates.filter((d) => optedOutBefore.has(d.id)).map((d) => d.label)
  // One source per line. A fresh run is a single list under the title;
  // a re-entry with standing opt-outs shows both halves of the split.
  const gateTitle = syncing.length > 0 ? 'These will sync to your server:' : 'Staying local-only:'
  const gateItems = [
    ...syncing.map((label) => `  ${label}`),
    ...(local.length > 0 && syncing.length > 0 ? ['Staying local-only:'] : []),
    ...local.map((label) => `  ${label}`),
  ]
  // The express gate already accepted this lane (LLP 0201): state the same
  // split it would have shown, then take it. Never silent - LLP 0188
  // #never-silent binds the statement, not the keypress.
  // @ref LLP 0201#narrate [implements]: an auto-accepted gate prints its statement instead of prompting
  if (opts.autoAccept) {
    narrateAcceptedGate({ stdout: opts.stdout, title: gateTitle, items: gateItems })
    return { optedOut: [...optedOutBefore].sort() }
  }
  let screen = 'gate'
  while (true) {
    if (screen === 'gate') {
      let choice
      try {
        choice = await confirm({
          title: gateTitle,
          ...(opts.progress ? { progress: opts.progress } : {}),
          items: gateItems,
          options: [
            { value: 'accept', label: local.length === 0 ? 'Sync all' : 'Keep this' },
            { value: 'customize', label: 'Select what to sync' },
          ],
          default: 'accept',
          ...(opts.allowBack ? { allowBack: true } : {}),
        })
      } catch (err) {
        if (isPromptBackError(err)) return { back: true }
        throw err
      }
      if (choice !== 'customize') return { optedOut: [...optedOutBefore].sort() }
      screen = 'menu'
    } else {
      try {
        const checked = await ask({
          pickType: 'clients',
          title: SYNC_SCOPE_MENU_TITLE,
          ...(opts.progress ? { progress: opts.progress } : {}),
          options: [
            // Locked rows lead the menu as read-only context, exactly as the
            // picker renders them: checked, disabled, fleet-labeled. They are
            // not candidates, so they never reach the opt-out computation.
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
          // The gate is always this lane's first screen, so the menu's
          // back always has a target.
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
        if (isPromptBackError(err)) {
          screen = 'gate'
          continue
        }
        throw err
      }
    }
  }
}

/**
 * @param {WizardSyncScopeResult} result
 * @param {RunWizardSyncScopeOptions} opts
 * @returns {Promise<WizardSyncScopeResult>}
 */
async function finishSpan(result, opts) {
  await withSpan(
    'wizard.sync_scope.finish',
    {
      [Attr.COMPONENT]: 'wizard',
      [Attr.OPERATION]: 'wizard.sync_scope.finish',
      candidates: opts.candidates.length,
      sources_opted_out: result.optedOut.length,
      status: result.cancelled ? 'cancelled' : result.back ? 'backed' : result.skipped ? 'skipped' : 'ok',
    },
    async () => {},
    { component: 'wizard' }
  )
  return result
}
