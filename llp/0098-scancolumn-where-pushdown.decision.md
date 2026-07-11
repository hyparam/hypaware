# LLP 0098: Push WHERE Through `scanColumn` So Filtered Aggregates Stay Streaming

**Type:** Decision
**Status:** Accepted
**Systems:** Query, Cache
**Author:** Phil / Claude
**Date:** 2026-07-11
**Related:** LLP 0054, LLP 0055, LLP 0056, LLP 0097

> Extends [LLP 0055](./0055-stream-aggregates-via-scancolumn.decision.md): the
> column-stream hook now carries the row predicate and reports applied-hint
> flags, so a filtered `COUNT` keeps the streaming fast path instead of
> falling back to per-row materialization.

## Context

LLP 0055 lit the engine's streaming-aggregate fast path by implementing
`scanColumn` down the source stack, but the hook's contract carried no
`where`. Any filtered aggregate therefore fell off the fast path entirely:
the engine took the row scan, materialized an `AsyncRow` per row, and applied
the predicate itself. On the production remote (~489k rows), an unfiltered
`COUNT(*)` answered from metadata in ~0.5s while the same count with ANY
predicate took 30 to 47 seconds; a query stacking three filtered subqueries
exceeded the gateway timeout and knocked the daemon over. The cost was per-row
materialization plus engine-side filtering, not missing file pruning.

Squirreling 0.15.0 extended the contract: `ScanColumnOptions` gains
`where`, and a source may return `ScanColumnResults` (`chunks()` plus
`appliedWhere` / `appliedLimitOffset`, the same hint-flag discipline `scan()`
has always had) instead of a bare `AsyncIterable`. The engine normalizes
legacy bare-iterable sources at its boundary (a legacy source can never claim
a predicate it predates), re-filters the value stream when `appliedWhere` is
false, and treats the flags as load-bearing: a source must never apply
`limit`/`offset` to a stream whose predicate it did not fully apply, because
a pre-filter slice silently drops matching values.

icebird 0.8.14 implements the source end: `scanColumn` converts the
predicate via `whereToParquetFilter`, prunes whole data files by partition
tuple and manifest bounds, hands the filter to hyparquet for row-group and
per-row matching, and reports `appliedWhere` honestly (an unconvertible
predicate such as `LIKE` or a function call leaves `appliedWhere: false` and
the engine re-filters).

That leaves the kernel's three wrapper layers, which all consumed the old
bare-iterable shape and forwarded no predicate:

- the storage wrapper (`src/core/cache/storage.js`), a verbatim passthrough;
- the core union (`src/core/query/union-source.js`);
- the ai-gateway schema padding (`withSchemaColumns` in
  `hypaware-core/plugins-workspace/ai-gateway/src/dataset.js`);
- plus the heap-budget decoration (`withHeapBudget` in
  `src/core/query/sql.js`, LLP 0097), which re-yields every chunk.

Any wrapper that iterates its inner source's return directly breaks at
runtime once icebird returns the flagged shape, so this was not optional
plumbing: the version bump forces the wrappers to speak the new contract.

## Options considered

