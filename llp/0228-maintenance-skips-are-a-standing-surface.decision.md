# LLP 0228: A partition maintenance leaves fragmented is named on a standing daemon surface

**Type:** Decision
**Status:** Accepted
**Systems:** Cache, Daemon, CLI
**Author:** Kenny / Claude
**Date:** 2026-08-13
**Related:** LLP 0217 (the effectiveness verdict whose skip reason this carries), LLP 0218 (the failed-attempt skip reason this carries), LLP 0199 (the baseline gate both sit on, and the walk order this borrows), LLP 0164 (the precedent: an operator-facing fact the daemon alone knows travels through `status.json`), LLP 0021 (the trace surface this stops being the only one)

> The daemon's maintenance tick stops discarding the report `maintainCache`
> hands back. Every completed tick overwrites one bounded snapshot in
> `status.json` naming the partitions it deliberately left fragmented and why;
> `hyp status` renders that snapshot and raises one warning diagnostic from it,
> and the tick logs one line whenever the count is nonzero. Retention is
> exactly the last tick, because a skip reason is a standing state the tick
> re-derives from the cursor, not an event that happened once.

## Context {#context}

LLP 0217 and LLP 0218 made a partition maintenance deliberately leaves
fragmented a *stated* outcome rather than an absence in a "0 partitions
compacted" summary: `MaintenancePartitionReport` carries
`compactionIneffective` and `compactionAttemptFailed`, `hyp query maintain`
prints both, and the `maintenance.partition` span carries
`compaction_ineffective` / `compaction_attempt_failed`.

Both statements reach an operator only if the operator goes looking. The
daemon runs the same walk hourly and `src/core/daemon/runtime.js` awaited
`maintainCache` and dropped its return value on the floor, so on an ordinary
install the only daemon-side evidence of a frozen partition was a span
attribute. A span attribute is a real observability channel (the repo's
Log-Driven Development rule says so), and it is the wrong one for this fact:
it is only there if tracing was on at the moment the tick ran, and finding it
means knowing to query the `traces` dataset for an attribute whose name you
already know. The state it describes, meanwhile, is not a moment. It persists
until something rewrites the cursor.

Reported as #742, deferred out of PR #741 on the grounds that widening the
surface LLP 0217/0218 settled is a new request rather than a defect in them.

## Decision {#decision}

<a id="status-file-is-the-surface"></a>**The daemon's status file carries it,
and `hyp status` reads it.** The maintenance tick summarizes its report into
`DaemonStatus.maintenance` and persists it with the snapshot the daemon
already writes on every sink tick. `hyp status` lifts it from `status.json`,
renders a `maintenance:` block, carries it under `--json`, and raises one
`maintenance_partitions_skipped` warning diagnostic naming the count and the
repair (`hyp query maintain --dry-run` to enumerate, `--force` to retry).

This is LLP 0164's route, for LLP 0164's reason. The daemon is the only
process that runs the hourly walk, `hyp status` activates no plugins and reads
no cache, and a CLI that re-ran `maintainCache` to answer the question would
be a *second* walk (loading metadata, stat-ing data files) fired by a status
command. The file is the only place the answer can come from without doing the
work twice.

