// @ts-check

import { Attr, withSpan } from '../../observability/index.js'
import { readObservabilityEnv } from '../../observability/env.js'
import { isPromptBackError, isPromptCancelledError } from '../tui/runtime.js'
import { defaultConfirmSelectPromptFactory } from '../walkthrough.js'
import { readFolderAskModeSafe, writeFolderAskMode } from '../../usage-policy/index.js'
import { narrateAcceptedGate } from './express.js'

/**
 * @import { RunWizardFolderAskOptions, WizardFolderAskResult } from '../../../../src/core/cli/wizard/types.js'
 * @import { FolderAskMode } from '../../../../src/core/usage-policy/types.js'
 */

const FOLDER_ASK_TITLE = 'When you start a session in a new folder:'

/**
 * The two answers, in display order. Sync leads because it is the default
 * (LLP 0200 #default): a bare enter is "all my folders sync", which is the
 * answer most users on an enrolled machine already mean.
 *
 * The summaries carry the consequence rather than restating the label,
 * because this is the one screen where the per-folder question is either
 * bought or declined, and neither answer should be a surprise later: the
 * sync row names the per-folder verb that still exists, and the ask row
 * names what the interruption will look like.
 *
 * @type {ReadonlyArray<{ value: FolderAskMode, label: string, summary: string }>}
 */
export const FOLDER_ASK_OPTIONS = [
  {
    value: 'sync',
    label: 'Sync them all',
    summary: 'No question at session start; mark exceptions with hyp policy set',
  },
  {
    value: 'ask',
    label: 'Ask me about each new folder',
    summary: 'A session opened somewhere new asks once: sync, local-only, or ignore',
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

  // One short line, not a paragraph: the two rows below already say what
  // each answer does, so the only thing left worth stating is the caveat
  // that neither answer disturbs a folder the user already decided about.
  const items = ['  Folders you already marked keep their class either way.']

  // The express gate already answered this lane (LLP 0201): state the
  // question and its default answer, record it, and move on. The default
  // is the one the asked screen below states - the standing answer, not
  // the shipped one - so accepting the gate cannot silently retire a
  // per-folder question the user asked for on an earlier run.
  // @ref LLP 0201#narrate [implements]: an auto-accepted question prints its statement instead of prompting
  // @ref LLP 0279#standing-answer [implements]: the express arm records the lane's stated default, which on a re-run is the standing mode
  if (opts.autoAccept) {
    narrateAcceptedGate({ stdout: opts.stdout, title: FOLDER_ASK_TITLE, items })
    // Inline: the block's title already said "New folders", so the answer
    // belongs under it as one more indented line rather than as a second
    // flush-left announcement repeating the subject.
    return await recordAnswer(before, { stateDir, before, opts, inline: true })
  }

  const confirm = opts.confirm ?? defaultConfirmSelectPromptFactory(opts)
  /** @type {string | number} */
  let choice
  try {
    choice = await confirm({
      title: FOLDER_ASK_TITLE,
      ...(opts.progress ? { progress: opts.progress } : {}),
      items,
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
      opts.stderr.write('hyp init: cancelled\n')
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
 * Under `deferWrite` the lane states the answer here and hands the write
 * back as `commit` (LLP 0279 #one-commit-point): the statement belongs to
 * the screen that produced it, but the preference itself is part of this
 * run's answer set and lands only once the run's config does. A run that
 * ends before that point leaves the standing mode alone.
 *
 * @ref LLP 0279#one-commit-point [implements]: the preference write is handed back rather than made the moment the lane is answered
 * @param {FolderAskMode} mode
 * @param {{ stateDir: string, before: FolderAskMode, opts: RunWizardFolderAskOptions, inline?: boolean }} ctx
 * @returns {Promise<WizardFolderAskResult>}
 */
async function recordAnswer(mode, { stateDir, before, opts, inline = false }) {
  /**
   * The write, and what it leaves in force: the answer, or the previous
   * mode with the warning the lane's contract promises.
   *
   * @returns {Promise<{ mode: FolderAskMode, skipped?: true }>}
   */
  const write = async () => {
    try {
      await writeFolderAskMode({ stateDir, mode })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      opts.stderr.write(
        `warning: could not record the new-folder answer (${detail}); ` +
        `it stays '${before}' - set it later with 'hyp policy folders ${mode}'\n`
      )
      return { mode: before, skipped: /** @type {const} */ (true) }
    }
    return { mode }
  }

  if (opts.deferWrite) {
    announceAnswer(mode, opts, inline)
    return await finishSpan({ mode, commit: async () => (await write()).mode }, opts)
  }

  const written = await write()
  if (written.skipped) return await finishSpan(written, opts)
  announceAnswer(mode, opts, inline)
  return await finishSpan({ mode }, opts)
}

/**
 * Say what is now true and how to change it.
 *
 * Two short lines rather than one long one: what is now true, then the
 * command that changes it, indented so it reads as a footnote to the
 * first rather than a second announcement.
 *
 * @param {FolderAskMode} mode
 * @param {RunWizardFolderAskOptions} opts
 * @param {boolean} inline
 */
function announceAnswer(mode, opts, inline) {
  const undo = mode === 'sync' ? 'hyp policy folders ask' : 'hyp policy folders sync'
  const said = mode === 'sync'
    ? 'New folders will sync without asking.'
    : 'You will be asked once per new folder.'
  opts.stdout.write(
    inline
      ? `  ${mode === 'sync' ? 'Syncing them all' : 'Asking about each one'}; change later with ${undo}\n`
      : `${said}\n  change this later: ${undo}\n`
  )
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
