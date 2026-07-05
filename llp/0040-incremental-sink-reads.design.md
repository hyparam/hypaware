# LLP 0040: Incremental sink reads — design

**Type:** design
**Status:** Active
**Systems:** Sinks, Cache
**Author:** neutral
**Date:** 2026-06-25
**Generated-by:** neutral
**Related:** LLP 0039, LLP 0013, LLP 0014

> Technical design covering the request in [LLP 0039](./0039-incremental-sink-reads.spec.md):
> give the central **forward** sink and the core **blob** sink a per-sink
> watermark so each tick reads and ships only rows added since its last
> successful export, surviving both retention front-prunes and compaction
> generation swaps.

@ref LLP 0039 — incremental sink reads requirement

## Ground truth this design is built on

Three facts from the code shape every decision below:

1. **The driver re-hands the whole partition set every tick, with a fresh
   batch id.** `createSinkDriver.runSink` (`src/core/sinks/driver.js`) calls
   `discoverReadyPartitions` (every partition for the sink's datasets, scope
   limit 1000) and mints `nextBatchId = instance-<iso>-<seq>` per tick. So
   nothing batch-id-keyed can be a *cross-tick* cursor — a cross-tick cursor
   must be keyed by `(sink instance, partition)` and persist outside the batch.

2. **The cache rewrites partitions out from under any positional reference.**
   - *Retention* (`src/core/cache/retention.js`) position-deletes the oldest
     rows of each source table via `icebergDelete`, producing a new delete
     snapshot on the *same* linear lineage. Data files and their physical row
     positions are untouched; the visible set shrinks **from the front**.
   - *Compaction* (`src/core/cache/maintenance.js` → `compactSourceTable`)
     rewrites the whole partition into a **brand-new table directory**
     (`table-<seq>/`, or `epoch=<N+1>/` on the legacy layout) with a **fresh
     Iceberg snapshot lineage**, then repoints `cursor.json.tableDir`. Iceberg
     stores absolute `file://` URLs, so the directory can't be renamed and the
     new lineage has **no ancestry link** to the old one. Row values are copied
     verbatim; dedup only drops exact `_hyp_cache_row_id` matches.

   The **logical partition directory** (`<cacheRoot>/datasets/<dataset>/source=<source>/`,
   i.e. `partition.tablePath`) is **stable** across both — only the `tableDir`
   inside it changes on compaction.

3. **Every cache row already passes one kernel write chokepoint.**
   `decorateRow` (`src/core/cache/streaming-reader.js`) stamps
   `_hyp_cache_row_id` (a content SHA-256, preserved through compaction and used
   as the compaction dedup key) and `_hyp_cache_batch_id` on every flushed row,
   and both are listed in `INTERNAL_FIELDS` so they never leak to query output
   or to `readRows` consumers.

## 1. Watermark shape decision

Two **hard** constraints from the spec, plus one cost constraint the acceptance
criteria add:

- **(A)** survives a retention front-prune,
- **(B)** survives a compaction generation swap,
- **(C)** a tick reads ≈ *N* rows for *N* new rows — bounded reads, not just
  bounded sends (acceptance: "reads/sends ≈N rows, independent of total
  partition size").

### Candidate A — snapshot ancestry, as `format-iceberg` does it

What it actually is today: the iceberg sink's marker
(`format-iceberg/src/state.js`, `markerSubsumedBySnapshot`) is keyed by
`(prefix, sink, dataset, batchId)` and records the **destination archive**
snapshot id; the ancestry walk proves "this batch already committed into the
archive" so a respool doesn't double-append. It is **destination-side,
batch-id-scoped retry idempotency** — not a source-read cursor.

Why it does not generalize to the forward/blob source-read problem:

- It is batch-id-keyed, and batch ids are minted fresh per tick (fact 1), so it
  can never match across ticks — exactly the cross-tick reuse we need.
- Even reframed as "remember the last *source* snapshot exported and
  incrementally scan files appended since it": that survives retention (A —
  delete-only, linear lineage) but **fails (B)**. Compaction starts a fresh
  lineage, so the recorded snapshot id is absent from the new table's metadata;
  `markerSubsumedBySnapshot` would correctly judge it stale and fall back to a
  **full re-read after every compaction** — and compaction fires on routine
  file-count thresholds. Rejected on (B).

