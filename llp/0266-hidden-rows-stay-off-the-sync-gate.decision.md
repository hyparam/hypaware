# LLP 0266: A hidden picker row stays off the sync gate too

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, CLI, Config
**Author:** Brendan / Claude
**Date:** 2026-08-18
**Related:** LLP 0202 (#hidden-rows: the display filter this widens, and the consequence line it corrects), LLP 0188 (#locked: why an org row is shown read-only rather than omitted), LLP 0190 (#sync-gate: the screen this changes), LLP 0031 (#status-provenance: the two-layer classification that decides "locked")

> Extends [LLP 0202 §hidden-rows](./0202-hidden-picker-rows.decision.md#hidden-rows)
> from "absent from the interactive menu and from the defaults gate" to
> "absent from every wizard screen", and corrects that doc's consequence
> line "the sync/opt-out menu is unchanged".

## The problem {#problem}

On an enrolled machine the sync gate led with rows the picker had
deliberately never offered:

```
These will sync to your server:
  Anthropic API · managed by your fleet
  OpenAI API · managed by your fleet
  Claude Code
  Codex
  ...
```

Both halves of that screen are individually correct and the combination is
misleading.

`raw-anthropic` and `raw-openai` are the two `hidden: true` rows (LLP 0202).
They are contributed by `@hypaware/ai-gateway`. `classifyClientProvenance`
resolves a picker row to its **owning plugin**, and `hyp join` writes a
central layer that declares `@hypaware/ai-gateway` (it carries the org's
`listen` address and `proxy_mode`). So on *every* enrolled machine those two
rows classify `'central'` and enter the locked set, while the client rows
the user actually picked - `claude`, `codex` - are owned by their own
plugins, are not in the central layer, and correctly classify `'local'`.

The pick lane never showed the contradiction because it filters both of its
screens through `visiblePickerDescriptors`. The sync lane did not filter,
and LLP 0188 #locked tells it to lead with the locked rows so the gate
states the whole sync picture rather than the editable slice. The result:
the only rows wearing `· managed by your fleet` were the two nobody had
seen, and a user reading down the list took the label as a property of the
clients under it. The label became a permanent, unattributable decoration
of every enrolled onboarding run.

## Decision {#sync-gate}

**The sync lane's locked rows go through the same display filter as the
picker's.** `runInitWizard` maps `lockedSources` to descriptors and passes
the result through `visiblePickerDescriptors` before handing it to
`runWizardSyncScope`; the lane receives an already-filtered list.

Two consequences follow, and both are the point:

- A machine whose locked set is entirely hidden - which is every machine
  enrolled today - shows a sync gate with **no fleet label at all**. That is
  honest: the fleet owns the gateway transport there, not any adapter the
  user can see or choose.
- A genuinely org-managed *client* still renders exactly as LLP 0188 #locked
  requires: listed on the gate fleet-suffixed, checked and disabled in the
  menu, never an opt-out candidate.

**Filter at the screen, never at the locked set.** Dropping the hidden ids
from `lockedSources` upstream would look like the same change and is not:
`runWizardPick` filters locked ids out of the local-layer composition
(`sources.filter((id) => !lockedSet.has(id))`), which is exactly the
collision [LLP 0129 §join-before-picker](./0129-join-before-picker.decision.md#join-before-picker)
exists to avoid. A raw id removed from the locked set would compose a second
copy of the org's gateway upstream into the local layer. The set stays whole;
only the display narrows - the same rule LLP 0202 already stated for its own
filter ("hiding is a display filter, never a catalog deletion").

## The empty no-question line {#no-candidates}

`runWizardSyncScope` short-circuits when there are no candidates, printing
*"Everything you picked is managed by your fleet and always syncs"* over the
locked rows. With the filter above that branch becomes reachable with an
empty locked list - an enrolled machine that picked nothing visible - where
the sentence names an owner for an empty list.

So the branch splits on whether there is a visible org row to name. With
none, it states the fact that is actually true: *"You picked nothing to
record, so nothing syncs to your server."* Both paths stay `noQuestion`, so
LLP 0191 #back-edges is unaffected and the step counter still does not skip
a number.

## Consequences {#consequences}

- `src/core/cli/wizard/index.js` imports `visiblePickerDescriptors` and
  applies it to `lockedDescriptors`; `runWizardSyncScope` documents that
  `opts.locked` arrives display-filtered rather than filtering defensively,
  so there is one filter, not two that can disagree.
- LLP 0202 §consequences' line "The sync/opt-out menu is unchanged" is
  superseded by this doc. It was written against the lane as it stood before
  the locked rows were added to the gate (PR #629, two days earlier), where
  it was true: the opt-out *candidates* have always been locked-filtered.
- The residuals LLP 0202 §residual left open are untouched. This changes one
  screen's row list, not capture, attribution, or the owner map that arms
  LLP 0192's fail-closed withholding.

## References

- LLP 0202, LLP 0188, LLP 0190, LLP 0191, LLP 0129, LLP 0031, LLP 0192
- `src/core/cli/wizard/index.js` (the `lockedDescriptors` mapping),
  `src/core/cli/wizard/sync_scope.js` (`runWizardSyncScope`),
  `src/core/cli/walkthrough.js` (`visiblePickerDescriptors`),
  `src/core/cli/wizard/provenance.js` (`classifyClientProvenance`)
