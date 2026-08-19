# LLP 0289: The sync lane asks the store about the rows it may not name

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, CLI, Config
**Author:** Brendan / Claude
**Date:** 2026-08-19
**Related:** LLP 0276 (#no-candidates: the sentence this qualifies, and the counts it widens), LLP 0188 (#opt-out: the store the export seam reads; #locked: why an org row needs no such question; #never-silent: the rule the unqualified sentence broke), LLP 0202 (#carry-through: how a hidden row ends up among the picks), LLP 0192 (#fail-closed: the seam that does the withholding)

> Extends [LLP 0276 §no-candidates](./0276-hidden-rows-stay-off-the-sync-gate.decision.md#no-candidates):
> the hidden *picks* cross into the sync lane as ids rather than a count,
> because the sentence they license is a claim about the export seam and
> only the policy store can settle it. The hidden *locked* rows keep their
> count.

## The problem {#problem}

LLP 0276 §no-candidates gave the empty-candidate branch four sentences and
picked between them on two counts, `lockedHidden` and `candidatesHidden`.
The third one reads:

```
You picked nothing to record, but capture already set up on this machine
still syncs to your server.
```

It fires on `candidatesHidden > 0`, and `candidatesHidden` counts the rows
the display filter took off the screen. That count says a hidden picked row
*exists*. The sentence claims the row *ships*, and those are different
facts.

A hidden row is off every wizard screen (LLP 0202, LLP 0276) but it is not
off every surface. It is a picker source with an id, and
`hyp policy client raw-anthropic local-only` addresses it by that id. The
entry lands in the machine-local client-sync store, which is exactly what
the export seam reads: `buildSourceWithholdResolver` withholds
`optedOutClientSourceIds(entries)` minus the central-classified ids
(`src/core/runtime/source_withhold.js`). So a user who ran that command,
then re-ran `hyp init` and picked nothing visible, was told their capture
still syncs while the seam was already withholding all of it.

The lane could not tell. `optedOutBefore` is computed over `candidateIds`,
the *visible* candidates (`sync_scope.js:80-81`), so a hidden id was
invisible to the only store read the lane performs. It printed the
qualified sentence unconditionally, on the screen LLP 0188 #never-silent
exists to make truthful.

## Decision {#ask-the-store}

**The hidden picks reach the sync lane as ids, and the lane spends them on
the store rather than on the screen.** `RunWizardSyncScopeOptions`'
`candidatesHidden` count becomes `candidatesHiddenIds`, and the branch
fires only when at least one of those ids has no standing `local-only`
entry:

- **Some hidden pick still ships.** The LLP 0276 sentence stands verbatim.
- **Every hidden pick is already withheld.** Nothing visible was picked and
  nothing leaves the machine, so the branch reads the fourth sentence,
  *"You picked nothing to record, so nothing syncs to your server."* That
  is now the true one.

The check is "any hidden pick ships", never "every one does": one withheld
row beside one standing row is still capture leaving the machine.

**Ids, not a richer count.** The alternative was to keep the count and have
the orchestrator (`src/core/cli/wizard/index.js`) pre-answer the question,
passing "how many hidden picks are standing". That makes the wizard a
second reader of a privacy store the lane already reads, with its own
failure mode: the lane degrades a corrupt store to a warning and a skipped
step, while a read in the orchestrator would throw out of the whole run.
One reader, one interpretation, one failure path.

**Withholding the ids was never the point.** LLP 0276 called them counts so
the lane "can tell the truth about them without being able to name them",
and naming them is what stays forbidden: the lane prints no hidden row,
before or after this change, and the tests assert it. What the lane gains
is the ability to *ask about* a row it may not print. A privacy screen that
is denied the identity of the thing it is describing cannot check its own
claim, and the LLP 0188 #never-silent cost of a wrong claim is higher than
the LLP 0202 cost of the lane holding an id it never renders.

**The locked list keeps its count.** `lockedHidden` needs no store
question, and giving it one would be wrong. An org row always syncs
(LLP 0188 #locked) and the export seam deliberately drops opt-out entries
for central-classified sources, so a standing entry for a hidden locked row
is inert. Its sentence is unconditional because the fact is. The asymmetry
between the two fields is the asymmetry between the two kinds of row.

## Consequences {#consequences}

- `src/core/cli/wizard/index.js` passes `candidatesHiddenIds` (the picked
  descriptors the display filter dropped, by id) in place of
  `candidatesHidden`; `lockedHidden` is unchanged.
- `runWizardSyncScope` computes the store's full opted-out set, not only
  the slice covering the visible candidates, and reads the hidden picks
  against it. The visible-candidate path is untouched: `optedOutBefore`
  still governs what the gate and menu render and what the write keeps,
  because those screens edit only what they show.
- The store is still not written on this path, opted-out hidden row or not.
  It stays `noQuestion`, so LLP 0191 #back-edges and the step counter are
  unaffected.
- A machine with no store file reads as nothing opted out (LLP 0188
  #migration), so a fresh enrolled run reaches the same sentence it did
  before this change.

## Not done {#not-done}

LLP 0281 §visible-org-row (in review on PR #925, not on `master` at the
time of writing) reuses this same sentence on a sibling branch: a visible
org row standing beside a hidden pick. It carries the same exposure for the
same reason. When it lands it consults the same `candidatesHiddenIds`
answer this doc mints, so the two branches keep agreeing rather than
disagreeing about one fact. Nothing else about LLP 0281 is affected.

## References

- LLP 0276, LLP 0202, LLP 0188, LLP 0192, LLP 0191
- `src/core/cli/wizard/sync_scope.js` (`runWizardSyncScope`),
  `src/core/cli/wizard/index.js` (the sync lane's call site),
  `src/core/cli/wizard/types.d.ts` (`RunWizardSyncScopeOptions`),
  `src/core/runtime/source_withhold.js` (the seam whose behaviour the
  sentence claims), `src/core/usage-policy/client_sync.js` (the store)
