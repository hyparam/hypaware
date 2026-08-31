# LLP 0336: Retention rides the maintenance tick, and the pass runs daily

**Type:** Decision
**Status:** Accepted
**Systems:** Cache
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-08-31
**Extends:** [LLP 0013](./0013-local-query-cache.decision.md)
(#retention-is-the-central-tradeoff: the window that decision made the
central tradeoff now has a shipped path that enforces it)
**Related:** LLP 0137, LLP 0220, LLP 0323, LLP 0326, LLP 0331, LLP 0334, hyparam/hypaware#1131

> `query.cache.retention` was schema-validated, cross-validated against the
> dataset registry, defaulted by the onboarding pathway (LLP 0137), and
> reported by `hyp status` as `cache retention: N days`. Nothing enforced
> it: `createRetentionEnforcer` (`src/core/cache/retention.js`) had zero
> non-test callers from the commit that introduced it, and `maintainCache`'s
> only age cutoff is Iceberg snapshot expiry. An operator could set a
> window, see it confirmed, and have data age past it forever
> (hyparam/hypaware#1131). This decision is about where enforcement runs
> and how often, not what it does: LLP 0013 settled the semantics (per
> dataset window, 90 day default, rows past it deleted permanently,
> retention-only eviction) and the enforcer already implements and tests
> them. The gap was a wire, and the wire is a design surface of its own
> because it decides when a user's data is deleted.

## The enforcer runs on the tail of the maintenance tick {#rides-the-maintenance-tick}

The daemon's maintenance section (`src/core/daemon/runtime.js`) constructs
one `createRetentionEnforcer` beside `maintainCache` and runs `tick()` on
the tail of the scheduled maintenance pass, inside the same
`maintenanceInFlight` promise. Not a timer of its own, for three reasons:

- **Shutdown already waits there.** A retention pass commits Iceberg
  deletes and removes whole partition directories; abandoning one mid-write
  is exactly what the shutdown path's `await maintenanceInFlight` exists to
  prevent. A second timer would need a second in-flight guard and a second
  shutdown await, duplicating machinery whose whole value is that there is
  one of it.
- **The cadence is already config.** `query.cache.maintenance.enabled` and
  `interval_minutes` are the operator's existing knobs for "when may the
  daemon mutate the cache in the background". Retention is background cache
  mutation; giving it a separate schedule would mean two knobs that both
  have to be off before the cache holds still.
- **Order matters and the tick provides it.** Retention runs after
  `maintainCache`, so it deletes against the freshly maintained layout, and
  the delete snapshots it commits are expired by the next tick's snapshot
  expiry rather than racing the current one.

The consequence of riding the tick is inherited honestly: an operator who
sets `maintenance.enabled: false` also stops retention. That is read as
intent (background mutation off means background deletion off), and it is
the same tradeoff `hyp status` already carries for compaction and snapshot
expiry.

A maintenance failure does not cost the retention pass: the tick's
`maintainCache` span settles (including its catch) before retention runs,
so a cache with one throwing partition still ages out the rest.

## The pass runs on the first tick, then daily {#daily-cadence}

A non-skipped enforcer pass reloads table metadata and re-reads the
timestamp column of every live data file per partition; the enforcer's own
cursor short-circuit (`lastCutoffMs >= cutoffMs`) can never fire on a later
pass because the cutoff advances with the clock. At the default maintenance
interval that would be a full-cache timestamp scan every hour, buying
nothing: windows are whole days.

So the daemon gates the pass to at most once per 24 hours of process
lifetime, and runs it on the first maintenance tick after boot. The stamp
advances only when a pass completes, so a failed pass retries on the next
maintenance tick (hourly by default) instead of standing unenforced for a
day, at the cost of an hourly `daemon.retention_failed` line while the
failure stands, which is the visible direction. The stamp is process-local
on purpose: a daemon that restarts runs retention within its first
interval, which errs toward enforcing the promise, and the enforcer's
per-partition retention cursor already makes a repeated pass idempotent.

## A deletion leaves a durable line {#durable-line}

Retention is the one cache mutation nothing can reconstruct afterwards, so
the pass does not rely on a tracer having been running when it fired (the
same argument LLP 0228 and LLP 0311 made for the status file and the
repartition line). Every partition that lost rows gets a `fileLog` line:
`daemon.retention_evicted` for a whole-directory eviction (dataset,
partition, rows) and `daemon.retention_rows_deleted` for a source-table
purge (dataset, source, cutoff date, rows). The eviction line is written on
the removal, not on the count: `rowsDeleted` for that path is
`cursor.rowCount`, a tally of what other passes committed, and a directory
whose tally reads 0 is still a directory that stops existing. A row purge
that deleted nothing has nothing to say and stays quiet; a removal never
does. The `retention.tick` span
carries `rows_deleted` and `partitions_evicted`, and the enforcer's own
child spans (`retention.plan_deletes`, `retention.iceberg_delete`,
`retention.evict`, `retention.evict_source_table`) are unchanged.

## What this makes live {#what-this-makes-live}

- LLP 0334#consequences bounds a daemon's `escapeReportedAt` by the poisoned
  partitions that currently exist, on the strength of the
  `clearEscapeReport` calls at retention's two whole-partition eviction
  sites. Those sites were unreachable from any daemon until this wire. They
  are reachable now, and the strand they close is narrower than 0332 and
  0334 supposed, because the cursor gate in
  #a-live-delete-carries-the-gates sits in front of them: an *armed* entry
  means the cursor does not read, and a cursor that does not read is a
  partition retention skips. So retention no longer removes a partition
  while it is poisoned at all. The calls stay, because "the removal owns
  the clear" is the rule LLP 0334 settled and each site is a removal; what
  changes is that the escape strand now ends at the refusal rather than at
  the delete. The bound is unaffected either way - it was always the count
  of poisoned partitions on disk, and one retention declines to touch is
  still one of them.
- A partition retention refuses is a partition that ages past its window and
  stays. That is the loud-refusal trade LLP 0328#loud-refusal already
  accepts, and here the refusal is genuinely loud: the standing
  `cursor_table_dir_escapes_partition` warning re-arms on the rewarn
  interval, and it names the partition.
- `hyp status`'s `cache retention: N days` line describes something that
  happens. The absent-config default (90 days, `DEFAULT_RETENTION_DAYS`)
  is now enforced too, which is what that line has reported all along.
- `hyp query maintain` is unchanged: it remains layout maintenance
  (compaction, snapshot expiry, migration), and its `--expire-only` still
  means snapshots. A manual retention trigger is a separate request if
  anyone wants one; this doc deliberately does not add a CLI surface.

## The window enforced is the window configured now {#window-read-per-pass}

`createRetentionEnforcer` normalizes its window once, at construction, and
`reload()` reassigns `boot.config`. So the daemon builds the enforcer per
pass rather than once at boot: a boot-time enforcer would keep deleting at
the boot-time window while `hyp status` reports the reloaded one off disk,
which is issue #1131's reported-is-not-enforced divergence returning through
the reload door. The asymmetry decides it - an operator who LOWERS the
window and reloads merely waits for a restart, while one who RAISES it after
a scare is still being deleted at the shorter window, and that is the
direction that costs data. The pass runs at most daily, so building an
enforcer per pass costs nothing.

## A live delete carries the gates a live delete has to carry {#a-live-delete-carries-the-gates}

Wiring the enforcer does not only schedule it: it makes
`src/core/cache/retention.js` the newest `readdir`-then-`rm -rf` pass in the
tree, and two rules this repo already settled apply to it for the first time
because until now nothing reached it.

- **LLP 0331#guard-travels-with-the-delete.** The pass walks
  `<cacheRoot>/datasets` and recursively removes directories under it. Every
  component below that root is descended from a `Dirent` the walk already
  saw was a directory, so a symlinked dataset or partition is skipped
  before anything opens it; `datasets/` itself is the one component opened
  on a name alone. The check is written inside `tick()`, not at the daemon
  call site, and it refuses the whole pass and says so through
  `reportPlantedSweepPath`. Components *above* `datasets/` (a relocated
  `query.cache.dir`, a `$HYP_HOME` on another volume) stay legitimate, which
  is the same asymmetry LLP 0326#positive-evidence settled.
- **LLP 0323#one-gate.** The pass read its cursor through `readCursorSync`,
  which answers epoch 0 for a `cursor.json` that exists and does not parse
  (or that names a generation outside its partition). That default is a
  *deletion instruction* here: it routes a source-table or higher-epoch
  partition into `evictLegacyPartition`, which weighs a retired `epoch=0`
  generation's mtime and then removes the whole partition directory, live
  generation and rows written today included. It reads through
  `tryReadCursorSync` instead, and a partition whose cursor file is present
  but unreadable is skipped: an unreadable cursor is not a licence to
  delete. Discovery's `legacy` flag still marks the legitimate
  table-with-no-cursor-file shape, which keeps the epoch-0 default.

- **The whole partition is not the committed half of it.** Both
  whole-directory paths remove `part.path`, and the capture spool
  (`<part.path>/_hypaware_spool`, rows this process captured and has not
  committed) is inside it. The age decision read `<generation>/data` alone,
  so a partition whose committed files date to March and whose source
  resumed this morning read as untouched since March, and the removal took
  rows captured minutes ago that no snapshot, manifest or `cursor.rowCount`
  knows about - so `rowsDeleted` did not even report them. The spool is
  weighed into the age decision instead of being made a refusal, because a
  refusal is the other failure: a spool stranded behind a failing flush
  would stop that partition reclaiming forever. A spool whose own newest
  captured row is past the window is as evictable as the data files beside
  it. Stamps (`last-flush.json`) are deliberately not weighed - a flush that
  commits nothing rewrites one, and weighing it would make a merely
  flush-attempted partition look perpetually fresh.
- **The partition mutation lock.** Every cursor mutator in the tree holds
  `withPartitionMutationLock` across its own read-modify-write: both append
  paths, and every cursor write in `maintenance.js` (whose rebaseline write
  carries the note explaining why re-reading without the lock is not
  enough). Retention held it at neither of its cursor writes and at neither
  of its whole-directory removals. That was harmless while nothing called
  it; on the tail of a live tick a pass over one partition spans a metadata
  load, a parquet scan of every data file, a commit per delete batch and a
  full rescan, and ingest appends to the same partition throughout. Writing
  the pre-pass snapshot back reverts what landed in between: `rowCount`
  cosmetically, and `pendingFallbacks` not, since a dropped increment
  strands provisional rows against the settle sweep. Retention now rewrites
  from the cursor on disk, under the lock, and takes it around its removals
  too, because an `rm -rf` of a live partition is the largest partition
  mutation in the file.

None is a new decision. All three are existing accepted ones arriving at a
path that was dead code when they were made, which is the shape LLP 0331
predicted: "a pass that exports its deletion and imports its containment
from whoever happens to call it has published the deletion without the
property that bounds it".

## Testable {#testable}

The wire is tested through the real scheduled path, not a hand-built
enforcer: `test/core/daemon-retention-enforcement.test.js` seeds one
dataset with an over-age and an under-age source partition, boots a real
daemon with a 30 day window, and asserts the over-age rows are gone, the
under-age rows survive byte-for-byte, and the `retention.tick` span exists
with the exact deleted-row count. Before the wire that test fails on the
span's absence, which is the bug by name.

Each gate above is pinned by a control that dies when only that gate is
reverted, and two of them exist to die under an over-tightened one: a
partition carrying **no** `cursor.json` at all is still evicted (the LLP
0323 gate is not a blanket refusal on any cursor that fails to read), and a
cache reached through a symlinked **ancestor** still enforces (the LLP 0331
check asks only about `datasets/`). The first of those has to be built as
the cursor-less on-disk shape discovery actually flags `legacy`, since a
fixture that writes a cursor file exercises the other side of the gate and
leaves the escape hatch unpinned.

## References {#references}

- [LLP 0013](./0013-local-query-cache.decision.md): the semantics this
  enforces (#retention-is-the-central-tradeoff), unchanged here.
- [LLP 0137](./0137-onboarding-retention-defaults.decision.md): how the
  window gets its value; the pathway default is now a real promise.
- [LLP 0220](./0220-maintenance-walk-survives-a-partition.decision.md):
  the tick this rides, and why its failures are contained.
- [LLP 0334](./0334-the-escape-report-tracks-the-partition-it-names.decision.md):
  the eviction-site clears this wire makes reachable (#eviction-clears,
  #consequences).
- hyparam/hypaware#1131: the gap, and the evidence the enforcer had no
  non-test caller.
- [LLP 0323](./0323-cursor-names-a-generation-in-its-own-partition.decision.md),
  [LLP 0326](./0326-generation-name-is-the-directory.decision.md),
  [LLP 0331](./0331-a-deleting-pass-carries-its-own-check.decision.md): the
  gates a delete path carries, applied here for the first time
  (#a-live-delete-carries-the-gates).