1. **Forward `where` and the flags through every wrapper** (chosen).
2. **Wrappers unwrap `ScanColumnResults` back to a bare iterable** and keep
   reporting nothing. Rejected: the engine would re-filter every stream
   (wasting icebird's honest `appliedWhere`), and a wrapper that discards
   flags invites the pre-filter-slice bug the flags exist to prevent.
3. **Drop the kernel `scanColumn` wrappers and let the engine fall back to
   row scans when a predicate is present.** Rejected: that is exactly the
   30-to-47-second path this work removes; LLP 0055's memory bounds would
   survive but its latency win would not extend to filtered aggregates.

## Decision

Every kernel wrapper that consumes an inner `scanColumn` goes through one
shim, `normalizeScanColumn` (`src/core/query/scan-column.js`, exported from
`hypaware/core/query`), mirroring the engine's boundary rule: a legacy
bare-iterable source is valid only for unfiltered scans and can claim
`appliedWhere` / `appliedLimitOffset` only when no predicate was requested.

### <a id="wrapper-duties"></a>Wrapper duties

Each layer forwards `where` exactly as far as it can prove it is safe, and
reports honestly when it could not:

- **Storage wrapper**: verbatim passthrough of options and result. Internal
  fields are not advertised, so neither the scanned column nor a predicate
  column can name one; there is nothing to gate.
- **Heap budget** (`withHeapBudget`): normalizes the inner result, passes
  both flags through untouched, and re-yields chunks with the inline
  `guard.check()` (LLP 0097). A dropped flag here would be invisible to an
  honest source (re-filtering already-matching values is idempotent), so its
  test uses a deliberately lying source to prove the flags survive.
- **ai-gateway `withSchemaColumns`**: a predicate naming a DECLARED but
  physically absent column (additive schema drift, LLP 0032) is stripped
  before it reaches a parquet-backed source, which throws on a filter column
  it cannot find. Stripping the predicate also strips `limit`/`offset` (they
  are only meaningful post-filter) and reports `appliedWhere: false`; the
  engine then filters over the null-normalized stream, where `IS NULL` reads
  the absent column correctly.

### <a id="union-flags"></a>Union flag merging

The union forwards the predicate per partition under the same schema gate as
its row path (a partition lacking a predicate column gets no filter rather
than a throw), and its `appliedWhere` is the AND across partitions: one
unfiltered partition means the engine must re-judge the whole merged stream,
which is safe because re-filtering values that already matched is a no-op.

`limit`/`offset` never coexist with a forwarded `where`. Without a
predicate, the union owns them over the CONCATENATED stream exactly as
before (they are not distributive across partitions, LLP 0015), pushing only
the remaining-need upper bound per partition. With a predicate, they are
neither forwarded nor applied and `appliedLimitOffset` is false: a partition
that ignored the predicate but honored a slice would silently drop matching
values, the exact failure the contract's "no limit/offset over an unapplied
where" rule exists to prevent.

## Consequences

- A filtered single-column aggregate (`SELECT COUNT(*) ... WHERE col ...`)
  stays on the streaming fast path end to end: icebird prunes files, hyparquet
  filters row groups and rows, and the engine trusts the stream instead of
  materializing rows. This removes the timeout class that took down the
  remote daemon.
- An unconvertible predicate degrades gracefully: the source streams the
  column, reports `appliedWhere: false`, and the engine filters values (still
  no row materialization).
- Kernel pins move to squirreling 0.15.0 and icebird 0.8.14 together; the
  wrappers do not compile against older icebird return shapes.
- Third-party plugin sources with legacy `scanColumn` implementations keep
  working through `normalizeScanColumn`, at unfiltered-scan fidelity.
- With a `where`, the union probes every partition's `scanColumn` up front
  (the merged flags must be returned synchronously, and the AND needs all of
  them), giving up the no-where branch's lazy sequential opens. This is
  O(partitions) synchronous work per filtered scan and rests on a convention
  the contract does not type: `scanColumn()` itself must be cheap, deferring
  all IO to `chunks()`. Icebird honors this (flags come from already-loaded
  manifest entries) and squirreling's engine makes the same eager call, but a
  plugin source that starts IO at call time pays that cost once per partition
  even when its chunks are never consumed. The lazy alternative (report
  `appliedWhere: false` pessimistically, open partitions on demand) was
  rejected: it forfeits engine trust on every filtered aggregate, trading a
  cost that scales with partition count for per-value re-filtering that
  scales with row count. If partition counts ever make the probe measurable,
  compaction is the lever, not scan wiring.
- New public surface on `hypaware/core/query`: `normalizeScanColumn`,
  `canPushWhere`, `whereColumns`, so plugin-side wrappers can apply the same
  discipline without reimplementing predicate-column enumeration. A plugin
  source implementing flagged `scanColumn` must follow the defer-IO rule
  above: compute flags synchronously, start IO only in `chunks()`.
