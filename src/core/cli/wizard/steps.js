// @ts-check

/**
 * @import { WizardPathway, WizardStepName } from '../../../../src/core/cli/wizard/types.js'
 */

/**
 * Display names for the counted lanes. Verb-shaped and short: they name
 * what the user is about to do, not the internal phase name, so the line
 * reads as a position in a journey rather than as debug output.
 */
export const WIZARD_STEP_LABELS = /** @type {Record<WizardStepName, string>} */ ({
  join: 'Join your team',
  pick: 'Choose what to collect',
  sync: 'Choose what syncs',
  folders: 'Choose how new folders are handled',
  finale: 'Finish setup',
})

/**
 * The counted lanes per pathway, in the order they run.
 *
 * Four rules produce these lists, and each one exists to stop the
 * denominator from being a lie:
 *
 * 1. **Only lanes that ask something are counted.** The `configure` phase
 *    and the privacy narration are output the user does not act on; a
 *    counter that advanced while text scrolled past would read as broken.
 *    `first look` has a prompt-shaped renderer but is a closing report,
 *    not a decision, so it renders without a counter rather than inflating
 *    the total with a step nobody answers.
 * 2. **The join lane counts once**, however many prompts happen inside it.
 *    It delegates to `runRemoteLogin`, which can ask for an org, so its
 *    internal prompt count is not knowable at fork resolution. Counting the
 *    lane instead of its prompts is what makes the total fixed from the
 *    moment the pathway is committed.
 * 3. **The fork is not a step.** The pathway it asks for is exactly what
 *    fixes the total, so the fork can never state one. It is absent from
 *    every list here and `runInitWizard` passes it no progress line.
 * 4. **A question lane counts on the machine where it has nothing to ask.**
 *    The sync lane asks nothing on a fully fleet-managed machine (LLP 0276
 *    #no-candidates) and still prints `Step 3 of 5 · Choose what syncs`
 *    above the statement it makes instead. The fixed denominator is why
 *    (LLP 0135 #progress, restated on `wizardStepProgress` below: it
 *    resolves at the fork and never moves): the lane's candidates are the
 *    pick lane's result, so at fork resolution nobody knows whether it
 *    will have a row to offer, and a total that waited for that answer
 *    would move. Blanking the numerator alone would print step 2, then a
 *    screen with no position, then step 4, and on a consent surface a
 *    missing number reads as a screen skipped without being shown.
 *    `first look` leaves the count under rule 1 on different ground: it
 *    is a report on every run, which the fork already knows, so dropping
 *    it leaves no hole. Rule 2 says the same thing from the front - a
 *    lane counts once however many prompts it holds, and zero is the
 *    bottom of that range.
 */
const WIZARD_ITINERARIES = /** @type {Record<WizardPathway, WizardStepName[]>} */ ({
  team: ['join', 'pick', 'sync', 'folders', 'finale'],
  local: ['pick', 'finale'],
})

/**
 * The counted lanes a committed pathway will run, in order. An
 * uncommitted pathway (the fork has not resolved, or the run is
 * non-interactive) has no itinerary and therefore no denominator.
 *
 * The `sync` lane (LLP 0188 #never-silent) and the `folders` lane
 * (LLP 0200 #wizard) run on every enrolled run, in that order: always on
 * the team pathway (the run that just enrolled), and on the local pathway
 * only for a managed machine reconfiguring through it (LLP 0182:
 * `managed` is an input, not a pathway). Both are enrolled-only for the
 * same reason - nothing forwards from an unenrolled machine, so neither
 * question has stakes there (LLP 0106 #enrolled-only). `managed` is known
 * at the gate, before the fork, so the denominator still resolves once.
 *
 * @param {WizardPathway | undefined} pathway
 * @param {{ managed?: boolean }} [opts]
 * @returns {WizardStepName[]}
 */
export function wizardItinerary(pathway, opts = {}) {
  if (!pathway) return []
  const base = WIZARD_ITINERARIES[pathway] ?? []
  if (pathway === 'local' && opts.managed === true) {
    return base.flatMap((step) => (step === 'pick' ? ['pick', 'sync', 'folders'] : [step]))
  }
  return base
}

/**
 * The position line for one lane of one pathway, e.g.
 * `Step 2 of 3 · Choose what to collect`. Returns `undefined` whenever the
 * position cannot be stated honestly: before the pathway is committed, on
 * a non-interactive run, or for a lane this pathway never runs (`join` on
 * the local pathway). Callers thread `undefined` straight through, so a
 * run with no committed pathway emits no breadcrumb at all and its output
 * is byte-identical to a run from before this existed.
 *
 * The denominator resolves once, at the fork, and never moves afterwards.
 * A failed join returns to the fork, which carries no counter, so a retry
 * that lands on a different pathway simply starts that pathway's count
 * rather than contradicting a total already on screen.
 *
 * @ref LLP 0135#progress [implements]: the denominator is resolved after the fork, counts prompt lanes rather than phases, and is absent when no pathway is committed
 * @ref LLP 0338#counts-anyway [implements]: the itinerary is a property of the pathway, so a lane with nothing to ask on this machine keeps both its place in the total and its position line
 *
 * @param {WizardPathway | undefined} pathway
 * @param {WizardStepName} step
 * @param {{ managed?: boolean }} [opts]
 * @returns {string | undefined}
 */
export function wizardStepProgress(pathway, step, opts) {
  const itinerary = wizardItinerary(pathway, opts)
  const index = itinerary.indexOf(step)
  if (index < 0) return undefined
  return `Step ${index + 1} of ${itinerary.length} · ${WIZARD_STEP_LABELS[step]}`
}
