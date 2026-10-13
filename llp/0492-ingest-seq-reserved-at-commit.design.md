# LLP 0492: Ingest seqs are reserved at commit

**Type:** design
**Status:** Active
**Systems:** Cache, Sinks
**Author:** HypForge implementer
**Date:** 2026-10-13
**Extends:** [LLP 0040#seq-allocator](./0040-incremental-sink-reads.design.md#seq-allocator) (the reservation unit and its concurrency boundary)
**Related:** LLP 0347, [issue 2578](https://github.com/hyparam/hypaware/issues/2578), [PR 2579](https://github.com/hyparam/hypaware/pull/2579)

@ref LLP 0040#seq-allocator [extends]: reserve per commit across processes instead of per block in one process
@ref LLP 0347#rows-wait [constrained-by]: a multi-partition chunk commits whole or waits in the spool

## Why {#why}

LLP 0040 section 7 reserved seqs in blocks of 1024 per process, handed them out
from memory, and left cross-process flushes of one cache out of scope. That
boundary no longer holds: a `hyp query` flushes the spool from its own process
while the daemon does the same. Each held a private block, so one partition
could receive, in commit order, rows whose seqs did not rise. Daemon rows
committed after a query flush carried seqs below rows the sink had already
exported, and stayed under its watermark for good (issue 2578).

Section 7 stays as the record of what T1 built. This document replaces its
reservation unit and its concurrency boundary. Everything else in section 7
still holds: the counter is cache-global, a run is durable before any seq in it
is stamped, and seqs start at 1.

## Reserve at commit {#reserve-at-commit}

- Nothing is held in memory between reservations. Each `reserve(count)` reads
  `nextSeq` from disk and durably writes `nextSeq + count` before it returns.
- The counter guard is the partition mutation guard, the cross-process lock
  directory with dead-owner recovery, keyed on `<cacheRoot>/_hyp_ingest_seq.json`.
- The commit path reserves under the partition guard, after the purge re-check
  and immediately before the append. The lock order is always partition guards
  first, then the counter guard. The counter guard is held for one read and one
  write-rename and never waits on a partition guard, so the two cannot cycle.
- Result: within one partition, seqs rise in commit order whichever process
  commits. Order across partitions does not matter, because each sink keeps a
  watermark per partition.
- A reconcile write reserves once for its written rows, under the partition
  guards it already holds.
- The counter file format is unchanged: `{ v: 1, nextSeq, updatedAt }`.

## Contention {#contention}

- The guard fails fast when held. `reserve` retries a busy counter up to 200
  times, 25 ms apart (about 5 s). A dead holder is reclaimed by the guard
  itself on the first retry.
- When the retries run out, `reserve` throws `cache_partition_mutation_busy`.
  The flush fails, the chunk stays in the spool, and the next tick replays it.
  No seq is consumed unless its write succeeded.
- The retry budget only decides how often a chunk waits a tick. Correctness
  does not depend on it, because of the whole-chunk rule below.

## Whole-chunk reservation {#whole-chunk}

- A chunk whose rows go to more than one partition first claims every partition
  guard, in sorted order. It then reserves once for the chunk's total row count,
  and finally commits each partition from its own contiguous slice of that run.
- So the counter refuses, if it refuses at all, before any partition has
  committed. The chunk waits whole (LLP 0347#rows-wait) and its replay commits
  each row once. Reserving per partition inside the commit loop let partition A
  commit, partition B time out at the counter, and the retry commit and export
  A's rows a second time.
- Rows the purge re-check drops inside the loop leave a gap at the end of the
  run. Gaps are allowed.
- A single-partition chunk reserves inside its one commit, which is the same
  rule.
- Cost: one counter round trip per chunk instead of one per partition.

## Mixed versions {#mixed-versions}

- A writer from before this change that is still running keeps its private
  block until it restarts, and stamps from memory. Its rows can still land
  below seqs a new writer has committed to the same partition.
- Both versions read and write the same counter file. The old writer advances
  `nextSeq` past its whole block, and new writers start above it, so new rows
  never collide with old ones. Only the old writer's rows are at risk.
- Restarting the daemon after an upgrade closes the gap. `hyp query` processes
  are short-lived and pick up the new code on their next run. No migration is
  needed.

## Tests {#tests}

`test/core/ingest-seq-cross-process.test.js` covers commit-order seqs across
processes, a two-partition chunk that the counter refuses before any commit, and
a two-partition chunk whose counter contention arrives after one partition is
ready to commit.
