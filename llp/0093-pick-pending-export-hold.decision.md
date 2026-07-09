# LLP 0093: fresh-enroll exports hold behind a bounded pick-pending marker

**Type:** Decision
**Status:** Accepted
**Systems:** Sinks, CLI, Usage-Policy
**Author:** Phil / Claude
**Date:** 2026-07-08
**Related:** LLP 0069, LLP 0071, LLP 0072, LLP 0080, LLP 0044, LLP 0063

> Closes the one-time forwarding window the issue #281 reordering left open
> (recorded as the "Revisited-by #281" notes in
> [LLP 0069 §trigger](./0069-local-only-dir-selection.spec.md#trigger) and
> [LLP 0080](./0080-local-only-dir-selection.design.md)), restoring R6's
> "not forwarded, even once" on the auto-daemon fresh-enroll path.
>
> @ref LLP 0069 [implements] - restores the R6 ordering guarantee the #281 fix narrowed.
> @ref LLP 0072 [constrained-by] - the hold must stay a bounded refinement; it can never block or fail the login, and an unanswered picker can never become a kill switch.

## Context

The #281 fix (PR #283) moved the local-only picker after `enrollCentralSink`
so it enumerates a populated cache. That reintroduced a window: the daemon the
enroll installs attaches clients and backfills history, and its central sink
can start exporting those backfilled rows **before the user finishes the
pick**. Withholding is enforced at export-read time (LLP 0080 export seam), so
rows from a directory the user was *about to* mark local-only forward once -
and the server has no retraction path, so that one-time leak is permanent.
This narrowed LLP 0069 R6's "recorded here, never forwarded - not even once"
to "withheld from every export tick after the pick" on exactly the
fresh-enroll path the picker exists for.

## Decision

**The enrolling login writes a machine-local pick-pending marker before
`enrollCentralSink`, and the kernel sink driver skips whole export ticks while
that marker is fresh.**

- **Marker**: `usage-policy/pick-pending.json` under `HYP_HOME` state,
  co-located with the local-only list (LLP 0071) whose first read it guards.
  Content is debug metadata only; freshness is the file's mtime, so a torn
  write can neither wedge nor extend the hold.
- **Lifecycle is login-owned**: written on the fresh-enroll fork only (the
  only fork where a first backfill can race the pick - a re-login edits a
  list whose daemon is already forwarding, LLP 0080 editor semantics),
  *before* `enrollCentralSink` so no daemon tick can beat it onto disk;
  cleared in one `finally` covering every exit from that fork (pick landed,
  cancelled, non-TTY skip, enroll error). Both write and clear are
  best-effort: a failed write degrades to the pre-hold behavior, a failed
  clear leaves the TTL as backstop; neither ever fails the login.
- **Enforcement is driver-wide**: `createSinkDriver.tick` checks the marker
  once per tick and, while fresh, exports nothing (`held: 'pick_pending'` in
  the tick report, one info log). Held rows sit in the cache and export on
  the first tick after the pick; watermarks (LLP 0040) make that a plain
  catch-up, nothing is dropped.

### The hold is always bounded {#bounded}

The marker expires on its own: `isPickPending` treats a marker older than
**10 minutes** (`PICK_PENDING_TTL_MS` - comfortably past the login's two 30s
bounded waits plus a human actually reading the picker) as absent and
opportunistically unlinks it. A stat failure also reads as absent. This is
deliberately the opposite polarity of the local-only *list* (which fails
loudly when unreadable, LLP 0080 #fail-safe): the list is the privacy signal,
the marker is only a timing hint, and failing closed on it would turn a
crashed login or a corrupt file into an unbounded export outage that only a
hand-deleted file could end. A privacy hold that cannot expire is a kill
switch, and LLP 0072 already decided the picker never gets one.

## Alternatives rejected

- **Backfill locally before the forwarding daemon starts** (the other option
  the #281 note floated). Reordering does not actually close the window: the
  pick needs a human, and the daemon would still forward the moment backfill
  completed if the user had walked away. It also delays *all* forwarding
  behind a possibly multi-minute backfill and rearranges the daemon
  lifecycle (LLP 0044 attach-first ordering) for no guarantee.
- **Gate only off-machine sinks**. The driver cannot know which sinks leave
  the machine without a new registration concept (an `offMachine`
  declaration every future forward sink must remember), and a plugin-side
  convention is exactly the kind of seam a new sink forgets. Holding every
  sink for a bounded window is harmless - a local sink's rows stay in the
  cache and export minutes later - where one missed forward hold is a
  permanent leak. One enforcement point in core, where local-only policy
  already lives, wins.
- **Unbounded hold until the pick lands**. See [#bounded](#bounded).

## Consequences

- R6's "not forwarded, even once" holds again on the auto-daemon
  fresh-enroll path, provided the pick concludes within the TTL; a user who
  ponders the picker past 10 minutes reverts to the narrowed guarantee
  (withheld from every tick after the pick), never to an error.
- Every sink, including local ones, pauses up to the pick duration (TTL-capped)
  on a fresh enroll only. No steady-state cost: the marker exists for at most
  one login's duration per machine lifetime, and a per-tick `stat` of a
  usually-absent file otherwise.
- `hyp remote login --no-forward` and query-only logins never write the
  marker (they never reach the enrolling fork).

> **Dormant while [LLP 0094](./0094-enrollment-picker-suspended.decision.md)
> suspends the picker trigger:** no login writes the marker (with no pending
> pick there is nothing to guard). The sink-driver hold and TTL behavior stay
> implemented and tested for when the trigger returns.
