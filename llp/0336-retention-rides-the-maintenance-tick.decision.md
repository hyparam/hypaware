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
**Related:** LLP 0137, LLP 0220, LLP 0334, hyparam/hypaware#1131

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
purge (dataset, source, cutoff date, rows). The `retention.tick` span
carries `rows_deleted` and `partitions_evicted`, and the enforcer's own
child spans (`retention.plan_deletes`, `retention.iceberg_delete`,
`retention.evict`, `retention.evict_source_table`) are unchanged.

## What this makes live {#what-this-makes-live}

- LLP 0334#consequences claims a daemon's `escapeReportedAt` is bounded by
  the poisoned partitions that currently exist, on the strength of the
  `clearEscapeReport` calls at retention's two whole-partition eviction
  sites. Those sites were unreachable from any daemon until this wire; the
  claim is now true of a running daemon, not only of the tests that
  construct an enforcer by hand.
- `hyp status`'s `cache retention: N days` line describes something that
  happens. The absent-config default (90 days, `DEFAULT_RETENTION_DAYS`)
  is now enforced too, which is what that line has reported all along.
- `hyp query maintain` is unchanged: it remains layout maintenance
  (compaction, snapshot expiry, migration), and its `--expire-only` still
  means snapshots. A manual retention trigger is a separate request if
  anyone wants one; this doc deliberately does not add a CLI surface.

## Testable {#testable}

The wire is tested through the real scheduled path, not a hand-built
enforcer: `test/core/daemon-retention-enforcement.test.js` seeds one
dataset with an over-age and an under-age source partition, boots a real
daemon with a 30 day window, and asserts the over-age rows are gone, the
under-age rows survive byte-for-byte, and the `retention.tick` span exists
with the exact deleted-row count. Before the wire that test fails on the
span's absence, which is the bug by name.

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
