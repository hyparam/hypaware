# LLP 0326: A generation name has to be the directory, not a pointer to one

**Type:** Decision
**Status:** Accepted
**Systems:** Cache
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-08-30
**Extends:** [LLP 0323](./0323-cursor-names-a-generation-in-its-own-partition.decision.md) (#contained: containment is now checked against the filesystem as well as the string)
**Related:** LLP 0304, LLP 0310, LLP 0316, LLP 0323
**Extended-by:** [LLP 0328](./0328-a-spool-path-is-checked-where-it-is-walked.decision.md)
(#one-level-down: the same check, on the capture-spool sweep, so the principle
now spans subsystems rather than only the cache)

> LLP 0323's containment check reads the string and never the disk, so a
> `tableDir` naming a bare-name SYMLINK is contained by spelling and
> elsewhere in fact: `path.resolve` folds `..` and stops. The staged-only
> sweep was measured unlinking through one, in a directory outside the
> cache. `generationDirIsContained` now asks the filesystem one question
> about the last path component, layout defaults included: `lstat`, is this
> a symlink. Every pass that unlinks by path asks it again, at the moment
> of the delete, about each component it will walk: the sweep's two
> subdirectories, and the spool's own fixed directory name. Only a
> symlink the filesystem confirms
> rejects anything; a stat that cannot answer accepts, because inventing an
> escape out of silence is how a gate starts losing live generations.

## What LLP 0323 left open, and what it costs {#the-door}

LLP 0323 settled that `tableDir` must be one bare path segment that
`path.resolve` places strictly inside the partition. Both halves are string
operations. `path.resolve` performs no `readlink`, so
`<partition>/evil` where `evil` is a symlink to somewhere else is a bare
name, is its own basename, and resolves to a strict descendant of the
partition. It passes.

LLP 0323 did not claim otherwise; symlinks appear nowhere in its text. The
gap was recorded rather than closed in hyparam/hypaware#1091 and it is
closed here, because the triage that recorded it measured the deletion
rather than reasoning about it. Planting `<partition>/evil -> <outside>`
with `cursor.tableDir: "evil"` and running `maintainCache` caused the
staged-only pass (LLP 0316#staged-writes-are-reclaimed) to unlink a
staged-shaped file inside `<outside>`. A `precious.txt` in the same
directory survived, so the reach is bounded by the staged-name predicate
and `ORPHAN_GRACE_MS`, but the file was gone.

The bar to reach it is a real filesystem symlink inside the user's own
cache tree, which is higher than the text edit LLP 0323 closed and higher
than any corruption can mint. That is why it was judged non-blocking, and
it is not why it is being left open now. The interesting case is not the
attacker who already holds everything: it is the confused deputy, where a
cache directory is reachable by something that could not delete the
symlink's target directly, and the daemon's unattended maintenance tick is
what carries the privilege across. That is the classic shape of a cleanup
daemon following a planted link, and it is cheap to refuse.

## The check is an `lstat` on the last component {#not-a-symlink}

After the segment rule and the resolution rule pass, the gate asks the
filesystem exactly one thing: is `<partition>/<tableDir>` itself a symlink.
If it is, the name does not identify a directory this partition owns and
the whole cursor is unreadable, on the same terms and through the same log
line as every other rejection LLP 0323 defined.

The **last component only**, and this is the part that matters. Every
component above it is the partition's own path, which the cache did not
choose: a `$HYP_HOME` on another volume, a `/tmp` that is `/private/tmp`,
a cache root a user pointed at another disk. Resolving those and demanding
the result look canonical rejects a working cache for the shape of the
path it lives at, which is a bigger loss than the one being prevented. A
`realpath` containment comparison happens to be equivalent to this check
(it resolves the shared prefix on both sides, so only the final component
can differ), but it pays for the whole prefix to say the same thing, and it
invites the naive spelling that compares `realpath(p)` to `p` and does
break the symlinked-ancestor cache. `lstat` says exactly what is meant.

A `tableDir` carrying a NUL is refused on the way past. It is the one byte
that would make this stat throw on its argument rather than on the
filesystem, and no directory entry on a supported filesystem can carry one,
so it names nothing anywhere. This closes item 2 of hyparam/hypaware#1091,
which noted it was rejectable for free once the gate was revisited. It adds
no protection class of its own.

The name a cursor does not write down is a name too. An absent `tableDir`
is the pre-`tableDir` spelling of the layout default, and the readers
resolve it before they join: `liveGenerationDir` answers `epoch=<n>` off the
layout, `appendRowsToSourceTable` answers `table` regardless. Both
resolutions are generation names something will walk, so when the field is
absent both get the same `lstat`. This does not reject an absent `tableDir`
(see `#consequences`); it refuses the same planted symlink wearing the name
nobody had to write down.

A symlink pointing back *inside* the partition is refused too. Nothing
mints one, and the gate's meaning is cleaner as "the name is the
directory" than as "the name is a directory or a link that currently lands
somewhere acceptable" - the latter is a fact that can change under a
`readlink` the gate is not going to repeat.

## Rejection needs positive evidence {#positive-evidence}

`lstat` is asked with `throwIfNoEntry: false`, and anything other than a
confirmed symlink accepts: a generation not created yet, a directory
removed under the read, a partition the process cannot traverse.

This asymmetry is load-bearing, not defensive coding. LLP 0323#whole-cursor
already refused one trade in this direction: a rejected cursor names no
live generation, so the orphan sweep keeps everything, but the append that
heals it writes a fresh `table` and the previous generation ages out. A
gate that treated an unanswerable stat as an escape would reach that
outcome from an ordinary transient - the very first append reads the cursor
before its generation exists - and it would do so on partitions where
nothing is wrong. Under-rejecting here costs a symlink the next read may
still catch; over-rejecting costs rows.

The same asymmetry is why this is a bar, not a guarantee. The stat happens
at cursor-read time and the sweep runs later, so a writer who can swap a
real directory for a symlink in between still wins the race. Closing that
would mean carrying an open descriptor from the check to every delete,
which is a different design than the one LLP 0323 settled. This document
claims that a symlink standing on disk when the cursor is read is refused,
and no more.

## One level down: the sweep's own path {#one-level-down}

The gate above runs when the cursor is read. The unlink runs later and one
component further down: `sweepUnreferencedTableFiles` joins `metadata/` and
`data/` onto the generation path, lists each, and removes what it finds by
path. A symlink at either component aims the identical deletion outside the
cache, and unlike the cursor door it needs no `cursor.json` edit at all: a
planted `<generation>/metadata -> <outside>` is the whole of it. Measured
the same way as the door above, that plant made the staged-only pass unlink
a staged-shaped file inside `<outside>` with a perfectly ordinary cursor
sitting in the partition.

So the pass asks the same question about every component it will traverse
(the generation directory, `metadata/`, `data/`) and reclaims nothing in a
generation where any of them is a confirmed symlink. Three `lstat`s against
a pass that already lists two directories and reads avro.

Re-asking about the generation directory is deliberate, not duplication
left in by accident. It is the same question at the moment of the delete
rather than at cursor-read time, which narrows (without closing) the window
`#positive-evidence` records as open, and it keeps the property attached to
the code that deletes rather than to a caller that has to remember. That is
LLP 0323#one-gate's reasoning applied to a second gate guarding a different
thing: the cursor gate decides whether a NAME is usable, this one decides
whether a PATH may be deleted inside.

The grep-index scratch sweep (LLP 0304#scratch-sweep-site) is the second
pass with this shape, and it needs the guard more rather than less. It
lists `<generation>/data` and unlinks by path exactly the same way, but it
resolves its generation through `readCursorSync`, the LENIENT reader: a
cursor the gate rejected still yields a default `epoch=0` there, so the
cursor gate is not standing in front of it at all. Measured on this branch
before the guard existed, a merely CORRUPT `cursor.json` beside a planted
`<partition>/epoch=0 -> <outside>` was enough to make it unlink a
scratch-shaped file in `<outside>`. No cursor had to be authored.

The third pass has no cursor in front of it at all. The spool's flush
lists `<partition>/_hypaware_spool`, reads each rotated `flush-*.jsonl`
into the cache, and then removes it by path (LLP 0322). That is a fixed
name inside the partition, so the plant is the same one and nothing has to
be written down anywhere: measured on this branch before the guard,
`<partition>/_hypaware_spool -> <outside>` with a `flush-`-shaped name in
`<outside>` had that file read and then unlinked, while a differently
named neighbour in the same directory survived. The guard sits on
`listFlushFiles`, the one list every read and every unlink in the flush
comes from, so returning nothing can only make a flush do less. Deeper, in
`spoolDir` itself, it would instead fail `append`, and `append`'s rejection
is the signal that decides whether a caller replays rows.

That is the general statement the three guards are instances of: a pass
that unlinks by path checks the path it will walk, at the point it walks
it. The cursor gate decides whether a NAME is usable; it cannot decide what
an unlink one lenient read (or no read at all) away is allowed to touch.

**Extended-by:** [LLP 0328](./0328-a-spool-path-is-checked-where-it-is-walked.decision.md)
(Accepted): that statement is not about the cache. The capture-spool sweep
(LLP 0253#purge-and-detach-sweep) had the same gap between a string
containment test and a `readdir` that follows, with a wider reach (no name
predicate, no grace window) and a user-invoked trigger, and it takes the same
check from this document. Nothing here is re-decided; the principle is applied
in a fourth pass and a second subsystem.

Each refusal logs its own `error_kind` rather than the cursor gate's:
`sweep_path_is_symlink` for the two maintenance passes,
`spool_dir_is_symlink` for the flush. The state they name is a different
one, where the cursor is fine and the directory under it is not, and the
two sweeps carry the operation that stood down alongside it, since they
reclaim different leaks and "nothing is being reclaimed" is otherwise one
message for two failures. A guard on a deleting pass fails silently by
construction, so a refusal that said nothing would be the half of this
design nobody can observe.

The check itself lives in one place, `isConfirmedSymlink` in
`src/core/cache/paths.js`, because the asymmetry in `#positive-evidence` is
its entire content: a second copy that drifted toward `realpath`, or toward
reading a throw as an escape, is a defect nothing beside it makes visible.

## Cost {#cost}

One `lstat` per cursor read that gets as far as a well-formed `tableDir`,
measured at about 3 microseconds against about 7 for the read it is
attached to. A cursor carrying no `tableDir` pays two instead of one,
because two defaults could be resolved and only one of them exists; a
sweep pays three more, once per tick per partition that reaches it. The
read already opens, reads, and closes a file and parses JSON; the tick
around it walks directories and scans parquet. On a
thousand-partition cache with a handful of reads each, the tick pays tens
of milliseconds once every few minutes.

The passes pay per traversal rather than per read: three `lstat`s for the
unreferenced sweep, three for the grep-index scratch sweep on grep
partitions, and one per spool flush. Measured on this branch, about 3.6
microseconds for a stat that finds something and about 2.3 for one that
does not, against about 7.3 for the cursor read alone.

The check stays in `tryReadCursorSync` rather than moving to the
destructive call sites, which is LLP 0323#one-gate unchanged: four guards
that must agree forever is the cost this gate exists to avoid, and the
fifth consumer added later is the one that would inherit the defect.

## Consequences {#consequences}

- A partition whose cursor names a symlinked generation degrades exactly
  as LLP 0323#consequences describes for any other rejected cursor: no
  compaction, no sweep, no eviction, invisible to queries, and healed by
  the next append. Nothing new was added to any consumer.
- The rejection reuses `error_kind: cursor_table_dir_escapes_partition`
  (LLP 0323#say-it) rather than minting a second kind. The logged
  `table_dir` is a bare name that looks contained, so the operator's next
  step is an `ls -l` in the logged partition, which answers immediately.
- A user who deliberately symlinked a single generation directory onto
  another volume loses that partition's maintenance until an append heals
  it. This is not a supported layout and it never worked: a compaction swap
  mints its replacement generation with `mkdir` beside the link, on the
  original volume, so the arrangement dissolves at the first compaction
  anyway. Linking `$HYP_HOME` or the cache root is the supported way to put
  the cache somewhere else, and neither is touched by this check. Linking a
  directory *inside* the datasets tree was never a way to do it and is not
  one this check took away: `discoverCachePartitions` walks with `readdir`
  and descends only into entries that are directories, so a symlinked
  dataset or partition directory is already invisible to maintenance.
- A generation whose `metadata/` or `data/` is a symlink keeps its cursor
  and its rows: the two file sweeps stand down, so the partition still
  reads, still appends, and still compacts. The narrower refusal is what
  the narrower door deserves - nothing about a planted subdirectory says
  the generation is not the live one. The grep-index scratch sweep stands
  down on a planted `metadata/` too, although it only lists `data/`: the
  three components are asked about together because a pass that traverses
  a generation has no cheaper way to be sure which of them it reaches.
- A table whose `_hypaware_spool` is a symlink stops committing: nothing
  is drained, and rows a running writer appends keep landing at the link's
  target, because `append` still writes there. Refusing the drain does not
  undo the plant and is not trying to; it stops the flush reading and
  deleting files the cache did not put there. The state is loud
  (`spool_dir_is_symlink` on every flush) and it is one an operator fixes
  at the filesystem, like every other consequence here.
- Items 3 and 4 of hyparam/hypaware#1091 stay open by decision, not by
  omission. A well-formed name for the *wrong* generation still costs the
  live one, which is the cursor's authority working as LLP 0323#contained
  states. An absent `tableDir` still means `table`, because rejecting it
  would break every legitimate pre-`tableDir` cache.

## References {#references}

- [LLP 0323](./0323-cursor-names-a-generation-in-its-own-partition.decision.md):
  the gate this extends - `#contained` for the string rules that run first,
  `#one-gate` for why it lives in the reader, `#whole-cursor` for the trade
  `#positive-evidence` above refuses to repeat, `#say-it` for the log line.
- [LLP 0316](./0316-link-is-the-cache-commit-point.decision.md):
  `#staged-writes-are-reclaimed`, the pass measured deleting through the
  symlink. Its own commit point is a hard link (`fs.linkSync`), which is
  not a symlink and is unaffected.
- [LLP 0310](./0310-in-place-subset-compaction.decision.md):
  `#unreferenced-sweep`, the other destructive reader downstream of the
  cursor.
- [LLP 0304](./0304-grep-search-round-4-corrections.decision.md):
  `#scratch-sweep-site`, the second pass that unlinks by path inside the
  live generation, and the one that resolves it leniently.
- [LLP 0322](./0322-a-failed-automatic-refresh-cools-down-and-is-visible.decision.md):
  the flush whose file list is the third pass, and whose `append` contract
  is why the guard sits on the list rather than on the directory name.
- Code: `src/core/cache/paths.js` (`isConfirmedSymlink`),
  `src/core/cache/partition.js` (`generationDirIsContained`,
  `generationDirIsSymlink`, `defaultGenerationDirs`),
  `src/core/cache/maintenance.js` (`sweepPathComponents`),
  `src/core/cache/sweep_guard.js` (`reportPlantedSweepPath`, moved there by
  LLP 0331 so both cache passes share one refusal message),
  `src/core/cache/spool.js` (`listFlushFiles`),
  `test/core/cache-cursor-containment.test.js`.
