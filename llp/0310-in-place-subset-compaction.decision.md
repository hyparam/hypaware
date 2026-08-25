# LLP 0310: Routine cache compaction merges fragmented tuples in place

**Type:** Decision
**Status:** Accepted
**Systems:** Cache
**Author:** Kenny / Claude
**Date:** 2026-08-25
**Related:** LLP 0027, LLP 0199, LLP 0207, LLP 0209, LLP 0217, LLP 0218
**Extended-by:** LLP 0312 (#consequences: the "keep `compact_avg_file_bytes`
at or below `compact_batch_bytes`" rule is now enforced by config validation;
#unreferenced-sweep: the round cap is clamped so one tick cannot spend the
retention window it calls the reader-safety window; the metadata-size dueness
trigger is left to the epoch layout, whose writer can clear it)

> Routine compaction dueness on a source-table generation is served by an
> in-place subset rewrite: icebird's files-scoped `icebergRewrite` merges only
> the fragmented partition tuples, committed as a `replace` snapshot into the
> same generation directory. Cost scales with what fragmented since the last
> pass instead of with the table, which retires the pathology this replaces: an
> hourly whole-generation rewrite of a 650 MB partition that reproduced its own
> file count. The generation-swap rewrite remains for `--force`, the re-settle
> sweep, and the legacy epoch layout. Live counts come from the snapshot
> summary, and files nothing references any more are released by a sweep
> bounded by snapshot retention.

## Context {#context}

