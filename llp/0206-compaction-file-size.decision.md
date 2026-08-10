# LLP 0206: Compaction file size follows bytes written, not the batch estimate

**Type:** Decision
**Status:** Accepted
**Systems:** Cache
**Author:** Kenny / Claude
**Date:** 2026-08-10
**Related:** LLP 0199, LLP 0027

> A compaction batch is a heap bound, not a file bound. Batches flush as
> parquet row groups into an open data file, and the file closes only when the
> bytes actually written reach `target_file_bytes`. Peak heap stays one batch;
> file size stops being a function of how badly the in-memory estimate
> mispredicts the compressed size.

## Context {#context}

`compactGeneration` flushed a batch to its own data file whenever the batch
reached `COMPACT_BATCH_SIZE` (10k) rows or `compact_batch_bytes` (32 MB) of
*estimated in-memory* bytes. The byte cap is a real OOM guard: a fat
denormalized column (tool definitions repeated on every row) pushes a 10k-row
batch into the gigabytes and kills the daemon mid-compaction.

Coupling the file boundary to that guard made `target_file_bytes` (128 MB)
unreachable by construction. An `ai_gateway_messages` row estimates ~140 KB in
memory and compresses roughly 70x in parquet, so the guard fired after ~230
rows and produced a ~0.5 MB file. Observed on the production central server
(2026-08-10): a 52,329-row day partition rewritten into 230 files, 463 KB
average, and every compacted partition looking the same (~0.5 MB across 789
live files / 409 MB).

Two consequences followed. The `compact_avg_file_bytes` heuristic (32 MB) would
re-flag every compacted partition forever, so LLP 0199's baseline gate was the
only thing standing between the deployment and infinite recompaction; before
that gate landed, production had rewritten the same partitions 29 to 51 times.
And parquet min/max statistics stayed scoped to ~230-row files, so the pruning
a sorted rewrite is supposed to buy never materialized in the cache tier.

Feeding compressed-bytes back into the batch sizer (predict the file size from
a running compression ratio, flush when the prediction reaches the target) does
not fix this. At 70x, a 128 MB output file needs ~9 GB of rows resident. Any
scheme that keeps one file per flush must choose between the OOM guard and the
file target; the two bounds have to be decoupled.

## Decision {#decision}

<a id="row-groups"></a>**A flush is a row group, not a file.** The batch caps
(`COMPACT_BATCH_SIZE` rows, `compact_batch_bytes` estimated bytes) are
unchanged and keep their meaning: they bound how many rows are resident at
once. What changes is where the flushed rows go. `openStreamingAppend` keeps
one parquet writer open per partition tuple; each flush encodes the batch as
one row group and appends it to that writer. The file is closed, and a new one
opened, only once `writer.offset` (bytes actually written) reaches
`target_file_bytes`. All of the rewrite's files commit as a single Iceberg
snapshot, so a compaction now also costs one metadata commit instead of one per
batch.

The local Iceberg writer implements `hyparquet-writer`'s optional `flush()`
hook, which is called after every row group: buffered bytes are appended to the
temp file and the in-memory buffer resets. Without it, a 128 MB output file
would be a 128 MB allocation and the heap bound would simply have moved. With
it, peak memory is one batch plus one row group of encoded bytes, whatever the
final file size.

Row groups are sorted individually (as batches always were), so a multi-row-
group file is a concatenation of sorted runs rather than a globally sorted
file. Such a file records `sort_order_id: 0`: claiming the table's sort order
for it would be a lie a reader could act on. A file that happens to hold a
single row group still claims the order.

<a id="schema-probe"></a>**The parquet schema comes from icebird, not from a
copy of it.** Writing row groups directly needs the parquet `SchemaElement[]`
that icebird's iceberg-to-parquet mapping produces (field ids, logical types,
decimal widths). That mapping is private to icebird, and a hand-rolled copy
would drift silently the first time icebird changed it. Instead the cache
writes a zero-record parquet file to an in-memory buffer with icebird's own
`writeParquet` and reads the schema back out of the footer: one tiny encode per
compaction, exact by construction. Everything else on the commit path
(manifest, snapshot, metadata commit) is icebird's, reached through the
`icebird/src/*.js` deep imports the cache already relies on.

Tables with nested (list/map/struct) columns fall back to the previous
one-file-per-batch path, because nested values need icebird's private default
materialization. The intrinsic cache only ever declares primitives, so this is
a guard rather than a live path.

## Consequences {#consequences}

- A compacted partition converges to a handful of files near
  `target_file_bytes`, so `compact_avg_file_bytes` stops re-flagging it on its
  own merits. LLP 0199's baseline gate is unchanged and still the authority on
  due-ness; it is no longer load-bearing against a heuristic that could never
  be satisfied.
- Parquet row-group statistics still bound ~one batch of rows, but they now sit
  inside a large file, which is what makes range pruning worth doing.
- A compaction that fails part-way commits nothing rather than a prefix of its
  batches. The half-written generation directory is unreferenced and the orphan
  sweep reclaims it, which is what already happened to a crashed compaction.
- `compact_batch_bytes` is now purely a memory knob. Tuning it changes peak
  heap and statistics granularity, and no longer changes file sizes.

## Extends {#extends}

LLP 0199 named "batches flush on estimated in-memory bytes" as the reason
compacted files are far below `compact_avg_file_bytes`, and gated compaction
due-ness on a recorded baseline so that fact could not cause infinite
recompaction. That gate stands. This document removes the fact it was
compensating for.
