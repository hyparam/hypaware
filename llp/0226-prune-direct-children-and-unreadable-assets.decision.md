# LLP 0226: The prune predicate narrows to direct children, and unreadable is not absent

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, Plugins, CLI
**Author:** Claude
**Date:** 2026-08-13
**Related:** LLP 0219 (#prune-on-materialize, #edited-assets-are-not-ours: the
two conditions this narrows), LLP 0138 (#one-materializer: the module both
conditions live in)

> Two narrowings of [LLP 0219](./0219-retired-client-assets-are-pruned.decision.md),
> found by the ship review of [#745](https://github.com/hyparam/hypaware/pull/745)
> and closed under [#746](https://github.com/hyparam/hypaware/issues/746): a
> prune candidate must be a direct child of a client's asset directory, not
> merely somewhere inside it, and a path the prune could not read is not the
> same fact as a path that is not there.
>
> @ref LLP 0219#prune-on-materialize [constrained-by]: narrows condition three
>   to a direct child rather than "strictly inside"; see #only-direct-children.
> @ref LLP 0219#edited-assets-are-not-ours [constrained-by]: splits the "no
>   digest" outcome into gone vs. unreadable; see #unreadable-is-not-absent.

## Context {#context}

LLP 0219 #prune-on-materialize's third condition asks whether a recorded
destination "sits strictly inside that client's own asset directories." That
is the right shape for containment but the wrong shape for evidence: the
materializer only ever writes `<base>/<name>` or `<base>/<name>.md`, over a
name `isSafeContributionName` has already forced to a single safe path
segment, so nothing HypAware has ever written is deeper than a direct child.
"Strictly inside" is wider than the writer, and the gap is a recursive
delete: a corrupt ledger record naming
`<skills>/<a-skill-this-run-is-installing>/subdir`, carrying a digest that
really does match that subtree, takes a slice out of a currently-live asset
on no authority but the record's shape.

Separately, LLP 0219 #edited-assets-are-not-ours's digest gate reads "no
digest" as one outcome, and `digestClientAsset` returned `undefined` for both
a path that is `ENOENT` and a path that exists but could not be read to
completion (an `EACCES` partway through a skill tree). Only the first is
"already gone." Collapsing the second into it dropped the ledger record in
silence while the copy was still on disk: permanently unprunable, because
nothing names the path any more, and permanently unreportable, for the same
reason - the exact leave-behind LLP 0219 exists to end.

Both were found by the same ship review, against hostile fixtures built to
extend the `#745` / `#746` line of attack, and both are hardening rather than
regressions on the shipped head: neither is reachable without a writer
already inside the trust domain the ledger lives in.

## Decision {#decision}

**A candidate must be a direct child of an asset directory**
{#only-direct-children}: narrows LLP 0219 #prune-on-materialize's third
condition rather than replacing it. Every write the materializer makes is
`<base>/<name>` or `<base>/<name>.md`, over a name that registration has
already forced to a single safe path segment, so "strictly inside the
client's asset directories" is wider than the writer: it also admits
`<skills>/<a-skill-this-run-is-installing>/subdir`, where one corrupt record
carrying a valid digest would take a subtree out of a live asset. The delete
side now admits exactly the shape the copy side writes and nothing beneath
it, which costs nothing (no path we ever wrote is deeper) and removes a
class of recursive delete that pure record corruption could otherwise reach.

The predicate is a strict conjunct of the one it narrows, not a stand-in for
it: `path.dirname(resolved) === base` is checked *alongside*
`isWithinDir(resolved, base)` (`src/core/runtime/contribution_names.js`),
never instead of it. `isWithinDir` refuses on a **prefix** test
(`rel.startsWith('..')`), not a path-segment test, so a basename beginning
with `..` (`<skills>/..stash`) is a name `path.dirname` alone would admit as
a direct child while the prefix test still refuses it, because
`path.relative(base, '<base>/..stash')` is the string `'..stash'`, which
starts with `'..'`. Dropping the conjunct would widen the predicate for
exactly that shape of name - a user-authored directory refused by the
pre-narrowing predicate and deleted by a `dirname`-only one - which is not a
narrowing at all. Keeping it is what makes "a direct child" a pure subset of
"strictly inside" rather than a different rule that happens to overlap it.
`isWithinDir` itself is unchanged here: it is shared with the write side
(`planClientAssets`), and loosening its prefix test there would let a
`..`-prefixed contribution name be written in the first place.

**An unreadable asset is not an absent one** {#unreadable-is-not-absent}:
reading a candidate produces three outcomes, not two: a digest, a path that
is not there (`ENOENT`, including a dangling symlink sitting at the
destination itself: `fs.stat` follows it and finds nothing), and a path that
is there but could not be read (an `EACCES` on a file inside an installed
skill, a device error, a file the walk just listed that is gone by the time
it tries to read it). Only the second is "already gone," and only the second
may drop the record in silence. The third keeps
the record, verbatim and with no digest re-taken, and reports the path
withheld with a `digest_unreadable` kind, because the copy is still on disk
and still model-invocable, and dropping the only record naming it makes it
permanently unprunable *and* unreportable, which is the leave-behind
LLP 0219 exists to end. The distinction keeps LLP 0219's claim that
unreadable things only ever remove *less* true of assets as well as of
ledger records.

The scoping is structural, not a branch to keep in sync by hand:
`inspectClientAsset` probes the top-level `fs.stat` in its own `try`, and
only that probe's `ENOENT` sets `missing`. Anything thrown while walking a
directory or reading a file (an `EACCES` three levels into a skill tree, a
device error, a file `readdir` just listed that is gone by the time
`readFile` reaches it) is caught by a second, narrower `try` that always
returns `missing: false`, so a new failure mode inside the walk cannot
silently migrate into "gone" the way it could when one `try` wrapped
`fs.stat`, `hashTree`, and `fs.readFile` together. A dangling symlink
*inside* the tree never reaches either `try`'s error path: `hashTree` reads
shape from `readdir`'s `Dirent` entries without following them, so a
symlink whose target is gone hashes as an opaque entry by name, same as one
whose target exists; nothing about it is unreadable in the first place.

## Consequences {#consequences}

- A corrupt ledger record naming a path deeper than the materializer ever
  writes is refused with the same "outside ... or deeper into them than
  HypAware writes" message `isRemovableAsset` already produces for
  out-of-tree paths, rather than being honoured because it happens to carry
  a matching digest.
- An unreadable entry inside an installed skill, or a file the walk lists and
  then loses to a concurrent actor, keeps the ledger record and is reported
  withheld instead of being read as already removed. The record survives to
  the next run, when a permissions fix (or the concurrent actor finishing its
  own write) lets the ordinary digest-matched prune finish the job. A dangling
  symlink at `dest` itself is not this case: `fs.stat` follows it, finds
  nothing, and the record is dropped as gone, same as any other `ENOENT` at
  `dest`.
- Neither narrowing changes what LLP 0219 §Consequences already says about a
  boot that lost part of its plugin set, about pre-ledger installs, or about
  the check-then-act residual: both are narrower readings of conditions
  LLP 0219 already gates on, not new gates.
