# LLP 0540: What the compaction contract boundaries do and do not promise

**Type:** Decision
**Status:** Accepted
**Systems:** Cache, Plugins
**Author:** neutral
**Date:** 2026-10-18
**Extends:** LLP 0312 (#avg-below-batch: the rule protects routine
source-table compaction and stays as written; #round-cap-under-retention:
the "strictly fewer" invariant holds only above the floor boundary;
#metadata-dueness: the retained metadata set is commit-rate dependent, not a
fixed 20 files)
**Related:** issue #1021

## Context {#context}

Review of PR #1020 left three findings against LLP 0312 open. None is a
production defect, and the decision on the issue keeps every runtime limit
as it is. What each finding showed is that LLP 0312, or the source comments
that cite it, states a boundary more broadly or more tightly than the code
holds it. This record says where each boundary actually sits, so the next
reader does not lean on a promise the code never made.

## The avg-below-batch rule protects source-table compaction {#avg-below-batch-scope}

`parseConfigShape` rejects an effective `compact_avg_file_bytes` above an
effective `compact_batch_bytes`. Effective means each key falls back to its
default when the file does not set it, so a config that only LOWERS
`compact_batch_bytes` below the default average trips the rule, as does one
that only raises the average above the default batch bound. The error
pointer names `/maintenance/compact_avg_file_bytes` in both cases, and the
message names `compact_batch_bytes` with the effective value it was compared
against, which is how a person who wrote only the batch key learns which
pair failed.

The premise LLP 0312 gives, that a merged file never exceeds
`compact_batch_bytes`, is a property of the in-place writer. The
generation-swap writer (`compactGeneration`, used for the legacy epoch
layout, `--force`, and the re-settle sweep) only uses the batch bound for its
in-memory batch and rolls output files at `target_file_bytes`. The rule is
kept anyway, because what it guards is the reachable case: every growing
partition is stamped `layout: 'source-table'` by the append path, and on
that layout routine dueness is served by the in-place writer, so an average
threshold above the batch bound is a partition that is due on every growth
tick forever. Widening the comparison to `max(compact_batch_bytes,
target_file_bytes)` would admit exactly that configuration. The other
writer's higher ceiling is not a reason to weaken a guard on the layout
where routine compaction runs.

## The round-cap invariant holds above the floor {#round-cap-floor-boundary}

`inPlaceRoundCap` is `min_snapshots_to_keep - 1`, clamped to at least 1 and
at most `MAX_INPLACE_COMPACT_ROUNDS`. The one-round floor stays. What changes
is the claim made about it:

- For `min_snapshots_to_keep >= 2` the cap is strictly below retention, so
  one tick never commits as many snapshots as the count rule keeps, and at
  least one pre-tick snapshot survives that tick's expiry by count.
- At `min_snapshots_to_keep = 1` the floor makes the cap equal to retention,
  and at `0` (which config validation admits) it exceeds it. Neither keeps a
  pre-tick snapshot by count. One survives only if
  `max_snapshot_age_hours` still covers it, or if the tick committed
  nothing. That is the window the config asked for, not a broken guard.

Nothing here promises a reader a minimum interval, a maintenance interval or
otherwise, whatever the two knobs are set to. The guarantee is about
snapshot COUNT across one tick above the floor; how long a reader's
snapshot lives depends on commit rate, age retention, and when the next
tick runs.

## The retained metadata set depends on commit rate {#metadata-retained-set}

The one-hour orphan grace (`ORPHAN_GRACE_MS`) and the version trim
(`METADATA_VERSIONS_KEPT = 20`) both stay. The trim hands every
`vN.metadata.json` past the newest 20 to the same grace-guarded removal the
unreferenced-file sweep uses for data files, so a surplus version younger
than the grace window survives the tick. The retained set is therefore the
newest 20 versions PLUS every older version written within the last hour.
It is bounded, but by commit rate, not by a fixed count of 20 files, and
each retained version carries the full snapshot list that retention keeps.

LLP 0312#metadata-dueness moved the 64 MB metadata trigger off source
tables because the in-place writer can only add versions. That still holds:
a metadata-only routine trigger would add work the routine writer cannot
clear. The bound that replaced it is the trim plus the sweep, read as above.

## Not decided here {#non-goals}

- No runtime, storage-format, or error-behavior change. The validation, its
  message and pointer, the round cap and its floor, the grace window, and
  the version trim are unchanged.
- No `max(compact_batch_bytes, target_file_bytes)` comparison, no
  layout-scoped or warning-only variant of the rule, and no config-loader
  recovery or error-pointer cleanup.
- No change to snapshot expiry, no skipping in-place compaction at
  `min_snapshots_to_keep <= 1`, and no restored metadata-only dueness
  trigger for source tables.
- No shortened or removed grace for superseded metadata versions to make a
  fixed bound true.
