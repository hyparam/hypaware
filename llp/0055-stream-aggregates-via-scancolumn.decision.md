# LLP 0055: Stream Aggregates via `scanColumn` Rather Than Buffering Rows

**Type:** Decision
**Status:** Draft
**Systems:** Query, Cache
**Author:** Phil / Claude
**Date:** 2026-06-30
**Related:** LLP 0015, LLP 0054, LLP 0057

> How scalar and distinct aggregates avoid buffering the scan. Implements the
> `#streaming-first` requirement of [LLP 0054](./0054-bounded-query-execution.spec.md).

## Context

The SQL engine ([squirreling](https://github.com/hyparam/squirreling)) already
contains a **streaming aggregate fast path**: for a scalar aggregate over a
single column it can pull values column-at-a-time and keep only an accumulator
(or, for `COUNT(DISTINCT)`, a set of distinct keys whose size is the column's
**cardinality**, not the row count). That path is **dormant** — it guards on the
source exposing a `scanColumn` method and bails to the row-buffering slow path
when the method is absent. No dataset source in this stack implements
`scanColumn`:

- the [icebird](https://github.com/hyparam/icebird) Iceberg `AsyncDataSource`
  exposes only `numRows` / `columns` / `scan`;
- the core union (`hypaware/core/query` → `union-source.js`, the shared
  `unionSources` every plugin imports per [LLP 0015](./0015-query-and-datasets.spec.md)
  "Multi-partition union") does not forward it;
- the ai-gateway schema-union wrapper (`withSchemaColumns`) does not forward it.

So `COUNT(DISTINCT session_id)` and even `COUNT(*)` / `MIN` / `MAX` take the slow
path that buffers the whole input into one group — the exact behaviour that
OOM-crashes the daemon (issue #9). The interface the fast path expects is
small and already typed in squirreling:

```
scanColumn({ column, limit, offset, signal }) -> AsyncIterable<ArrayLike<SqlPrimitive>>
```

an async iterable of column-value chunks.

## Options considered

1. **Implement `scanColumn` on the Iceberg source and the union/schema wrappers**
   so the existing streaming fast path lights up. (Chosen.)
2. **Leave the fast path dormant; rely only on the execution budget**
   ([LLP 0056](./0056-refuse-over-spill-or-truncate.decision.md)) to refuse the
   aggregates that buffer. Rejected: refusing a `COUNT(DISTINCT session_id)` that
   is *trivially* streamable (a few thousand distinct ids) is a bad answer — the
   query is cheap, the engine just wasn't given the column-scan hook. Budget
   alone would force users to filter queries that need no filtering.
3. **Rewrite the aggregate operators to buffer less** in squirreling without a
   column interface. Rejected: duplicates work the dormant fast path already
   does, and column-at-a-time scanning is the right primitive for a columnar
   (Parquet/Iceberg) backend anyway.

## Decision

Implement `scanColumn` end-to-end down the dataset source stack, matching
squirreling's existing `ScanColumnOptions` contract:

- **icebird Iceberg source** — read a single column's values via row-group
  column chunks, yielding chunks as an async iterable; honor `signal`
  (per [LLP 0054](./0054-bounded-query-execution.spec.md) `#signal-threading`).
  This is an upstream change to `github.com/hyparam/icebird`, then a pinned
  version bump in the kernel.
- **core `unionSources`** (`src/core/query/union-source.js`) — forward
  `scanColumn` by **concatenating per-partition column streams**, the same
  non-distributive discipline `unionSources` already applies to row scans:
  `limit`/`offset` are **not** pushed per partition (they are not distributive
  across a concatenation — [LLP 0015](./0015-query-and-datasets.spec.md) "Multi-partition
  union"); the engine re-applies them over the merged column stream.
- **ai-gateway `withSchemaColumns`** — forward `scanColumn`; a partition whose
  physical schema lacks the requested column yields nulls (the same additive
  schema-drift rule `withSchemaColumns` already applies to row reads), never
  throws.

A source that cannot stream a given column may omit `scanColumn` for it; the
engine then falls back to the buffering path, which is now bounded by the
execution budget ([LLP 0056](./0056-refuse-over-spill-or-truncate.decision.md)).
The two are complementary: streaming removes the common aggregate crashers;
the budget backstops whatever still buffers.

## Consequences

- `COUNT(DISTINCT session_id)` and the borderline multi-`DISTINCT` over
  low-cardinality keys → **fixed**: O(cardinality) memory, zero row buffering.
- `COUNT` / `MIN` / `MAX` / `SUM` / `AVG` → **fixed**: O(1)-row memory.
- `COUNT(DISTINCT content_text)` → **partially** improved: no row buffering, but
  the distinct set of ~495k multi-KB strings is inherent to the query's meaning.
  It no longer holds the rows, roughly halving peak, but is not bounded by this
  decision — the execution budget refuses it past the ceiling
  ([LLP 0056](./0056-refuse-over-spill-or-truncate.decision.md)).
- `ORDER BY` and high-cardinality `GROUP BY` are unaffected here — they are not
  scalar aggregates and have no streaming column path; they are bounded by the
  budget, not by this decision.
- New first-party surface (`scanColumn`) on icebird and the core union helper.
  The icebird change is upstream; coordinate the kernel version bump in
  [LLP 0057](./0057-bounded-query-execution.plan.md).

The code sites — icebird's source factory, `union-source.js`, and ai-gateway's
`withSchemaColumns` — carry an `@ref` to this decision when implemented.
