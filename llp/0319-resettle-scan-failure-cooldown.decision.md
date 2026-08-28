# LLP 0319: A re-settle seeding scan that could not read its table cools down before it is retried

**Type:** Decision
**Status:** Accepted
**Systems:** Cache
**Author:** Phil / Claude
**Date:** 2026-08-28
**Related:** LLP 0027 (#re-settle-sweep, the sweep gate this bounds), LLP 0199 (the baseline gate the retry rides on), LLP 0218 (the cursor-stamped skip idiom this follows)

> Extends [LLP 0027](./0027-cache-settlement.decision.md). A seeding scan that
> could not read the table still caches no verdict, and the partition is still
> classified again later. It is no longer classified again on the very next
> tick: the failure is stamped on the cursor and the retry waits out a window.
> A delay on the retry, never a verdict about the partition.

## Context {#context}

LLP 0027#re-settle-sweep gates the forced re-settle rewrite on
`cursor.pendingFallbacks`, a count the flush path maintains, so the hourly tick
answers "does this partition hold a marker row?" from the cursor instead of
decoding the table's whole `attributes` column. A cursor written before that
field existed pays one legacy scan and the verdict is cached.

That cache is permanent, which is why a scan that *failed* must not write one:
a false zero strands every `gateway_fallback` row in the partition until an
append happens to flip the count off zero, or a human runs
`hyp query maintain --force`. So the scan answers `boolean | undefined`, the
caller writes no cursor field on `undefined`, and the next tick classifies the
partition again (#1044, PR #1049).

Right per tick, unbounded in time. The retry rides the LLP 0199 baseline gate,
and for the population that can get stuck that gate never closes:

- A partition that was never compacted has no `resettleBaselineFiles` at all,
  so `grewSinceCompaction` is permanently true whether or not it ever grows
  again.
- The rewrite that would move the baseline reads the same data files the scan
  could not, so it cannot run either.

For a partition whose data files are permanently unreadable - a torn parquet, a
half-copied cache, a live file the daemon lost read permission on - the whole
`attributes` decode is therefore re-paid on every tick, forever. That is a
narrow reinstatement of exactly the per-tick decode the cursor count was
introduced to retire, and it was recorded as a deferred finding on PR #1049
rather than fixed there (#1054).

It is narrow. The hourly OOM this echoes hit every legacy partition of a
*healthy* table every tick; this needs real corruption, is confined to the one
affected partition, and a partition that keeps growing trips `needsCompaction`
first and skips the scan outright. But "bounded per tick, unbounded in time" is
not a bound.

## Decision {#decision}

<a id="cool-the-retry-down"></a>**A failed scan is stamped, and the stamp
delays the next one.** The tick whose scan could not read the table writes
`resettleScanFailedAt` into the cursor's `compaction` block, and a later tick
that finds that stamp younger than `RESETTLE_SCAN_COOLDOWN_MS` (six hours, six
default maintenance intervals) skips the scan and records
`resettle_scan_cooling_down` on the partition span. Once the window is up the
next tick scans again; if that scan also fails, the stamp is refreshed and the
window restarts. The retry rate on a permanently unreadable partition falls
from every tick to at most four attempts a day, at any tick cadence.

What PR #1049 bought is untouched: **a failed scan is still cached as nothing
at all.** The stamp is not a verdict and is never read as one. It says when a
scan last failed, not what the partition holds, and `pendingFallbacks` stays
absent - so the sweep the scan would have forced is delayed by the window, not
cancelled, and no code path can read a failure as a zero.

Nothing real is lost to the delay. While the table is unreadable the rewrite
the scan would force cannot run, so a scan that succeeded on the next tick
would only fail one step later. And a marker row that lands *while* the stamp
stands is counted by the flush path exactly as always: `pendingFallbacks`
becomes concrete, the early return fires before the stamp is ever consulted,
and the sweep is not delayed for it at all. The cooldown can only ever delay
the reclassification of rows already committed under a legacy cursor.

<a id="clearing"></a>**The stamp clears when something has proved the table
readable.** It lives in the `compaction` block deliberately, beside
`resettleBaselineFiles`, because that block already has the lifetime this state
wants:

- An append carries the block through untouched, so ordinary write traffic does
  not reopen the retry. A flush changing the file count is not evidence that a
  torn file was repaired, and clearing on it would restore a per-flush decode in
  the one partition where the sweep cannot run anyway.
- A generation rewrite, an in-place compaction, a foreign-replace recognition
  (LLP 0207), and the at-the-floor verdict (LLP 0310) all replace or supersede
  that block, so each drops the stamp with the record that supersedes it. All
  of them read the table, so each is proof the scan would now get an answer.
- A completed scan drops it explicitly, in the same write that seeds the count.

A repair that leaves the table's metadata identical - the bytes of a data file
restored in place - is not detectable without the scan itself, and proving it
would mean stat-ing data files on ticks that currently touch none, which is the
cost LLP 0218 declined for the same kind of report. The window is the answer for
that case: a partition that becomes readable again resumes normal behaviour
within it.

<a id="unreadable-stamp-scans"></a>**A stamp that cannot be read as a recent
failure is no stamp.** Absent, unparseable, or dated in the future by a clock
that moved: all three answer "not cooling down" and the scan runs. Suppressing
work on state this build cannot interpret is the direction that hides marker
rows; re-scanning is only ever a cost. `--force` is unaffected - it makes
compaction due before the sweep gate is consulted at all.

## Consequences {#consequences}

- The sweep for a partition whose seeding scan fails is delayed by up to the
  window. Only pre-existing rows under a legacy cursor are affected, and only
  while the table cannot be read.
- The state stays diagnosable. The failing tick still records
  `resettle_scan_unreadable` and `resettle_scan_error` (LLP 0021's 512-char
  cap), the cooled ticks record `resettle_scan_cooling_down`, and
  `resettleScanFailedAt` is readable in `cursor.json` for as long as it stands.
- The cursor stays compatible both ways: an older build ignores the extra key
  in the compaction block, and this build treats a cursor without one as a
  partition whose last scan is not known to have failed, which is what every
  cursor written before this document is.
- A dry run neither stamps nor seeds, for the reason it already declines to
  seed: a preview must not decide when the daemon next looks.
- The window is a constant, not config. It is a retry cadence for a corruption
  corner, not a tuning knob, and a partition that needs the sweep sooner than
  the window has `hyp query maintain --force`.

## Extends {#extends}

LLP 0027#re-settle-sweep settled that the sweep is gated on the cursor count
and that only a completed scan is a verdict. Both stand. What this document
adds is the missing bound on the retry the second half creates: the unknown
answer costs one scan per window, not one per tick.
