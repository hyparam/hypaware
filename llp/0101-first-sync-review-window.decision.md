# LLP 0101: first sync waits for a deadline, not a pick

**Type:** Decision
**Status:** Accepted
**Systems:** Sinks, CLI, Usage-Policy
**Author:** Phil / Claude
**Date:** 2026-07-13
**Related:** LLP 0063, LLP 0069, LLP 0093, LLP 0100, LLP 0102
**Extended-by:** LLP 0203 (#no-release: setup offers the release verb instead of only naming it), LLP 0324 (#hold: a preview-only dataset-disposition seam counts per destination without teaching the driver which sinks leave the machine), LLP 0325 (#no-release: the plan's count spends its budget as per-destination deadlines because the release is all-or-nothing)

> On an attended enrolling login, the sink driver exports nothing until a
> **printed, absolute deadline**: the next local 11:59pm, rolled to the
> following day when that is less than four hours away. The deadline is the
> latest the first sync can happen, not the earliest: a confirmed `hyp sync`
> ends the window early (amended 2026-07-27, see [#no-release](#no-release)).
> No extension. Supersedes the pick-pending marker of
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
- **Scope of the hold** {#hold}: driver-wide, every sink, exactly as LLP 0093 chose
  and for the same reasons: the driver cannot reliably know which sinks leave
  the machine, and a held local sink merely exports hours late, while one
  missed forward hold is a permanent leak.
- **Which enrollments** {#which}: the attended enrolling-login fork only.
  `hyp join` (MDM, operator-driven, bootstrap token) forwards immediately as
  today: the operator chose enrollment deliberately, and silently delaying a
  fleet rollout by hours would be the surprise in the other direction.
  Re-logins hold nothing: the daemon is already forwarding, so there is no
  "first" sync to defer.
- **Release only by confirmed, attended request** {#no-release}
  *(amended 2026-07-27; the original text is kept below it)*: `hyp sync`
  prints what would leave, warns that the window is open and that sent
  history cannot be un-sent, and on an explicit `y` clears the marker and
  exports. Release-on-review-completion stays rejected: it would need a
  completion signal from the skill, and a skill that finished is not the
  same as a user who decided. The daemon never clears the marker, so an
  unattended machine still waits out the full window.

  Two shapes of `hyp sync` cannot release, because the consent they carry is
  narrower than what the release does:

  - **Instance-scoped** (`hyp sync <instance>`) refuses while a hold is live.
    The hold is driver-wide (`#hold`), so a plan built from one named handle
    omits every destination the release would unblock; confirming it would
    forward the others unseen. Releasing is all-or-nothing because the hold
    is.
  - **`--yes`** refuses while a hold is live. "Attended" is the operative
    word: a provisioning script is not a person, and its destination list
    scrolls past in a log nobody reads. `--yes` still works for ordinary
    syncs; what it must not buy is somebody's review window.

  A release that cannot be completed (an unlink failure) is an error, not a
  quiet no-op: the marker survives, the driver holds the tick, and the
  command must say so rather than exit 0 having sent nothing.

  What the amendment concedes is the third clause of the original: the cost
  is *not* only latency. On an attended onboarding the hold blocks the
  demonstration that the product works at all, and the person running it has
  no way to say "I have seen enough". Worse, the window is sized for a review
  (`hypaware-privacy`) too slow to run in the meeting the hold was scoped to
  (`#which` holds the attended lane and lets unattended `hyp join` forward
  immediately, which is backwards for exactly this case). Nothing in
  [LLP 0069](./0069-local-only-dir-selection.spec.md) R6 is given up: R6
  forbids a *silent* first forward, and an explicit confirmation naming the
  destination is the consent it exists to obtain.

  The first clause survives with a wording change: the printed message says
  "no later than <deadline>", so it stays unconditionally true.

  > *Original (2026-07-13):* **No early release**: rejected a release verb
  > ("sync now") and release-on-review-completion. The hold simply runs to
  > its deadline, even for a user who finished the review in ten minutes.
  > This keeps the printed message unconditionally true, needs no completion
  > signal from the skill, and costs only latency on a machine that was not
  > forwarding yesterday either.
- **No extension**: bounded always. A hold that can be pushed out is a kill
  switch with extra steps ([LLP 0093 #bounded](./0093-pick-pending-export-hold.decision.md#bounded)).

## Consequences

- The [LLP 0069](./0069-local-only-dir-selection.spec.md) R6 guarantee, "not
  forwarded, even once", is restored for anything the user marks during the
  window, by construction: nothing at all forwards before the deadline.
- Live capture during the window lands in the cache and ships at the deadline
  unless marked; watermarks ([LLP 0040](./0040-incremental-sink-reads.design.md))
  make the first post-deadline tick a plain catch-up.
- `hyp status` shows the pending deadline (LLP 0100 R9), and names `hyp sync`
  beside it: a countdown the reader cannot act on is where the original
  decision's cost was hiding.
- The three surfaces that print the deadline (the login message, the wizard's
  privacy narration, `hyp status`) all name `hyp sync`, and the formatted
  deadline carries its time zone - an absolute time is only memorable if the
  reader knows which clock it is on.
- LLP 0093's pick-pending semantics retire with the picker
  ([LLP 0102](./0102-skill-replaces-enrollment-picker.decision.md)); its
  driver-side hold machinery is reused, resized, and renamed.
