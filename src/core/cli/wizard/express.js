// @ts-check

import { Attr, getLogger, withSpan } from '../../observability/index.js'
import { isPromptBackError, isPromptCancelledError } from '../tui/runtime.js'
import { defaultConfirmSelectPromptFactory } from '../walkthrough.js'

/**
 * @import { RunWizardExpressGateOptions, WizardExpressChoice } from '../../../../src/core/cli/wizard/types.js'
 */

const EXPRESS_TITLE = 'Set up recording'

/**
 * The wizard's express gate (LLP 0201): the one accept-or-customize
 * question, before the question lanes, that answers all of them at once.
 *
 * Accepting takes every lane's stated default; declining asks the real
 * questions, linearly, with no further accept-or-customize screens
 * (LLP 0201 #decline). Shown on every attended pass whose seeding yields
 * default rows, on both pathways.
 *
 * The rows are self-explaining (LLP 0201 #gate): the detected tool names
 * live in the accept row's own summary sentence, not in the items chrome
 * above the key-hint line, which goes unread. The sentence is both the
 * disclosure (accepting *configures* those tools, LLP 0190 #pick-gate)
 * and the evidence (what was found). `sync` is claimed only on an
 * enrolled run - on a solo machine nothing forwards, so promising it
 * would be a claim the install cannot keep.
 *
 * Accepting is never silent (LLP 0188 #never-silent): each lane still
 * narrates the statement it would have shown, it simply does not stop
 * for an answer.
 *
 * @ref LLP 0201#gate [implements]: one self-explaining question before the lanes, naming the tools in the accept row's summary, that accepts every lane's stated default
 * @param {RunWizardExpressGateOptions} opts
 * @returns {Promise<WizardExpressChoice>}
 */
export async function runWizardExpressGate(opts) {
  const log = getLogger('wizard')
  const confirm = opts.confirm ?? defaultConfirmSelectPromptFactory(opts)

  /** @type {string | number} */
  let choice
  try {
    choice = await confirm({
      title: EXPRESS_TITLE,
      options: [
        {
          value: 'defaults',
          // "and sync" is claimed only where accepting would in fact sync
          // everything named. Unenrolled, nothing forwards. Enrolled with a
          // standing opt-out in the store, accepting *keeps* that opt-out
          // (`sync_scope.js` returns `optedOutBefore` verbatim on this
          // keypress), so the unqualified promise is false on exactly the
          // reconfigure the retired sync gate handled with its
          // "Sync all" / "Keep this" split. Dropping the clause rather than
          // qualifying it reuses the shipped solo label and keeps the row
          // one short line; the accept narration still states the split
          // (LLP 0201 #narrate), so nothing goes unsaid.
          // @ref LLP 0201#gate [implements]: the accept row claims sync only when the install can keep the promise
          label: opts.enrolled && !opts.syncWithheld ? 'Record and sync everything' : 'Record everything',
          // The one row guaranteed to be read on the fast path, so the
          // tool names and the side-effect disclosure live here rather
          // than above the prompt chrome (LLP 0201 #gate). One sentence
          // doing both jobs: it names what was found, and it says that
          // accepting *configures* those tools rather than merely
          // watching them. That second half is the disclosure LLP 0190
          // #pick-gate put on the happy-path accept row, which is this
          // row now that the per-lane gates are retired - an express
          // accept never opens the menu whose per-row summaries carry
          // the specifics (attach, config writes, helper skills, the
          // OTLP receiver), so dropping it here drops it everywhere.
          // @ref LLP 0190#pick-gate [implements]: the happy path's accept row carries the one-line configures-your-tools disclosure
          summary: `Configures ${joinNames(opts.rows)} to record through HypAware.`,
        },
        {
          value: 'choose',
          label: 'Customize',
          // The decline row glosses the questions it opens (LLP 0201
          // #decline): the menus, not another round of gates. All of
          // them, in the order they open. An enrolled decline opens
          // three (pick, sync, new-folder), and a gloss that named two
          // of them understated what saying no leads to on the wizard's
          // one consent screen. The clauses track the counted lanes'
          // own labels ("Choose what to collect", "Choose what syncs",
          // "Choose how new folders are handled", `steps.js`), so the
          // row and the position lines it opens say the same thing.
          // Unenrolled, the sync and new-folder lanes do not run
          // (nothing forwards from a solo machine), so the gloss keeps
          // naming only the menu that does.
          // @ref LLP 0201#decline [implements]: the decline row names every question the decline opens
          summary: opts.enrolled
            ? 'Choose what to record, what syncs, and how new folders are handled.'
            : 'Choose what to record.',
        },
      ],
      default: 'defaults',
      ...(opts.allowBack ? { allowBack: true } : {}),
    })
  } catch (err) {
    if (isPromptBackError(err)) return 'back'
    if (!isPromptCancelledError(err)) throw err
    return 'cancelled'
  }

  const result = /** @type {WizardExpressChoice} */ (choice === 'defaults' ? 'defaults' : 'choose')
  await withSpan(
    'wizard.express_gate',
    {
      [Attr.COMPONENT]: 'wizard',
      [Attr.OPERATION]: 'wizard.express_gate',
      express: result,
      enrolled: opts.enrolled === true,
      status: 'ok',
    },
    async () => {},
    { component: 'wizard' }
  )
  log.info('wizard.express_gate', { [Attr.COMPONENT]: 'wizard', express: result })
  return result
}

/**
 * Join tool names into one spoken-order list: "Claude Code", "Claude Code
 * and Codex", "Claude Code, Codex, and OpenClaw". The names arrive plain
 * (no fleet or setup suffixes): the sentence names what was found, and
 * the per-row detail stays on the later screens and narrations.
 *
 * @param {string[]} names
 * @param {string} [conjunction] joins the last name; "and" unless the
 *   sentence wants "or" (the folder-ask title reads any-of, not all-of)
 * @returns {string}
 */
export function joinNames(names, conjunction = 'and') {
  if (names.length <= 1) return names[0] ?? ''
  if (names.length === 2) return `${names[0]} ${conjunction} ${names[1]}`
  return `${names.slice(0, -1).join(', ')}, ${conjunction} ${names[names.length - 1]}`
}

/**
 * Print the statement a lane would have shown, when the express gate
 * already answered it.
 *
 * This is what keeps the fast path honest: the lanes are the
 * never-silent surfaces (LLP 0188 #never-silent), and skipping the
 * *prompt* must not skip the *statement*.
 *
 * A blank line leads each block. On the express path these statements
 * arrive back to back with nothing to break them up - the prompts that
 * used to separate them are exactly what was removed - so without it the
 * run reads as one paragraph of mixed subjects. `lead: false` exists for
 * a block that already has a blank line above it, so a run never shows
 * a double gap; no current caller needs it since the pick lane's welcome
 * banner (its former blank-line source) was retired with LLP 0211.
 *
 * @ref LLP 0201#narrate [implements]: an auto-accepted lane prints its statement instead of prompting
 * @param {{ stdout: { write(chunk: string): unknown }, title: string, items?: string[], lead?: boolean }} args
 */
export function narrateAcceptedGate({ stdout, title, items = [], lead = true }) {
  stdout.write(`${lead ? '\n' : ''}${title}\n`)
  for (const item of items) stdout.write(`${item}\n`)
}
