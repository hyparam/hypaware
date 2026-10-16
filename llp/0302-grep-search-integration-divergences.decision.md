# LLP 0302: What the shipped `hyp query grep` does differently from LLP 0264

**Type:** Decision
**Status:** Accepted
**Systems:** Query, Cache, CLI, MCP
**Author:** neutral
**Date:** 2026-08-24
**Extends:** LLP 0264 (#visibility, #lifecycle), LLP 0265 (T6)
**Extended-by:** [LLP 0303](./0303-grep-search-round-3-corrections.decision.md) (#build-site is budgeted by a share of the tick rather than its tail, and sweeps its own publish scratch; #usage-exit reaches the query refusals the shared matcher raises; most of #residuals is closed)
**Related:** LLP 0104 (position deletes), LLP 0105 (local-only visibility), LLP 0199 (the compaction baseline gate), LLP 0217 (the effectiveness verdict), LLP 0220 (a partition's error ends that partition), LLP 0293 (#one-contract: exit 2 is the usage code)

> [LLP 0264](./0264-grep-search-mirrors-the-server.decision.md) is Accepted and
> [LLP 0265](./0265-grep-search-implementation.plan.md) is Active, so neither is
> edited. Building the thing they describe turned up three places where the
> shipped mechanism is not the one they name, and one rule neither of them
> reaches. This records all four, so a reader who follows a `@ref` from the code
> back to 0264 is not left reconciling a doc against a tree that disagrees with
> it.

## Context {#context}

LLP 0264 designed the client grep by analogy with the server's shipped service,
before the client's own read path had been walked end to end. Three of its
mechanism choices assumed the client would reach its rows the way `hyp query
sql` does, through the icebird `AsyncDataSource` seam. The grep service does
not: its whole reason to exist is that the two tiers are chosen **per file**
(sidecar-indexed or brute-scanned), which means it walks data files directly.
Everything the source seam was doing for free then has to be done explicitly,
by the walk.

None of this changes what a caller sees. The rules 0264 settled (which rows are
visible, which are purged, what an unindexed file costs) hold exactly as
written; only the place they are enforced moved.

## The visibility lattice is a shared predicate, not the source wrapper {#visibility-predicate}

[LLP 0264 #visibility](./0264-grep-search-mirrors-the-server.decision.md#visibility)
says the scan "wraps its per-partition source in the existing
`withLocalOnlyVisibility` wrapper". It cannot: that wrapper decorates an
`AsyncDataSource`, and the grep walk has no source to decorate.

So the lattice check is hoisted out of the wrapper into one exported predicate,
`cwdWithheldFromCaller` in `src/core/query/visibility.js`, and the wrapper is
rewritten to call it. The SQL seam and the grep walk now share the rule itself
rather than sharing a wrapper that contains it, which is the invariant 0264
#visibility was protecting ("the lattice is not reimplemented"), reached by the
other half of the same move.

Two consequences worth stating, because they are not the wrapper's:

- The grep walk applies the predicate **after** the match predicate, so
  `localOnly.withheldRows` counts hits the caller was not allowed to see. That
  is the number the verb renders as guidance, and an out-of-rank row consumes
  no result budget.
- `LocalOnlyListUnreadableError` propagates from inside the indexed tier's read
  loop, where the surrounding `catch` exists to degrade a poisoned sidecar. It
  is re-thrown explicitly: a corrupt machine-local list is not index state, and
  degrading it would blame a healthy sidecar, advise deleting it, rescan every
  candidate file, and then raise the identical error anyway (LLP 0080's
  fail-safe polarity).

## Purge is applied by the walk, from the committed delete positions {#purge-by-position}

LLP 0264 #visibility says purged rows "are handled below the wrapper already:
the icebird source applies position deletes". Again, there is no source. A raw
parquet read applies nothing, so a purged row would resurrect on both tiers.

The walk applies them itself. `listLiveDataFiles` (new, in
`src/core/cache/iceberg/store.js`) returns each live data file with its
identity-partition values and its committed position-delete positions, and both
tiers filter every row against that set before it can match or surface. The
rule of LLP 0104 is unchanged; the enforcement point is the walk instead of the
source.

`listLiveDataFiles` deliberately **propagates** a metadata load failure rather
than degrading to an empty list, matching `dataSourceForTable`: unreadable
table metadata means an unknown row set, and grep must not answer zero over a
partition where `hyp query sql` raises.

## The build pass runs on coverage, under the tick budget {#build-site}

[LLP 0265 T6](./0265-grep-search-implementation.plan.md#tasks) says
"`compactGeneration` queues an index build for each finalized data file", and
[LLP 0264 #lifecycle](./0264-grep-search-mirrors-the-server.decision.md#lifecycle)
says sidecars are built "during maintenance/compaction, the moment a file
becomes immutable". Taken literally, that gate strands a partition already at
the compaction floor: it never becomes due for a rewrite (LLP 0199's baseline
gate, or LLP 0217's ineffectiveness verdict), so its files never get sidecars,
every grep brute-scans them for the life of the generation, and the
`hyp query status` coverage line advises a compaction that will not run.

The premise is also stronger than it needs to be. What makes an index safe is
that a **committed data file never changes its rows**, which is true of every
file in the table, not only of one a compactor just wrote. Compaction is where
indexing is *cheapest* (one index over merged files instead of many over the
fragments they replace); it is not what makes indexing *correct*.

So:

- The pass hangs off `maintainCache`'s partition loop, not `compactGeneration`.
  A build is not part of the rewrite's transaction: LLP 0220 already says a
  partition's error ends that partition's work, and an index that cannot be
  built must cost speed and nothing else.
- Its gate is **missing coverage**, measured by one `readdir` of the live data
  directory (`countIndexCoverage`), the same cost profile as the file counters
  beside it. Complete coverage costs a directory read and no pass at all.
- It is bounded by the tick's own deadline and reports `sidecarsDeferred`. An
  unbudgeted pass appended after the cutoff undoes what the budget is for, and
  indexing is seconds of CPU per file. The first missing file of a pass is
  always attempted, for the reason `maintainCache` always works one partition:
  a pass that could build nothing on an already-exhausted tick would never
  index anything on a busy cache.
- It is resumable across ticks because sidecar existence is the only completion
  marker, which is LLP 0264 #lifecycle's own rule doing more work than it was
  asked to.

The per-file poison bound (`MAX_INDEX_ATTEMPTS`) now bites where it was
designed to. Under the compaction-only gate a failed file was never offered to
a second pass, so the counter was inert; under this gate a file hypgrep cannot
index costs three builds to prove and then costs nothing, and its warning stops
repeating.

The `hyp query status` line says "maintenance indexes them", not "compaction
indexes them", for the same reason.

**Extended-by:** [LLP 0303 #build-share](./0303-grep-search-round-3-corrections.decision.md#build-share).
Handing the pass the tick's own deadline bounds the tick but not the walk: the
neediest-first order puts the partition with the most to index first, so the
pass could spend the tail and starve every partition behind it. It is capped at
a share of the tick per partition now, and it sweeps abandoned publish scratch
([#scratch-sweep](./0303-grep-search-round-3-corrections.decision.md#scratch-sweep)).

## An argument rule the schema cannot state still exits 2 {#usage-exit}

[LLP 0293 #one-contract](./0293-core-command-argument-validation.decision.md#one-contract)
settles that a caller's argument mistake is exit 2, never exit 1 through a
failure downstream of it. The verb family reaches that through the argv codec,
which validates argv against the declared `inputSchema`, and `runVerbCommand`
turns every codec refusal into exit 2.

`inputSchema` is a set of independent properties, so it cannot state every
argument rule. `hyp query grep` has both kinds it cannot:

- A **value shape** with no schema word for it: `--from 2026-8-1` is a
  well-typed string. The window is compared lexicographically, so it sorts
  below every real day and prunes the whole cache.
- A **cross-field** rule: `--from 2026-08-20 --to 2026-08-01` is two
  well-formed days that select no day at all.

Both render as an unexplained empty answer, which is precisely the forged
"nothing is recorded on this machine" that the verb's coverage clause and its
zero-files notice exist to make impossible. So both are refused, and refused
with the usage code: a script retries on 1 (the cache was busy) and reports on
2 (the command was wrong), and a typo answering 1 is met by a retry loop that
can never succeed.

The mechanism is `VerbUsageError` (`src/core/cli/verb_errors.js`): an operation
throws it for a caller's argument mistake and a plain `Error` for everything
else, and `runVerbCommand` maps it to exit 2 with the usage line beside it,
exactly as it does for a codec refusal. On the MCP surface the distinction
costs nothing, since both are the tool's error text. This is available to every
verb, not only to grep; it is the seam LLP 0293 D1 needs wherever a rule
outgrows the schema.

**Extended-by:** [LLP 0303 #query-refusal-exit](./0303-grep-search-round-3-corrections.decision.md#query-refusal-exit).
An invalid `--regex` pattern and an over-length query are the same kind of
caller mistake and still exited 1, because they are refused inside the shared
matcher, which must not import a CLI error class. The shared module raises a
refusal KIND (`GrepQueryError`) and each surface maps it to its own code.

The same rule reaches the one argument the schema CAN state and was not
stating. `limit` was declared a bare `number`, and the operation then rewrote
anything unusable to the default, so `--limit 0`, `--limit -5` and
`--limit 2.5` all returned 50 rows and exit 0: a request for FEWER rows
answered with more of them, and the same silent substitution over MCP, where
this schema is what a caller validates against. It is `{ type: 'integer',
minimum: 1 }` now, which the codec already turns into a named refusal. The
ceiling stays out of the schema on purpose: above it the flag clamps rather
than refuses, because the help text promises a capped answer and "raise
--limit" is advice a caller already at the ceiling cannot follow.

## What this does not settle {#residuals}

> Superseded in part by
> [LLP 0303 #residuals](./0303-grep-search-round-3-corrections.decision.md#residuals),
> which closes the T6 test and narrows the rest.

- **The T6 test that was promised.** LLP 0265 T6 asks for a test pinning that
  "orphan sweep and retention delete sidecars with their files". Retirement is
  pinned (`a retired generation dies whole, sidecars included`). Retention is
  not: it reclaims whole partition directories, so a sidecar cannot outlive its
  file there either, but nothing asserts it.
- **A data file dereferenced without a rewrite.** A purge that empties a file
  can leave it on disk while the manifest stops listing it. `countIndexCoverage`
  reads the directory and would keep counting it as indexable, so the build gate
  fires each tick and the pass finds nothing to do (one metadata load, no
  builds) until the next compaction retires the generation. Bounded and cheap,
  recorded rather than fixed.
- **The server's half.** hypaware-server #364, the displacement fix that lets a
  server's own `grep_search` outrank the kernel-shipped twin (server LLP 0178),
  is **merged**, so the sequencing risk LLP 0264 #open named (a server host
  ending up with two tools of one name) is spent. What is still out of tree is
  the server's import swap onto this repo's shared allowlist module, which is a
  follow-up rather than a gate: until it lands the two repositories hold two
  copies of the same constant, and LLP 0264 #shared's "no tier can surface a
  match another tier cannot" rests on them being kept equal by hand.
