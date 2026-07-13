# LLP 0101: first sync waits for a deadline, not a pick

**Type:** Decision
**Status:** Accepted
**Systems:** Sinks, CLI, Usage-Policy
**Author:** Phil / Claude
**Date:** 2026-07-13
**Related:** LLP 0063, LLP 0069, LLP 0093, LLP 0100, LLP 0102

> On an attended enrolling login, the sink driver exports nothing until a
> **printed, absolute deadline**: the next local 11:59pm, rolled to the
> following day when that is less than four hours away. No early release, no
> extension. Supersedes the pick-pending marker of
> [LLP 0093](./0093-pick-pending-export-hold.decision.md), generalizing its
> enforcement point from a 10-minute picker guard to an hours-long review
> window.
>
> @ref LLP 0100#requirements [implements] - R2's "no export tick before the deadline".
> @ref LLP 0093 [constrained-by] - inherits the bounded-hold and fail-open doctrine: a privacy hold that cannot expire is a kill switch.

## Context

[LLP 0093](./0093-pick-pending-export-hold.decision.md) already established
the mechanism this needs: a machine-local marker written by the enrolling
login **before** `enrollCentralSink` (so no daemon tick can beat it onto
disk), checked once per tick by the kernel sink driver, holding whole export
ticks while fresh, expiring on its own, reading corruption as absence. It was
sized for one picker interaction (10 minutes) and went dormant when the
picker was suspended ([LLP 0094](./0094-enrollment-picker-suspended.decision.md)).

The privacy review flow ([LLP 0100](./0100-enrollment-privacy-review.spec.md))
needs the same hold with different sizing: the review happens after login, in
the user's own time, so the window is hours and the deadline must be
printable as a memorable absolute time.

## Decision

**The enrolling login writes a first-sync hold marker containing an absolute
deadline; `createSinkDriver.tick` exports nothing while `now < deadline`.**

- **Deadline rule** {#deadline}: the next local 11:59pm; if that is less than
  4 hours away, the following day's 11:59pm. An absolute end-of-day time is
  memorable ("tonight at 11:59pm") where a duration is not, and it hints at
  the eventual daily-sync cadence without inventing one. The floor prevents a
  11:30pm enrollment from getting a useless 29-minute window.
- **Marker**: replaces `usage-policy/pick-pending.json`; the deadline is
  stored **inside** the marker, not derived from mtime, because an hours-long
  hold must survive incidental touches. An unreadable or malformed marker
  reads as absent (fail-open, the [LLP 0093 #bounded](./0093-pick-pending-export-hold.decision.md#bounded)
  polarity: the machine-local policy lists are the privacy signal, the marker
  is only timing). A deadline in the past reads as absent and is
  opportunistically unlinked.
- **Scope of the hold**: driver-wide, every sink, exactly as LLP 0093 chose
  and for the same reasons: the driver cannot reliably know which sinks leave
  the machine, and a held local sink merely exports hours late, while one
  missed forward hold is a permanent leak.
- **Which enrollments** {#which}: the attended enrolling-login fork only.
  `hyp join` (MDM, operator-driven, bootstrap token) forwards immediately as
  today: the operator chose enrollment deliberately, and silently delaying a
  fleet rollout by hours would be the surprise in the other direction.
  Re-logins hold nothing: the daemon is already forwarding, so there is no
  "first" sync to defer.
- **No early release** {#no-release}: rejected a release verb ("sync now")
  and release-on-review-completion. The hold simply runs to its deadline,
  even for a user who finished the review in ten minutes. This keeps the
  printed message unconditionally true, needs no completion signal from the
  skill, and costs only latency on a machine that was not forwarding
  yesterday either.
- **No extension**: bounded always. A hold that can be pushed out is a kill
  switch with extra steps ([LLP 0093 #bounded](./0093-pick-pending-export-hold.decision.md#bounded)).

## Consequences

- The [LLP 0069](./0069-local-only-dir-selection.spec.md) R6 guarantee, "not
  forwarded, even once", is restored for anything the user marks during the
  window, by construction: nothing at all forwards before the deadline.
- Live capture during the window lands in the cache and ships at the deadline
  unless marked; watermarks ([LLP 0040](./0040-incremental-sink-reads.design.md))
  make the first post-deadline tick a plain catch-up.
- `hyp status` shows the pending deadline (LLP 0100 R9).
- LLP 0093's pick-pending semantics retire with the picker
  ([LLP 0102](./0102-skill-replaces-enrollment-picker.decision.md)); its
  driver-side hold machinery is reused, resized, and renamed.
