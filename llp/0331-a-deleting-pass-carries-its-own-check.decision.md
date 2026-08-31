# LLP 0331: A deleting pass carries its own check, and asks it of its own filesystem

**Type:** Decision
**Status:** Accepted
**Systems:** Privacy, Cache, Plugins, Sources
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-08-30
**Extends:** [LLP 0328](./0328-a-spool-path-is-checked-where-it-is-walked.decision.md)
(#sweep-path: the check belongs to the code that deletes, and it asks the
filesystem the walk will read)
**Related:** LLP 0253, LLP 0263, LLP 0304, LLP 0326

> LLP 0328 settled that a pass which lists a directory and unlinks by path asks
> the filesystem about that directory at the moment it walks it. Two things
> that decision leaves implicit turned out to be load-bearing. First, "the code
> that deletes" means the function, not its caller: `sweepIndexScratch` is
> exported with its guard written at its single call site, so a second caller
> acquires the deletion without it. Second, "the filesystem" means the one the
> walk will read: `sweepCaptureSpool` reads through an injectable `{ fs }`
> while its guard read `node:fs`, and the mismatch failed OPEN, because a path
> absent from the real filesystem is not a confirmed symlink. This document
> settles both, and applies 0326's rule to the vector-search orphan sweep,
> which had no check at all.

## The guard travels with the delete {#guard-travels-with-the-delete}

**The `isConfirmedSymlink` check for a readdir-then-unlink pass is written
inside that pass, not in front of its callers.** A pass that exports its
deletion and imports its containment from whoever happens to call it has
published the deletion without the property that bounds it, and the second
caller is silent about what it lost.

Three passes are brought to that rule here.

- **`sweepIndexScratch`** (`src/core/search/sidecar_build.js`) lists
  `<generation>/data` and unlinks `*.index.parquet*.tmp` past a grace window.
  Its guard lived in `src/core/cache/maintenance.js` at the one call site.
  Calling the exported function directly walked straight through a symlink at
  the generation directory or at `data/`, which is what its new controls
  measured before this change.
- **The vector-search orphan sweep** (`hypaware-core/plugins-workspace/
  vector-search/src/refresh.js`) unlinks a `.parquet` and a `.meta.json` inside
  `<stateDir>/indexes/<decl.name>`. The last segment is config-declared and
  `path.join` performs no `readlink`, so the directory is inside the plugin
  state root by spelling and can be a symlink in fact. It had no check
  anywhere. It is narrower than the spool door 0328 measured (two names under
  one base, no recursion, no wildcard) and it is the same gap.
- **`sweepCaptureSpool`** keeps the check 0328 gave it, unchanged in what it
  asks and where.

The components a pass asks about are the ones it opens, and no more. The
scratch sweep's caller asked about three (`<generation>`, `metadata/`,
`data/`); the pass itself walks two, and `metadata/` belongs to the
unreferenced sweep. Refusing on a component this pass never opens would stop
reclaiming for a reason unrelated to anything it touches, which is the
over-tightening failure mode LLP 0328#loud-refusal describes: quieter than the
escape, and worse.

One `path.resolve` first, and the resolved spelling is what is checked, walked,
and reported. `lstat` answers about a link only when the path *names* the link;
a trailing `/` or `/.` makes the kernel resolve the last component. That was a
live bypass in 0328's own first fix, where detach handed the sweep the attach
marker's `spool_dir` verbatim.

