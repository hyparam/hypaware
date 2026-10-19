# LLP 0527: A Hermes poll tick reconciles a budgeted batch of sessions in one commit per partition

**Type:** Decision
**Status:** Accepted
**Systems:** Sources, Cache, Plugins
**Author:** Phil / Claude
**Date:** 2026-10-17
**Related:** LLP 0118, LLP 0417
**Extends:** [LLP 0122](./0122-hermes-log-forwarding.design.md) (#source: start awaits one bounded tick, and later ticks finish the rest), [LLP 0449](./0449-hermes-mutable-transcripts.spec.md) (#read-commit-guard: the guard spans a batch commit)
**Tracker:** hyparam/hypaware#2279

## Context

`startHermesSource` awaits its first poll tick (LLP 0122 `#source`), and that
tick reconciled every changed session one at a time. Each per-session
reconcile discovered the dataset's partitions, took their guards, and loaded
and committed every partition's table metadata. A pass that flags every
session at once (a first tick, a lost watermark sidecar, or the LLP 0449
fingerprint upgrade over legacy marks) therefore cost sessions times
partitions metadata loads before start returned, and the daemon stayed
unhealthy for the whole history. The watermark was flushed after each
session, one more write per session.

## Decision

### Batched reconcile {#batched-reconcile}

A tick collects its changed sessions into one batch and commits it through a
new optional storage call, `reconcileRowsBatch(dataset, columns, snapshots)`.
The cache discovers partitions once, takes one set of partition guards, and
reconciles each partition for every snapshot of the batch in one metadata load
and one commit. Each scope is settled, and logged as
`cache.snapshot_reconciled`, exactly as a lone `reconcileRows` settles it;
`reconcileRows` is now the one-snapshot case of the same code.

Every session's scope guard (LLP 0449 `#read-commit-guard`) is claimed before
its read, as before, and is held until the batch commit returns. The
read-to-commit guarantee is unchanged: no snapshot of a session can commit
between another writer's read and commit of it. The cost is that a backfill
reaching a session in a poll's in-flight batch waits for the batch, not for one
session. Its per-session wait (about five seconds) covers a typical batch
commit, but a batch of large sessions or a large cache can take longer; the
backfill then refuses that session with its existing explicit, retryable busy
error rather than waiting without bound. The lock order is unchanged: scope
guards, then partition guards.

If the batch commit fails, the tick retries its snapshots one at a time in
session order. Reconciling a snapshot twice is idempotent, so a partly
committed batch is safe to retry, and a session that cannot commit holds back
only itself and the sessions after it, and is named in the failure log, as
before batching. Storage without the batch call takes the per-session path.

### Tick budget {#tick-budget}

A tick admits at most 64 changed sessions, and stops admitting once the batch
holds 4096 projected rows. The check runs before each session and a session is
projected whole, so the last session admitted can carry the batch past 4096 by
up to its own projection; the first session is always admitted, so one long
session still makes progress. A session another writer holds is deferred and
does not count. The watermark is flushed once per tick, after the commit, so a restart
repeats at most the one batch that had not committed, and a session is never
marked before its commit.

Sessions past the budget are left unmarked and counted as `sessions_pending`
on the `hermes.poll` span and log. After a healthy tick with sessions pending,
the source schedules a catch-up tick one second later instead of waiting a
poll interval, so a full repair converges in seconds of wall time while each
batch yields the event loop. A failed tick does not catch up early; it waits
the normal interval.

The watermark's bytes are unchanged: it is the same per-session map, written
less often.

## Consequences

- Daemon start commits at most one batch, whatever the history size; the rest
  lands on the following ticks. Change detection is unchanged: when the
  database changed, the first tick still makes the streaming full-history
  fingerprint pass LLP 0449 `#cost-and-verification` describes, before any
  batch is admitted. What this bounds is the reconcile and commit work, not
  that pass.
- Metadata loads per tick are one per partition, not one per session per
  partition.
- The budget bounds sessions and projected rows, not bytes or peak memory. A
  batch holds up to 64 scope guards and projections until it commits, and its
  projected rows are bounded by 4096 plus the last admitted session's
  projection. The reconcile visits one partition at a time and holds what
  LLP 0449 `#cost-and-verification` names for it: the batch's delete positions,
  a parquet row group, and the table's manifest metadata and live deletion
  masks, which scale with cache size and compaction backlog.
- A concurrent backfill can wait for a whole batch commit for a session the
  poll holds, instead of one session's commit, and is refused as busy if the
  commit outlasts its wait.
