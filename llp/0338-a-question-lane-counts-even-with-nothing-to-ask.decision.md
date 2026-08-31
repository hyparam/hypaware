# LLP 0338: A question lane counts even on the machine where it has nothing to ask

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, CLI
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-08-31
**Extends:** [LLP 0135](./0135-install-experience-overhaul.design.md)
(#progress fixed three rules for the position indicator and left one case
between two of them: a lane that is a question lane on the pathway but has
no question on this machine. This decision names which rule wins)
**Related:** LLP 0188 (#never-silent: the sync lane's statement, which is
what this leaves untouched), LLP 0201 (#decline: the gate gloss that names
the lanes a decline opens), LLP 0276 (#no-candidates: the lane that states
its outcome and asks nothing), LLP 0191 (#back-edges: the other place a
no-question lane is treated specially, and why it can be),
hyparam/hypaware#1147

> On a fully fleet-managed machine the sync lane prints
> `Step 3 of 5 · Choose what syncs`, states that everything picked is the
> fleet's and always syncs, and asks nothing. The position line names a
> choice the screen does not offer. This decision keeps it: the itinerary
> is a property of the pathway, not of the machine, and every alternative
> either moves a denominator that must not move or leaves a hole where a
> step the user passed through should be.

## Context {#context}

[LLP 0135 #progress](./0135-install-experience-overhaul.design.md#progress)
gave the wizard a position line and three rules to keep the denominator
honest. Two of them meet on this case and point opposite ways.

Rule 1 says the denominator resolves after the fork and never moves again.
Rule 2 says steps are prompt lanes, not phases, and gives `first look` as
the worked example: it "renders with no counter rather than inflating the
total with a step nobody answers".

The sync lane on a fully fleet-managed machine is a step nobody answers.
It reaches `candidates.length === 0` (LLP 0276 #no-candidates), writes its
position line, states the fleet sentence and the locked rows, and returns
without prompting. Rendered:

```
Step 3 of 5 · Choose what syncs
Everything you picked is managed by your fleet and always syncs.
  Claude Code
```

The same shape reaches the same arm when the opt-out store is unreadable.

## The itinerary is a property of the pathway, not of the machine {#counts-anyway}

**A lane the pathway runs counts, and states its position, whether or not
it turns out to have a question on this machine.** Nothing about the
counter changes.

Rule 1 decides it, because the alternatives need something rule 1 forbids:

- **Dropping the lane from the denominator is not available.** The sync
  lane's candidates are `picked.descriptors`, the pick lane's own result.
  The pick lane runs after the fork, and on the decline path it runs after
  the express gate too, so at the moment the denominator resolves nobody
  knows whether the lane will have a row to offer. A user who adds one
  unlocked tool in the pick menu gives that same lane a real question. A
  total that waited for that answer would be a total that moves, which is
  the one thing #progress forbids outright.
- **Blanking the position line alone is worse than the overstatement it
  fixes.** With the denominator pinned at five, suppressing the numerator
  on this lane prints `Step 2 of 5`, then a screen with no position, then
  `Step 4 of 5`. On a consent surface a missing step number reads as a
  screen that was skipped without being shown, which is the opposite of
  what happened: the screen was shown, and it said what it did. A counter
  exists to say where the reader is (issue #415); a hole says the reader
  cannot be told.
- **`first look` does not transfer.** It renders without a counter because
  it is a report on *every* run, on every pathway, which is a static
  property known when the itinerary resolves. That is what lets it leave
  the denominator entirely and therefore leave no hole. The sync lane is a
  question lane that happens to have nothing to ask on one machine shape,
  which is a runtime property. Rule 2 excludes phases, not question lanes
  having a quiet day.

Rule 3 already reaches the same answer from the front:
"a lane counts once, however many prompts it contains", written for
`join`, whose internal prompt count is unknowable at fork resolution.
Zero is the bottom of that range, not an exception to it.

**The statement was never at stake.** LLP 0188 #never-silent binds what
the lane says, not whether it asks, and this lane says its facts in full
on the screen the position line sits above. What the line overstates is
interactivity, and the very next line corrects it, in the same frame, at
the first moment the machine could know.

## The decline gloss stands as written {#gloss}

The express gate's Customize row glosses the lanes a decline opens
("Choose what to record, what syncs, and how new folders are handled",
LLP 0201 #decline). On this machine the middle clause names a lane that
will not ask, so the gloss can overstate by one.

It stays. The gate cannot know: whether the sync lane asks depends on the
user's own pick-menu answers, which happen after the gate on the decline
path. The gloss names the lanes a decline opens, which is true of every
run, and tracks the counted lanes' own labels so the row and the position
lines it opens say the same thing. Tightening it to this machine would
desync it from the `Choose what syncs` line on the screen it leads to, and
would still be guessing.

## Consequences {#consequences}

- `wizardItinerary` stays a pure function of pathway and `managed`, with
  no lane-emptiness input, and `steps.js` stays a data module with no I/O.
  Every pathway prints exactly what it printed before this decision.
- Of the lanes the wizard could have counted, `first look` remains the
  only one held outside the denominator, and remains so on the static
  ground that it is never a question anywhere. The fork (rule 3) and the
  express gate (LLP 0201 #no-counter) are outside it for the prior
  reason and are untouched here: each is what fixes the total, so neither
  can state one.
- LLP 0191 #back-edges is unaffected and stays asymmetric with this on
  purpose: the back edge skips a lane that asked nothing because it is
  chosen *after* that lane ran and reported `noQuestion`, so it can use a
  fact the counter has to state before it exists.
- A future lane that is narration-only on every run belongs out of the
  itinerary, like `first look`. A future lane that is sometimes empty
  belongs in it, like this one. The test is whether the fork can know.

## References

- LLP 0135 (#progress), LLP 0188, LLP 0191, LLP 0201, LLP 0276
- `src/core/cli/wizard/steps.js` (the itinerary and the position line),
  `src/core/cli/wizard/sync_scope.js` (the no-candidates arm that renders
  the position line above a statement),
  `src/core/cli/wizard/express.js` (the decline gloss)
- `test/core/cli/wizard/progress.test.js`
