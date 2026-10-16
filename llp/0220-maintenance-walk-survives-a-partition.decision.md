# LLP 0220: A maintenance walk survives the partition that throws, and says it lost one

**Type:** Decision
**Status:** Accepted
**Systems:** Cache
**Author:** Kenny / Claude
**Date:** 2026-08-13
**Related:** LLP 0199 (the neediest-first walk this makes survivable), LLP 0217 (the retry the attempt spends, which must still be spent), LLP 0218 (the skip-reason vocabulary this sits beside), LLP 0021 (the span helper that rethrows)

> A partition whose maintenance throws ends that partition's work, not the
> tick's. The walk records the failure on that partition's report and moves to
> the next one. The tick then resolves with a report carrying the failures,
> because the walk did complete; its callers read the failures off the report
> and refuse to describe the run as clean.

## Context {#context}

`maintainCache` walks partitions neediest-first (LLP 0199#neediest-first):
descending live data-file count, so the most fragmented partition is visited
first. That is deliberate, and it is also why the walk is fragile. The
neediest partition is the one most likely to fail a rewrite: in the #723 case
318 MB, 230k rows and 1,521 files, doubling disk while it runs, and one torn
data file in it is enough to throw.

There was no per-partition catch, and `withSpan` rethrows after recording the
exception (LLP 0021#span-helpers). So the first partition's error propagated
out of the loop, out of `maintainCache`, and into
`src/core/daemon/runtime.js`, which logged `daemon.maintenance_failed` and
waited an hour to run into the same wall. Every partition behind the failure
got neither compaction nor snapshot expiry, which is the guard against the
unbounded metadata growth #723 was filed about in the first place.

LLP 0217#retry-on-writer-change bounded how long this lasts: the failing
attempt spends its writer generation's retry, so from the next tick the
partition is skipped rather than re-attempted, and LLP 0218 made that skip a
stated reason. Both leave the tick in which the failure happens fully lost,
and that tick is the one that had the neediest partition's whole backlog
queued behind it.

Reported as #737, deliberately out of scope for the PR that settled the retry
stamp, because continuing the walk is a behaviour change and not a fix to
what that PR broke.

## Decision {#decision}

<a id="walk-survives-a-partition"></a>**One partition's error is one
partition's outcome.** The maintenance loop catches around the
`maintenance.partition` span, records the failure on that partition's report,
and continues to the next partition. The catch is *outside* `withSpan` on
purpose: the helper records the exception and an ERROR status on the partition
span and then rethrows, so catching outside keeps the trace honest about which
partition failed while the walk moves on. Catching inside the callback would
publish an `ok` span for a partition that threw, which is the legibility
defect one layer down from the one being fixed.

The partition's report object is therefore built before the span opens rather
than inside it, so a partition that threw part-way still reports what the run
had established about it: its live data-file count, and any snapshots the
expiry pass expired before compaction reached the error.

Nothing about the failure path itself moves. LLP 0217's writer-generation
stamp is written from inside `compactGeneration`'s own catch, on the way out,
before the error reaches this one, so the attempt still spends the retry and
a persistently failing partition is still attempted once per writer
generation rather than once per tick.

<a id="tick-reports-degraded"></a>**The tick resolves, and reports what it
lost.** `maintainCache` returns its report instead of rejecting when a
partition threw, because the walk it was asked to perform completed. The
report is the honest carrier: `MaintenancePartitionReport` gains `failed`,
`errorKind` and `errorMessage`, and `MaintenanceReport` gains `totalFailed`.

Rejecting after the walk instead would keep the daemon's existing wiring, but
it throws the report away, so a tick that maintained forty partitions and lost
one would print nothing about any of them. The report is the only thing that
knows what the tick did.

Every caller therefore reads the failures rather than a rejected promise. The
daemon logs one `daemon.maintenance_failed` per failed partition, naming the
dataset and partition (which the propagated exception never could), and marks
the `maintenance.tick` span with `status: degraded` and `partitions_failed`
as attributes *and* an `ERROR` span status code - set directly once the
report is in hand, since `withSpan`'s status-attribute convention only reads
that attribute's snapshot from before the callback runs and cannot see a
verdict this late (`src/core/daemon/runtime.js`'s tick manages its span
directly for this reason, rather than through `withSpan`). Its
outer `.catch` stays, for the errors still outside the per-partition catch:
partition discovery and the retired-generation sweep. `hyp query maintain`
prints a `FAILED:` line for the partition and exits non-zero, so a script that
gated on the old exit status does not start reading a degraded run as a clean
one.

<a id="this-tick-versus-a-recorded-one"></a>**`failed` is not
`compactionAttemptFailed`.** LLP 0218's field is read off the cursor and means
*an earlier tick's attempt failed and nothing has been attempted since*; the
partition was skipped, deliberately, for a stated reason. `failed` means *this
tick attempted work here and it threw*. They never appear together, because a
tick that attempted a rewrite is not a tick that skipped one, and an operator
has to be able to tell a partition that just broke from one that has been
quietly frozen for a week. Keeping one field for both would put the two
readings back into the same absence the LLP 0218 report exists to remove.

## Consequences {#consequences}

- A cache holding one broken partition no longer has its whole walk starved
  by it: the walk moves on to the next partition instead of aborting. The
  per-tick budget guard (LLP 0199#neediest-first) still applies, and is keyed
  off partitions actually *maintained*, not partitions merely visited - a
  partition that failed did no work, so it cannot itself satisfy the guard's
  "always work one partition before the budget can cut the tick short"
  guarantee and stall everything behind it (`src/core/cache/maintenance.js`).
  What this buys is "the walk keeps moving past a failure", not "every
  healthy partition is guaranteed maintenance on the tick a partition
  breaks": a tight budget can still cut a tick short once real work has
  happened, exactly as it could before this document. The one case that
  guard alone cannot bound - every partition in the cache failing - is capped
  separately: the walk still breaks once `MAX_FAILURES_BEFORE_BUDGET_BREAK`
  partitions have failed past the budget, so an all-failing cache cannot walk
  unbounded either. The guard against unbounded metadata growth (snapshot
  expiry, the orphan sweep) stops being hostage to the neediest partition's
  health specifically; it is not a promise that one failure never costs any
  other partition its turn in a budget-constrained tick.
- `cleanRetiredEpochs` now runs on a tick that lost a partition, where the
  abort used to skip it, so the half-written generation a failed rewrite left
  behind is reclaimed by the orphan sweep on schedule instead of waiting for a
  clean tick.
- The budget still applies. A partition that fails fast costs its share of
  `max_tick_ms` and no more, and the walk continues into the neediest healthy
  partition rather than postponing the whole ranking by an hour.
- `daemon.maintenance_failed` fires once per failed partition rather than once
  per tick, and carries the partition identity. A cache with several broken
  partitions logs several lines, which is the correct count of things that are
  wrong.
- Tests that asserted the whole tick rejected now assert the partition's
  report instead. The thing they pin (the stamp, the committed cursor, the
  recorded verdict) is unchanged; only how the failure is observed moved.
- A failure that ought to abort the whole walk has nowhere to say so. Nothing
  in the current maintenance path is such a failure (the shared state a
  partition touches is its own directory and its own cursor), but a future step
  that corrupts something cache-wide would need a way to stop the walk rather
  than being reported as one partition's error.

## Extends {#extends}

LLP 0199 settled the walk order and the budget that cuts it short, and both
stand: neediest-first is still the order, and a partition that fails is still
visited in it. What this document adds is that the order's own consequence -
the likeliest partition to fail goes first - no longer decides whether the
rest of the walk happens. LLP 0218 settled that a partition maintenance leaves
alone is left alone for a stated reason; this extends that vocabulary to the
partition maintenance tried and could not finish.