### Candidate B — monotonic per-row ingest sequence column (**recommended**) {#ingest-seq-column}

Add a kernel-assigned, append-monotonic `int64` column `_hyp_ingest_seq`,
stamped at the same chokepoint as `_hyp_cache_row_id` (fact 3) and carried as an
ordinary **internal** (hidden) Iceberg column. The watermark for a
`(sink, partition)` is the highest seq it has durably exported; an incremental
read yields rows with `seq > watermark`.

- **(A)** Retention deletes the lowest-seq rows, all already `< watermark`; a
  strict `> watermark` filter never looks at them. No skip, no dup. **Pass.**
- **(B)** The seq is a **row-resident value**, so the compaction rewrite copies
  it verbatim into the new generation. The watermark is keyed by the **logical
  partition path** (stable; fact 2), not by snapshot id or physical position, so
  it reads straight through the `tableDir` swap. **Pass.**
- **(C)** A strict `seq > watermark` predicate emits only the *N_new* rows.
  **As built, the predicate is a yielded-row filter** over the partition's
  current snapshot (see §2): the scan still visits every surviving row, so a tick
  reads ≈ the *surviving-partition* size, not ≈*N_new*. Retention front-prunes
  already-exported rows, so "surviving" is bounded and shrinks — reads do not grow
  with total history — but the stronger O(*N_new*) bound is **not yet delivered**.
  A numeric `min/max` column statistic *can in principle* let icebird skip whole
  data files whose `max(seq) ≤ watermark` (seq correlates with append order, and
  numeric stats dodge the string-stats truncation hazard); landing that
  null-aware file/row-group pushdown is a **follow-up optimization** that layers
  on without changing the read contract. **Partial (bounded by surviving
  partition, pending icebird pushdown).**

It is the **only** shape that meets (A) and (B) and is the right basis for (C):
row-resident (survives every cache rewrite), totally ordered (a strict `>` is
exactly-once), and stats-prunable *once icebird gains null-aware seq pushdown*.

### Candidate C — content-addressed continuation (seen-set over `_hyp_cache_row_id`)

Persist the set of exported row ids; skip any row already in it.

- Correct across (A) and (B) — the row id is preserved through compaction.
- But **fails (C)**: to decide which ids are new you must scan the **whole**
  partition every tick (O(*N*) read per tick → O(*N·K*) cumulative; only the
  *send* shrinks), and the id set grows unboundedly (needs GC coupled to
  retention). Rejected on cost.

### Decision

**Recommend Candidate B — a monotonic `_hyp_ingest_seq` watermark.** The
mechanism iceberg proves (snapshot ancestry) is destination-side, batch-scoped,
and does not survive a source compaction; the content-addressed set is correct
but cannot meet the bounded-read goal even in principle. A row-resident,
totally-ordered, stats-prunable sequence clears (A) and (B) outright and is the
only shape that can also reach the O(*N_new*) bound (C) once icebird gains
null-aware seq pushdown; until then it bounds reads by the surviving-partition
size (full scan emitting *N_new*), which is the same correctness with a weaker
cost guarantee.

## 2. Storage API extension {#storage-api-extension}

`QueryStorageService.readRows` today
(`hypaware-plugin-kernel-types.d.ts`, impl in `src/core/cache/storage.js`):

```ts
readRows(tablePath: string, columns?: string[]): AsyncIterable<Record<string, unknown>>
```

Extend with an optional, **back-compatible** third argument and add a
cursor-aware sibling:

```ts
interface SinkContinuation { v: 1; seq: string }      // int64 as decimal string
interface ReadRowsOptions  { since?: SinkContinuation }

readRows(tablePath: string, columns?: string[], opts?: ReadRowsOptions):
  AsyncIterable<Record<string, unknown>>

// cursor-aware surface for sinks that must advance a watermark
readRowsSince(tablePath: string, opts: { since?: SinkContinuation, columns?: string[] }):
  AsyncIterable<{ row: Record<string, unknown>, after: SinkContinuation }>
```

- **Back-compat:** `opts` absent ⇒ identical to today (full scan). Every current
  caller — `central/sink.js`, `local-fs`, `s3`, `format-iceberg`,
  `ai-gateway` projector & dataset, `vector-search`, backfill, and the query
  `dataSourceForTable` path — passes nothing and is byte-for-byte unchanged.
