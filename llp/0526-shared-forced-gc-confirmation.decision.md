# LLP 0526: One recent forced GC stands in for every query guard's passing confirmation

**Type:** Decision
**Status:** Accepted
**Systems:** Query
**Author:** Phil / Claude
**Date:** 2026-10-17
**Related:** LLP 0054, LLP 0056
**Extends:** [LLP 0097](./0097-heap-growth-query-budget.decision.md) (#confirm-with-gc: the forced confirmation collection is shared across concurrent query guards; a recent one may pass a check, never refuse it)
**Tracker:** hyparam/hypaware#2526

## Context

LLP 0097 `#confirm-with-gc` confirms every raw-heap crossing with a forced
full GC and refuses only on growth that survives it. Its cost model was "one
forced GC per budget-width of garbage" for a well-bounded query. That holds
for one query. It does not hold for several that overlap.

Each guard measures growth from the heap at its own start. When queries
arrive staggered, the earliest one's baseline excludes the live sets of every
query that joins after it, so its settled growth sits just under the budget.
Each fresh stride of garbage then puts its raw delta back over, and it forces
another collection, every stride, for the rest of its run. Every forced GC
is a full stop-the-world collection that also pauses the other queries.
Issue #2526 measured 8 / 28 / 141 forced collections for 1 / 2 / 3 staggered
600k-row scans, where the single-query cost would predict about 24 for three.
None of those collections finds anything to refuse.

The guard's contracts still have to hold: a collection that did not run is
not a confirmation, a suppressed collection never turns a raw delta into a
false refusal, sustained retained growth still gets a real confirmation and a
typed refusal within a bounded interval, the terminal check never lets an
over-budget result escape, and the watchdog keeps covering no-row phases.
Serializing queries, resetting baselines, deleting the check, or patching
`gc` globally were ruled out by the issue.

## <a id="shared-confirmation"></a>Decision: a recent shared collection may pass a check, never refuse one

The kernel keeps one process-wide record of the most recent forced
confirmation collection: an epoch counter, when it ran, and the settled heap
it left. It is three scalars overwritten in place. No query registers in it,
so a finished or aborted query leaves nothing behind and nothing grows with
the number of queries.

Each guard notes the epoch when it takes its baseline. When a check's raw
delta crosses the budget and a GC handle is available, the check skips its
own collection and passes only when all of these hold:

1. it is not the terminal check;
2. the recorded collection ran after this query's baseline (its epoch
   differs from the one noted), so it measured memory this query could own;
3. it ran less than `CONFIRM_GC_STAND_IN_MS` (1000ms) ago;
4. the heap has grown less than one budget since it settled;
5. its settled heap showed this query at or under budget.

Otherwise the check forces a collection itself, records it as the new shared
confirmation, and decides on what that collection settled. So every refusal
still rests on a collection that the refusing check made, a stand-in can only
ever yield a pass, and the terminal check always forces. The GC-unavailable
fallback is unchanged: with no handle the guard refuses on the raw delta.
A disabled budget never reaches the check at all.

This restores LLP 0097's cost model, counted per process rather than per
query: roughly one forced collection per budget-width of heap growth across
all running queries, plus at most one per second of a crossing, plus each
query's first and terminal collections.

### <a id="sampling-delay"></a>The sampling delay this costs

A query whose retained memory crosses the budget while a sibling's recent
passing collection stands in is not refused at that check. It is confirmed at
the first check after either bound lapses: the 1000ms interval, or one budget
of heap growth since the shared collection. Two consequences follow from the
conditions above.

- **Time.** The extra delay is under 1000ms plus the rows until the next
  inline check (one 4096-row stride) or the next 100ms watchdog tick.
- **Bytes.** At a stand-in pass, this query's settled growth at the shared
  collection was at most one budget (condition 5), and the heap has grown by
  less than one budget since (condition 4). Its retained growth is therefore
  under twice the budget at any pass, and whatever the stand-in hides is less
  than one budget.

