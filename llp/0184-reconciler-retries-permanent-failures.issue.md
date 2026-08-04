# LLP 0184: Reconciler retries permanently-failed client actions on every boot

**Type:** issue
**Status:** Draft
**Systems:** Config, Daemon
**Author:** Brendan McMullen
**Date:** 2026-08-04
**Related:** LLP 0036, LLP 0041, LLP 0109, LLP 0174

## Summary

The action reconciler treats every `failed` marker as transient: each
reconcile pass retries it, unconditionally, forever. That is correct for the
failures LLP 0041 designed around (a `hyp backfill` subprocess dying, a
transcript dir briefly missing) but wrong for a *refusal*: an attach that
fails a precondition only the user can change. A refused attach re-runs on
every daemon boot with no backoff and no terminal state, its `attempts`
counter climbing without bound, and `hyp status` reports the same `failed`
line indefinitely with no signal that waiting will not help.

## Motivation

Observed in the field on 2026-08-04: the installed (1.19.0, LLP 0109-design)
OpenClaw attach refuses when `agents.defaults.model.primary` is not an
`anthropic/<model>` id (`NON_ANTHROPIC_PRIMARY`). On a machine with an OpenAI
primary the marker recorded `"attempts": 17`, one per daemon boot, tracking a
restart loop exactly. Nothing about the retry could ever succeed: the refusal
is a property of the user's OpenClaw config, and the reconciler has no way to
know that.

The cost is mostly noise (wasted boot work, a misleading `failed` status, an
unbounded counter), but the pattern generalizes: the current LLP 0172/0173
attach refuses on a conflicting user-owned `models.providers` entry, the
Claude attach refuses a JSONC settings file (the one refusal LLP 0163's
repair-not-refuse design keeps), and any future handler with a precondition
gate inherits the same loop.

Tracked as [hyparam/hypaware#601](https://github.com/hyparam/hypaware/issues/601).

## Analysis

Two seams conspire:

1. **The marker cannot express "permanent".** LLP 0041 defines `done`
   (short-circuits) and `failed` (retried next pass) and explicitly notes
   `failed` is "not terminal - retried next pass". There is no third state.

2. **The handlers already know, but discard, the distinction.** The OpenClaw
   attach's `fail()` helper takes an `errorKind` (`'refused'`, `'read'`,
   `'write'`, `'endpoint'`, ...) but only feeds it to the span and log; the
   returned outcome is `{ status: 'failed', reason }`, so by the time the
   reconciler writes the marker the transient/permanent signal is gone.

## Proposed direction

Not settled here; candidates, roughly in order of appetite:

- **A terminal marker state.** Let a handler return
  `{ status: 'refused', reason }`; the reconciler writes it as a marker that
  short-circuits like `done` but surfaces as attention-needed in
  `hyp status`. Cleared when the handler's `desired()` input changes
  (the LLP 0086 `isCurrent` freshness hook is the existing precedent for
  input-keyed invalidation), or by an explicit `hyp attach` re-run.
- **Bounded retries / backoff.** Cap or exponentially space retries of
  `failed` markers. Simpler, but treats the symptom: a refusal still churns
  until the cap, and a genuinely transient failure past the cap is stranded.
- **Status-only fix.** Keep retrying but have `hyp status` distinguish
  "failing, will retry" from "refused, needs your action" using the reason.
  Cheapest, fixes the operator confusion, leaves the wasted work.

Whatever the fix, the handler outcome type needs to carry the
transient/permanent bit across the reconciler seam instead of dropping it at
the log layer.

## Open questions

- Does a `refused` marker short-circuit forever, or should it re-arm when the
  refused-upon input changes (e.g. the user edits `openclaw.json`)? An
  `isCurrent`-style hash of the precondition input would make re-arm
  automatic but adds a per-handler contract.
- Should `attempts` on transient `failed` markers be bounded at all, or is
  retry-per-boot acceptable once refusals are carved out?
- LLP 0041 is Active: this lands as an extension (new LLP noted on its
  `Extended-by:` line), not an edit to what it settled.

## References

- [LLP 0036](./0036-central-config-driven-client-actions.decision.md): the
  client-action seam this machinery realizes
- [LLP 0041](./0041-central-config-client-actions.design.md): marker states
  and the "failed is not terminal" retry design
- [LLP 0109](./0109-openclaw-client-adapter.decision.md): the v1 attach whose
  `NON_ANTHROPIC_PRIMARY` refusal surfaced the loop
- `src/core/config/action_reconciler.js`: reconcile pass; only `done`
  short-circuits
- `hypaware-core/plugins-workspace/openclaw/src/attach.js`: `fail()` drops
  `errorKind` from the returned outcome
