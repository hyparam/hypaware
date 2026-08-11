// @ts-check

import { Attr, getLogger, withSpan } from '../../observability/index.js'
import { isPromptBackError, isPromptCancelledError } from '../tui/runtime.js'
import { defaultConfirmSelectPromptFactory } from '../walkthrough.js'

/**
 * @import { RunWizardExpressGateOptions, WizardExpressChoice } from '../../../../src/core/cli/wizard/types.js'
 */

const EXPRESS_TITLE = 'HypAware found these on this machine:'

/**
 * The wizard's express gate (LLP 0201): one question, before the question
 * lanes, that answers all of them at once.
 *
 * Every lane already opens with a defaults gate of its own (LLP 0190), so
 * the common run is a sequence of bare enters whose answers were knowable
 * before the first one. This collapses that sequence into a single yes:
 * record what was detected, sync all of it, let new folders sync. Declining
 * runs the lanes exactly as before, gates and all.
 *
 * The screen is the *list* plus two verbs, not a policy summary: `rows` are
 * the pick gate's own rows (LLP 0201 #gate), so "Record and sync all of
 * these" points at something concrete the user can read, and the alternative
 * is simply "Let me choose". A gate whose rows would be empty is never
 * asked - the orchestrator skips it, because there would be nothing to
 * accept. Nor is a gate with only one gate behind it (LLP 0201
 * #one-lane-no-gate): on a solo local run the pick gate is the only
 * question and already offers these rows itself, so the orchestrator
 * shows this screen only on an enrolled run, whose itinerary adds the
 * sync and new-folder lanes.
 *
 * Accepting is never silent (LLP 0188 #never-silent): each lane still
 * narrates the statement its gate would have shown, it simply does not stop
 * for an answer. The user therefore sees the same rows in the same order,
 * minus the keypresses.
 *
 * @ref LLP 0201#gate [implements]: one question before the lanes, naming the rows it will record, that accepts every lane's stated default
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
      // The rows themselves are the explanation. They are the pick gate's
      // own rows (LLP 0201 #gate), so accepting here records exactly what
      // is on screen.
      items: opts.rows,
      options: [
        {
          value: 'defaults',
          // The label names the act on the listed things, not an abstract
          // "defaults": one line the user can check against the list above
          // it. `sync` is claimed only on an enrolled run - on a solo
          // machine nothing forwards, so promising it would be a claim the
          // install cannot keep.
          label: opts.enrolled ? 'Record and sync all of these' : 'Record all of these',
          // The one row guaranteed to be read on the fast path, so the
          // side-effect disclosure lives here as well as on the pick gate
          // it stands in for (LLP 0190 #pick-gate). One line: what
          // accepting does to the machine, plus the folder policy that
          // rides with it.
          summary: opts.enrolled
            ? 'Configures each to record through HypAware; new folders sync too.'
            : 'Configures each to record through HypAware.',
        },
        { value: 'choose', label: 'Let me choose' },
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
 * Print the statement a lane's defaults gate would have shown, when the
 * express gate already answered it.
 *
 * This is what keeps the fast path honest: the lanes' gates are the
 * never-silent surfaces (LLP 0188 #never-silent, LLP 0190), and skipping
 * the *prompt* must not skip the *statement*. The wording is the gate's
 * own title and items, so the two paths read identically apart from the
 * missing question.
 *
 * A blank line leads each block. On the express path these statements
 * arrive back to back with nothing to break them up - the prompts that
 * used to separate them are exactly what was removed - so without it the
 * run reads as one paragraph of mixed subjects. `lead: false` exists for
 * a block that already has a blank line above it, so a run never shows
 * a double gap; no current caller needs it since the pick lane's welcome
 * banner (its former blank-line source) was retired with LLP 0211.
 *
 * @ref LLP 0201#narrate [implements]: an auto-accepted gate prints its statement instead of prompting
 * @param {{ stdout: { write(chunk: string): unknown }, title: string, items?: string[], lead?: boolean }} args
 */
export function narrateAcceptedGate({ stdout, title, items = [], lead = true }) {
  stdout.write(`${lead ? '\n' : ''}${title}\n`)
  for (const item of items) stdout.write(`${item}\n`)
}
