# LLP 0344: Retention Under Fault

**Type:** RFC
**Status:** Draft
**Systems:** Cache, Config, Observability
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-08-31
**Related:** LLP 0013, LLP 0220, LLP 0323, LLP 0331, LLP 0332, LLP 0334;
hyparam/hypaware#1138, hyparam/hypaware#1131, hyparam/hypaware#1166,
hyparam/hypaware#1170, PR #1135, PR #1162

> Four deferred findings from the review of PR #1135 (the retention
> enforcement wire) share one property that kept every one of them out of
> that PR: each is a change to what a live daemon deletes. A per-partition
> catch makes a pass delete more than it does today; a budget makes it
> delete less; a registry miss and a bare-number timestamp each decide
> whether a partition is evicted whole, purged by row, or left alone. None
> of those is a fix that a reviewer can wave through in the margin of the
> PR that exposed it. This document states them, states what is already
> known about each, and puts the options up. It decides nothing.
>
> A fifth question arrived the same way, out of the review of the PR that
> carries this document: what a retention window means for a partition
> whose cursor cannot be read (#unreadable-cursor). It has the same
> property, so it is stated here on the same terms.

## Context {#context}

`src/core/cache/retention.js` has enforced a per-dataset window since
LLP 0013#retention-is-the-central-tradeoff, but nothing on the daemon called
it: `hyp status` reported a window that was never applied (issue #1131). PR
#1135 wires `createRetentionEnforcer().tick()` onto the maintenance tick and
is the change that makes every question below a live one, because until it
lands the enforcer runs only where a test or a command calls it.

Two review rounds and a triage pass at head
`fe5fdba25af6dc2e27bd1bfbc821482e592b8765` classified six findings
non-blocking: each one either under-deletes, degrades observability, or
needs a dataset shape nothing in this repo ships, and none deletes data the
configured window does not name. Two of the six are settled elsewhere and
are recorded at the end of this document. The four here are open, and
#unreadable-cursor, which the review of the PR that carries this document
added later, is open beside them.

The reader should hold one asymmetry throughout. Retention is the only
subsystem in the tree whose ordinary successful operation destroys data
permanently, so its failure modes are not symmetric: a pass that deletes too
little is a disk-space bug an operator can see in `df`, and a pass that
deletes too much is unrecoverable. Every option below is written with which
direction it fails in made explicit, because that is the axis the decision
turns on.

## A partition that throws stops the pass {#failing-partition}

### What is there

`tick()` in `src/core/cache/retention.js` loops over
`discoverCachePartitions(cacheRoot)` and calls `purgeSourceTable` or
`evictLegacyPartition` per partition, with no `try` inside the loop. Its
neighbour `maintainCache` in `src/core/cache/maintenance.js` does have one,
under `@ref LLP 0220#walk-survives-a-partition`: one partition's failure is
a note on that partition, never the walk's verdict.

So a throw from any partition ends the pass for every partition ordered
after it. Real sources for the throw: an ENOSPC on a cursor write, an
Iceberg commit conflict against live ingest in `commitDeleteBatch`, an
unwritable temp file under the atomic cursor write.

Under the PR #1135 wire the daily cadence stamp advances only on success, so
a pass that dies at partition *k* retries hourly and dies at partition *k*
again, and everything after *k* is never enforced while `hyp status` keeps
reporting the window. That is issue #1131 re-entering through the fault
path. It is not silent (an hourly `daemon.retention_failed` line) and it
never over-deletes, which is why both review rounds and the triage held it
non-blocking.

### Why it was not just fixed

Adding the catch makes the daemon delete data it does not delete today. That
is the right direction only if the answer to "should a pass finish when one
partition cannot be enforced" is yes, and that is a question about the
product's promise, not about this loop.

There is a second question underneath it, which is why a catch alone may not
be the whole answer. `discoverCachePartitions` returns a stable order, so a
partition that fails deterministically shadows the same tail forever. A
catch converts that from "the tail is never enforced" to "one partition is
never enforced", which is strictly better; randomising the order or
quarantining the failing partition converts it further, at the cost of
either a non-reproducible pass or a new piece of persisted state.

### Options {#failing-partition-options}

1. **Leave it.** The pass is all-or-nothing and the failure is hourly and
   logged. Fails toward under-deletion, which is the safe direction. Costs:
   a single bad partition can silently cap the cache's whole enforced set,
   and the operator's only signal is a log line that does not name what went
   unenforced.
2. **Per-partition catch, matching `maintainCache`.** The pass continues and
   the failing partition is a note. Fails toward completing the pass. Costs:
   a partition that fails every time is now permanently unenforced with the
   pass reporting success, so the stamp advances and the retry cadence drops
   from hourly to daily. Wants a counter or a status line naming the
   unenforced partitions, or it trades a loud stall for a quiet one.
3. **Per-partition catch plus randomised order.** Removes the shadow without
   new state: over enough passes every partition gets a turn ahead of the
   failing one. Costs reproducibility, which matters to the smoke tier.
4. **Per-partition catch plus quarantine.** A partition that fails *n*
   consecutive passes is skipped and reported until something clears it.
   Bounded and legible. Costs a new piece of persisted per-partition state,
   which is LLP 0013 territory and needs a home in the cursor or beside it.

### What a decision needs to say

Whether a failing partition stops the pass; if it does not, what surface
names the partitions the pass could not enforce, and whether the cadence
stamp may advance on a partially enforced pass; and whether order is
stabilised, randomised, or quarantined.

## The pass is unbudgeted inside a promise shutdown awaits {#budget}

### What is there

Under PR #1135, `buildRetention().tick()` runs inside the maintenance
in-flight promise and takes no budget, while `maintainCache` beside it takes
`budgetMs: mCfg.max_tick_ms`. Shutdown does a bare `await
maintenanceInFlight`.

A non-skipped pass re-reads the timestamp column of every live data file in
the cache. On a large cache SIGTERM therefore blocks behind that scan until
the service manager escalates to SIGKILL, which interrupts a delete in
progress: the exact outcome the await was added to prevent.

The triage verified the interruption is survivable today. The mutation lock
is in-process (a promise map in `src/core/cache/partition.js`, nothing
strands on disk), `writeCursor` is atomic, an interrupted `rm -rf` only
touches a partition already judged evictable, and an interrupted Iceberg
commit is re-planned next pass. So this is a shutdown-latency and
predictability question, not a corruption one.

### Options {#budget-options}

1. **Leave it.** Simplest, and the interrupt is survivable. Costs: shutdown
   time is unbounded in cache size, and "survivable" is a property of
   today's delete paths that nothing pins.
2. **Give the pass `max_tick_ms`, sharing the maintenance budget.** One
   knob, one meaning. Costs: retention and compaction then compete for one
   budget, so a slow compaction can starve retention indefinitely and the
   window silently stops being enforced on a busy cache. That is the failure
   this whole series exists to remove.
3. **Give the pass its own budget key.** Independent, and starvation is
   visible as a pass that always runs out. Costs a new config key, which
   `CLAUDE.md` says to add only when the task calls for it, and a decision
   about its default.
4. **No budget, but make the pass interruptible.** Check a shutdown signal
   between partitions (and between delete batches) and stop cleanly at the
   next boundary. Shutdown latency is then bounded by one partition rather
   than by the cache, and no pass is ever killed mid-delete. Costs plumbing
   an abort signal into the enforcer.

A budget and an interrupt are not the same mechanism, and the discussion
should not conflate them: a budget bounds the *work* a pass does on a
healthy daemon, an interrupt bounds the *time* a shutdown waits. It is
coherent to want the second and refuse the first.

### What a decision needs to say

Whether a pass is budgeted and out of which budget; what a pass that runs
out records so a permanently truncated pass is visible rather than silent;
and what happens to a pass that SIGTERM arrives during.

## A registry miss evicts a whole partition on mtime {#registry-miss}

### What is there

`retentionTimestampColumns(dataset)` asks `getDataset` for the dataset's
declared `primaryTimestampColumn` and `fallbackTimestampColumns`, and falls
back to `['timestamp', 'created_at', 'recorded_at', 'date']` when the
registration is absent. A registration is absent whenever the plugin is
disabled, was deselected at `hyp init`, or failed activation.

`purgeSourceTable` then intersects those names with the table schema, and a
table with none of them routes to `evictSourceTableByMtime`, which removes
the whole partition directory on data-file mtime rather than purging rows.

The datasets in this repo whose real timestamp column is none of the four:
`claude_telemetry_events` (`event_timestamp`), `gascity_messages`
(`event_time`), otel `traces` (`startTimestamp`), `context_graph` nodes and
edges (`first_seen`), context-graph-enrich `resolutions` (`resolved_at`) and
`committed` (`committed_at`). Otel `logs` and `metrics` use `timestamp` and
are safe, and `ai_gateway_messages` has a STRING `date` that parses.

This is not an in-window over-delete. The age gate requires that nothing in
the partition was written since the cutoff, capture spool included. The
defect is coarseness: a directory removal where a row-level purge was
declared, with `rowsDeleted` reported from a possibly stale
`cursor.rowCount`.

### Options {#registry-miss-options}

1. **Leave it.** The gate keeps it from deleting in-window data. Costs: the
   reported row count is wrong, the granularity silently changes with which
   plugins happen to be active, and a decision this important is made by an
   accident of activation order.
2. **Persist the declared timestamp column beside the table.** A registry
   miss then degrades to a row-level purge at the column the dataset
   actually declared, and the mtime path is left for tables that never
   declared one. This is the candidate the triage named. It adds a field to
   on-disk cache state, which is LLP 0013 territory and is exactly the kind
   of addition `CLAUDE.md` says needs the task to call for it.
3. **Refuse to enforce a dataset whose registration is missing.** No
   registration, no deletion, and say so. Fails toward under-deletion, which
   is safe, and it is honest: the daemon does not know what the column
   means. Costs: a deselected plugin's data is then retained forever, which
   is the opposite of what a privacy-shaped retention window promises.
4. **Narrow the default column list to nothing** and treat "no declared
   column and no `timestamp`-named column" as case 3.

### What a decision needs to say

Whether a dataset with no live registration is enforced at all; if it is,
whether the fallback may evict a whole partition or must degrade to a
row-level purge; and if it must, where the declared column is persisted.

## A bare-number timestamp is read as epoch milliseconds {#bare-number}

### What is there

`extractTimestampMs` returns any finite `number` as-is and converts `bigint`
the same way. An INT64 column carrying epoch *seconds* therefore dates to
1975 and is deleted on the first pass even when it means now.

Verified unreachable from anything shipped: every bundled timestamp column
under the candidate names is declared `TIMESTAMP` and comes back from
hyparquet as a JS `Date`, and the one STRING exception
(`ai_gateway_messages.date`) parses. The exposure is a third-party plugin
dataset declaring an INT64 seconds column under one of the four default
names.

This is the one finding in this document whose failure direction is
over-deletion, which is why it is here despite being the narrowest.

### Options {#bare-number-options}

1. **Leave it, and document the unit.** A bare number means epoch
   milliseconds; a plugin that writes seconds is writing the wrong thing.
   Costs: nothing enforces the documentation, and the penalty for getting it
   wrong is silent permanent deletion of live data.
2. **Magnitude heuristic.** A number below some threshold is read as
   seconds. Catches the realistic mistake. Costs a heuristic in the one code
   path where being wrong deletes data, and it is wrong for any dataset
   legitimately holding timestamps before the threshold date.
3. **Treat a bare number as unparseable.** Conservative and unambiguous, and
   the direction of the error is under-deletion. Costs: a plugin
   legitimately writing epoch-ms silently stops being reclaimed, which is
   over-tightening, and it is invisible unless something reports the
   unparseable rate.
4. **Read the unit from the column's declared Iceberg type** rather than
   guessing from the value, and treat a number under a type that does not
   say as unparseable. The most work, and the only option that is not a
   guess.

### What a decision needs to say

Which units a bare number may mean, what happens to one whose unit cannot be
established, and whether the rows a pass could not date are reported: options
3 and 4 both fail toward retaining data forever, so whether that is
acceptable turns on whether it is visible.

## A cursor that cannot be read suspends the window {#unreadable-cursor}

### What is there

`tick()` reads every partition through `readCursorSync`, which is
`tryReadCursorSync(...) ?? { epoch: 0, rowCount: 0, compaction: null }`. The
refusal that reader raises for a `cursor.json` that does not parse is
therefore erased where the pass reads it: a partition whose cursor is corrupt
arrives in the loop as a layout-less epoch-0 cursor, spelled exactly like a
real one. Its `layout` is not `source-table`, so it routes to
`evictLegacyPartition`, which acts only when `epoch=<part.epoch>/` or a table
directly under the partition exists and returns null for every other shape.

The erasure happens twice over, which matters to any option scoped at a call
site. `discoverCachePartitions` reads the same `cursor.json` through the same
defaulting `readCursorSync` before `tick()` ever sees the partition, and that
is where `part.epoch` comes from. So an unreadable cursor is synthesized into
an epoch-0 cursor once for the loop's own read and once for the epoch
`evictLegacyPartition` joins onto the partition path, and the second read is
shared with `maintenance.js`, `purge.js`, and `cacheStatus`.

Four partitions, each carrying `cursor.json = '{ not json'` and a 400-day-old
mtime under a 90-day window, against the same four with a healthy cursor
naming the shape that is really there:

| partition shape | corrupt cursor | healthy cursor |
| --- | --- | --- |
| source-table (`table/metadata/`) | skipped, no result | row-level purge |
| epoch layout at `epoch=0/` | evicted whole | evicted whole |
| epoch layout at `epoch=3/` | skipped, no result | evicted whole |
| bare `metadata/` under the partition | evicted whole | evicted whole |

The two columns together are the finding. Corruption adds no deletion: on the
two shapes that are evicted, the synthesized epoch-0 default names the same
live generation the healthy cursor names, so the eviction turns on a
directory mtime past the cutoff and nothing else, and it lands either way.
Not because the cursor is unconsulted (the `epoch=3/` row is what a
synthesized epoch costs a partition), but because on those two shapes the
guess and the truth agree. What corruption changes is the other two cells. A
real source table holding three rows, two of them 400 days old, keeps all
three under a broken cursor and loses the two under a healthy one, with the
pass returning `sourceTableResults: []` and no error.

So the delta is under-deletion, and it is not the disk-space bug that
direction usually is. A retention window is a privacy promise, and a
partition whose cursor stopped parsing keeps every row past it until
something rewrites the bytes. One thing does: an append to that same
partition writes a fresh cursor over them, restarting `rowCount` from the
rows it just appended and dropping the `retention` block.

That append is not a repair, and it should not be read as one.
`appendRowsToSourceTable` does read through `tryReadCursorSync`, and then
spells out the same epoch-0 default `readCursorSync` is defined as, so the
refusal is erased there too: it takes `tableDir` to be the default `table`
and writes that name down. On a partition already compacted to a
`table-<ms>` generation the append therefore mints a second `table/` holding
only the rows it just appended, publishes it as live, and leaves the real
generation unreferenced; the orphan sweep reclaims that generation once past
the grace window, and every row the partition held before the append is
gone. That is the precise failure
`tryReadCursorSync` refuses a non-string `tableDir` to prevent rather than
dropping the field (LLP 0323#whole-cursor), arriving instead through the
write path; it is a defect of the write path, not of retention, and it is
filed as #1170 rather than answered by any option below. So the append ends
the suspension only on a partition whose live generation is the bare `table`
the default happens to guess right, and where it guesses wrong it is
Option 4's re-derivation with none of Option 4's care.

In any case the partitions this question is about are the ones aging out of
the window, and a partition keyed by a date that has passed is exactly the
one nothing appends to any more. Compaction and the orphan sweep supply no
bound either, and not for the same reason. Compaction reads the partition
through the same defaulting `readCursorSync`, so it plans against a
synthesized `epoch=0/` that is not there, counts no data files, and rewrites
nothing. The orphan sweep is the one that reaches the refusing gate:
`walkForRetired` reads through `tryReadCursorSync` (LLP 0323#one-gate), so
the live generation stays unknown and the sweep declines to call any sibling
an orphan, which is what keeps it from deleting the real one. A maintenance
tick over a compacted partition with a corrupt cursor leaves both the
`cursor.json` bytes and the `table-<ms>` generation exactly as it found
them. So for the partitions retention is coming for, the suspension has no
end.

This is LLP 0331#guard-travels-with-the-delete reached through a different
property. The pass takes "the cursor was read" from a reader that answers a
default when it was not, so the two readers over one `cursor.json` disagree:
`tryReadCursorSync` refuses the partition and `readCursorSync` hands the
same bytes to a pass that may delete on them.

Since the PR that carries this document the refusal itself is audible: one
WARN naming the partition, at most once per condition per rewarn window
(LLP 0332#transition-plus-rewarn), retracted when a read stops refusing
(LLP 0334#recovery-is-announced). The consequence is not. `RetentionResult`
carries `evicted` and `sourceTableResults`, and a partition the pass could
not characterise appears in neither, so nothing that reports the window
reports that the window went unenforced. That is issue #1131's gap again,
entered through the cursor instead of through the missing wire.

### Options {#unreadable-cursor-options}

1. **Leave it.** The refusal names the partition on the log channel and
   retention stays lenient. Fails toward under-deletion on most shapes,
   which is the safe direction. Costs: the window is unenforced for an
   unbounded time on a partition an operator can only find by reading WARN
   lines, and the shapes that are still deleted are deleted on a cursor the
   shared reader had already refused, so the deleting pass and the gate in
   front of it disagree about what is known.
2. **Read the cursor through `tryReadCursorSync` and refuse the partition.**
   The skip becomes deliberate rather than the side effect of a synthesized
   default, and nothing is deleted on a cursor nobody could read. Fails
   toward under-deletion on every shape. Costs: it removes a delete a live
   daemon performs today (the `epoch=0` and bare shapes), so it is a change
   to what is deleted rather than a tidy; and a deliberate refusal that
   still appears nowhere on the pass result trades an accidental silence for
   a designed one.
3. **Refuse and report.** Option 2, plus the refused partitions on
   `RetentionResult` and on whatever surface states the configured window,
   so "reported" and "enforced" cannot drift the way #1131 describes. Costs
   a field on the pass result and a surface to carry it, and it is the same
   question #failing-partition asks about naming the partitions a pass could
   not enforce, which argues for one answer rather than two.
4. **Re-derive or quarantine.** Rebuild a usable cursor from what the
   directory shows, or hold the partition aside until something clears it.
   Only this option ends the suspension rather than choosing a direction for
   it. Costs the most, and re-derivation is the guess LLP 0323#whole-cursor
   already refused to make at read time: a partition that has been compacted
   has a live generation the directory alone cannot identify, and guessing
   it wrong turns an unenforced window into local data loss.

### What a decision needs to say

Whether a partition whose cursor cannot be read may be deleted at all, and
whether the shapes deleted today keep being deleted; whether the suspension
of the window is reported anywhere other than a WARN line, and on what
surface; and whether a suspension may be indefinite or has to end in a
repair, a quarantine, or an alarm.

## Not decided here {#not-decided}

Two of the six findings from the same triage are not open questions:

- **The silent half of the cursor-gate refusal set.** The `JSON.parse` catch
  in `tryReadCursorSync` returned null with no warning, so a corrupt but
  non-escaping `cursor.json` made retention skip that partition silently and
  forever. That is an observability gap, not a deletion-behaviour question,
  and it is fixed in the PR that carries this document by giving the refusal
  the same standing report its escaping sibling has had since LLP 0332,
  under the same window and with the same retraction on clear (LLP
  0334#recovery-is-announced).

  The triage also noted that the parse-failure exit calls `noteEscapeCleared`,
  so a previously escaping cursor that degrades to unparseable garbage
  clears the standing escape warning. It does, deliberately: LLP 0334
  settled that an unproven condition may not throttle, and the escape
  condition is genuinely unproven once the bytes stop parsing. What made
  that a defect was the silence after the retraction, and the new refusal
  fills it. The clearing itself was settled by LLP 0334 and is not reopened
  here.

  The report is the whole of what that fix is. What the silence was hiding,
  a partition that keeps every row past the configured window for as long as
  its cursor stays broken, is a deletion-behaviour question, and it is
  #unreadable-cursor above.

- **The per-pass enforcer rebuild has no test seam.** PR #1135 builds the
  enforcer per pass so a SIGHUP reload changes the enforced window, and no
  automated control pins that, because the daily cadence stamp cannot be
  provoked into a second pass inside a test. The seam and its control belong
  in the PR that owns the code: the enforcer rebuild and the cadence stamp
  do not exist on `master`, so nothing on `master` can be pinned or
  regressed. It stays open against PR #1135.

## References {#references}

- [LLP 0013](./0013-local-query-cache.decision.md):
  #retention-is-the-central-tradeoff, the window whose enforcement every
  finding here is about, and the home of any new on-disk cache state.
- [LLP 0220](./0220-maintenance-walk-survives-a-partition.decision.md):
  #walk-survives-a-partition, the rule the maintenance walk follows and the
  retention loop does not.
- [LLP 0323](./0323-cursor-names-a-generation-in-its-own-partition.decision.md):
  #one-gate, the reader every destructive path shares, and #whole-cursor, the
  re-derivation it refuses to make at read time.
- [LLP 0331](./0331-a-deleting-pass-carries-its-own-check.decision.md): a
  deleting pass checks its own preconditions rather than inheriting them,
  which #unreadable-cursor reads through the cursor.
- [LLP 0332](./0332-cursor-refusal-warns-on-transition-then-rewarns.decision.md)
  and [LLP 0334](./0334-the-escape-report-tracks-the-partition-it-names.decision.md):
  the standing-refusal report the fixed finding above extends.
- hyparam/hypaware#1138: the triage that carries all six findings and the
  head each was verified at.
- hyparam/hypaware#1131: the reported window that was never enforced, which
  PR #1135 answers and #failing-partition can reintroduce under fault.