- **`since` semantics:** yields only rows with `_hyp_ingest_seq > since.seq`.
  The token is **opaque and versioned** so the mechanism can change later
  without invalidating persisted watermarks; `seq` is a decimal string to dodge
  bigint/JSON hazards (the column is int64).
- **Why a sibling, not just a filter:** `_hyp_ingest_seq` is an `INTERNAL_FIELD`
  stripped from output, so a sink reading `readRows` cannot learn the high-water
  seq to persist. `readRowsSince` pairs each clean (internal-stripped) row with
  the `after` token to store *once this row is durably shipped*. Internally both
  share one scan; the kernel reads `_hyp_ingest_seq`, emits the token, then
  strips it — so the seq never reaches the wire payload or query results.
- Implementation point: both route through `scanRowsFromTable`
  (`src/core/cache/iceberg/store.js`), which already projects columns over the
  latest snapshot; `since` becomes a predicate (ideally pushed to icebird as a
  `seq > x` file/row-group skip, falling back to a yielded-row filter).

## 3. Persisted watermark contract {#watermark-contract}

- **One watermark per `(sink instance, partition)`.** Stored under the sink
  plugin's `PluginPaths.stateDir` (the kernel already threads `ctx.paths` to
  request sinks and to blob writer/destination ctx in
  `src/core/sinks/materialize.js`):

  ```text
  <stateDir>/watermarks/<dataset>/<partition-key>.json
  { "v": 1, "continuation": { "v": 1, "seq": "<int64>" },
    "exportedRowCount": <n>, "updatedAt": "<iso>" }
  ```

- **`partition-key` is the LOGICAL partition identity**, derived from
  `partition.tablePath` relative to `cacheRoot` (the `source=<source>` segments),
  **never** the physical `tableDir`. This is the hinge of constraint (B): the
  logical path is stable, the `tableDir` is not. Segments are sanitized as in
  `state.js`'s `sanitizeSegment`.
- **Local for both sinks.** The watermark tracks progress reading the *local*
  cache, so it lives on local disk even when the blob destination is S3. (The
  iceberg sink's destination-side marker is a separate concern and stays where
  it is.)
