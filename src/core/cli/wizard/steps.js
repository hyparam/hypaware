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
  finale: 'Finish setup',
})

/**
 * The counted lanes per pathway, in the order they run.
 *
 * Three rules produce these lists, and each one exists to stop the
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
 */
const WIZARD_ITINERARIES = /** @type {Record<WizardPathway, WizardStepName[]>} */ ({
  team: ['join', 'pick', 'sync', 'finale'],
  local: ['pick', 'finale'],
})

/**
 * The counted lanes a committed pathway will run, in order. An
 * uncommitted pathway (the fork has not resolved, or the run is
 * non-interactive) has no itinerary and therefore no denominator.
 *
 * The `sync` lane (LLP 0181 #never-silent) runs on every enrolled run:
 * always on the team pathway (the run that just enrolled), and on the
 * local pathway only for a managed machine reconfiguring through it
 * (LLP 0182: `managed` is an input, not a pathway). `managed` is known
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
    return base.flatMap((step) => (step === 'pick' ? ['pick', 'sync'] : [step]))
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
