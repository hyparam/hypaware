# LLP 0206: Compaction file size follows bytes written, not the batch estimate

**Type:** Decision
**Status:** Accepted
**Systems:** Cache
**Author:** Kenny / Claude
**Date:** 2026-08-10
**Related:** LLP 0199, LLP 0027

> A compaction batch is a heap bound, not a file bound. Batches flush as
> parquet row groups into an open data file, and the file closes when the bytes
> actually written reach `target_file_bytes` or when the row-group metadata the
> open writer pins reaches its own budget, whichever binds first. File size
> stops being a function of how badly the in-memory estimate mispredicts the
> compressed size. It remains a function of the partition spec: a data file
> cannot span partition tuples.

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
it, encoded page bytes stop being a function of file size.

<a id="retained-metadata"></a>**Holding a file open costs retained row-group
metadata, and that is bounded separately.** `flush()` drains encoded bytes; it
does not touch what `ParquetWriter` accumulates in memory for the footer.
`write()` pushes one `ColumnChunk` per column per row group onto
`row_groups`, and each chunk's `statistics` holds the RAW, untruncated JS
`min_value`/`max_value`. Truncation to 16 units happens at serialization, in
`finish()`. So peak memory is three terms, not two:

    one batch + one row group of encoded bytes
      + (2 x widest value + ~1 KB) x columns x row groups per open file
      x files open at once

Measured against `openStreamingAppend` with one string column and 100 row
groups: 4.4 MB retained at 20 KB values, 27.7 MB at 140 KB, 109.0 MB at 560 KB.
The control, every row sharing one string object, stayed flat at 0.5 MB, which
locates the growth in the retained bounds rather than anywhere else. At the
production shape that motivated this document (~70 KB values, ~0.46 MB written
per row group, 128 MB target, so ~278 row groups), reaching the target would
have pinned ~40 MB per file: more than `compact_batch_bytes` itself, and
multiplied by up to `MAX_OPEN_FILES` (64) concurrently open files.

The third term is therefore capped by a global budget,
`MAX_OPEN_STATS_BYTES` (32 MiB, matching the default `compact_batch_bytes`).
Each row group is charged an upper bound on what it pins - the widest value
per column counted twice, plus a flat ~1 KB per column chunk, measured - and
when the total across all open files reaches the budget, the file holding the
most is closed early. A file therefore rolls on `target_file_bytes` or on the
budget, whichever binds first, and the bound holds regardless of per-value
size, column count, or how many files are open.

The budget is global rather than per-file deliberately. A per-file cap has to
be divided by `MAX_OPEN_FILES` to bound the aggregate, which for fat rows
forces files back down to single-digit megabytes: the defect this document
exists to fix. A global budget is spent on whichever files are actually open,
so a single-tuple rewrite still reaches `target_file_bytes` while a 64-tuple
fan-out rolls earlier.

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
materialization. A declared `JSON` column is not one of those: it maps to
iceberg `variant`, whose parquet form is a two-leaf group that
`hyparquet-writer` encodes from the raw JS value, and `ai_gateway_messages`
declares seven. A second guard checks that icebird's mapping produced exactly
one top-level parquet element per schema field, because `columnData` is
positional and iceberg `unknown` maps to no element at all. Neither guard is
reachable from the cache's declared types today.

## Consequences {#consequences}

- <a id="tuple-bound"></a>Within one partition tuple, a rewrite converges to
  files near `target_file_bytes` (or near the retained-metadata budget, for
  very fat rows) instead of one file per batch. It does NOT reduce the number
  of tuples. A data file cannot span partition tuples, so the file count after
  a rewrite is approximately the number of distinct tuples in the partition,
  and `target_file_bytes` only binds within a tuple.
- That bound is load-bearing for the motivating dataset.
  `ai_gateway_messages` declares identity partitioning on
  `(session_id, conversation_id, cwd, date)`, so a day partition fans out
  across one tuple per session and a per-session file never approaches 128 MB.
  Measured: compacting 600 fat rows with `target_file_bytes: 128 MB` across
  10, 30 and 100 distinct sessions produced 10, 30 and 100 files (1.7 to
  3.0 KB each), independent of `target_file_bytes`. This document fixes
  many-files-per-tuple; it does not collapse a partition whose tuple count is
  already high. Whether production's 230-file day partition shrinks depends on
  how many distinct tuples that day holds, which is a partitioning question
  and not settled here.
- Consequently `compact_avg_file_bytes` can still flag a high-tuple partition
  on its own merits, and LLP 0199's baseline gate remains fully load-bearing
  as the authority on due-ness. It is unchanged.
- Parquet row-group statistics still bound ~one batch of rows, but they now sit
  inside a large file, which is what makes range pruning worth doing.
- A compaction that fails part-way commits nothing rather than a prefix of its
  batches. The half-written generation directory is unreferenced and the orphan
  sweep reclaims it, which is what already happened to a crashed compaction.
  Because the rewrite now holds writers open across the whole scan rather than
  finishing one per batch, the sink also exposes `abort()`, and
  `compactGeneration` calls it in a `finally`: otherwise a partition that
  throws on every tick leaks up to `MAX_OPEN_FILES` descriptors and `.tmp.*`
  files per tick.
- `compact_batch_bytes` no longer changes file sizes. It still changes peak
  heap and statistics granularity, and it now sets the scale of the
  retained-metadata budget it is matched to.

## Extends {#extends}

LLP 0199 named "batches flush on estimated in-memory bytes" as the reason
compacted files are far below `compact_avg_file_bytes`, and gated compaction
due-ness on a recorded baseline so that fact could not cause infinite
recompaction. This document removes that particular reason. It does not
remove the need for the gate: a partition with many distinct partition tuples
still compacts to many small files (see [Consequences](#tuple-bound)), so
`compact_avg_file_bytes` can still flag an already-converged partition and
LLP 0199's baseline remains the authority on due-ness.
