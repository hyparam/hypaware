# LLP 0325: The preview budget is spent as cumulative per-destination deadlines

**Type:** Decision
**Status:** Accepted
**Systems:** Sinks, CLI
**Author:** Phil / Claude
**Generated-by:** neutral
**Date:** 2026-08-29
**Related:** LLP 0101 (#no-release, the all-or-nothing release whose plan this feeds), LLP 0040 (#storage-api-extension, the seam whose parity a shared scan would break), LLP 0324 (the eligibility half of the same preview)

> `hyp sync`'s pending preview spends one wall-clock budget in destination
> order, so on a slow machine the first destination gets an exact count and a
> later one inherits a spent budget and reports `unknown`. The budget stays a
> single number, but it is now spent as cumulative per-destination deadlines
> over whatever partition discovery leaves: destination *i* of *n* may run
> until `scanStart + remaining * (i + 1) / n`, where `scanStart` is the clock
> after discovery and `remaining` is the budget it did not consume. A fast
> destination's unused time rolls forward automatically, a single-destination
> machine is unchanged, and a slow machine degrades to labelled floors on
> every line instead of precision on the first and absence on the rest.

## Context {#context}

The preview (`previewPendingRows`, `src/core/sinks/pending.js`) computes one
deadline, `now + DEFAULT_BUDGET_MS`, and every destination's count checks that
same clock. The degradation is honest: a truncated count is a floor rendered
"at least N", a count that could not be taken is `unknown`, and the in-source
false-zero guard forbids a degraded count from rendering as "nothing pending".
Nothing under-discloses.

But the degradation is order-dependent, and the order is an iteration detail
no consent rationale defends. Releasing the first-sync hold is all-or-nothing:
[LLP 0101 #no-release](./0101-first-sync-review-window.decision.md#no-release)
refuses an instance-scoped release precisely because the plan must cover every
destination the release unblocks. A plan is therefore only as informative as
its *worst* line, and today's spending order concentrates the whole budget on
whichever destination happens to be listed first, leaving `unknown` on
destinations the confirmation will forward anyway. The right objective for a
consent surface with a fixed budget is to maximize the minimum disclosure
across destinations, not the precision of the first one.

Two other degradations were examined and left standing, see
[#unflushed-stays-global](#unflushed-stays-global) and the alternatives.

## Decision

### Cumulative slices with automatic rollover {#slices}

Partition discovery comes off the top {#discovery-off-the-top}. It is one
shared cost every destination benefits from, paid before any of them counts,
so it is charged to no slice: the preview notes `start` before discovery and
anchors the slices at `scanStart`, the clock reading after it, dividing only
`remaining = start + budget - scanStart`. Destination *i* (zero-based) of *n*
then counts until the absolute deadline `scanStart + remaining * (i + 1) / n`.
Everything downstream of the deadline is unchanged: the same per-partition and
per-512-rows clock checks, the same floor and `unknown` semantics, the same
false-zero guard.

Anchoring at `start` instead would charge the whole shared cost to slice 0 and
so relocate this decision's own failure onto the first destination rather than
removing it: with four destinations, a 3000ms budget and a 900ms discovery,
slice 0 ends 150ms before its first row is read, and the plan prints `unknown`
on line one beside three floors. Discovery is plugin-backed
(`discoverPartitions` over a cold cache), so its share is not small.

Because the deadlines are cumulative absolute times, not per-destination
stopwatches, a destination that finishes early donates its remainder to every
later one with no bookkeeping {#rollover}. The last destination's deadline is
`scanStart + remaining`, which is `start + budget` exactly, so the preview's
total wall-clock bound is exactly what it was. With one destination the
formula collapses to today's single deadline, so the common
single-destination machine is byte-identical {#single}. `remaining` is
deliberately signed: a discovery that alone outlasts the budget leaves every
deadline already in the past and every destination reporting `unknown`, which
is precisely what one shared spent deadline does today.

The cost is the one the trade names: on a machine slow enough that the first
destination used to consume the whole budget for an exact count, that
destination now stops at its slice and reports a floor. What is bought is
that every later destination reports a floor too, instead of `unknown`. Two
labelled floors inform the all-or-nothing confirmation better than one exact
count beside an absent answer, because the confirmation forwards both
destinations either way.

The cost has a second, sharper form, and naming it is part of accepting the
trade {#floor-to-unknown}. A destination whose *watermark survey* outruns its
deadline has no cursor to count any row from, so it reports `unknown` rather
than a floor. A slice is by construction shorter than the old shared budget,
so on a survey-bound machine (many partitions, cold filesystem) the first
destination can fall from a floor to `unknown`, not merely from exact to a
floor. This is accepted rather than mitigated: the plan's worth is bounded by
its worst line, that line is `unknown` under either scheme on such a machine,
and the slices at least stop one destination's survey from spending every
other destination's. Charging discovery to no slice removes the common cause;
what remains is inherent to giving any destination less than the whole clock.

A destination can still meet an already-spent deadline: the clock checks are
periodic, so one slow `readRowsSince` pull can overshoot a slice into the
next. The existing spent-budget path (report `unknown` rather than a floor
built from nothing) already handles that and stays.

### The unflushed floor stays global, and the spool stays uncounted {#unflushed-stays-global}

Any partition with pending spool rows still downgrades every destination to a
floor, because the preview writes nothing (a preview that flushes the cache
is not a preview) and rows still in the spool are invisible to the table
read. The candidate remedy, a new read-only spool row-count seam, is
rejected: a spooled row has not passed `settleBatch`, which may drop it, and
its usage-policy resolution happens at flush, so a spool count is itself only
a bound. It would buy a labelled approximate number instead of a labelled
floor, at the price of a new kernel storage seam and extra IO spent inside
the very budget this decision rations. The floor is honest and says why it is
a floor.

## Alternatives considered

- **One shared scan serving every destination.** Counting all destinations
  from the oldest cursor in a single pass would remove the order dependence at
  its root, but the preview's number is trustworthy only because each
  destination's count hands `readRowsSince` exactly the options the export
  hands it (`since` from that destination's own watermark, `includeLegacy`
  derived from its presence,
  [LLP 0040 #storage-api-extension](./0040-incremental-sink-reads.design.md#storage-api-extension)),
  a property `test/core/sink-seam-parity.test.js` pins behaviourally. A shared
  scan cannot pass per-destination options and would turn the quoted number
  into a second, derived notion of pending.
- **Raise the budget.** Changes how long the prompt keeps a person waiting,
  not how fairly the wait is spent, and #976 is why the bound exists.
- **Accept the steady state.** The degradation is honest but lands `unknown`
  on destinations the all-or-nothing release forwards regardless, which is
  the weakest disclosure on the surface that matters most, and the remedy is
  local to one function.

## Consequences

- Implemented in the same change as this document, in
  `src/core/sinks/pending.js`, with two cases added to
  `test/core/sync-pending-volume.test.js`: a scan that exhausts the first
  destination's slice must leave the second destination with a floor, not
  `unknown`; and a preview whose discovery eats a large share of the budget
  must still leave every destination a floor, which pins
  [#discovery-off-the-top](#discovery-off-the-top) against a regression that
  would put `unknown` back on the first line.
- The `sync.pending_preview` log line still sums `hyp_pending_rows` across
  every status and so reads low on a degraded machine; `hyp_exact_counts` on
  the same line remains the disambiguator. Unchanged by this decision.
- Which datasets a destination's count should include at all is the other
  half of the same preview and is settled separately in
  [LLP 0324](./0324-preview-asks-each-destination-which-datasets-it-forwards.decision.md).
