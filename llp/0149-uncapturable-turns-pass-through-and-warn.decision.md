# LLP 0149: Uncapturable turns pass through and warn

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Observability
**Author:** Phil / Claude
**Date:** 2026-07-29
**Related:** LLP 0152 (plugin-steered shadow providers), LLP 0145 (borrowed credentials), LLP 0146 (deferred providers), LLP 0147 (CLI backends)

> When the plugin cannot capture a turn, the turn still runs: direct to the
> vendor, uncaptured, with a warning that makes the gap visible. One rule
> for every cause. This was previously an open question duplicated across
> LLP 0152 and LLP 0145; both now cite this decision.

## Context

Steering can be impossible for several distinct reasons:

- the shadowed provider's credential cannot be resolved (LLP 0145),
- the vendor has no registered gateway preset (LLP 0144),
- the provider family is deferred (host-signed vendors, LLP 0146).

Each cause raises the same choice: run the turn uncaptured, or fail it.
Refusing makes capture problems into user-facing outages; passing through
silently would recreate the invisible-gap failure mode this whole revision
exists to remove. The middle path is pass through **and warn**: the user's
turn always works, and the gap is always on the record.

A policy knob ("required" mode that refuses instead) was considered for
compliance-minded deployments and deliberately not built: no one has asked,
and the knob is easy to add later without breaking anything.

## Decision

- If the plugin cannot steer a provider, any cause, it leaves the turn on
  its original provider, unmodified. The user's turn never fails because of
  capture.
- Every pass-through emits a structured uncaptured-provider warning naming
  the provider, the cause (`no_credential` | `no_preset` | `deferred`), and
  the session, so coverage gaps are queryable rather than anecdotal.
- The warning is rate-limited per provider+cause, not per turn, so a
  misconfigured provider does not flood logs.
- Steering decisions are made per turn, so a provider that becomes
  capturable (credential added, preset registered) is picked up on the next
  turn with no restart.
- LLP 0152's and LLP 0145's former open questions on this point are closed
  by this decision.

## Consequences

- Coverage is best-effort by design, and the record says so itself: the
  warnings are the coverage ledger. Any surface reporting OpenClaw capture
  coverage should derive from them.
- A future "required" mode (refuse instead of pass through) remains open as
  an additive knob if a deployment ever needs it; nothing in this decision
  blocks it.

## References

- LLP 0152, 0144, 0145, 0146, 0147
