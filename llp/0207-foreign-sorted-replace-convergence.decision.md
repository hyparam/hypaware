# LLP 0207: A foreign sorted replace is a second convergence source

**Type:** Decision
**Status:** Accepted
**Systems:** Cache
**Author:** Phil / Claude
**Date:** 2026-08-10
**Related:** LLP 0199, LLP 0027

> The compaction due-test recognizes a rewrite it did not make: when a
> partition's current snapshot is a `replace` committed under the table's
> declared default sort order, and nothing has been appended since, the
> partition is converged. Maintenance re-baselines the cursor to the live
> data-file count and skips, instead of rewriting the sorted layout back
> into per-batch files.

## Context {#context}

The central server sorts each day's cache table in place right before its
nightly export (hypaware-server LLP 0115/0116): a `replace` snapshot,
globally session-sorted, big files, committed through icebird without
touching the kernel's partition cursor. The LLP 0199 baseline gate only
recognizes the kernel's own rewrites (the baseline is written by
`compactGeneration`), so the foreign replace moves the live file count off
the recorded baseline and reads as growth. The avg-file-size heuristic
then flags the day (a sorted day compresses to a handful of files well
under `compact_avg_file_bytes`), and the next hourly tick rewrites the
partition into ~0.5MB per-batch files, 30-90 minutes after the sorted
layout was created (hyparam/hypaware#700, verified on prod 2026-08-10).
Every exported day lost its sorted form on its export night, so the whole
cache-resident window served the shredded layout.

## Decision {#decision}

<a id="foreign-replace"></a>**Recognition test.** When a partition is
otherwise compaction-due, load the live table metadata (the same load the
rewrite needs anyway for schema, partition spec, and sort-order carry) and
check: is the current snapshot a `replace`, and does the table declare a
default sort order (identity transforms, per `sortColumnsFromMetadata`)?
Both together identify a deliberate foreign sorted rewrite; this is the
kernel-side mirror of the server day compactor's `alreadyCompacted` +
`sortOrderDeclared` skip. The `replace` still being current doubles as the
no-append-since test: a later append flips the current snapshot's
operation and the partition is genuinely due again. A `replace` on a
table with no declared sort order is not blessed; an arbitrary foreign
rewrite gets no convergence credit.

<a id="re-baseline"></a>**Re-baseline instead of rewrite.** On
recognition, write the cursor with `compaction.resettleBaselineFiles` set
to the live data-file count and everything else preserved: no rewrite, no
epoch bump, `compactedAt` still names the kernel's own last rewrite. From
the next tick on, the LLP 0199 gate holds the partition as converged
until the count moves again.

<a id="outranks-resettle"></a>**Recognition outranks the re-settle
force.** The LLP 0027 re-settle sweep can only run inside a rewrite, so
skipping defers settlement of any still-fallback rows until the next
append. The alternative repeats the bug: a single leftover unmatchable
fallback row would force a shredding rewrite every night forever. An
explicit `--force` still rewrites (and sweeps).

## Consequences {#consequences}

- The sorted big-file layout survives from export until eviction, and a
  guaranteed pointless full-partition rewrite per day per org disappears.
- A partition with committed fallback rows under a foreign sorted replace
  keeps them provisional until data next flushes into it; closed days keep
  them indefinitely. Same accepted shape as the LLP 0199 gate's treatment
  of unmatchable fallbacks.
- Cache partitions are each their own Iceberg table, so the
  snapshot-level test IS partition-level here; the shared-archive
  table-level blindness (hypaware-server LLP 0135) does not apply.
- The metadata load moves ahead of the rewrite decision (one load per
  compaction-due partition, reused by the rewrite); partitions not due
  still pay nothing.
- Dry runs report the partition as `rebaselined`, not `compacted`, and
  write nothing.
