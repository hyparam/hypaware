# LLP 0102: the privacy skill replaces the enrollment picker

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Onboarding, Usage-Policy
**Author:** Phil / Claude
**Date:** 2026-07-13
**Related:** LLP 0069, LLP 0072, LLP 0080, LLP 0093, LLP 0094, LLP 0100, LLP 0101

> The redesign [LLP 0094](./0094-enrollment-picker-suspended.decision.md)
> suspended the picker for is **not a better picker**. The in-login TUI
> acquisition path is retired permanently in favor of the deadline-plus-skill
> flow ([LLP 0100](./0100-enrollment-privacy-review.spec.md)): login finishes
> fast, the first sync waits ([LLP 0101](./0101-first-sync-review-window.decision.md)),
> and the review happens afterwards in the user's own agent session against a
> settled cache.
>
> @ref LLP 0094 [implements] - this is the "new decision superseding this one" its Consequences called for.
> @ref LLP 0072 [constrained-by] - the flow remains a skippable refinement, never a gate; doing nothing still enrolls and syncs.

## Context

LLP 0094 suspended the login-time picker after its enumeration raced the
first backfill and misrepresented the machine's history, and sketched a
redesign that was still a synchronous picker: plugin-contributed enumeration
plus a searchable TUI. Both halves fought the same structural constraint: a
login command has seconds of user attention and runs while the cache is
still filling.

## Decision

**Retire the in-login picker acquisition path permanently; enrollment-time
privacy refinement is the review window plus the `hypaware-privacy` skill.**

- [LLP 0094](./0094-enrollment-picker-suspended.decision.md) and the picker
  design [LLP 0080](./0080-local-only-dir-selection.design.md) are superseded
  by this decision. `ENROLLMENT_PICKER_ENABLED`, the picker module
  (`src/core/commands/local_only.js` picker entry points), the captured-
  directory wait, the `freshenCaptureEnumeration` kernel re-boot, and the
  dormant pick-pending marker writes can be deleted; the durable-command hint
  survives in the login output alongside the deadline message.
- [LLP 0069](./0069-local-only-dir-selection.spec.md) is **not** superseded:
  its enumeration semantics (§enumerate, which the skill's survey reuses),
  persistence ([LLP 0071](./0071-machine-local-exclusion-list.decision.md)),
  export-seam enforcement ([LLP 0070](./0070-local-only-export-seam.decision.md)),
  and the durable CLI (R7) all survive as the substrate the skill drives.
  Only §trigger's login-time interactive acquisition is replaced.

## Why the skill flow dominates the picker

- **The race is gone structurally.** The deadline is hours after backfill
  settles; the skill also checks settlement explicitly (LLP 0100 R-flow).
  No wait heuristics, no second kernel boot, no partial list presented as
  the whole.
- **Richer judgment.** A picker shows paths; the skill reads content. "This
  directory contains what looks like credentials" beats a bare
  `~/clients/acme (412 rows)`.
- **No TTY ceiling.** A TUI multi-select caps out around tens of items
  (LLP 0080's bounded presentation); a conversation handles 126 directories
  by grouping, ranking, and asking.
- **Right attention budget.** Login wants to finish in seconds; a privacy
  review deserves minutes. Decoupling them serves both.

## Consequences

- LLP 0094's "re-enable is a deliberate act" clause is discharged: the
  constant is never flipped back; the code it guards is removed instead.
- The picker's unit-tested wiring (fork ordering, TTY gating, editor
  semantics) is deleted rather than kept as skeleton; the skill flow shares
  none of its shape. Forward-refs on 0080/0093/0094 point here.
- Privacy refinement acquisition becomes client-dependent (needs Claude or
  Codex attached). The durable CLI path (`hyp ignore --local-only`,
  `hyp ignore --private`) remains the client-independent floor, as it has
  been since [LLP 0094](./0094-enrollment-picker-suspended.decision.md).