The delay needs a passing collection, taken after this query's baseline,
that already showed it holding retained growth: what a stand-in hides is less
than that growth, because the heap must still be under one budget above the
collection's settled heap. A query whose first crossing is the retaining one
(the crasher class LLP 0097 names) has no such collection, alone or not, so it
forces and refuses at the same check as before. The same rule applies to a
query's own earlier passing collections, so a lone query with garbage and
slow retention can see the same bounded delay.

The interval was chosen from the focused harness below. 250ms, 500ms, and
1000ms gave identical collection counts in every shape measured, because the
byte bound, not the clock, ends each stand-in under sustained scan load. The
interval only bounds the lag when growth is slow. 1000ms is the longest of
the three and keeps the lag at one second.

### Measurements

Simulated heap (deterministic clock, heap, and `gc` seam;
`test/core/query-sql-shared-gc-confirmation.test.js`, run at full scale for
this record): 600k rows per query, 1KB of garbage per row, 64MB budget,
4096-row stride, queries staggered by 100k rows.

| Forced GCs, 1 / 2 / 3 queries | 28MB live per query | 31MB live per query |
|---|---|---|
| before (LLP 0097 per query) | 8 / 27 / 118 | 8 / 29 / 242 |
| shared, 250ms | 8 / 17 / 26 | 8 / 17 / 26 |
| shared, 500ms | 8 / 17 / 26 | 8 / 17 / 26 |
| shared, 1000ms | 8 / 17 / 26 | 8 / 17 / 26 |

The in-repo test runs the same shapes at quarter scale (16MB budget), where
the counts are 2 / 6 / 30 and 2 / 7 / 63 before and 2 / 5 / 7 after, and it
asserts the policy bound rather than these numbers.

Real V8 heap (`benchmarks/query-shared-gc-confirmation.mjs`, 400k rows per
query, 28MB live, 64MB budget, median of three runs): three staggered queries
went from 75 forced collections (about 1.1s of GC) and 9.6s of process CPU to
26 collections (about 0.37s) and 6.0s of CPU. One query was unchanged within
run-to-run noise (6 to 9 collections, 1.7s to 1.9s of CPU, either way).

## Consequences

- Concurrent queries no longer multiply forced collections; the count tracks
  heap growth, not the number of guards.
- A query retaining memory beside a recent passing collection may refuse
  later than it would have alone: within about a second, once the stand-in
  interval or its byte bound lapses and the next inline check or watchdog
  tick runs. That second is when a check must force again, not a wall-clock
  deadline; an event loop starved of ticks delays the watchdog as it did
  before. Its retained growth is under twice its budget at each check a
  stand-in passes, so with the default 1GiB budget a stand-in may pass at
  almost 2GiB of growth. That is a bound at those checks, not a peak bound
  between them: one large stride can overshoot, as it could before, and the
  synchronous-allocation gap (#727) is unchanged. In the quarter-scale
  harness the delay was 197ms in one run and 262ms in another, settled at
  19.9MB and 20.6MB against a 16MB budget, where the per-query guard refused
  at about 16MB. A query that crosses in its last stride can now refuse at
  the `terminal` site where the per-query guard reached `watchdog` first; it
  still refuses.
- No refusal is lost. In the harness every shape that refuses under the
  per-query guard also refuses here (a lone retaining query, a retaining
  query beside staggered scans, tail retention, a no-row phase), and the lone
  retaining query refuses at the same check. The GC-unavailable fallback is
  untouched and its existing tests pass unchanged. This relaxes the stricter same-refusal-point term the #2526
  admission first set; the issue itself allows a bounded interval, and the
  admitting orchestrator accepted it on 2026-10-17.
- The shared record is overwritten in place and never cleared. An aborted
  query cannot leave it in a state that lets another query pass: any check
  whose baseline postdates the record forces, and an old record ages out of
  the interval.
- The refusal diagnostics LLP 0097 defines are unchanged; `gc=confirmed`
  still means this check's own collection settled the reported growth.
