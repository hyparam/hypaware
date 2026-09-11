# LLP 0402: the tree digest frames what it hashes, and the boot heal is the migration

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, Plugins, Daemon
**Author:** Claude
**Date:** 2026-09-11
**Related:** LLP 0219 (#edited-assets-are-not-ours: the evidence rule whose measure this repairs, and its "the digest separates shapes, not only bytes" paragraph), LLP 0284 (#digests-are-per-path: which records the gate reads), LLP 0397 (#ledger-decides: the boot refresh the migration rides), LLP 0400 (#source-equality-is-ownership, #one-write: the healing this re-uses as the re-record, and the write budget it stays inside), LLP 0401 (#digest-covers-the-copy: the set the hash covers, unchanged here; #migration: the hazard this one has to answer for)
**Extends:** LLP 0219, LLP 0400

> Inside the directory domain the hash input was ambiguous: each entry framed
> its shape and path, and then the bytes ran on unframed to the next entry's
> line. Two files of `''` and `'hello'` wrote the same stream as one file
> holding `f:b\nhello`, so a crafted edit kept the recorded digest intact and
> the prune deleted a copy the user had taken over ([#1669](https://github.com/hyparam/hypaware/issues/1669)).
> This settles that every variable-length run in the stream carries its own
> byte length, and that the re-record the new framing forces is the heal
> LLP 0400 already performs rather than a version tag on the record.

## Context {#context}

[LLP 0219 #edited-assets-are-not-ours](./0219-retired-client-assets-are-pruned.decision.md#edited-assets-are-not-ours)
makes one digest the whole of the evidence that a retired copy is HypAware's to
delete, and its own paragraph on the hasher says why the shape is seeded into
the stream: a collision "hands a file the user wrote a digest that was recorded
for something else, which is the one thing a match may never mean". The seed
made the *file* and *directory* domains disjoint. It bought nothing inside the
directory domain, where the walk wrote `f:<relpath>\n` and then the file's bytes
with no boundary after them:

```
tree A: { a: '',  b: 'hello' }   ->  dir\n  f:a\n  f:b\n hello
tree B: { a: 'f:b\nhello' }      ->  dir\n  f:a\n  f:b\nhello
both digest 561a36c026fd225bfef889ab7b15796c46e4d8aba852f55615e7248d6b02573c
```

Every consumer of the digest inherits that. `pruneOneAsset` reaches
`recorded.has(digest) === true` on the crafted copy and `fs.rm(dest, { recursive: true })`
takes the directory instead of withholding it; `refreshClientAssets` reports the
same copy `unchanged` and never `asset_edited`. It takes a deliberately crafted
edit, not an accident, and the copy is one the user already owns - but it is
exactly the property the hasher exists to have, and the path it gates is a
delete.

Framing the bytes is one line. The hard half is that **it changes every digest
the hasher produces for a tree**, which is the migration hazard
[LLP 0401 #migration](./0401-the-asset-digest-covers-what-the-copier-carries.decision.md#migration)
cites when it refuses the copier-side alternative: every digest already in
`client-assets.json` stops matching, and on the next boot every installed skill
is reported `asset_edited`, frozen, never refreshed again, and never prunable.

## Decision {#decision}

**Every variable-length run in the tree's hash input is preceded by its own byte
length** {#framed-entries}.

- Each entry line becomes `<shape>:<byte length of relpath>:<relpath>\n`, and a
  file's bytes are preceded by `<byte length>\n`. Nothing that follows an entry
  can be read as part of it, so the stream is self-delimiting and distinct trees
  produce distinct streams.

- **The path is framed as well as the bytes.** Framing the bytes alone closes
  the reported pair and leaves the same ambiguity one level up, because a file
  name may itself hold a `\n`: a file named `a\n2` holding nothing writes the
  same bytes-framed stream as a file named `a` holding `0\n`. The name is the
  half of an entry the user controls most directly, so leaving it unframed
  leaves the crafted-edit family open at the cheapest point of entry.

- **The single-file domain is left exactly as it is** {#file-domain-untouched}.
  `file\n` followed by the whole of the bytes is already injective: there is
  nothing after the bytes for them to be confused with. Framing it would change
  every subagent digest for no property gained, so every `agent` record in every
  shipped ledger still matches, and the migration below reaches only skills.

- **The set the hash covers does not move.** Files and directories, and nothing
  else, exactly as
  [LLP 0401 #digest-covers-the-copy](./0401-the-asset-digest-covers-what-the-copier-carries.decision.md#digest-covers-the-copy)
  settled. This changes how the covered entries are framed, never which entries
  they are.

**The re-record is the boot heal, not a version tag** {#migration-is-the-boot-heal}.

A skill's recorded digest no longer matches the copy it names, and the first
boot on the new version meets that. It is already answered:
[LLP 0400 #source-equality-is-ownership](./0400-source-equality-heals-a-stale-record.decision.md#source-equality-is-ownership)
decides that a copy whose bytes digest equal to the *current source* is
HypAware's own and heals its record to what is on disk. Both digests in that
comparison are taken by the new hasher, so an untouched copy of an unchanged
source satisfies it on the first boot: the record is re-recorded, nothing is
copied, and the pass says `client_assets.refresh_record_healed` instead of
warning. The heal rides the pass's single post-loop write, so the migration
costs one ledger write per home and stays inside
[#one-write](./0400-source-equality-heals-a-stale-record.decision.md#one-write).

- **It cannot adopt a copy the user edited** {#no-silent-adoption}. The heal is
  gated on equality with the source, never on the record being old. A copy the
  user took over digests equal to neither, so it takes the `asset_edited` exit
  it takes today: named on stderr, left alone, never re-recorded, and still not
  prunable. The only copy this adopts is one byte-identical to what a refresh
  would write right now, which 0400 already settled is ours ("a user who edited
  a copy into byte-identity with the current source has written our bytes, and
  gets our bytes"). A migration that re-recorded whatever was on disk would hand
  the prune a matching digest for a file the user authored, which is worse than
  the collision it closed.

- **A version tag on the recorded digest is rejected.** Recognizing an
  old-format record is only useful if the old hasher is then run against the
  copy to decide it, which means shipping the colliding hasher forever and
  keeping it authoritative on the delete path this document exists to close -
  for precisely the records that have not been re-recorded yet, which is the
  whole population at migration time. It also adds a format to a field every
  reader today treats as opaque. Recognition without re-verification buys
  nothing the heal does not already give.

- **The ledger's own `version` is not bumped.** It looks like the instrument and
  is the wrong one: the record *shape* is unchanged, and an unknown version
  reads as an empty ledger, which makes `refreshClientAssets` return before it
  can heal anything. That trades a one-boot re-record for assets that are never
  refreshed and never pruned again until someone re-runs `hyp skills install`.

- **The residue is named, not healed** {#residue}. Two cases the heal cannot
  reach, both of which fail towards reporting and away from deleting:

  - A skill whose *source* also moved across the upgrade span matches neither
    its record nor the new source. It is reported `asset_edited`, and the
    warning already names the repair: `hyp skills install`. This is not only
    the host that skipped several releases: a *single* release that lands this
    framing and also edits a shipped skill body puts every skill it edited
    here, and every later boot repeats the report until the repair is run. So
    the release landing this changes no skill source, or its notes name each
    skill it did. On a daemon boot that report is
    `client_assets.refresh_skipped` with `asset_edited` in `daemon.log` and not
    a line on the terminal, because the boot refresh passes no `stderr` by
    design (LLP 0397); the copy itself is left exactly as it was.
  - A skill retired *in the same upgrade* has no source to be equal to, so the
    prune finds no matching record, withholds the directory, and reports
    `asset_modified`. A leave-behind the user is told about, which is the
    direction LLP 0219 and LLP 0226 both choose when the evidence is gone.

  Accepted because the alternative for either is a delete or an adoption made on
  evidence that no longer exists.

## Consequences {#consequences}

- Two distinct skill trees can no longer share a digest, so the prune's evidence
  gate means what
  [LLP 0219 #edited-assets-are-not-ours](./0219-retired-client-assets-are-pruned.decision.md#edited-assets-are-not-ours)
  says it means. Pinned by a test that fails on the previous hasher, and by a
  second assertion that fails on a hasher framing only the bytes.
- Every skill digest recorded by a previous release changes; every agent digest
  is unchanged. The first boot after the update heals the skill records it can
  and names the ones it cannot.
- Per entry the hasher does one extra `Buffer.byteLength` over a short relative
  path and one extra `hash.update` of a short string; per file it hashes the
  buffer `readFile` already returned. No second read, no copy of the bytes, no
  extra ledger write.
- A release landing this is a release that changes a recorded digest format in
  all but name, so it is worth a release note: the first boot logs
  `client_assets.refresh_record_healed` for each installed skill, and a host
  sees one `asset_edited` report per skill whose source moved in the same span,
  whether that span is several releases or the one release landing this.
- The heal runs inside the boot refresh, which only the daemon calls. A host
  that never starts the daemon keeps its old-format records indefinitely, and
  that is the safe direction: the prune withholds and reports on a record it
  cannot match, and the next `hyp skills install` re-records every copy it
  writes.
