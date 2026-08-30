# LLP 0328: A spool path is checked where it is walked, not only where it is spelled

**Type:** Decision
**Status:** Accepted
**Systems:** Privacy, Config, CLI, Clients
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-08-30
**Extends:** [LLP 0253](./0253-body-spool-is-capped-and-swept.decision.md)
(#purge-and-detach-sweep: the sweep now asks the filesystem about each
directory as well as asking the string about the name)
**Extended-by:** [LLP 0331](./0331-a-deleting-pass-carries-its-own-check.decision.md)
(#sweep-path: "the code that deletes" is the function rather than its caller,
and "the filesystem" is the one the walk reads rather than `node:fs`)
**Related:** LLP 0258, LLP 0323, LLP 0326

> `isCaptureSpoolDir` decides whether a name is a spool this install owns, and
> it is string work: `path.resolve` performs no `readlink`, so
> `<hyp-home>/spool/claude-bodies` can be a direct child of the spool root by
> spelling and a symlink in fact. `sweepCaptureSpool` then hands that path to
> `readdir`, which follows it, and removes every file it lists with no name
> predicate and no grace window, recursing through real subdirectories. Both
> shapes were measured emptying a tree outside the HypAware home. The sweep now
> asks the one question LLP 0326 settled, `lstat`, is this a symlink, about each
> directory at the moment it walks it, and refuses out loud. Only a symlink the
> filesystem confirms refuses anything.

## The door, and why the string gate could not see it {#the-door}

LLP 0253#purge-and-detach-sweep settles that `hyp purge` and `hyp detach` both
empty the spool. Detach learns the directory from the attach marker (LLP
0258#marker-and-spool), which lives in the user's own settings file, so
`isCaptureSpoolDir` exists to keep "empty the directory the marker names" from
being a recursive-delete primitive pointed anywhere. It is the same mechanism
LLP 0323 used for `cursor.tableDir` and it has the same blind spot LLP 0326
measured there: `path.resolve` folds `..` and stops, and a bare name that
happens to be a symlink is contained by spelling and elsewhere in fact.

Two shapes were measured deleting outside the HypAware home at `a77b16f5`, and
both were reproduced on this branch before the guard:

- **Detach.** `<hyp-home>/spool/claude-bodies -> <outside>` passes
  `isCaptureSpoolDir`, because its parent really is `<hyp-home>/spool`. The
  sweep emptied `<outside>`, `<outside>/sub` included.
- **Purge.** `<hyp-home>/spool` itself a symlink. `hyp purge` sweeps the root
  unconditionally, whatever the target was, so this plant needs no settings
  edit at all: one symlink inside the user's own HypAware home is the whole of
  it. The sweep emptied `<outside>`, nested directories included.

The reach is what makes this worth its own document rather than a note on LLP
0326. The passes 0326 guarded delete by a name predicate (`staged-`,
`flush-`) inside a grace window; this one deletes every file it lists. And the
trigger is a user-invoked verb the user believes touches only HypAware data,
so the confused-deputy story is the strongest form of it: `hyp purge` carries
whatever the invoking user can reach, to a tree they were not asked about.

A symlinked *client* directory under a real root was safe before this change
and is unaffected by it: the walk lists that dirent, `entry.isDirectory()` is
false, and the link itself is removed rather than followed. The gap was never
the dirents. It was the one path no dirent ever described, the entry path the
sweep was handed.

## The check is LLP 0326's, at each directory the walk dequeues {#sweep-path}

**Before `readdir`, the sweep asks `isConfirmedSymlink` about the directory it
is about to walk. A confirmed symlink empties nothing beneath it and is
reported; anything else proceeds.** The check is asked inside the loop, so it
covers the entry path and every subdirectory on the same terms, because the
question is about the path this iteration will walk rather than about who
supplied it.

That is LLP 0326#one-level-down's general statement (a pass that unlinks by
path checks the path it will walk, at the point it walks it) reaching its
fourth pass and its first subsystem outside the cache. The principle is not
about generations or cursors; it is about the gap between a name a string
gate approved and a path a syscall will follow, and that gap opens wherever
the two are separated. Nothing here re-decides 0326: the same function, the
same asymmetry, the same reason.

`isConfirmedSymlink` rather than a second copy, and imported from
`src/core/cache/paths.js` rather than reimplemented next to the spool. Its
entire content is the asymmetry in LLP 0326#positive-evidence, and a copy that
drifted toward `realpath`, or toward reading a throw as an escape, is a defect
nothing beside it makes visible. The import direction (core reaching into the
cache subsystem for a filesystem predicate) is worth less than a check that
can disagree with itself.

## Rejection still needs positive evidence {#positive-evidence}

An unanswerable `lstat` accepts, exactly as LLP 0326#positive-evidence
settled, and the cost of getting this backwards is specific here. A refusal
returns the same zero counts an empty spool returns. The `readdir` behind an
unanswerable stat, by contrast, fails and is counted, and that count is what
produces detach's "N items in the body spool could not be removed; empty
`<dir>` by hand". Reading silence as an escape would convert the one line that
tells a user to act into an indistinguishable success.

The TOCTOU boundary LLP 0326 recorded is unchanged and is restated here
because this document's passes are user-invoked rather than periodic: the
`lstat` is at walk time and the `rm` runs after, so a swap in between still
wins. This is a bar, not a guarantee. Closing it means carrying a directory
descriptor from the check to every unlink, which is a different design.

## Saying so is half the guard {#loud-refusal}

A guard on a deleting pass fails silently by construction: the verb still
succeeds, and a spool that has quietly stopped being emptied looks exactly
like a spool that was already empty. The refusal logs `error_kind:
capture_spool_path_is_symlink` under `hyp_operation: capture_spool.sweep`,
with the spool it was asked to empty and the component that refused, so `ls
-l` at one of them answers in one line.

Its own `error_kind`, not the cache's `sweep_path_is_symlink` or
`spool_dir_is_symlink`: this is a different spool in a different subsystem
(raw request bodies under the HypAware home, not `_hypaware_spool` inside a
cache partition), and the two would otherwise be one message for two states an
operator resolves differently.

The refused paths are directories, and LLP 0253's privacy rule for this file
(counts, never names) bounds the spooled bodies, whose names are the client's
and whose contents are raw prompts. A spool directory is one we or the attach
marker named.

## Consequences {#consequences}

- Neither `hyp purge` nor `hyp detach` empties a tree through a symlinked
  spool path, and the tree the link points at is left whole, nested
  directories included.
- A spool that refuses is visible in the log rather than only in the absence
  of a count.
- An ordinary spool, an absent spool, a spool under a symlinked `$HYP_HOME`,
  and a spool the process cannot stat all behave as they did. The last of
  those still reports `failed`, which is the user-facing half of positive
  evidence.
- `isCaptureSpoolDir` is unchanged. It answers a different question (may this
  marker aim the sweep here at all) and it is still the gate that keeps a
  hand-edited marker from naming `/etc`. This decision adds the question the
  string could not answer; it does not replace the string.
- One `lstat` per directory the sweep walks, against a pass that already
  `readdir`s and `lstat`s every file inside it.
