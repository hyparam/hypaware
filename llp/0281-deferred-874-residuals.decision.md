# LLP 0281: The sync gate's fleet sentence stops at the fleet's rows, and the returning gate keys on a recorded answer

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, CLI, Config
**Author:** Brendan / Claude
**Date:** 2026-08-19
**Related:** LLP 0276 (#no-candidates: the four-way split this adds a case to), LLP 0277 (#answer-less: the discriminator this carries to a second reader), LLP 0129 (#returning-gate: the gate being re-keyed), LLP 0182 (#one-reconfigure: the menu behind that gate), LLP 0202 (#carry-through: how a hidden row reaches a pick), LLP 0188 (#never-silent: why a sentence about what leaves the machine has to be true)

> Two residuals triaged out of PR #874 and tracked in issue #911. Both are
> the same shape: a screen keyed on a proxy for the fact it states. The
> sync gate's fleet sentence claims exhaustiveness over rows the fleet
> does not own, and the returning gate calls a machine "already set up"
> because a config *file* exists.

## Context {#context}

[LLP 0276 §no-candidates](./0276-hidden-rows-stay-off-the-sync-gate.decision.md#no-candidates)
split the sync lane's empty-candidate line four ways so it could never claim
"nothing syncs" while a display-filtered row was still standing. It solved
the *empty* cases. It left the non-empty one alone: with a visible org row
present, the lane still prints one sentence, and that sentence quantifies
over everything picked.

[LLP 0277 §consequences](./0277-answer-less-config-is-not-a-reconfigure.decision.md#consequences)
moved the pick phase off "a config file exists" and onto "the config records
a pick answer", and named the returning gate as a declared residual: it still
keys on `configExists && configValid`, so the answer-less config
`hyp remote add` writes still fronts onboarding with the "already set up"
summary.

## The visible org row is not a licence to speak for the rest {#visible-org-row}

> **Extended-by: [LLP 0289 §ask-the-store](./0289-sync-lane-asks-the-store-about-hidden-picks.decision.md#ask-the-store).**
> "A carried hidden row is also standing" is a question for the policy
> store, not something `candidatesHidden > 0` can answer: that count says
> such a row *exists*, and the sentence below claims it *ships*. The field
> is `candidatesHiddenIds`, and this branch fires only when at least one
> hidden pick has no standing `local-only` entry - the same question its
> no-locked sibling asks, so the two branches agree. The rows are still
> never named.

`runWizardSyncScope`'s no-candidates branch, with a visible locked row,
prints *"Everything you picked is managed by your fleet and always syncs"*
over the org rows. `candidatesHidden > 0` says a carried hidden row
(LLP 0202 §carry-through) is also standing: it is in `sources`, it composes
into the **local** layer, and absent an opt-out entry it syncs. The sentence
hands the fleet an owner's claim over capture the fleet does not own.

Unlike the cases LLP 0276 fixed, no clause here is affirmatively false about
*what* leaves the machine - which is why round 2 left it. But the fix is the
same rule that doc already applies twice, and applying it consistently is
cheaper than carrying the exception: **a sentence names only the rows whose
owner it names.** So with a hidden pick standing beside the org rows:

```
Your fleet manages these and they always sync:
  Claude Code
Capture already set up on this machine also syncs to your server.
```

The org rows keep a sentence scoped to themselves; the machine's own capture
gets the sentence LLP 0276 §no-candidates already minted for it, unchanged.
Neither line names the withheld row: `candidatesHidden` stays a count, per
LLP 0276's "the lane must be able to tell the truth about them without being
able to name them". With no hidden pick standing the exhaustive sentence is
true and stays exactly as it was, so the common enrolled run is untouched.

The path stays `noQuestion`, so LLP 0191 §back-edges and the step counter are
unaffected.

## The returning gate asks the pick lane's question {#returning-gate}

**`evaluateReturningGate` keys on a recorded pick answer, not on the config
file existing.** The guard becomes
`!configExists || !configValid || !configRecordsAnswer`, and a config that
records no answer takes the first-run path - straight through to
`runWizardFork`, no summary screen - exactly as a missing one does.

The gate cannot re-read the config itself without duplicating the layer
resolution, so the claim travels on the report it already collects:
`HypAwareStatusReport.configRecordsAnswer`, set by `collectHypAwareStatus`.

**Each layer answers on its own terms, not off the merge.** The local layer
answers when it records a pick answer at all (LLP 0277 §answer-less) - the
same discriminator the pick lane reads, so the gate and the lane cannot
classify one file two ways. The central layer answers when it carries capture
of its own: a machine whose fleet configured its sources *is* set up, the
fleet having answered on its behalf, and dropping it to the first-run path
would re-ask questions whose answers the org owns (LLP 0129
§join-before-picker).

The bare `@hypaware/central` **enrollment seed is not that answer.** `hyp join`
and the enrolling `hyp remote login` write
`plugins: [{ name: '@hypaware/central' }]` plus the central sink so the machine
can reach its server at all; that is on disk before anyone has been asked
anything, and reading it as an answer is the same file-existence proxy this
decision is removing. So a central layer naming only the enrollment plugin
records no answer.

Reading the **merged** config instead cannot express either half, and gets both
wrong in the direction that matters:

- it hides the enrollment seed among the plugins, so
  `hyp remote add` → `hyp remote login` → `hyp init` - the documented team
  order, and the whole point of this half of the decision - would still front
  the returning summary;
- `mergeConfigLayers` sets `plugins` on the effective config only when the
  merged list is non-empty, so a joined machine's deliberate `plugins: []`
  record-nothing pick would come back as "no answer" and re-open onboarding on
  it, which LLP 0277 §answer-less forbids.

What changes is only the machine whose config exists because a writer that
never asked the pick question created it.

`managed` is still read before the early return, on this branch for the same
reason as the invalid-config branch: the caller locks the org's rows off it,
and an editable org row composes into the local layer.

**The discriminator moves to `src/core/config/schema.js`.** It lived in the
CLI walkthrough, and `collectHypAwareStatus` is a daemon-side reader; the
daemon importing the walkthrough to ask one question about a config document
would close an import cycle (`walkthrough.js` already imports `status.js`).
One definition, beside the loader, with both readers importing it - the same
"one filter, not two that can disagree" rule LLP 0276 §consequences states.

## Consequences {#consequences}

- `hyp remote add` → `hyp remote login` → `hyp init` now presents the fork,
  not the returning summary, completing the journey LLP 0277 §consequences
  left half-fixed. The pick lane behind it was already correct.
- `configRecordsAnswer` is a new required field on `HypAwareStatusReport`.
  `hyp status`'s own rendering is unchanged: it keys its "configured" line on
  `configExists`, which still answers the question that line asks.
- A hand-written config without `plugins` re-opens the fork as well as the
  pick questions. Such a config could not have activated capture anyway.
- The sync gate's five no-question sentences are now one per fact. The only
  new one is the pairing; every individual sentence is one LLP 0276 minted.
- Nothing here touches capture, attribution, or the owner map that arms
  LLP 0192's fail-closed withholding. Both changes are screen text and one
  gate predicate.

## Not done here {#not-done}

Residual 3 of issue #911 - PR #874's title and body cite LLP 0266/0267 after
commit `e613ba25` renumbered the docs to 0276/0277 - is repository metadata
on a merged pull request, not code. It is corrected on the pull request
itself; there is nothing in the tree to change for it.

## References

- LLP 0276, LLP 0277, LLP 0129, LLP 0182, LLP 0202, LLP 0188, LLP 0191, LLP 0183
- `src/core/cli/wizard/sync_scope.js` (`runWizardSyncScope`),
  `src/core/cli/wizard/fork.js` (`evaluateReturningGate`),
  `src/core/config/schema.js` (`configRecordsPickAnswer`),
  `src/core/daemon/status.js` (`collectHypAwareStatus`)
- Issue #911, PR #874
