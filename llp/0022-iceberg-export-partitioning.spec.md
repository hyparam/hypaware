# LLP 0022: Iceberg export partitioning (day grain + conversation sort)

**Type:** Spec
**Status:** Draft
**Systems:** Sinks
**Author:** Phil / Claude
**Date:** 2026-06-09
**Related:** LLP 0014, LLP 0013, LLP 0003, LLP 0015, LLP 0021

> Lay out exported Iceberg tables for an archive's job, not the cache's:
> **partition by day** (a writer-owned default from `primaryTimestampColumn`,
> *not* the cache's `cachePartitioning`) and **sort each partition by the
> dataset's lookup key** (`conversation_id`). Day grain bounds file count by
> time; the within-partition sort preserves conversation-lookup speed via
> row-group pruning instead of one-file-per-conversation partitioning.

## Summary

The intrinsic Iceberg-backed cache (`src/core/cache/iceberg/`) and the
`@hypaware/format-iceberg` export writer sit on the **same `icebird` engine** and
encode data files **identically**. They diverge on the read-side layout: the
cache **partitions** its tables (`icebergCreateTable({ …, partitionSpec })`,
`src/core/cache/iceberg/store.js:105`); the export creates tables with **no**
`partitionSpec` (`format-iceberg/src/commit.js:83`), so an exported table is one
flat, ever-growing set of data files.

This spec gives the export a layout fit for an archive:

1. **Partition by a writer-owned day grain** — `day(primaryTimestampColumn)`,
   e.g. `day(message_created_at)` for ai-gateway. Independent of
   `cachePartitioning`. Bounds file count by *time* (~58 partitions today, +1/day)
   instead of by *conversation cardinality* (unbounded — see
   [§Why day, not conversation_id](#why-day-not-conversation-id)).
2. **Sort each day partition by the dataset's lookup key** — `conversation_id`
   for ai-gateway. A conversation's rows cluster inside the day file(s), so a
   `conversation_id` lookup prunes row groups by their min/max bounds without
   making `conversation_id` a partition boundary (and its file-count floor). See
   [§Within-partition sort](#within-partition-sort).

The cache and sinks have **different jobs** — the cache is the "recent-query
story," sinks are the "long-term-storage and downstream-integration story"
([LLP 0014](./0014-sinks.spec.md#sinks-are-export-targets-not-the-write-path)) —
so they *should* lay out differently. Parity-by-construction (the earlier,
**abandoned** design — inherit `cachePartitioning` so the export mirrors the
cache's `conversation_id:identity` partitioning) is rejected: it reproduces the
file-count pathology below. The export instead borrows `conversation_id` only as
a **sort** key, where it helps and costs nothing.

## Why day, not conversation_id

Measured from the local cache (`hyp query` over `ai_gateway_messages`,
2026-06-09):

- **517,752 rows / 3,799 conversations / 58 distinct days**, ~1.8 KB/row, 3
  sources, ~3,917 `(conversation_id, cwd, date)` cache partitions.
- The cache's `conversation_id:identity` partition field sets a **hard floor of
  ~1 data file per conversation**: ~4,523 live files at ~120–480 KB each
  (another ~4,080 were an orphaned table generation — `du` over the directory
  overcounts; trust snapshot `total-data-files`).
- **Compaction cannot beat that floor.** Iceberg compaction (icebird's
  `icebergRewrite`) only merges files *within* a partition. A
  conversation_id-identity partition holds one conversation, so the floor is one
  object per conversation — **unbounded** in the number of conversations.
- `date` is **day-grained** (`2026-06-04`): ~25–39K rows/day. A day-grain
  partition yields **dozens of multi-MB files per day**, with time-range pruning
  and no compaction pressure.

Conversation_id is the wrong *partition* axis for an archive on file-count
grounds alone. But it is the right *lookup* axis — recovered here as a sort key
(below), not a partition.

## Partition derivation

The export derives its partition spec **per dataset, at commit time** (a
`format-iceberg` sink has no single dataset — `createSink` runs once for many),
from the dataset's `DatasetRegistration`
(`collectivus-plugin-kernel-types.d.ts`):

- If the dataset declares a `primaryTimestampColumn` present in its schema,
  partition by **`day(primaryTimestampColumn)`**. For `ai_gateway_messages`,
  `day(message_created_at)`.
- Otherwise export **unpartitioned** (V1 behavior unchanged for that dataset). A
  dataset with no primary timestamp has no defensible day grain.

The writer **synthesizes** the partition declaration — it does *not* read
`cachePartitioning` for the partition axis. It builds the declaration shape the
shared helper consumes, with one day-grained field, and feeds it to
`partitionSpecForDeclaration(declaration, schema)` (the exact cache helper, now
promoted to core — [§Shared core helpers](#shared-core-helpers)):

```js
{ iceberg: { fields: [{ column: primaryTimestampColumn, transform: 'day', required: true }] } }
```

**Why `day(timestamp)`, not `identity(date)`.** ai-gateway carries a precomputed
day-grained `date` string, so `identity(date)` was on the table. It is rejected
as the rule: `day(primaryTimestampColumn)` is **general** to any timestamped
dataset, whereas `identity(date)` only works where a day column is precomputed
and would couple the export to a cache-ism. icebird buckets `day` correctly on
append (`groupByPartition` + `dayTransform`, verified). The cost is partition
values are UTC **day ordinals** (e.g. `…_day=20608`), not `date=2026-06-04`
strings — cosmetic in object keys; engines prune on values, and HypAware prunes
at the file/row-group level regardless ([§What this buys](#what-this-buys)).

## Within-partition sort

Conversation lookup is preserved by **clustering** a conversation's rows together
inside each day partition — a table **sort order** on the dataset's lookup
columns — not by partitioning on `conversation_id`. The export creates the table
with a `sortOrder`; icebird then **sorts every append by the table's default sort
order automatically** (`icebergAppend` → `prepareAppend` resolves
`default-sort-order-id`, sorts each partition group, and records the real
`sort_order_id`). No per-call threading. A `conversation_id` lookup then prunes
data files / row groups by their `conversation_id` min/max bounds
([§What this buys](#what-this-buys)), which a one-file-per-conversation partition
would have achieved only at the unbounded file-count cost above.

**Sort-key derivation.** The dataset's lookup columns are exactly the identity
columns it already declares in `cachePartitioning.iceberg.fields`. The export
sorts by those identity columns, in declared order — for ai-gateway,
`conversation_id, cwd, date`, so `conversation_id` leads and dominates the
clustering. This is the one place the export **does** read `cachePartitioning`:
for the *sort* axis, where reusing the dataset's declared identity columns is
beneficial and carries none of the partition file-count cost. The *partition*
axis stays writer-owned and independent (see
[§Partition derivation](#partition-derivation)). A dataset with no
`cachePartitioning` is day-partitioned but unsorted — still file-count-bounded
and time-pruneable.

**Files are locally, not globally, sorted.** Each append sorts only its own
rows, so a day partition touched by N export batches holds N internally-sorted
files whose `conversation_id` ranges may overlap. Row-group pruning still skips
most of them; a tighter global sort is available out-of-band via `icebergRewrite`
([§Compaction](#compaction)), not run in V1.

Sort order is mutable table metadata, **not** partition spec, so introducing or
evolving it later is not partition-spec drift
([§Drift rejection](#drift-rejection)).

## Shared core helpers

`partitionSpecForDeclaration` and `validatePartitionSpecStability` (plus the
`CachePartitioningDeclaration` type) live under `src/core/cache/iceberg/schema.js`
and `src/core/cache/types.d.ts`, but are pure functions of `(declaration, schema)`
already consumed beyond the cache: the dataset registry validates declarations
(`src/core/registry/datasets.js`), the public plugin surface types them
(`DatasetRegistration.cachePartitioning`), and now the export derives a spec with
them. They are **core surface**. Promote both functions and the type to a neutral
core home re-exported from `src/core/index.js`; cache and export import from
there. Move + re-export, behavior unchanged. Recorded as an amendment to
[LLP 0003](./0003-core-vs-plugin-surface.spec.md), not a new Decision LLP.

The `Cache…` prefix is a historical misnomer once the export consumes the type;
it keeps its name in V1 to avoid churning the dataset-registration surface.

## Drift rejection

On append to an existing table, the export validates that the dataset's derived
day-grain spec still matches the table's current `PartitionSpec` via
`validatePartitionSpecStability(declaration, existingSpec, schema)`, mirroring the
cache (`src/core/cache/iceberg/store.js:122-125`). A mismatch (a dataset that
gained/changed `primaryTimestampColumn`, or a table written before this spec)
fails with the stable `error_kind` **`iceberg_partition_spec_drift`**. V1
**rejects** drift; partition *evolution* is unsupported. The operator path is to
export to a new table prefix; auto-roll is a possible future increment. (Sort-
order changes are not drift — see [§Within-partition sort](#within-partition-sort).)

## No sink override

A `format-iceberg` sink exports **multiple** datasets — each its own table, per
the "one source, one table" invariant
([LLP 0000](./0000-hypaware.explainer.md#cross-cutting-invariants)) — with
different schemas and timestamp columns. A single sink-level partition
declaration would be ambiguous across them; a per-dataset override map was
considered and dropped. Partitioning and clustering are **writer-owned defaults**
keyed off the dataset's own registration, not operator config. The export adds
**no new config** in V1.

## What this buys

With the partition + sort layout on an icebird carrying the read-pruning work
(#20/#21, see [§icebird dependency](#icebird-dependency)), day partitioning buys
HypAware's **own** read path — not just external engines:

1. **Partition pruning** — `partitionMightMatch` skips data files whose day
   ordinal can't match a time predicate (`icebergDataSource` applies it inside
   `scan()`; transforms applied to filter literals).
2. **Row-group pruning** — WHERE is pushed to hyparquet, skipping row groups /
   pages by column statistics. With the `conversation_id` sort, a
   `conversation_id` predicate prunes most row groups in each day file.
3. **File-count control** — the immediate, layout-level win: bounded large files
   instead of one-per-conversation sprawl, independent of any read path.
4. **External engines** (Trino/Spark/Snowflake) — real partition pruning on the
   day ordinal from Iceberg manifest data.

The same pin bump gives the **cache's** read path (`store.js`) the same pruning
for free — a bonus beyond this spec's scope.

## Compaction

icebird now exposes `icebergRewrite` (reads live rows, sorts globally under the
target spec, writes consolidated files, commits a replace snapshot). So
compaction is **available**, reframing the prior
`format-iceberg/src/maintenance.js:120` "blocked by icebird" status. But for a
day-partitioned archive it is **not needed** (partitions already hold large
files), and it is **not run in the daemon** — a full read-rewrite risks the
OOM/blocking failure already seen with the parquet sink (the encoder OOMed/blocked
the daemon; exports run manually with a large heap). V1 leaves it as an out-of-band tool that
would tighten the local-vs-global sort, nothing more. The maintenance report
should say "not needed / out-of-band," not "blocked."

## Observability

Emit the resolved partition spec and sort order on the iceberg sink's
`iceberg.table.create` / `iceberg.snapshot.commit` spans as **`hyp_partition_spec`**
(e.g. `day(message_created_at)`) and **`hyp_sort_order`** (e.g.
`conversation_id,cwd,date`), so a smoke can assert the intended layout was written
([LLP 0021](./0021-observability.spec.md)). On drift rejection, emit
`error_kind=iceberg_partition_spec_drift`.

## icebird dependency

All three enablers are implemented in icebird `master` (commit `3edb15b`,
"Scan pruning and sort-on-write (#20, #21, #22)"), **as yet unpublished** (npm
tops out at `0.8.5` pinned / `0.8.8` latest):

- **#20** data-file pruning via partition values + manifest bounds — `prune.js`
  `partitionMightMatch` / `fileMightMatch`.
- **#21** row-group/page pruning via column stats + bloom filters — WHERE
  pushdown in `icebergDataSource.scan()`.
- **#22** sort-on-append — `prepareAppend` sorts each partition group by the
  table's `default-sort-order-id`; `icebergRewrite` for global compaction.

**Landing requirement:** this work depends on a published icebird containing
`3edb15b` (e.g. `0.8.9`/`0.9.0`); the committed `package.json` pin moves from
`0.8.5` to that version. The bump is a **shared-engine** change — the cache rides
the same icebird — so the cache's tests and hermetic smokes must be re-run to
confirm no regression across the changed `create.js` / `commit.js` / `read.js` /
`transform.js`. During development this worktree builds against a local checkout
of icebird `master`; the pin is updated to the published version before merge.

## Out of scope

- **Daemon-run compaction** — available via `icebergRewrite` but deliberately not
  run in-process (memory landmine). Out-of-band only.
- **Non-parquet data files** — Iceberg V1 is parquet-only.
- **External catalog integration** (REST/Glue/Nessie) — file-catalog only.
- **Renaming `cachePartitioning` / `CachePartitioningDeclaration`** — a separate
  breaking change.

## References

- [LLP 0014](./0014-sinks.spec.md) — Sinks; iceberg as a table-format writer; the
  cache-vs-sink jobs split this spec leans on.
- [LLP 0013](./0013-local-query-cache.decision.md) — the cache whose layout this
  spec deliberately *diverges* from.
- [LLP 0015](./0015-query-and-datasets.spec.md) — datasets,
  `primaryTimestampColumn`, queryable read.
- [LLP 0003](./0003-core-vs-plugin-surface.spec.md) — core/plugin boundary;
  amended for the helper promotion ([§Shared core helpers](#shared-core-helpers)).
- [LLP 0021](./0021-observability.spec.md) — the span attributes above.
- Code: `src/core/cache/iceberg/store.js:100-126` (cache create+partitionSpec,
  drift guard), `src/core/cache/iceberg/schema.js`
  (`partitionSpecForDeclaration`, `validatePartitionSpecStability`),
  `format-iceberg/src/commit.js:81-107` (export create+append),
  `format-iceberg/src/table-format.js:184` (per-dataset `exportDataset`),
  `format-iceberg/src/maintenance.js:120` (compaction framing).
- icebird `master` `3edb15b` — `src/write/sort.js`, `src/write/stage.js`,
  `src/prune.js`, `src/write/rewrite.js`.
</content>