`ai_gateway_messages` is identity-partitioned by
`(session_id, conversation_id, cwd, date)` (LLP 0030), so a data file cannot
span partition tuples (LLP 0209#tuple-bound) and the table's file-count floor
is one file per tuple - about 1,250 files on the measured install, far above
`compact_file_count`. Every flush therefore made the partition due again, and
the only rewrite maintenance had was the whole-generation one: an hourly
~650 MB rewrite whose output reproduced its input (1,255 files to 1,246,
measured 2026-08-25). LLP 0217's verdict machinery correctly skipped the
partition between flushes, but any growth re-armed the full rewrite.

icebird 0.8.26 added the enabling primitive: `icebergRewrite({ files })` reads
and rewrites only the named data files and carries every other file forward
untouched, with its original sequence numbers, in one `replace` commit.

Re-partitioning the cache to a coarser layout (day grain, as the export side
chose in LLP 0022) would lower the floor itself; that is deliberately deferred
until this machinery has bedded in, and would supersede LLP 0030's spec.

## Decision {#decision}

### In-place by default {#in-place-by-default}

When compaction is due on a `source-table` generation, maintenance merges
fragmented tuples in place instead of swapping generations. The
generation-swap rewrite (`compactGeneration`) remains the path for:

- `--force`: an explicit operator request rewrites everything, as before.
- The re-settle sweep (LLP 0027): collapsing a split twin pair needs the
  whole-generation scan, because the native twin may live in a file a subset
  pass would not read. This covers both the `hasResettle` trigger and the
  case below where the selected victims themselves carry fallback rows.
- The legacy `epoch` layout.

Victims that carry a committed gateway fallback row route the tick to the
full rewrite only when the dataset's settle hook can upgrade one of those
rows right now, established by offering the victim files' fallback rows to
the hook in memory (bounded by the round's byte budget, nothing committed).
Every committed file a round selects is asked about once, not only the first
round's: the byte budget stops one round well short of a fragmented
partition, so later rounds reach committed files the tick has not read, and
a probe scoped to round 0 would merge a settleable fallback row in place.
An UNMATCHABLE fallback, one whose transcript line never lands, must merge
in place instead: this is LLP 0027's own protection restated for this path,
and it is measured, not theoretical - on the live cache one unmatchable row
made every growth tick a whole-generation rewrite (with the generation swap
also discarding every grep sidecar), which is precisely the pathology this
decision retires.

### Victim selection {#victim-selection}

A file is a merge candidate only when it is small (below half of
`target_file_bytes`, so two candidates still merge to at most the target and
a file past that mark has little to gain) and shares its tuple with another
candidate; a tuple's lone file is its floor. A tuple is taken whole where it
fits, and a round stops adding tuples at `compact_batch_bytes` of victim
data, because the files-scoped rewrite materializes the victims' rows in
memory - the same bound LLP 0209 puts on a compaction batch. A tuple whose
candidates outweigh that budget by themselves is merged a prefix at a time,
smallest files first: routine dueness no longer reaches the streaming
whole-generation rewrite, so skipping such a tuple would keep the partition
due, hand it an empty victim set, and freeze it at its fragmentation under
the floor verdict forever. The prefix rewrites some rows more than once
across ticks and in exchange the live file count falls monotonically; a
tuple whose two smallest candidates do not fit the budget cannot be merged
by THIS rewrite within its heap bound and is left alone. The streaming
whole-generation rewrite could still merge it, since it batches on the way
out, but buying a whole-table rewrite on every growth tick is the exact cost
this decision retires, so such a tuple waits for `--force`. A tick runs at
most `MAX_INPLACE_COMPACT_ROUNDS` rounds; a deeper backlog drains on later
ticks.

### The floor is a verdict {#floor-is-a-verdict}

When the heuristics flag a partition but no tuple holds two mergeable files,
the partition sits on its identity-partitioning floor. That observation IS
the LLP 0217 ineffectiveness verdict, reached by a listing instead of by a
rewrite that reproduces the layout: the cursor records before == after under
the current writer generation, and later ticks skip for that stated reason
until new data flushes. The writer generation bumps to 3 for this change, so
every partition frozen by the old whole-generation writer gets its one owed
reassessment (LLP 0217#retry-on-writer-change) at the cost of a listing.

### Live-count units {#live-count-units}

The baseline gate (LLP 0199), the dueness heuristics, the recorded verdicts,
and `hyp cache status` measure a source-table generation by its **live** file
count, read from the current snapshot summary's `total-data-files` /
`total-files-size`, falling back to directory counts where a summary is
missing. In-place commits leave superseded files in the directory until
retention releases them, so a directory count would over-read a freshly
compacted partition and then move again when the sweep below deletes the
leftovers; both moves would read as growth. The summary moves only when data
does. Existing cursors need no migration: a generation-swapped directory
held only live files, so recorded baselines are already in live units.

### Unreferenced-file sweep {#unreferenced-sweep}

Nothing else deletes what in-place commits supersede: icebird's snapshot
expiry removes snapshots, not files. Each maintenance tick therefore sweeps
the live generation for files no retained snapshot references: the
referenced set is every manifest list, manifest, and data/delete file
reachable from any snapshot still in the table metadata, so **snapshot
retention is the reader-safety window** - a file is reclaimed only after
expiry has released every snapshot that could read it, the same role
`GRACE_PERIOD_MS` plays for retired generation directories. Two guards on
top: nothing younger than `ORPHAN_GRACE_MS` is touched (a concurrent append
stages files before its commit references them), and the newest
`METADATA_VERSIONS_KEPT` metadata versions are kept regardless, since
in-place commits no longer retire whole directories that used to carry old
versions away. A data file's grep sidecar is removed with it. An unreadable
manifest aborts the sweep for the tick: an unknown referenced set must not
delete anything.

## Consequences {#consequences}

- Hourly maintenance cost on an active large partition drops from a
  whole-table rewrite to merging the hour's new small files; the measured
  install's ~10 CPU-seconds-per-tick burn becomes proportional to new data.
- Between an in-place commit and retention release, the directory holds
  superseded files: disk temporarily exceeds live data by roughly the bytes
  rewritten within the retention window, and the grep sidecar build may
  index a superseded file it finds uncovered (wasted but harmless work; the
  sweep removes the pair together).
- Within-generation dedup by `_hyp_cache_row_id` and the re-settle upgrade
  only run on the whole-generation paths. Routine in-place ticks preserve
  rows byte-for-byte; residual duplicates or fallback rows in files the
  subset pass never selects wait for a forced or settle-routed full rewrite.
- An in-place merge materializes its victims, so a merged file never exceeds
  `compact_batch_bytes` (32 MB by default) and routine maintenance no longer
  converges a tuple toward `target_file_bytes`. Keep `compact_avg_file_bytes`
  at or below `compact_batch_bytes`, or a converged partition reads as
  permanently due; `--force` remains the only path that builds target-sized
  files.
- The file-count floor itself stands until the cache is re-partitioned
  (deferred; would supersede LLP 0030's partition fields).

## References {#references}

- [LLP 0199](./0199-maintenance-compaction-convergence.decision.md): the
  baseline gate this decision re-units to live counts.
- [LLP 0209](./0209-compaction-file-size.decision.md): the tuple bound and
  the batch-bytes heap argument the victim budget reuses.
- [LLP 0217](./0217-compaction-effectiveness-verdict.decision.md): the
  verdict machinery the floor observation now feeds without a rewrite.
- [LLP 0022](./0022-iceberg-export-partitioning.spec.md): the export-side
  day-grain layout the deferred re-partition would mirror.
- Code: `src/core/cache/maintenance.js` (`compactLiveFilesInPlace`,
  `selectInPlaceVictims`, `sweepUnreferencedTableFiles`, `liveTableStats`),
  `src/core/cache/iceberg/store.js` (`listLiveDataFiles` sizes), icebird
  `icebergRewrite({ files })` (0.8.26).
