# LLP 0304: The grep search stack after review round 4

**Type:** Decision
**Status:** Accepted
**Systems:** Query, Cache
**Author:** neutral
**Date:** 2026-08-24
**Extends:** LLP 0303 (#scratch-sweep, #memory-bound)
**Related:** LLP 0302 (round 2's corrections), LLP 0264 (#shared, #lifecycle), LLP 0199 (the neediest-first maintenance walk)

> [LLP 0303](./0303-grep-search-round-3-corrections.decision.md) recorded round
> 3's corrections. Two of them do not hold as stated: one sweep is unreachable
> in the exact case it was written for, and one memory bound is true on one tier
> and not on the other. This records what each really does.

## The scratch sweep runs on every tick, not only when there is a build {#scratch-sweep-site}

LLP 0303 `#scratch-sweep` put the abandoned-scratch sweep inside
`buildSidecarsForTable`, and the maintenance caller runs that pass only when a
partition's coverage is short (`coverage.indexed < coverage.indexable`,
LLP 0302 `#build-site`). Those two facts cancel each other out:

- The crash the sweep exists for is a SIGKILL between the scratch write and the
  rename. The rename is what publishes the sidecar, so after that crash the
  sidecar is **missing** and the partition's coverage is short.
- The next tick therefore runs the pass, rebuilds that sidecar, and coverage
  goes complete again - within seconds, and so well inside the sweep's own
  one-hour grace window. The sweep that did run spared the scratch, correctly,
  because it was still young.
- From then on coverage is complete, the pass never runs again for that
  generation, and the scratch is never looked at again. It ages past the grace
  window with nothing left to reclaim it.

So the grace window, which was meant to delay the reclaim by an hour, instead
suppressed it for the life of the generation: exactly the unbounded,
unbilled, once-per-crash leak `#scratch-sweep` set out to close.

The sweep is therefore not the build pass's work. It is
`sweepIndexScratch(tableDir)`, exported from the same module and run by the
maintenance caller on **every** tick over a table that carries sidecars,
before and independently of the coverage gate. It costs one `readdir` of a
directory `countIndexCoverage` reads on the same tick anyway. The grace window
is unchanged and still load-bearing: two writers over one cache (the daemon's
tick and a hand-run `hyp`) is the case the random scratch token exists for, and
an in-flight scratch must never be pulled out from under its writer.

The general rule this is an instance of: **a reclaim must not be gated on the
condition its own success removes.**

## The indexed tier's raw-byte bound is the candidate ranges, not one row group {#indexed-tier-residency}

LLP 0303 `#memory-bound` moved both tiers off the cache's resident
`resolver.reader` and onto hyparquet's `asyncBufferFromFile`, and concluded
that "the module's stated bound (one row group, plus the index on the indexed
tier) is true rather than aspirational". It is true on the **scan** tier and
not on the **indexed** one.

`parquetFind` does not read through the buffer it is handed. It wraps it:
`file = cachedAsyncBuffer(rawFile)`, a memoizing layer that holds every slice
it fetches for the life of one file's search (hyparquet
`src/utils.js`). The indexed tier's raw residency is therefore the **union of
the candidate ranges** that search read, which for a query the index cannot
prune approaches the projected bytes of the whole file. A literal shorter than
hypgrep's n-gram length prunes to no blocks at all, so it reads and retains
every range.

Nothing regressed: before `#memory-bound` the same wrapper sat on top of a
buffer that already held the entire file, so the change is strictly an
improvement, and it removed a synchronous whole-file read from the loop. What
does not hold is the claim, which is a bound no call path enforces and which
the module's own docstring restated.

The correction is to the statement, not to the code. Bounding the indexed
tier at a row group would mean not using `parquetFind`'s streaming entry
point, or a hypgrep change to let a caller supply its own buffer wrapper;
neither buys anything at the scale this cache actually reaches, and both cost
the pruning the tier exists for. What matters is that the bound is **per
file** on both tiers - the walk is sequential and nothing survives a file but
the trimmed hit buffer - and that the docstring says which tier gets which.

## What this does not settle {#residuals}

Carried forward from LLP 0303 `#residuals`, unchanged: the server's own
`exhausted` computation, and the server's import swap onto this repo's shared
modules.

**Corrected**, not carried: LLP 0303 `#residuals` says a data file
dereferenced without a rewrite "now costs a directory read per tick rather
than a metadata load, because `#build-share`'s short-circuit runs first". It
does not. That short-circuit fires only when every missing sidecar is
**quarantined**, and a dereferenced file has never been offered to a build, so
it is never in the quarantine ledger: `scanForBuildable` reads it as
buildable, the short-circuit is skipped, and `buildSidecarsForTable` pays a
full `listLiveDataFiles` (metadata plus manifest-list plus manifest) on every
tick to rediscover that the file it is short by is not in the table.
Measured at this head: with one unreferenced `.parquet` in a live generation's
`data/`, every subsequent tick reports `sidecarsBuilt: 0` (the pass ran) where
a clean partition reports the field absent (the gate skipped it), for the life
of the generation. `hyp cache status` also reports that partition permanently
under-indexed. Still bounded and still not a wrong answer, and closing it
means either giving the gate a live-file denominator (a metadata load per grep
partition per tick, the cost the readdir gate exists to avoid) or a separate
orphan reaper; both are larger than the leak.

Added here:

- **The build's tick share is one window near the front of the tick, not a
  per-partition allowance.** `deadlineMs` is `startMs + budgetMs * share`, an
  absolute instant, and the neediest-first walk ranks every dataset together,
  so a busy `logs` or `traces` partition compacting ahead of the grep ones can
  spend the window before the build pass is reached at all. Every grep
  partition after that indexes exactly one file per tick (the mandatory first
  attempt) and defers the rest. Coverage still advances monotonically, so the
  `hyp cache status` advice remains actionable, but it can advance slowly on a
  busy cache. The alternative reading (`Date.now() + budgetMs * share`, a
  share per partition as the docstring first implied) recreates the starvation
  `#build-share` was written to remove, one partition wider: K grep partitions
  would take K shares and the loop's own budget break would then cut the
  non-grep partitions behind them. Which of the two the daemon wants is a
  scheduling decision with a measurement attached, not a review-round patch,
  so the code keeps the conservative one and the docstring now says what it
  actually does.
- **`--remote` skips the verb's operation-level argument rules.**
  `runVerbCommand` sends the codec's params straight to the server without
  calling `operation`, so the day-shape check, the inverted-window check and
  the `GrepQueryError` mapping never run on that path and the server applies
  its own. Schema-level rules (`--limit` and friends) still run, because the
  codec runs first. This is the verb framework's shape rather than grep's, and
  the server is the right authority for a remote call; it is recorded because
  `docs/CLI_REFERENCE.md` stated the local refusals without naming the
  exception (it now does).
