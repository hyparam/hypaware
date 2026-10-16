# LLP 0311: Re-partition the cache's ai_gateway_messages to date grain

**Type:** Decision
**Status:** Accepted
**Systems:** Cache, Plugins
**Author:** Kenny / Claude
**Date:** 2026-08-25
**Related:** LLP 0022, LLP 0030, LLP 0209, LLP 0217, LLP 0310
**Extended-by:** LLP 0321

> The cache's `ai_gateway_messages` table drops `session_id`,
> `conversation_id`, and `cwd` from its partition spec and partitions on
> `date` alone, with those columns kept as the table's sort order. This
> removes the one-file-per-session floor (LLP 0310#context) that made the
> table's file count grow without bound. Existing caches migrate by a
> one-time streaming generation-swap rewrite; no recreate, no backfill.

## Context {#context}

The cache partitions `ai_gateway_messages` by identity on
`(session_id, conversation_id, cwd, date)` (LLP 0030). A data file cannot
span partition tuples, so the table's file-count floor is one file per
session tuple: about 1,250 files on the measured install (August 2026),
each a few hundred KB. LLP 0022 measured the same pathology in June
(~4,500 files, one per conversation) and fixed it for the export side
with day-grain partitioning plus a within-partition sort, but left the
cache's layout alone. LLP 0310 gave the cache in-place subset compaction,
which stops maintenance from fighting the floor, but the floor itself
stands and grows with every new session.

Query pruning no longer needs the identity partitions. The chain was
verified end to end on the current code: the storage wrapper forwards
WHERE into icebird's scan (`storage.js` passes `options` through and
exposes `appliedWhere`), every append records per-file lower and upper
bounds in the manifests (`stage.js`), `fileMightMatch` prunes files on
those bounds, and hyparquet-writer emits row-group statistics by default.
With the table sorted by `session_id`, a session's rows cluster into a
contiguous range, so per-file and per-row-group bounds on `session_id`
stay tight and a session lookup skips cold files without opening them.

## Decision {#decision}

### Date is the only partition field {#date-partition}

The cache table's partition spec becomes identity on `date` alone.
`identity(date)` is chosen over the export's `day(message_created_at)`
(LLP 0022#partition-derivation) because cache queries in practice filter
on the string `date` column, and an identity partition on that column
prunes those filters exactly; the cache owns the precomputed column, so
LLP 0022's generality argument for the timestamp transform does not
apply here. The export layout is unchanged.

The on-disk `source=<x>` directory split above the Iceberg table is not
partitioning and is unchanged.

### Lookup columns split from partition columns {#declaration-split}

`cachePartitioning.iceberg.fields` currently does double duty: it is the
cache's partition spec and, per LLP 0022#within-partition-sort, the
export's sort key. Dropping columns from it would silently degrade the
export sort. The declaration therefore splits the two roles: the
identity fields stay declared in order as the dataset's lookup columns
(still seeding the export sort, and now also a cache table sort order,
which icebird applies on every append and rewrite), and a separate
declaration names the subset that actually partitions the cache table.
The chosen shape is a per-field `sortOnly: true` flag on
`CachePartitionField`: one list, one order, and a field without the flag
partitions as before, so no other dataset moves. No new operator-facing
config.

For `ai_gateway_messages`: partition = `date`; sort =
`session_id, conversation_id, cwd, date` (unchanged order).

### Migration is a scheduled generation swap {#migration}

The drift guard (`validatePartitionSpecStability`) currently rejects any
append whose declaration disagrees with the table's recorded spec, which
would brick every existing cache on upgrade. Instead:

- Appends write under the **table's recorded spec** when it differs from
  the declaration, so flushes keep landing and queries keep working.
- The maintenance tick detects the mismatch and runs the existing
  streaming whole-generation rewrite (`compactGeneration`) with the new
  declaration, producing a new generation under the new spec and
  swapping the cursor. This is the same machinery `--force` and the
  re-settle sweep use, with the same memory bound, and it is idempotent:
  a crash mid-swap leaves the old generation live.
- After the swap the recorded spec matches the declaration and the guard
  is strict again. Old generations retire through the existing grace
  window.

No cache recreate, no backfill, and no schema or spool-label bump: the
columns, row identity, and fallback-hash scope (LLP 0030) are untouched;
only the partition spec and sort order move.

## Consequences {#consequences}

- The file-count floor drops from one per session tuple to one per day
  per source. In-place compaction (LLP 0310) then converges each day
  partition to a single file of a few MB, so the table settles near
  days x sources files instead of ~1,250 and growing.
- Session lookups trade exact partition pruning for bounds pruning over
  sorted files: near-equivalent skip rates, far fewer file opens. Date
  filters still prune exactly. Full scans and aggregates get faster
  because the same bytes sit in a few hundred files instead of
  thousands.
- The one-time migration rewrite costs one whole-generation pass per
  partition (minutes on a large install) and rebuilds the grep sidecars
  once, since every data file is new.
- LLP 0310's victim selection groups by partition tuple; day tuples are
  bigger, and a day exceeding `compact_batch_bytes` merges a prefix at a
  time, smallest files first, as already specified.
- This supersedes LLP 0030's decision 4 (the cache partition fields).
  The `session_id` / `conversation_id` column split, the fallback-hash
  scope, and the graph anchor all stand.

## References {#references}

- [LLP 0030](./0030-session-id-partition-key.decision.md): the identity
  partition fields this replaces; everything else in it stands.
- [LLP 0022](./0022-iceberg-export-partitioning.spec.md): the export-side
  day-grain precedent and the sort-key derivation this decouples from.
- [LLP 0310](./0310-in-place-subset-compaction.decision.md): the
  compaction machinery that made this safe to do incrementally, and
  whose deferral this resolves.
- Code: `hypaware-core/plugins-workspace/ai-gateway/src/dataset.js`
  (`cachePartitioning`), `src/core/cache/iceberg/store.js` (drift
  guard), `src/core/cache/maintenance.js` (`compactGeneration`, the
  migration vehicle), `src/core/iceberg/partition-spec.js`
  (`partitionSpecForDeclaration`).
