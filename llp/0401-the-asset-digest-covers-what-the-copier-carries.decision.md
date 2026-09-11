# LLP 0401: the asset digest covers exactly what the copier carries

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, Plugins, Daemon
**Author:** Claude
**Date:** 2026-09-11
**Related:** LLP 0219 (#edited-assets-are-not-ours: the evidence rule this narrows), LLP 0226 (#unreadable-is-not-absent: the paragraph whose supporting sentence this makes obsolete), LLP 0284 (#digests-are-per-path: which records the gate reads), LLP 0397 (#ledger-decides: the boot refresh whose unchanged check this makes reachable), LLP 0400 (#one-write: the per-boot write this stops)
**Extends:** LLP 0219

> `copyDir` copies files and directories and skips every other entry;
> `hashTree` folded any other entry into the digest as an `o:<relpath>` line. A
> source tree holding a symlink could therefore never digest equal to the copy
> made of it, so the boot refresh re-copied the tree and rewrote the ledger on
> every boot, forever. This settles that the digest covers exactly the set the
> copier carries, and states the edit-detection that narrowing gives up.

## Context {#context}

[LLP 0397 #ledger-decides](./0397-installed-client-assets-follow-the-update.decision.md#ledger-decides)
decides an installed copy by comparing `digest(source)` with the digest
recorded for the copy. That comparison presumes the two are asked the same
question. They were not: the copier's set of entries and the hasher's set were
written independently and disagreed on everything that is neither a file nor a
directory.

For a source tree holding one such entry the disagreement is total and
permanent. `digest(source)` carries an `o:` line the copy can never carry, so
the unchanged check fails on every boot, the whole tree is re-copied, the new
digest is recorded, and the post-loop ledger write runs with byte-identical
content every time. That is the repeated per-boot work and the per-boot write
[LLP 0400 #one-write](./0400-source-equality-heals-a-stale-record.decision.md#one-write)
rejects, and it is silent except as an endless `refreshed` line
([#1666](https://github.com/hyparam/hypaware/issues/1666)). No shipped skill
source holds such an entry today, but a `local-dir` plugin source can.

Two directions close it: teach the copier to carry what the hasher covers, or
narrow the hasher to what the copier carries.

## Decision {#decision}

**The digest covers exactly the set `copyDir` copies: files and directories,
and nothing else** {#digest-covers-the-copy}.

- **The copier is the authority, not the hasher.** What the copy does not hold,
  the digest does not cover. The invariant the refresh needs is one-directional:
  the hash may never cover something the copy cannot carry. Narrowing the hasher
  satisfies it for every entry kind at once.

- **The copier is not taught to carry them.** Three reasons, in order of weight.
  A recreated symlink is a pointer the plugin tree chose, materialized into
  `~/.claude/skills`, which the client loads as skill content: the copier would
  gain the ability to place a reference to anywhere on disk into a directory it
  otherwise only ever writes plain files into. A fifo, socket, or device cannot
  be recreated at all without reaching outside the standard library, so that
  direction closes the symlink case and leaves the identical bug for the rest.
  And copying a symlink changes `digest(copy)`, which invalidates every ledger
  digest already recorded for such a tree and freezes those assets as
  `asset_edited` with no self-repair.

- **Recorded digests survive** {#migration}. Skipping changes the digest only of
  a tree that holds an entry the copier already skipped, so every digest ever
  recorded for a tree the copier wrote is unchanged. Verified against the
  shipped trees before landing: `src`, `src/core/cli`, `hypaware-core/plugins-workspace`,
  and every `skills/` and `agents/` directory digest byte-identically under both
  versions. No migration, and no boot that reports a copy as edited because the
  hasher moved under it.

- **Edit detection narrows to the same set** {#edit-detection-narrows}. This is
  the price, and it is a real narrowing of
  [LLP 0219 #edited-assets-are-not-ours](./0219-retired-client-assets-are-pruned.decision.md#edited-assets-are-not-ours),
  which reads the digest as the measure of "the user took this copy over". A
  symlink the user drops into an installed copy no longer moves the digest, so
  the copy still matches its record: the refresh overwrites it on the next
  source change instead of reporting `asset_edited`, and a prune of the retired
  asset removes the directory (the link with it, never its target) instead of
  withholding it. A file or a directory the user adds, and any edit to the bytes
  of a file already there, still move the digest and still stop both.

  Accepted because the alternative is worse in the same terms: covering the
  entry buys edit detection for one entry kind and pays for it with a tree that
  can never settle, is re-copied on every boot, and whose next copy overwrites
  the user's entry anyway.

## Consequences {#consequences}

- A source tree holding a symlink settles: the boot after the copy reports it
  unchanged, copies nothing, and writes no ledger. Pinned by a test that fails
  on the previous hasher.
- The hasher does strictly less work per skipped entry (no `path.join`, no
  `path.relative`, no `hash.update`) and the same work per entry it keeps.
- Two trees differing only in entries the copier skips now digest identically.
  Every digest consumer sees that: the refresh's unchanged check, the record the
  materializer writes, and the prune's ownership evidence. The prune's other
  gates are untouched, including the shape check that refuses a candidate whose
  file-or-directory kind contradicts its record.
- The `o:` line is gone from the hash input. Nothing ever parsed it: the digest
  is opaque to every reader, compared only against another digest produced by
  the same function.
- [LLP 0226 #unreadable-is-not-absent](./0226-prune-direct-children-and-unreadable-assets.decision.md#unreadable-is-not-absent)
  is unaffected in what it decided, but its supporting sentence that a dangling
  symlink inside the tree "hashes as an opaque entry by name" no longer
  describes the code. The conclusion that sentence supports still holds, and for
  a stronger reason: a skipped entry reaches neither `try`'s error path at all.
