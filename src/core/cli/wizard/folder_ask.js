// @ts-check

import { Attr, withSpan } from '../../observability/index.js'
import { readObservabilityEnv } from '../../observability/env.js'
import { isPromptBackError, isPromptCancelledError } from '../tui/runtime.js'
import { defaultConfirmSelectPromptFactory } from '../walkthrough.js'
import { readFolderAskModeSafe, writeFolderAskMode } from '../../usage-policy/index.js'
import { joinNames, narrateAcceptedGate } from './express.js'

/**
 * @import { RunWizardFolderAskOptions, WizardFolderAskResult } from '../../../../src/core/cli/wizard/types.js'
 * @import { FolderAskMode } from '../../../../src/core/usage-policy/types.js'
 */

/**
 * The question's title: a sentence lead-in the rows complete, naming the
 * recorded tools so a first-time user knows what a "session" is. "or"
 * because any one of them opening triggers the moment, not all at once.
 * The names come from the run's own picks; a run that has none to offer
 * falls back to the tool-free phrasing.
 *
 * @param {string[]} names
 * @returns {string}
 */
export function folderAskTitle(names) {
  return names.length > 0
    ? `When opening ${joinNames(names, 'or')} in a new project,`
    : 'When starting a session in a new project,'
}

/**
 * The two answers, in display order. Sync leads because it is the default
 * (LLP 0200 #default): a bare enter is "new folders sync", which is the
 * answer most users on an enrolled machine already mean.
 *
 * Each row is self-explaining (LLP 0201 #gate): the label completes the
 * title's sentence, and the summary carries the consequence rather than
 * restating the label, so neither answer is a surprise later. Nothing
 * rides the items chrome above the key-hint line, which goes unread.
 *
 * @type {ReadonlyArray<{ value: FolderAskMode, label: string, summary: string }>}
 */
export const FOLDER_ASK_OPTIONS = [
  {
    value: 'sync',
    label: 'Sync it automatically',
    summary: 'Recording from a new folder syncs without asking.',
  },
  {
    value: 'ask',
    label: 'Ask me the first time',
    summary: 'Your first session in a new folder asks: sync, keep it local, or ignore it.',
  },
]

/**
 * The wizard's new-folder step (LLP 0200 #wizard): one question, on every
 * enrolled run, right after the sync-scope lane.
 *
 * It is deliberately its own step rather than a row on the sync gate. The
 * gate answers "which of my adapters ship" (LLP 0188/0190) and this answers
 * "what happens the next time I work somewhere new"; they are different
 * axes, and folding the second into the first made a per-adapter checklist
 * silently decide a per-folder policy.
 *
 * `sync` is the default and one keypress. `ask` buys the per-folder
 * session-start question ([LLP 0106](../../../../llp/0106-session-start-classification-hook.decision.md)),
 * which is the interruption this step exists to make optional. The answer
 * is written either way: the user answered a question, and a recorded
 * answer is what `hyp status`, `hyp policy list`, and a later re-run read
 * back.
 *
 * A failed write warns and leaves the previous mode standing rather than
 * failing the run: onboarding has already done the load-bearing work by
 * this point, and `hyp policy folders` can set it later.
 *
 * @ref LLP 0200#wizard [implements]: the new-folder question is its own step, after the per-adapter sync lane
 * @ref LLP 0200#default [implements]: sync leads and is the bare-enter answer; the ask is the opt-in
 * @param {RunWizardFolderAskOptions} opts
 * @returns {Promise<WizardFolderAskResult>}
 */
export async function runWizardFolderAsk(opts) {
  const stateDir = readObservabilityEnv(opts.env).stateDir
  const before = await readFolderAskModeSafe({ stateDir })
  const title = folderAskTitle(opts.names ?? [])

  // The express gate already answered this lane (LLP 0201): state the
  // question and its standing answer, record it, and move on.
  //
  // `before`, not the constant: an accept takes the answer the prompted
  // arm would have offered (`default: before` below), which on a machine
  // that never set one *is* the default and on a machine that did is what
  // that user chose. Hardcoding the default here made "accept the
  // defaults" silently overwrite a standing `ask` with `sync` - the less
  // protective value - and then print the new value as though the user
  // had just answered it. LLP 0200 #wizard binds the round-trip to the
  // re-run, not to the prompt shape, and the sibling auto-accepted lane
  // round-trips its own store the same way (`sync_scope.js`, which keeps
  // `optedOutBefore` verbatim on this exact keypress). The answer is
  // still written on every run, which is what #wizard requires of the
  // step whether or not the value moved.
  // @ref LLP 0200#wizard [implements]: an express accept round-trips the standing preference instead of resetting it
  // @ref LLP 0201#narrate [implements]: an auto-accepted question prints its statement instead of prompting
  if (opts.autoAccept) {
    narrateAcceptedGate({ stdout: opts.stdout, title })
    // Inline: the title is a sentence lead-in still on screen, so the
    // answer belongs under it as an indented line completing it rather
    // than as a second flush-left announcement repeating the subject.
    return await recordAnswer(before, { stateDir, before, opts, inline: true })
  }

  const confirm = opts.confirm ?? defaultConfirmSelectPromptFactory(opts)
  /** @type {string | number} */
  let choice
  try {
    choice = await confirm({
      title,
      ...(opts.progress ? { progress: opts.progress } : {}),
      options: FOLDER_ASK_OPTIONS.map((o) => ({ value: o.value, label: o.label, summary: o.summary })),
      // A re-run defaults to the standing answer, so re-entering the wizard
      // round-trips the preference instead of resetting it.
      default: before,
      ...(opts.allowBack ? { allowBack: true } : {}),
    })
  } catch (err) {
    if (isPromptBackError(err)) return await finishSpan({ back: true, mode: before }, opts)
    if (!isPromptCancelledError(err)) throw err
    try {
      opts.stderr.write('hyp setup: cancelled\n')
    } catch {
      // best-effort: stderr might be closed during cleanup
    }
    return await finishSpan({ cancelled: true, mode: before }, opts)
  }

  const mode = /** @type {FolderAskMode} */ (
    FOLDER_ASK_OPTIONS.some((o) => o.value === choice) ? choice : before
  )
  return await recordAnswer(mode, { stateDir, before, opts })
}