The alternatives were weighed and are not enough on their own. A `fileLog`
line alone (#742's option 1) is a record of a tick, not a description of a
state: it scrolls away, and it is the shape of surface that already existed
for the failing tick in LLP 0218's context section. A new field on the
maintenance report alone changes nothing, because the caller that discards
the report is the whole defect. So the log line is kept as the record (the
tick logs `daemon.maintenance_skipped` when the count is nonzero) and the
status file is the discovery, which is #742's option 3.

Nothing about *when* a partition is compacted moves. This decision reads the
report the walk already produces, and it must never be a reason to stat a
data file: proving a skipped partition is also still fragmented is exactly the
per-tick cost the LLP 0199 gate exists to avoid, and LLP 0217 and LLP 0218
both already declined to pay it for their own reports.

<a id="last-tick-only"></a>**Retention is the last completed tick, and only
that.** Every completed tick overwrites the snapshot whole, including a tick
that skipped nothing (which writes zeros).

A skip reason is per-partition and per-tick, so a standing surface needs a
retention rule, and the reason itself decides which one. Both reasons are read
off the partition cursor on every tick: they describe a state that is still
true, not an event that occurred. So the newest tick is the only tick whose
answer is current, and a partition that thaws (a `--force` rewrite, new data
flushing in, the next writer generation) drops off the surface on the tick
after it thaws, with no expiry rule and nothing to invalidate. That is the same
self-clearing property LLP 0218 built into the report itself. A last-N history
would go stale against the cursor, would need an eviction rule of its own, and
would duplicate the `fileLog`, which is already the append-only record with
timestamps.

The snapshot is bounded three ways, because `status.json` is read back and
printed to a terminal. `reasons` is a fixed key set, one integer per reason.
`partitions` is capped at `MAX_SKIPPED_PARTITIONS_REPORTED` entries, taken in
walk order, which is LLP 0199#neediest-first: descending live data-file count,
so the named partitions are the worst ones and the cap costs no sort of its
own. `skippedTotal` is the true count, so the cap is never a lie, and the
render says how many were not named and which command lists them all. The cap
and the sanitizing are re-applied on read as well as on write, for the reason
LLP 0164 states: core reads a *file*, and must not assume the daemon that
wrote it was this build.

Each named partition carries its dataset, its partition tuple, its reason, and
the one number or timestamp that reason is about (the recorded rewrite's
data-file count, or when the spent attempt failed). Those are dataset and
partition identifiers and kernel-side counters. Nothing from a row, a prompt,
a credential, or a config value is anywhere near this path.

<a id="reason-ids-are-span-attribute-names"></a>**The reason ids are the span
attribute names, verbatim.** `compaction_ineffective` (LLP
0217#record-effectiveness) and `compaction_attempt_failed` (LLP
0218#report-the-spent-attempt) are the ids on every operator-facing surface:
the status file, `hyp status` text, `hyp status --json`, and the daemon log
line. They are already the `maintenance.partition` span's attribute names, and
those are in turn named after the `MaintenancePartitionReport` fields, so an
operator moving between a trace query, `hyp status`, and the daemon log reads
one spelling. Minting a third name for the same fact is exactly the parallel
vocabulary this repo's skip reporting has so far avoided.

Two things a maintenance tick also does are deliberately *not* reasons here. A
partition sitting on its baseline with a rewrite recorded as effective is
converged (LLP 0199#baseline-gate): that is the healthy majority of every
cache, it is why the gate exists, and naming it would put most partitions on
the surface and none of the interesting ones. A rebaseline (LLP 0207) is work
the tick performed, not a partition it left alone. The surface names only the
partitions the kernel knows are still fragmented and has stopped rewriting.

A partition whose rewrite throws on every tick is knowingly deferred, not
named here. On the ordinary growth path a throwing rewrite writes no LLP
0217 retry stamp, so the tick re-attempts and re-throws forever without
`compactionAttemptFailed` ever being set, and this surface says nothing
about it. That is the correct behavior for the two reasons this document
settled (an operator sees nothing rather than a false "0 skipped"), not a
defect in either; a third id for a tick's own error is the additive
extension this decision's Consequences section already anticipates, left
for whoever picks it up next.

## Consequences {#consequences}

- `hyp status` on an install with no frozen partition is unchanged: the text
  block renders only when the count is nonzero, the way every other
  conditional section in the status render does. `--json` always carries the
  key (null before any tick has run), per that surface's "missing values
  surface as null rather than being omitted" contract.
- The diagnostic is a warning and never flips `overall` to `degraded`. A
  frozen partition is a thing to know about, not an outage: the daemon is
  running, capture is working, and queries answer. This puts it beside
  `recent_errors` and a failed client action rather than beside a missing
  config.
- The snapshot can only say what the last tick saw. A tick cut short by
  `max_tick_ms` (LLP 0199#neediest-first) reports the partitions it reached and
  no others, so `partitionsVisited` is on the snapshot beside the counts: "3
  skipped of 12 visited" is honest in a way "3 skipped" is not when the cache
  holds 400 partitions.
- A daemon that has never run a maintenance tick, and an install whose
  maintenance is disabled, both leave the field absent. Absent means "no tick
  has reported", which is not "nothing is frozen", and the render says nothing
  rather than claiming a clean cache.
- `status.json` grows by a bounded constant. It is rewritten in full on every
  persist, so there is no accumulation across ticks and no file growth to
  bound over a daemon's lifetime.
- The surface is additive to the report, so a later per-partition outcome
  worth standing (this tick's own error, say, which is a different fact from
  either reason here) is a new id and a new count key, not a new shape.

## Extends {#extends}

LLP 0217 settled that a partition skipped because its rewrite achieved nothing
is skipped explicitly, and LLP 0218 settled the same for a partition whose one
retry was spent by an attempt that threw. Both stand exactly as written: this
document changes neither the verdicts, nor what is recorded on the cursor, nor
when a partition is retried. What it adds is that the daemon, which runs the
walk that reaches those verdicts, stops throwing away the report that states
them, so a frozen partition is discoverable by an operator who never runs
`hyp query maintain` and never queries the `traces` dataset.
