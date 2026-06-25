# LLP 0039: Incremental sink reads

**Type:** Spec
**Status:** Active
**Systems:** Sinks, Cache
**Author:** neutral (escalated from issue #122)
**Date:** 2026-06-25
**Related:** LLP 0013, LLP 0014
**Generated-by:** neutral

> Sinks must read only the rows added since their last successful export, not
> re-read and re-stream the whole partition every tick. Escalated from GitHub
> issue #122, which a fix attempt found to be an architectural change rather than
> a localized bug.

## Problem

Every scheduled tick, the request (central forward) sink and the blob sink read
the **entire** partition and re-stream all of it — there is no per-sink cursor or
watermark that skips already-exported rows:

- `forwardPartition` iterates the whole table each tick
  (`hypaware-core/plugins-workspace/central/src/sink.js` — `for await (const row of
  storage.readRows(tablePath))`).
- the core blob/encoder path does the same full-partition `readRows`
  (`src/core/sinks/encoder.js`, driven from `src/core/sinks/materialize.js`).

Correctness today leans entirely on the **server-side idempotency ledger**
(`X-Hyp-Batch-Id`) to drop re-sent chunks. The server stays correct, but the
client still **reads and transmits everything** on every run. Cumulative work is
**O(N²)** while data grows (tick *k* moves ≈ *k·c* rows: 1+2+…+K ≈ K²/2); with
retention it plateaus to "re-read and re-send the whole retention window every
minute" — wasteful by roughly retention-window-many re-sends per row versus the
ideal of once.

The local **iceberg** table-format sink is already incremental — snapshot
ancestry / `markerSubsumedBySnapshot` skips already-exported data (O(N)
amortized; `format-iceberg/src/table-format.js`, `state.js`). The forward and
blob sinks never got the equivalent.

## Why this is a design, not a one-line fix

A naïve cursor (a stored physical-row offset or a cumulative `cursor.rowCount`)
is **not** exactly-once here, because two cache behaviours move rows underneath
any positional watermark:

- **Retention** permanently position-deletes rows from the *front* of each
  partition's table ([LLP 0013](./0013-local-query-cache.decision.md) — retention
  is the central trade-off), so a physical offset silently skips or re-counts
  rows after the first prune.
- **Compaction** rewrites tables into fresh epoch generations, invalidating any
  offset keyed to a prior generation.

Choosing a watermark that survives retention **and** compaction is a real design
decision with several viable shapes — snapshot ancestry (as iceberg already
does), a monotonic per-row sequence/ingest column, or a content-addressed
continuation token. The chosen shape also revises the documented designs in
[LLP 0014](./0014-sinks.spec.md) (forward-sink backpressure currently specifies
*server-side dedup over client re-send*) and the storage read contract in
[LLP 0013](./0013-local-query-cache.decision.md), so it must land as a design
decision rather than an ad-hoc bug PR.

## Scope

A shared incremental-read mechanism covering **both** non-iceberg sinks:

- the central **forward** (request) sink, and
- the core **blob** (plain-Parquet) sink,

reusing or generalizing the incremental approach the iceberg sink already proves.
This likely entails extending the kernel-owned storage read surface
(`QueryStorageService.readRows`, consumed by sinks, backfill, query,
vector-search, and the message projector) with a `since`/continuation parameter,
plus a persisted per-`(sink instance, partition)` watermark under the sink's
plugin state dir. The server idempotency ledger is **retained** as the in-flight
retry safety net, not removed.

## Acceptance

- A tick with **no new rows** transmits ≈0 bytes (today: re-sends everything).
- A tick after **N new rows** reads/sends ≈N rows, independent of total partition
  size.
- **Exactly-once is preserved across retention prunes and compaction generation
  swaps** — no row is skipped or duplicated after the front of a partition is
  pruned or a table is compacted into a new epoch.
- The server idempotency ledger still covers mid-batch retries.

## Origin

Escalated by the neutral reconciler from GitHub issue
[#122](https://github.com/hyparam/hypaware/issues/122) — the bug-fix worker
determined a test-provable localized fix was not credible without first making
the watermark design decision above, so the work re-enters the pipeline family as
a request rather than the maintenance family as a fix.
