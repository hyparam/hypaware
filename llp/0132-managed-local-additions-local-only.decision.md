# LLP 0132: On a managed machine, local additions are local-only, always

**Type:** Decision
**Status:** Accepted
**Systems:** Sinks, Usage-Policy, Config, Onboarding
**Author:** Phil / Claude
**Date:** 2026-07-22
**Related:** LLP 0031, LLP 0069, LLP 0070, LLP 0100, LLP 0128

> Spawned by [LLP 0128](./0128-install-experience-overhaul.rfc.md) on
> acceptance. Extends
> [LLP 0070](./0070-local-only-export-seam.decision.md): the export seam
> learns **source-scoped** withholding alongside its directory-scoped
> classes.

## Context

On an enrolled machine, the central sink exports the whole cache; the
only never-forward controls are directory-scoped
([LLP 0069](./0069-local-only-dir-selection.spec.md) /
[LLP 0070](./0070-local-only-export-seam.decision.md)) and the
per-session opt-out. So a source the user adds locally (the additive
local layer, [LLP 0031](./0031-layered-config.decision.md)) would ship
its rows to the org server, even though the org never asked for it.

## Decision

<a id="rule"></a>**The org sees exactly what the org configured; anything
the user adds is theirs.** Sources contributed by the local layer on a
machine with a central layer are collected and locally queryable but
never forwarded. There is no per-item sync toggle. The path to org
visibility is the admin naming the source in the fleet config.

Rejected: a per-addition "sync this?" choice. It reopens the BYOD
volunteer-data leak class [LLP 0100](./0100-enrollment-privacy-review.spec.md)
exists to prevent, and it makes "what does my org see" need a table to
answer instead of one sentence.

<a id="source-scoped-withholding"></a>**Mechanism: source-scoped
withholding at the export seam.** The LLP 0070 seam gains a second
withholding key: rows attributable to a local-layer-only source are
withheld from forward exports, wholesale, regardless of directory class.
The exact attribution key (source id / client name on the row) is an
implementation-time design detail; the invariant is that the seam, not
the picker, enforces the rule, exactly as LLP 0070 argued for directory
classes (a bypassable UI marking is not a policy).

<a id="never-silent"></a>**Never a silent state.** The picker annotates
additions ("stays on this machine"), and `hyp status` shows the split
("syncing: claude - local-only: codex").

## Consequences

- The privacy story on a managed machine is one sentence, and the org's
  visibility is defined solely by the org's authored config.
- A per-item sync flag, if a real fleet ever asks, can be added later as
  an org-gated policy; walking back from the permissive default would
  take data you cannot unship.
- Backfill on join ([LLP 0037](./0037-backfill-on-join.decision.md)) is
  untouched: it concerns the org-named sources; local additions are
  outside its scope by this rule.
