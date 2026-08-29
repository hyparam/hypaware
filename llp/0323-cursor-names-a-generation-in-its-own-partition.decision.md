# LLP 0323: A cursor may only name a generation inside its own partition

**Type:** Decision
**Status:** Accepted
**Systems:** Cache
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-08-29
**Related:** LLP 0013, LLP 0217, LLP 0310, LLP 0316, LLP 0023, LLP 0220

> `cursor.json`'s `tableDir` is a directory NAME, not a path: the readers
> downstream of it join it onto the partition directory and then sweep,
> unlink, and rewrite what they find. A value that resolves outside its own
> partition therefore aims destructive cache maintenance at a directory the
> cache does not own. `tryReadCursorSync` rejects it, which makes the WHOLE
> cursor unreadable rather than dropping one field, and every reader gets
> the degradation it already had for a corrupt cursor. The rejection is the
> one corrupt-cursor case that knows its own cause, so it is logged.

## Context {#context}

`readCursorSync` and `tryReadCursorSync` are the cache's only readers of
`cursor.json`. Both accepted `tableDir` on `typeof === 'string'` and nothing
else. `generationLayout` then computed the live generation as
`path.join(partitionDir, tableDir)`, so a single `..` segment moved the live
generation out of the partition, out of the datasets tree, and out of the
cache directory entirely - while every consumer went on treating it as a
generation this partition owns.

That is not a read-only mistake. The maintenance tick's unreferenced-file
sweep (LLP 0310#unreferenced-sweep) unlinks inside the live generation, and
LLP 0316#staged-writes-are-reclaimed added a pass that runs on a directory
holding no published metadata at all - so an escaped directory with nothing
Iceberg-shaped in it is still a directory the sweep enters. Reproduced at
triage of hyparam/hypaware#1084: unreferenced files and staged names in an
escaped directory with published metadata (pre-existing), and staged-shaped
names, older than `ORPHAN_GRACE_MS`, in one without (added by #1080).

Every writer in the tree mints a bare name: `generationLayout`'s
`nextDirName` produces `table-<ms>`, the context-graph rewrite produces the
same shape, and a first append writes `table`. Nothing `hyp` writes can
fail the check, which is what makes rejection cheap: reaching it means the
file was edited or corrupted, not that a legitimate layout was missed.

## The gate is the reader, not the call sites {#one-gate}

The escape is reachable from `generationLayout`, from `liveGenerationDir`,
from `resolveIcebergDir`, and from the context-graph rewrite. Guarding those
means four guards that must stay in agreement forever, and a fifth consumer
added later inherits the defect by default. `tryReadCursorSync` is the
single shared entry point (`readCursorSync` delegates to it), so the value
is checked once, at the point it stops being untrusted bytes and starts
being a `PartitionCursor`. Downstream code keeps its existing invariant -
"a cursor I was handed names a generation in my partition" - without
restating it.

## Contained means resolves strictly inside {#contained}

`path.resolve(partitionDir, tableDir)` must be a strict descendant of
`path.resolve(partitionDir)`. Absolute values are rejected before that
because `path.resolve` discards the partition rather than escaping it by
degrees: today's consumers all use `path.join`, which swallows a leading
separator and lands back inside by accident, and an accident is not a
guarantee. `partitionDir` itself is rejected: it holds the cursor, not a
generation. So is the empty string.

## Rejecting the whole cursor, not the field {#whole-cursor}

Dropping only `tableDir` and keeping the rest looks gentler and is
considerably more dangerous. A source-table cursor with no `tableDir`
reads as the DEFAULT generation, `table` - a real directory that the cursor
never named. On a partition whose live generation is a `table-<ms>` (every
partition that has ever been compacted by a generation swap), the orphan
sweep would then see the real live generation as a directory the cursor does
not reference and reclaim it once past `ORPHAN_GRACE_MS`. The field-level
guard converts an escape into local data loss.

Returning null keeps `liveGenerationDir` at null, which is precisely the
signal the orphan sweep already refuses to act on. The unreadable-cursor
path is load-bearing and already built.

## Read time, not write time {#read-time}

`writeCursor` could reject instead, and it should not be the only gate:
`cursor.json` is a plain file in the user's cache, so the threat is a file
`writeCursor` never saw. A write-time check validates only the values `hyp`
already constrains and leaves the untrusted path unguarded, which is the
wrong half. Read time also fixes caches that are already on disk carrying a
bad cursor, where a write-time check would fix only the next write - and
there may be no next write, because a partition whose maintenance is
misdirected is not one that is being appended to.

A write-time assertion remains available as a cheap invariant on `hyp`'s own
writers. It is not added here: it would be a second place to keep in
agreement with this one, and the read-time gate makes anything it caught
harmless anyway.

## The rejection is logged {#say-it}

Every other corrupt-cursor outcome is a silent null, and rightly: a
truncated JSON file says nothing about how it got truncated. This one does.
Left silent, the operator sees a partition that stops compacting, reads as
empty, and leaves a foreign directory untouched, with no line anywhere
connecting the three. `tryReadCursorSync` emits a `warn` on the `cache`
logger carrying `error_kind: cursor_table_dir_escapes_partition`, the
partition directory, and the rejected value. It cannot be reached by
anything `hyp` writes, so it cannot become routine noise.

## Consequences {#consequences}

- A partition with an escaping cursor stops being maintained: no
  compaction, no snapshot expiry, no sweep. It is not deleted, not
  truncated, and not read from the wrong place. Maintenance's own
  early return (`tableExists(liveDir)` on the synthesized `epoch=0`) is
  what stops it, so no new skip path was added.
- Its rows are invisible to queries until the cursor is healed, because
  `resolveIcebergDir` falls back to the partition directory, which is not a
  table. The next append heals it: it writes a fresh cursor at `table`.
- Retention routes such a partition to the legacy-epoch branch, which
  returns without evicting because neither `epoch=0` nor the partition
  directory is an Iceberg table. A legacy epoch-layout partition whose
  cursor carries an escaping `tableDir` (a shape nothing writes) loses its
  eviction until an append restores the cursor.
- `hyp query status` under-reports such a partition: zero data files, zero
  metadata bytes, epoch 0. The log line above is what explains it.
- The context-graph compaction already skips an unreadable cursor with
  `reason: 'unreadable-cursor'` (LLP 0023), so it inherits the rejection
  with no change and reports it.

## References {#references}

- [LLP 0310](./0310-in-place-subset-compaction.decision.md):
  `#unreferenced-sweep`, the sweep whose reach this bounds.
- [LLP 0316](./0316-link-is-the-cache-commit-point.decision.md):
  `#staged-writes-are-reclaimed`, the pass that reaches a directory with no
  published metadata, which is what made an escaped directory with nothing
  in it reachable.
- [LLP 0023](./0023-context-graph-projection.decision.md): the
  unreadable-cursor skip this rejection routes into.
- [LLP 0217](./0217-compaction-effectiveness-verdict.decision.md):
  `#consequences` for the cursor's compatibility rule - readers probe the
  fields they need. Containment is a constraint on one field's meaning, not
  a new required field, so it does not disturb it.
- [LLP 0220](./0220-maintenance-walk-survives-a-partition.decision.md): one
  partition's problem ends that partition's work, not the tick's, which is
  why a rejected cursor is survivable.
- Code: `src/core/cache/partition.js` (`tryReadCursorSync`,
  `generationDirIsContained`), `test/core/cache-cursor-containment.test.js`.
