# LLP 0530: What date partitioning prunes, what a forced rewrite may not drop, and why the migration is one-way

**Type:** Decision
**Status:** Accepted
**Systems:** Cache
**Author:** neutral
**Date:** 2026-10-17
**Extends:** LLP 0311 (#context, #consequences, #migration)
**Related:** LLP 0310, LLP 0359 (#consequences), LLP 0220 (#walk-survives-a-partition), issue #1023, PR #2690

> [LLP 0311](./0311-cache-date-partition.decision.md) is Accepted, so it is not
> edited. Two of its statements are wrong as written, and it is silent on two
> things its migration made true. This records the corrected statements and
> keeps every decision 0311 made: the cache stays partitioned on
> `identity(date)`, with `session_id`, `conversation_id` and `cwd` as sort-only
> fields.

## Context {#context}

LLP 0311#context says per-file and per-row-group bounds on `session_id` "stay
tight", so a session lookup skips cold files without opening them, and
0311#consequences expects "near-equivalent skip rates" to the old identity
prune. Neither holds at file level. The cache appender sorts each batch on its
own and writes it as one row group (`src/core/cache/iceberg/stream_append.js`),
so a day file that took a day of appends has `session_id` bounds spanning every
session active that day. Compaction merges a day to one or two row groups, so
row-group bounds do not narrow it much either.

Issue #1023 measured the effect on one contributor's 1.3 GB install: a bare
`where session_id = 'x'` went from 0.22s to 0.36s, growing with cache size.
Results stay correct. Triage judged it non-blocking: the latency is fine at
the scale measured, retention bounds the growth, a date predicate restores
exact pruning, and the trade removed the one-file-per-session floor (1251 to
149 files, maintenance converging).

## Decision {#decision}

- **A session lookup is not a partition prune.** {#pruning} Day partitioning
  removes the identity prune `session_id` had. File and row-group bounds on
  `session_id` are a best-effort skip, not a promise of tight per-session
  ranges, so a bare `session_id` lookup can read most of the day files in the
  cache. A `date` predicate prunes exactly. This replaces the "stay tight" and
  "near-equivalent skip rates" statements in 0311; LLP 0359#consequences, which
  cites those bounds for its session-scoped probes, keeps its correctness but
  not a tight-pruning cost.
- **Tuning stays as it is.** {#tuning} The date partitioning and the
  compaction tuning stay. Row-group size or file-size tuning to tighten session
  bounds is declined unless a fresh, material performance regression is
  measured. The 1.3 GB timings in #1023 are historical evidence, not a current
  benchmark, and do not justify it on their own.
- **`--force` overrides dueness, never metadata integrity.** {#forced-rewrite}
  `hyp cache maintain --force` skips the heuristics that decide whether a
  partition is due. It does not let a rewrite publish a generation without the
  schema, partition spec and sort order the table's metadata records. When any
  of them cannot be read or carried, the rewrite is refused before anything is
  reserved or written: the live generation and its cursor stay as they were,
  the partition fails with `compaction_metadata_unavailable`, the walk carries
  on to the next partition (LLP 0220), and the next run after the metadata is
  repaired rewrites it. The legacy epoch layout is exempt, because its lack of
  a spec is a property of the layout, not a failed read. Without this rule a
  forced rewrite could publish a generation with no partition spec, which the
  next declaration-carrying append rejects (#1023, fixed in #2690).
- **The migration is one-way for older builds.** {#downgrade} The first
  release that migrates `ai_gateway_messages` to the date spec is v1.28.0
  (#1019). After a cache has been migrated, a build older than that cannot
  append to it: it declares `session_id` as a partition field, finds it
  missing from the recorded spec, and refuses the append as spec evolution.
  The supported recovery is to go back to v1.28.0 or newer. Deleting or
  rebuilding the cache is not a recovery: it discards captured history that
  the newer build reads as it is.

## Guidance {#guidance}

Shipped query guidance makes no timing promise for a session lookup (the
`~0.15s` note #1023 found in the `hypaware-query` skill is already gone), so
there is no timing statement to correct. The skill already says to filter by
`date` to bound scans. `docs/QUERYING.md`, which shows the bare session read,
now says to add a `date` range when the session's days are known, and to make
the range cover every day the session ran, because a session can cross
midnight and a range that misses a day silently drops that day's rows. When
the days are not known, the bare `session_id` lookup is still correct, just
broader.

## Consequences {#consequences}

- A session lookup costs more as the cache grows, bounded by retention. The
  date predicate is the documented way to bound it.
- A forced maintenance run can now report a failed partition where it used to
  publish a damaged one. The failure line names the reason and the partition
  is retried on the next run.
- A downgrade below v1.28.0 stops appends to `ai_gateway_messages` until a
  v1.28.0 or newer build is back. The rows already in the cache are untouched.