/**
 * Persist the answer and confirm it, or warn and leave the previous mode
 * standing. Shared by the asked and the auto-accepted paths so both record
 * and report identically.
 *
 * `inline` renders the confirmation as part of the block above it (the
 * auto-accepted path, where the title is still on screen); the asked path
 * prints it flush-left, because the prompt frame it answers has cleared.
 *
 * @param {FolderAskMode} mode
 * @param {{ stateDir: string, before: FolderAskMode, opts: RunWizardFolderAskOptions, inline?: boolean }} ctx
 * @returns {Promise<WizardFolderAskResult>}
 */
async function recordAnswer(mode, { stateDir, before, opts, inline = false }) {
  try {
    await writeFolderAskMode({ stateDir, mode })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    // The inline path left its title on stdout as a sentence lead-in
    // ending in a comma, and the clause that completes it is written
    // below, after this branch has already returned. Nothing on stdout
    // then finishes the sentence: the next thing the user sees is the
    // configure phase's own output, under a half-written question. So
    // this arm completes it with the mode that actually stands, which is
    // `before` - the store was not written, so the standing answer is
    // still true of the machine and the title is still true of it. The
    // "could not record" half stays on stderr, where the failure belongs;
    // no new claim is made here, only the one the run was already about
    // to make.
    //
    // Before the warning, not after it. stdout and stderr are the same
    // terminal on the run this narration is for, so writing the warning
    // first wedges it between the lead-in and the clause that completes
    // it - a milder version of the half-written question this arm exists
    // to close. Finishing the sentence first leaves the warning where a
    // warning belongs: under the statement it qualifies. The two streams
    // are separate sinks in tests, so only the terminal can see this
    // ordering, which is why a test asserts it through one shared sink.
    //
    // Both writes are best-effort, and guarded separately. This is the arm
    // the step documents as one that warns rather than failing the run, so
    // a stream that throws must not be the thing that fails it; the cancel
    // path above already guards its one write for exactly that reason (a
    // stream can be closed under a run that is shutting down). The guards
    // are separate because the two halves are separate obligations: a
    // stdout that throws must not take the warning down with it, and a
    // warning that cannot be written must not take the run down with it.
    // Nothing is made conditional here - both writes still happen on every
    // reachable run, and the guard only covers the case that today ends the
    // run with the warning unsaid anyway.
    // @ref LLP 0201#narrate [implements]: a narrated question finishes its sentence even when the write behind it fails, before the warning that qualifies it
    // @ref LLP 0200#wizard [implements]: the failed-write arm warns and leaves the previous mode standing rather than failing the run, including when the warning itself cannot be written
    if (inline) {
      try {
        opts.stdout.write(`${standingClause(before)}\n`)
      } catch {
        // best-effort: stdout might be closed during cleanup
      }
    }
    try {
      opts.stderr.write(
        `warning: could not record the new-folder answer (${detail}); ` +
        `it stays '${before}' - set it later with 'hyp privacy folders ${mode}'\n`
      )
    } catch {
      // best-effort: stderr might be closed during cleanup
    }
    return await finishSpan({ mode: before, skipped: true }, opts)
  }

  // Two short lines rather than one long one: what is now true, then the
  // command that changes it, indented so it reads as a footnote to the
  // first rather than a second announcement.
  const undo = mode === 'sync' ? 'hyp privacy folders ask' : 'hyp privacy folders sync'
  const said = mode === 'sync'
    ? 'New folders will sync without asking.'
    : 'You will be asked once per new folder.'
  opts.stdout.write(
    inline
      ? `${standingClause(mode)}; change later with ${undo}\n`
      : `${said}\n  change this later: ${undo}\n`
  )
  return await finishSpan({ mode }, opts)
}

/**
 * The indented clause that completes the title's sentence on the inline
 * (narrated) path: "When opening Claude Code in a new project," + "it
 * syncs automatically". One source for it, because both the recorded and
 * the failed-write arms have to finish the same sentence.
 *
 * @param {FolderAskMode} mode
 * @returns {string}
 */
function standingClause(mode) {
  return mode === 'sync' ? '  it syncs automatically' : '  you are asked the first time'
}

/**
 * @param {WizardFolderAskResult} result
 * @param {RunWizardFolderAskOptions} opts
 * @returns {Promise<WizardFolderAskResult>}
 */
async function finishSpan(result, opts) {
  await withSpan(
    'wizard.folder_ask.finish',
    {
      [Attr.COMPONENT]: 'wizard',
      [Attr.OPERATION]: 'wizard.folder_ask.finish',
      folder_ask: result.mode,
      status: result.cancelled ? 'cancelled' : result.back ? 'backed' : result.skipped ? 'skipped' : 'ok',
    },
    async () => {},
    { component: 'wizard' }
  )
  return result
}
