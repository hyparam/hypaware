# LLP 0316: One `link` is the local cache's whole concurrency control

**Type:** Decision
**Status:** Accepted
**Systems:** Cache
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-08-26
**Related:** LLP 0022, LLP 0209, LLP 0310, LLP 0312
**Extended-by:** [LLP 0323](./0323-cursor-names-a-generation-in-its-own-partition.decision.md)
(#staged-writes-are-reclaimed: entering a metadata directory with nothing
published makes WHICH directory the sweep was pointed at load-bearing, so a
cursor whose `tableDir` resolves outside its partition is now rejected at the
reader and names no live generation at all)

> The intrinsic cache has no catalog service, no lock file, and no lease. A
> conditional Iceberg commit (`ifNoneMatch: '*'`) publishes by staging the
> bytes under a unique name and then `link(2)`-ing that name onto
> `v<N+1>.metadata.json`. `link` refuses an existing destination with
> `EEXIST` atomically, so that one call IS the create-only precondition,
> the commit point, and the arbiter of a two-writer race, all at once. The
> price is that a filesystem without hard links cannot host the cache
> directory at all, which the cache says out loud instead of degrading. The
> staging name a crashed publish strands is reclaimed by the
> unreferenced-file sweep, because on the in-place layout nothing else ever
> will.

## Context {#context}

`icebird`'s file catalog commits by writing the next metadata version and
retrying on a `412`: a losing committer reloads the table and re-applies its
snapshot. That protocol only works if the write of `v<N+1>.metadata.json`
actually fails when the version already exists. Against object storage the
precondition is the store's own conditional PUT. Against the local
filesystem there is no such header, so `localWriter` has to build the
precondition out of syscalls.

The obvious build is `existsSync` then `rename`. It is wrong, and wrong in
the silent direction: POSIX `rename` replaces its destination without a
word, so two committers can both observe the version absent, both publish,
and the second one's metadata simply erases the first one's snapshot. No
error reaches `commitWithRetry`, so nothing retries and no reader ever
learns a commit was dropped. The window is small, and the daemon usually
has one writer, but "usually one writer" is not something the cache
enforces anywhere: `hyp query maintain`, a foreground flush, and the
daemon's own maintenance tick are separate processes over the same
directory.

## The publishing `link` is the commit point {#link-is-the-commit-point}

`link(2)` fails with `EEXIST` when its destination exists, atomically and
with no window between the test and the create. So the conditional branch
of `localWriter.finish` publishes with `link` and translates `EEXIST` into
the `412` the retry loop already knows how to read. The check and the act
are one call; there is nothing left to race.

That call is therefore load-bearing in a way that is easy to miss when
reading the function: it is not "a way to move a file into place", it is
the entirety of the cache's concurrency control. There is no lock to take,
no catalog to ask, and no single-writer invariant enforced anywhere else.
Anything that replaces it has to carry the same guarantee - atomic
create-or-fail on the destination name - or the cache loses conflict
detection with nothing to report the loss.

The non-conditional branch keeps `rename`, and that is not an
inconsistency: without `ifNoneMatch` the caller has asked for
last-write-wins on a data file whose name is already unique, so atomic
CONTENT replacement is the property it wants and `rename` is the call that
has it.

## A filesystem with no hard links cannot host the cache {#no-link-no-cache}

`link` between two siblings can never fail with `EXDEV`, but it can fail
with `EPERM`, `ENOSYS`, or `ENOTSUP` on a volume that has no hard links at
all: FAT and exFAT, and some FUSE and cloud-sync mounts. On such a volume
every conditional commit fails, which means the cache cannot commit at all.

The cache does not fall back. A check-then-act `rename` fallback would
reintroduce exactly the lost-update defect the `link` exists to remove, and
it would do so on precisely the mounts (network and sync-backed) where
concurrent access is likeliest. The alternative that would work is
publishing through `open(filePath, 'wx')`, trading atomic content for
atomic creation, which is the trade the `local-fs` blob store makes and the
wrong one for a metadata file a reader may be mid-read of.

So the failure is named instead: a bare errno does not tell an operator
that their cache directory is on the wrong kind of volume, and the fix
(move `HYP_HOME`) is not discoverable from `EPERM`. The error says the
cache directory must be on a filesystem that supports `link(2)`.

## A crashed publish's staging name is reclaimed by the sweep {#staged-writes-are-reclaimed}

