# LLP 0199: Cache compaction converges: baseline gate and neediest-first order

**Type:** Decision
**Status:** Accepted
**Systems:** Cache
**Author:** Kenny / Claude
**Date:** 2026-08-07
**Related:** LLP 0027
**Extended-by:** [LLP 0207](./0207-foreign-sorted-replace-convergence.decision.md) (a baseline mismatch whose current snapshot is a sorted `replace` is a foreign rewrite, not growth: recognize it and re-baseline instead of compacting); [LLP 0209](./0209-compaction-file-size.decision.md) (the rewrite the baseline gate protects now sizes its output files by bytes written rather than by the in-memory batch estimate, so a compacted generation actually reaches `target_file_bytes`); [LLP 0217](./0217-compaction-effectiveness-verdict.decision.md) (the cursor records what a rewrite achieved, not only the count it produced, so a partition sitting on its baseline because the rewrite accomplished nothing is skipped explicitly and retried once when the writer changes); [LLP 0220](./0220-maintenance-walk-survives-a-partition.decision.md) (the neediest-first order puts the likeliest partition to fail first, so the walk catches per partition and continues instead of losing every partition behind it)

> Maintenance stops re-flagging already-compacted partitions: a partition is
> only compaction-due when its live data-file count has moved off the count
> recorded by its last rewrite, and the maintenance walk visits partitions in
> descending live-file order. Together these make each tick spend its budget
> on the partitions that actually need work, so a budget cutoff postpones the
> healthiest partitions instead of starving the same tail forever.

## Context {#context}

`needsCompaction` flags a partition when its data-file count exceeds
`compact_file_count`, or when the average data-file size is below
`compact_avg_file_bytes` (32 MB). The second heuristic is self-defeating:
compacted output files are usually far smaller than 32 MB (batches flush on
*estimated in-memory* bytes, and the table's partition spec further splits
each batch), so a partition that has just been rewritten still reads as due.
Every tick then recompacts it again, forever.

Combined with two other facts this starved real deployments:

- `maintainCache` walks partitions in directory order and checks its
  `max_tick_ms` budget (default 30 s) between partitions.
- hypaware-server runs the same maintenance hourly over per-org, per-day
  partitions.

Observed on the production server (2026-08-07): the first four partitions in
walk order (`org=diegozilla`, closed days holding a few MB) had been
rewritten 29 to 51 times, one hourly tick's whole budget each time, while
every `org=hyperparam` partition sat at epoch 0 with 700 to 1250 data files
and thousands of metadata files, never once compacted and never reached by
snapshot expiry.

## Decision {#decision}

<a id="baseline-gate"></a>**Baseline gate.** Every compaction already records
the post-rewrite data-file count in the partition cursor
(`compaction.resettleBaselineFiles`, introduced for the re-settle sweep,
LLP 0027#re-settle-sweep). Generalize that gate to all compaction due-ness:
no compaction heuristic fires, the metadata-size clause included, unless the
live data-file count differs from the recorded baseline, i.e. unless data has
actually flushed (or been retention-deleted) since the last rewrite. A partition whose count sits on
its baseline is converged; rewriting it would reproduce the same generation.
A partition never compacted has no baseline and is always eligible.

<a id="neediest-first"></a>**Neediest-first order.** Before the maintenance
loop, rank discovered partitions by live data-file count, descending, and
walk that order instead of directory order. When the tick budget cuts the
walk short, what gets postponed is the healthiest tail, and the most
fragmented partitions are served first. Ranking costs one `readdir` per
partition.

## Consequences {#consequences}

- A closed (no longer written) partition is compacted exactly once and then
  costs a tick only its snapshot-expiry check.
- Old cursors written before the baseline field existed have no baseline, so
  such partitions compact one more time and then converge.
- The coincidence where flushes plus deletes return a partition to exactly
  its baseline count skips one rewrite until the count next moves; this is
  the same accepted trade LLP 0027 made for the re-settle force.
- The scheduling change is caller-agnostic: both the client daemon and
  hypaware-server get convergence without config changes. Backlogged
  deployments drain their worst partitions first, one budget window at a
  time.
