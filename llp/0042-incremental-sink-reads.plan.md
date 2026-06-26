# LLP 0042: Incremental sink reads — plan

**Type:** plan
**Status:** Active
**Systems:** Sinks, Cache
**Author:** neutral
**Date:** 2026-06-25
**Generated-by:** neutral
**Related:** LLP 0040

> Implementation plan refining [LLP 0040](./0040-incremental-sink-reads.design.md)
> (which answers the spec in [LLP 0039](./0039-incremental-sink-reads.spec.md))
> into small, independently-mergeable tasks. The design's chosen shape — a
> row-resident monotonic `_hyp_ingest_seq` int64 watermark, a `since`/continuation
> extension to `QueryStorageService.readRows`, and a per-`(sink instance, partition)`
> watermark keyed by the **logical** partition path — decomposes cleanly along the
> producer → read-API → persistence → consumer seam.

@ref LLP 0040 — incremental sink reads design

## How the work splits

The design has one hard ordering: **a value must be produced before it can be
read, and the read surface must exist before a sink can consume it.** Everything
else parallelizes. The seam is:

1. **Producer (T1).** Stamp the monotonic `_hyp_ingest_seq` at the single kernel
   write chokepoint (`decorateRow` in `src/core/cache/streaming-reader.js`, fact 3
   of the design) and add it as a hidden, nullable, additive int64 column. This is
   self-contained and back-compatible: nothing reads the column yet, and
   `INTERNAL_FIELDS` already strips it from every existing `readRows` consumer, so
   it merges with zero behavioural change. The delicate part the design flags
   (risk #2) lives entirely here: a crash/resume-safe allocator that **never goes
   backwards**, reserving seq blocks durably in `cursor.json` (`nextSeq`,
   reserve-before-stamp) so a resumed flush never re-issues a seq `≤` one already
   exported.

2. **Read API (T2).** Extend the kernel storage contract
   (`collectivus-plugin-kernel-types.d.ts` decl; `src/core/cache/storage.js` impl;
   predicate pushed through `scanRowsFromTable` in `src/core/cache/iceberg/store.js`).
   Adds a back-compatible `opts.since` to `readRows` plus the cursor-aware
   `readRowsSince` sibling that pairs each internal-stripped row with its `after`
   token. `opts` absent ⇒ byte-for-byte identical to today, so every current caller
   (forward sink, local-fs/s3, format-iceberg, ai-gateway projector & dataset,
   vector-search, backfill, query) is untouched until it opts in. This task also
   owns the **null-seq migration contract** (design risk #1): a row whose seq is
   null (pre-upgrade) is treated as **new** — emitted, never skipped — so the
   upgrade is at worst a one-time full re-export, never silent data loss.

3. **Persistence (T3).** A small per-`(sink instance, partition)` watermark store
   under the sink plugin's `PluginPaths.stateDir`
   (`<stateDir>/watermarks/<dataset>/<partition-key>.json`), keyed by the **stable
   logical partition path** (relative to `cacheRoot`, sanitized as in
   `state.js`'s `sanitizeSegment`) — never the physical `tableDir`. This keying is
   the hinge of design constraint (B): it reads straight through a compaction
   generation swap. Atomic write-rename, like `writeCursor`/`writeProgress`.

4. **Consumers (T4, T5).** Two disjoint wirings, parallelizable against each
   other once T2+T3 land:
   - **Forward sink** (`hypaware-core/plugins-workspace/central/src/sink.js`,
     `forwardPartition`): swap the full `readRows(tablePath)` loop for
     `readRowsSince({ since })`; advance the watermark **once, at end-of-partition**
     (after every chunk acks), to the partition's high-water `after` token — never
     per-chunk, because the scan is not seq-ordered so a per-chunk advance to the
     running-max `after` could skip lower-seq rows in a later un-acked chunk
     (design §3/§4). The existing `MAX_CHUNK_ROWS`/`MAX_CHUNK_BYTES` chunking, the
     `batchIdForChunk` derivation (keyed by chunk **start seq**, stable across a
     respool), and the `Retry-After` backpressure loop (LLP 0014) are untouched;
     a partial partition does not checkpoint, so a failure re-reads the whole
     partition and the server ledger dedupes the already-acked prefix.
   - **Core blob sink** (`src/core/sinks/materialize.js` →
     `local-fs`/`s3` destination `index.js` → `src/core/sinks/encoder.js`): feed
     `readRowsSince({ since })` into the unchanged `encodePartition` contract; an
     empty new-row set writes **no blob**; embed the `[sinceSeq, lastSeq]` range in
     the output filename so a crash-retry re-PUTs the **same object key**
     (idempotent overwrite — the blob sink's stand-in for the server ledger);
     advance the watermark after the durable PUT.

5. **Proof (T6).** Exactly-once acceptance across the two cache rewrites that
   make this hard — retention front-prune and compaction generation swap — for
   **both** sinks, plus the watermark/outbox-respool composition (design risk #6).

The `format-iceberg` sink is out of scope (it already has destination-side
idempotency); the server idempotency ledger is **retained** as the in-flight
retry net, now backstopping a bounded suffix rather than the whole partition.

## Dependency rationale

- **T2 → T1**: the `since` filter and `readRowsSince`'s `after` token can only be
  written and tested once the seq column is produced and stamped.
- **T3 → T2**: the watermark file persists a `SinkContinuation`, the token type
  the read API introduces.
- **T4, T5 → T2, T3**: each sink needs both the cursor-aware read surface (T2)
  and the persisted watermark (T3); the two sinks touch disjoint files and merge
  independently.
- **T6 → T4, T5**: the exactly-once proof exercises both wired sinks end to end.

## Tasks
- id: T1  branch: task/incremental-sink-reads/T1  deps: []        -- Stamp internal nullable int64 `_hyp_ingest_seq` at the `decorateRow` flush chokepoint via a crash-safe never-regressing allocator (cursor.json `nextSeq`, reserve-before-stamp); add to `INTERNAL_FIELDS`; additive nullable schema that rides compaction verbatim
- id: T2  branch: task/incremental-sink-reads/T2  deps: [T1]       -- Extend storage read contract: back-compat `readRows(...,opts.since)` + cursor-aware `readRowsSince` emitting `{row, after}`; push `seq>since` predicate through `scanRowsFromTable`/icebird with yielded-row fallback; null-seq = new (one-time migration, never skipped); update kernel-types decl
- id: T3  branch: task/incremental-sink-reads/T3  deps: [T2]       -- Persisted per-(sink instance, partition) watermark store under sink `stateDir/watermarks/<dataset>/<partition-key>.json`, keyed by the stable LOGICAL partition path (not `tableDir`); atomic write-rename
- id: T4  branch: task/incremental-sink-reads/T4  deps: [T2, T3]   -- Wire central forward sink (`forwardPartition`) to `readRowsSince({ since })`; advance watermark ONCE at end-of-partition (every chunk acked) to the high-water `after`, never per-chunk (unordered scan would skip lower-seq rows in a later un-acked chunk); chunking/backpressure/`batchIdForChunk` (keyed by chunk start seq) unchanged; server ledger dedupes the re-read prefix on failure
- id: T5  branch: task/incremental-sink-reads/T5  deps: [T2, T3]   -- Wire core blob sink (local-fs + s3 destinations) to `readRowsSince({ since })`; skip empty new-row set (no blob); embed `[sinceSeq,lastSeq]` in filename for idempotent re-PUT; advance watermark after durable PUT
- id: T6  branch: task/incremental-sink-reads/T6  deps: [T4, T5]   -- Exactly-once acceptance tests/smoke across retention front-prune + compaction generation swap for both sinks; assert ≈0 bytes on no-new-rows and ≈N on N-new; cover watermark vs. driver-outbox respool composition
