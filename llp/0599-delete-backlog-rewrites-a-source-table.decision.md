# LLP 0599: A delete backlog makes a source table due for a rewrite

**Type:** Decision
**Status:** Accepted
**Systems:** Cache
**Author:** Kenny / HypForge
**Generated-by:** neutral
**Date:** 2026-11-12
**Related:** LLP 0199, LLP 0207, LLP 0310, LLP 0336

> Routine maintenance rewrites a source-table generation once position and
> equality deletes hide at least a quarter of its records. The counters come
> from the snapshot summary maintenance already loads. This dueness outranks
> the baseline gate, the in-place merge and the foreign sorted replace,
> because none of them can see deletes.

## Context {#context}

Deletes never change a table's data-file count. Retention (LLP 0336), purge
and the delete-and-append writers (`reconcileRowsInTable`) all add position
delete files and leave the data files in place. So:

- the baseline gate (LLP 0199#baseline-gate) sees no growth and calls the
  partition converged;
- the in-place merge (LLP 0310#in-place-by-default) picks only fragmented
  files, so a large file whose rows are mostly deleted is never chosen;
- a foreign sorted replace (LLP 0207) re-baselines instead of rewriting.

Every read still decodes the hidden rows and applies the deletes. On a live
`github_events` table, 1.83M deletes over 1.84M records made queries about
5x slower until a manual rewrite.

## Decision {#decision}

<a id="ratio"></a>**The ratio.** A source-table generation is due when
`total-position-deletes + total-equality-deletes >= 0.25 * total-records`,
read from the current snapshot summary. A summary missing `total-records`,
or with no deletes, is never due. The check costs no I/O: the summary is
already loaded for the growth and re-partition checks.

<a id="route"></a>**The route.** A due delete backlog takes the
whole-generation rewrite (`compactGeneration`), as a due re-partition or
column backfill does. It outranks:

- the baseline gate, which cannot see deletes;
- the in-place merge, which would keep the files the deletes point into;
- the foreign sorted replace recognition, which would re-baseline over the
  backlog. On hypaware-server this means a day partition with a backlog is
  rewritten by the kernel rather than left to the server's sorted day
  compaction.

<a id="convergence"></a>**Convergence.** The rewrite writes only live rows
into a fresh generation, so its summary has no deletes and the next tick is
not due. Only new deletes make it due again.

## Consequences {#consequences}

<a id="cost"></a>**Cost.** At due time the deleted rows `D` are at least a
quarter of the records, so the live rows the rewrite copies are at most `3D`.
One rewrite copies at most three live rows per row deleted since the last
one. The cost is amortized over the deletes and does not grow with uptime.
Under daily retention with a window of `W` days, a table whose arrival rate
is steady becomes due about every `W/3` days (every 10 days for 30). A
delete-and-append writer pays at most three rows rewritten per row it
already replaced.

Measured on a 1.84M-record, 547 MB, 160-file partition. The rewrite streams
in `compact_batch_bytes` batches and holds a set of row ids, so its memory
grows with the live rows, not the deleted ones:

| Deleted | Rewrite | Peak RSS | Full read before / after | Next tick |
|---|---|---|---|---|
| 25% | 6.5 s | 515 MB | 2.3 s / 1.5 s | 8 ms, not due |
| 99.5% | 2.4 s | 374 MB | 2.2 s / 0.03 s | 7 ms, not due |

The 30 s tick budget is checked between partitions, so a rewrite of a
much larger table can run past it, as a forced or backfill rewrite already
can.

<a id="small-tables"></a>**Small tables.** There is no row floor. A table of
four rows with one deleted is due. The hourly tick bounds how often that can
happen, and the rewrite of a small table is cheap.

**Equality deletes** are counted by delete-file records, which may match more
or fewer rows. Nothing in the repo writes them yet.

**Not re-checked under the lock.** The dueness is read before the partition
mutation lock. If another process rewrote the generation in between, this
one rewrites it again once. That costs one extra rewrite and is not a loop.