Staging is what makes the publish atomic, and staging leaks. A crash
between opening `<final>.tmp.<pid>.<ms>.<rand>` and publishing it, or
between the successful `link` and the `rm` that drops the now-redundant
staging name, strands that file in the table directory. Neither the
successful nor the failing path may report the `rm` as an error: after the
`link` the commit HAS landed, and telling the caller otherwise would make
`commitWithRetry` surface a failed commit for a snapshot that is on disk.

The stranded file is unreadable by construction - it matches neither
icebird's anchored `v<N>.metadata.json` regex nor any path the table's own
metadata carries - and that invisibility was mistaken for harmlessness.
It is not: `measureMetadataDir` sizes the whole metadata directory, so the
leak is counted by the metadata figure `hyp query status` reports and by
the epoch layout's 64 MB metadata-size dueness trigger. More to the point,
under the in-place layout (LLP 0310) no generation directory is ever
retired, so nothing sweeps the leak away as a side effect the way the old
generation-swap rewrite did.

The unreferenced-file sweep therefore recognizes the staging suffix and
reclaims it, under the same `ORPHAN_GRACE_MS` window it applies to every
other candidate. The pattern lives with the writer that mints the name, so
producer and recognizer cannot drift apart.

Two things bound that clause, and both are load-bearing.

It runs BEFORE the referenced-set walk, not inside the metadata loop after
it. Every other candidate the sweep weighs is a file some snapshot might
name, so the walk returns early and deletes nothing rather than guess when
it cannot build the set. A staging name is unreferenced by construction, so
the set has nothing to say about it, and the reachable early return is the
most ordinary one there is: a table with metadata on disk and no snapshot
committed yet - `hyp` created it and died before the first append - returns
before the metadata loop ever runs. That is also precisely the table most
likely to be carrying a stranded staging name from the create that made it.
Gated behind the walk, the leak's only reclaimer never runs there at all.

It reads only `metadata/`. There the grace window is enough on its own:
every write into that directory opens its staged file and publishes it
within milliseconds - by `link` for a conditional metadata version, by
`rename` for a manifest, a manifest list, or the version hint - so a staged
name an hour old cannot belong to a live write.
That is not true of `data/`, and the difference is not a detail. A parked
streaming writer (LLP 0209#descriptor-parking) holds a staged data file
across a whole rewrite with its descriptor returned and no writes landing on
it, so its mtime goes stale while the write is very much in flight; unlinking
it would not fail the write, because `openTmp` reopens the name in append
mode and recreates it empty, and `finish` would then publish a truncated
data file and commit it with no error. The `data/` staging leak is real and
wants its own reclaimer, but it wants a liveness test, not this grace window.

## Consequences {#consequences}

- The cache directory has a filesystem requirement it did not previously
  state. A volume without `link(2)` fails every conditional commit with a
  message naming the cause, rather than silently losing snapshots.
- A concurrent-commit race is now a `412` and a retry rather than a lost
  update, so a second writer over the same cache is a slowdown, not a
  correctness problem.
- The metadata directory has one fewer unbounded growth term. It was small
  in absolute size, but it was the only leak in that directory with no
  reclaimer at all.
- The sweep now has two passes with different preconditions. Reordering the
  staging pass behind the referenced-set walk, or reusing its grace window
  for `data/`, each reintroduces a defect this doc names.
- Anything that later wants to publish cache metadata by another route
  (a different writer, a remote catalog) has to state which of `link`'s two
  jobs it is taking over. Taking over the "move it into place" half alone
  removes conflict detection without removing anything that looks like it.

## References {#references}

- [LLP 0310](./0310-in-place-subset-compaction.decision.md): `#unreferenced-sweep`
  for snapshot retention as the reader-safety window, and for why the
  in-place layout retires no directory that could carry a leak with it.
- [LLP 0312](./0312-compaction-contract-boundaries.decision.md):
  `#metadata-dueness` for the metadata-size trigger now being the epoch
  layout's alone.
- [LLP 0209](./0209-compaction-file-size.decision.md): `#row-groups` and
  `#descriptor-parking` for the parked writer that can hold a staged
  `data/` file open across a whole rewrite, which is why the sweep's grace
  window is sufficient in `metadata/` and would not be in `data/`.
- [LLP 0022](./0022-iceberg-export-partitioning.spec.md): the export path's
  conditional-commit and `412` behavior, which this is the cache-local
  counterpart of.
- Code: `src/core/cache/iceberg/resolver.js` (`localWriter`'s `finish`,
  `stagedNameFor`, `isStagedWriteName`), `src/core/cache/maintenance.js`
  (`sweepUnreferencedTableFiles`, `measureMetadataDir`).