- **Advances only after a successful, durable export, ONCE per partition:**
  - forward sink — after **every** chunk of the partition has been acked
    (`202`/`2xx`), advance to the partition's high-water `after` token (the last
    row read). The advance is **end-of-partition, never per-chunk**: the scan is
    not seq-ordered (§4 risk #3), so `after` is a running max — a chunk that
    physically precedes a lower-seq chunk would, if checkpointed, advance the
    watermark past rows still un-acked in a later chunk and skip them forever on a
    between-chunk failure. A partial partition therefore never checkpoints; a
    crash/failure re-reads the whole partition next tick and the server ledger
    dedupes the already-acked prefix (stable per-chunk batch ids, §4).
  - blob sink — after the encoded blob is durably PUT, advance to the `after`
    token of the **last row in that blob**.
- **Crash-safety:** atomic write-rename (the `writeCursor` / `writeProgress`
  idiom). **Invariant: ship/PUT first, advance watermark second.** A crash
  between the two re-exports a bounded suffix next tick (at-least-once); §5
  shows dedup makes it exactly-once.

## 4. Applying it to both sinks {#applying-it-to-both-sinks}

**Forward sink** (`hypaware-core/plugins-workspace/central/src/sink.js`,
`forwardPartition`): load the continuation for `(instance, partition-key)`;
replace

```js
for await (const row of storage.readRows(tablePath)) { … }
```

with

```js
for await (const { row, after } of storage.readRowsSince(tablePath, { since })) { … }
```

keep the existing `MAX_CHUNK_ROWS` / `MAX_CHUNK_BYTES` chunking and the
backpressure/`Retry-After` loop (LLP 0014) untouched; once **every** chunk is
acked, persist the partition's high-water `after` as the new watermark
(end-of-partition, never per-chunk — see §3). The
`batchIdForChunk(signal, tablePath, chunkStartSeq, body)` derivation keys each
chunk by the **seq it starts after** (the prior chunk's `after`, or `since` for
the first chunk) plus its bytes — **not** a per-tick `chunkIndex` ordinal. Keying
on the start seq keeps an id stable across a watermark advance: a respool
re-reads from the (unchanged) watermark, reproduces the same `[startSeq, body]`,
and so the same id, so the server ledger (server LLP 0001) dedupes the redelivered
prefix. An ordinal would re-number the suffix from 0 after an advance and mint a
fresh id for an already-stored chunk, double-storing it. With nothing new, the
`since` filter yields zero rows → zero chunks → 0 bytes.

**Core blob sink** (`src/core/sinks/materialize.js` → destination
`local-fs`/`s3` `index.js` → `src/core/sinks/encoder.js`): the destinations feed
`storage.readRows(partition.tablePath)` into `encodePartition`. Switch them to
load the continuation and read via `readRowsSince({ since })`, feeding the clean
row stream into the unchanged `encoder.encodePartition` contract; after the blob
is PUT, advance the watermark to the blob's last `after`. An empty new-row set
writes **no blob** (skip, 0 bytes). The output filename embeds the
`[sinceSeq, lastSeq]` range so a crash-retry re-PUTs the **same object key**
(idempotent overwrite) — the blob sink's stand-in for the server ledger.

The `format-iceberg` sink is unchanged (it already has destination-side
idempotency); it may later adopt the same source watermark to bound its reads,
but that is out of scope. The **server idempotency ledger is retained** as the
in-flight retry net (spec requirement); it now backstops only a bounded suffix
instead of the whole partition.

## 5. Exactly-once argument {#exactly-once-argument}

- **No new rows.** `readRowsSince(since=watermark)` yields nothing → forward
  sends 0 chunks; blob writes no file. Watermark unchanged. ≈0 bytes.
  *(acceptance 1)*
- **N new rows.** Exactly the rows with `seq > watermark` are yielded and
  shipped (≈*N* sent, independent of total history). As built the read **scans
  the surviving partition** and filters to *N* (a yielded-row filter, §2/§1(C));
  file-level `max(seq) ≤ watermark` pruning to make the *read* ≈*N* is a pending
  icebird-pushdown optimization. The watermark advances to `max(seq)`.
  *(acceptance 2 — sends bounded now; reads bounded by surviving partition,
  O(N_new) reads pending pushdown)*
- **Across a retention prune.** The prune deletes only rows with `seq` far below
  the watermark (already exported). A `> watermark` read is blind to them — no
  skip, no dup. *(acceptance 3a)*
- **Across a compaction generation swap.** The seq rides the row into the new
  `tableDir`; the watermark is keyed by the stable logical partition path; the
  read filters `> watermark` over the new generation and yields the same
  survivors. Compaction dedup can only remove exact `_hyp_cache_row_id`
  duplicates, which were never two distinct un-exported rows. No skip, no dup.
  *(acceptance 3b)*
- **Mid-batch retry.** The watermark advances only after a durable export
  completes (forward: every chunk acked, end-of-partition; blob: blob PUT), so a
  crash leaves it at the last *fully* exported seq. The next tick re-reads from
  there — the forward sink re-streams the whole partition and the server ledger
  dedupes the already-acked chunks (stable `chunkStartSeq` batch ids); the blob
  sink re-PUTs the same `[sinceSeq,lastSeq]` object key (idempotent overwrite).
  *(acceptance 4)*
  - **Known gap (not yet closed):** if a chunk/blob commits, its watermark write
    is then lost (crash in the PUT→advance window), **and new rows append before
    the retry**, the resumed export reads from the old watermark and the in-flight
    unit grows past what committed: the forward sink's last partial chunk gets a
    new body → new batch id → the server stores it alongside the committed one;
    the blob sink's range grows → `S.<since>-<lastA>` and `S.<since>-<lastB>` both
    land. The dedup nets (server ledger / seq-range filename) assume the retry
    reproduces the *identical* unit, which later arrivals break. Closing this
    needs the in-flight upper bound persisted as a pre-commit intent so the retry
    caps its read at the committed `lastSeq` (a read `until` bound + a pending
    intent record). Tracked as risk #7 (§6).

## 6. Risks / open questions for review

1. **Pre-upgrade rows have a null `_hyp_ingest_seq`. (RESOLVED.)** A sink with
   **no durable watermark** treats null-seq rows as "new" (one full backlog
   export, `readRowsSince`/`readRows` default `includeLegacy: true`); once it has
   a watermark it passes `includeLegacy: false`, so the backlog is re-exported
   **exactly once** instead of on every tick (which also dodges duplicates after
   a compaction reorders the body). This is safe because no NEW null-seq row can
   appear post-upgrade — `decorateRow` stamps a real seq on every flushed row —
   so a row that is null after the first export is always one already shipped.
2. **Seq allocator durability is the most delicate piece.** `decorateRow` runs
   in the spool reader, which resumes from a byte offset
   (`streamFlushFile` / `writeProgress`). The monotonic counter (e.g. `nextSeq`
   reserved in blocks in `cursor.json`) must **never go backwards** across a
   crash/resume — a new row stamped `≤ watermark` would be skipped forever.
   Duplicate seqs across a crash boundary are tolerable (strict `>` plus row-id
   dedup); regressions are not. The allocator that satisfies this is specified
   in [§7](#seq-allocator).
3. **Interleaving weakens file-level pruning.** Multiple sources/late arrivals
   in one partition can scatter seq ranges across files, so a tick reads more
   than *N* (still correct, just less cheap). Acceptable; flagged.
4. **New internal int64 column is an additive cache-schema change** (LLP 0029
   path): must be nullable, must not perturb partition-spec stability, and must
   be added to `INTERNAL_FIELDS` so it never leaks to query output or the
   forward NDJSON payload.
5. **Retention-vs-export coupling** (the open question in
   [LLP 0013](./0013-local-query-cache.decision.md#open-question)): a durable
   per-sink watermark finally makes "evict only past the minimum exported
   watermark" (`wait_for_sink_ack`) implementable. This design does **not**
   change retention — a lagging sink can still have un-exported rows pruned
   (data loss). Decide whether to wire ack-coupled eviction alongside this.
6. **Watermark vs. driver outbox. (TESTED.)** The driver's outbox respool and
   the watermark are two retry mechanisms; they compose — the outbox replays the
   partition, the watermark bounds the replay to the un-acked work — and the
   end-to-end acceptance suite exercises it (`sink-incremental-acceptance`).
7. **Watermark-write-lost + new-arrivals duplication. (OPEN — escalated.)** The
   narrow exactly-once gap detailed in §5: a unit commits, its watermark write is
   lost in the commit→advance window, and new rows append before the retry, so
   the resumed in-flight unit grows past what committed and the dedup net (server
   ledger / seq-range filename) no longer recognizes it. The common in-flight
   retry (no new arrivals) IS covered. Closing this needs a pre-commit intent: a
   read `until` upper bound plus a persisted intent record so the retry caps its
   read at the committed `lastSeq` and reproduces the identical body/key. This is
   a design-level addition to the watermark contract (both sinks; the forward
   sink's streaming chunking makes the upper bound awkward) and is deferred to a
   follow-up rather than patched half-way under the exactly-once claim.

## 7. Seq allocator (as built, T1) {#seq-allocator}

Refines risk #2. The `_hyp_ingest_seq` counter is **cache-global**, persisted at
`<cacheRoot>/_hyp_ingest_seq.json` (`{ v, nextSeq, updatedAt }`, atomic
write-rename) — **not** in a per-partition `cursor.json`. Two reasons:

- `decorateRow` runs **before** rows are grouped into `source=<…>` destination
  partitions (fact 3 + the flush re-grouping in `appendChunk`), so at the stamp
  point there is no destination partition cursor to write.
- Two distinct spool table paths — live capture (`datasets/<ds>`) and `backfill`
  (`datasets/<ds>/<backfill-seg>`) — flush into the **same** destination
  partition. Only a single cache-wide counter guarantees every partition
  observes a strictly-increasing seq subsequence; a per-partition counter would
  interleave two independent sequences and could regress.

Reservation is **block-wise** (`createIngestSeqAllocator`, default block 1024):
a whole block is durably reserved (persisted `nextSeq` advanced) **before** any
seq in it is stamped onto a row. A crash therefore abandons at most the unused
tail of the current block (a harmless gap in the sequence) and can never
re-issue a seq `≤` one already stamped. Seqs start at 1, so a null/`0` watermark
("exported nothing") is `< ` every real row's seq. In-process concurrency (two
flushes sharing the one allocator) is serialized through a promise-chain mutex;
cross-process concurrent flush of one cache is out of scope (the daemon owns the
cache, matching the existing single-writer write-rename idiom).