Neither of the two new passes has a live bypass of that shape today, and each
control that pins the rule says so in place rather than implying a door it did
not measure. Both existing inputs are normalized upstream: a `cursor.tableDir`
whose `basename` differs from itself makes the whole cursor unreadable
(`generationDirIsContained`, LLP 0323#one-gate), and an index name containing
`/` is rejected by `INDEX_NAME_RE` before it reaches a decl. What the resolve
pins is the same thing the rest of this document pins: the property belongs to
the pass, so it holds for a caller that has not been through those gates. A
guard whose correctness rests on its current caller's input hygiene is the
guard-at-the-call-site defect wearing a different hat.

The refusal report moves to `src/core/cache/sweep_guard.js` so both cache
passes say the same sentence with the same `error_kind`, and it takes the
pass's own logger where the pass has one. That last part is why these guards
have a regression control on *speaking* at all, which no earlier one in the
series has: on a default install the global provider is null and the record is
dropped (#1108), so a refusal is otherwise indistinguishable from having
nothing to do.

## The seam and the check mean the same filesystem {#seam-answers-the-check}

**A pass whose reads and unlinks go through an injectable filesystem asks its
containment question of that same filesystem.** `sweepCaptureSpool` takes
`{ fs }` for `readdir`, `lstat`, and `rm`; its guard called `isConfirmedSymlink`,
which is `node:fs` `lstatSync`. An injected filesystem was therefore read by
the walk and never by the check, and the check did not merely abstain: it
returned `false`, because a path that does not exist on the real filesystem is
not a confirmed symlink. The seam failed **open**, on exactly the plant the
guard exists for.

Inert against production, where both callers pass real `fsp`, and that is the
point: a seam that disagrees with its guard is a defect measured only by
whatever takes the seam next.

`isConfirmedSymlinkVia` is the promise-API spelling of the same three clauses,
and it lives immediately beside `isConfirmedSymlink` in
`src/core/cache/paths.js`. LLP 0328#sweep-path warns against a second copy of
this predicate, and the warning is about drift a reader cannot see: a copy that
reached for `realpath`, or that read a throw as an escape, would be wrong in a
way nothing beside it made visible. Adjacency is the answer to that. `lstat`
rejecting is the promise API's spelling of `throwIfNoEntry: false` returning
`undefined`, so both forms accept on silence for the reason LLP
0326#positive-evidence settled.

It also removes a synchronous syscall per directory from an `async` walk, which
is a consequence rather than a motive.

## What this does not decide: the Claude body-spool cap {#body-spool-cap-deferred}

`enforceClaudeBodySpoolCap` (`hypaware-core/plugins-workspace/claude/src/
telemetry/spool.js`) is the closest twin of the door 0328 closed: it lists
`<hyp-home>/spool/claude-bodies`, the same directory, and `rm`s listed names
with no name predicate, from two callers that guard nothing. **It is
deliberately unchanged here**, and this section records why so the next reader
does not mistake the omission for an oversight.

Adding the guard to it, alone, removes a bound rather than only closing a door.
A spool path the sweep refuses is a spool `hyp purge` and detach no longer
empty; what keeps it from growing without limit today is precisely that the cap
enforcer is unguarded and follows the link, evicting oldest-first at the
configured cap. Guard the enforcer as well and nothing reclaims that directory
at all: the growth is unbounded, it is raw prompt bodies, and on a default
install no surface says so.

So the fix has a retention half, and the retention half is a choice between two
settled things rather than an implementation:

- Refuse and **surface**, so the user learns the relocated spool is no longer
  managed. The surface is the open question in #1108, which covers all four
  existing guards and states that it needs a decision rather than a patch. The
  claude source's `status()` details are not that surface: `hyp status` reads
  named fields out of them and renders no general details, and `SourceStatus`'s
  `degraded` state does not reach `SourceSnapshot`, whose states are the
  daemon's rather than the plugin's.
- Or decide that a symlinked client spool directory is **supported**, and make
  containment mean staying inside a resolved root rather than refusing links.
  That contradicts LLP 0328#the-door ("nothing we or a client write mints a
  symlink here, so a confirmed one means this is not a spool to empty") and is
  a replacement for it, not an extension.

Both are new requests. Neither is this one.

## Consequences {#consequences}

- `sweepIndexScratch` and the vector-search orphan sweep each reclaim nothing
  through a confirmed symlink on the path they walk, and say so; a second
  caller of either cannot acquire the deletion without the check.
- The scratch sweep no longer refuses on a symlinked `metadata/` sibling it
  never opens. That is a loosening, and the intended one: the components asked
  about are the components walked.
- `sweepCaptureSpool`'s guard reads whatever filesystem its caller injected.
  For the two production callers this is `fsp` and behaviour is unchanged.
- An ordinary generation, an ordinary index, a generation or index under a
  symlinked ancestor, and a directory the process cannot stat all behave as
  they did. Each of those is a control, and each dies under a blanket-refusal
  mutant except where stated in the test file.
- The Claude body-spool cap keeps its current behaviour, and with it the bound
  it puts on a spool the sweep refuses.
- A refused index directory accumulates orphaned shards, and a refused
  generation accumulates publish scratch, because each refused pass is the only
  reclaimer of what it reclaims. That is the same shape as the retention half
  of #body-spool-cap-deferred and it is accepted here rather than deferred, on
  two differences the deferral turns on: the contents are derived vectors and
  build scratch rather than raw prompt bodies, and the relocation a user
  actually performs (a state root or a cache root on another volume) is above
  the components these passes ask about, so it still reclaims. What is refused
  is a link at the leaf, which nothing in the tree mints.
- `orphansSwept` counts only sweeps that reached their unlinks. It reaches an
  operator through the vector source's `status()` details, and a refusal that
  incremented it would report deletion that did not happen, which is a worse
  reading of a refusal than the zero it is allowed to look like.
- One `lstat` per pass, against passes that already `readdir` and `stat` every
  file they weigh.
