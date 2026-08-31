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
    opts.stderr.write(
      `warning: could not record the new-folder answer (${detail}); ` +
      `it stays '${before}' - set it later with 'hyp privacy folders ${mode}'\n`
    )
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
      ? `  ${mode === 'sync' ? 'it syncs automatically' : 'you are asked the first time'}; change later with ${undo}\n`
      : `${said}\n  change this later: ${undo}\n`
  )
  return await finishSpan({ mode }, opts)
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
