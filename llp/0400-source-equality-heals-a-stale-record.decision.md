# LLP 0400: bytes equal to the current source are evidence the copy is ours

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, Plugins, Daemon
**Author:** Claude
**Date:** 2026-09-11
**Related:** LLP 0219 (#edited-assets-are-not-ours: the evidence rule this widens, for healing only), LLP 0284 (#digests-are-per-path: which digests the gate is asked of, and its "none re-recorded" clause), LLP 0397 (#ledger-decides, #edited-copies-are-kept: the refresh pass this runs inside), LLP 0226 (#unreadable-is-not-absent: the other narrowing of the same rule)
**Extends:** LLP 0219, LLP 0284, LLP 0397
**Extended-by:** LLP 0402 (#migration-is-the-boot-heal: gives #source-equality-is-ownership a second job, as the one-boot re-record that carries every skill record across a change of hasher; what heals and what is reported is unchanged)

> The boot refresh rewrites every stale copy and then writes the ledger once,
> after the whole loop. A kill inside that loop (a `hyp daemon restart` landing
> in the boot window) leaves every copy it already swapped in recorded under the
> digest of the bytes it replaced. This settles that a copy whose bytes digest
> equal to the *current source* is recognized as HypAware's own and its record is
> healed to what is on disk, so an interrupted pass converges on the next boot
> instead of freezing the copy as an edit forever.

## Context {#context}

[LLP 0397 #ledger-decides](./0397-installed-client-assets-follow-the-update.decision.md#ledger-decides)
decides each installed copy by two digests, and writes the ledger once for the
whole pass. One write is deliberate: a write per asset multiplies one write into
N, and still leaves a window between the rename that swaps the new bytes in and
the write that records them.

That window has a terminal cost. Between `replaceAsset` and the single write,
every copy already swapped in is on disk as the new source while its record
still names the bytes it replaced. A kill there (SIGKILL, a power loss, a
`hyp daemon restart` inside the boot window) and, from the next boot on, each
such copy matches no digest recorded for its path. Three consequences follow,
none of them recoverable by anything the daemon does again:

- [LLP 0397 #edited-copies-are-kept](./0397-installed-client-assets-follow-the-update.decision.md#edited-copies-are-kept)
  reports it as a user edit, on stderr and as `client_assets.refresh_skipped`
  with `error_kind` `asset_edited`, on every boot.
- It is never refreshed again, so the next real source change does not reach it.
- [LLP 0219 #edited-assets-are-not-ours](./0219-retired-client-assets-are-pruned.decision.md#edited-assets-are-not-ours)
  fails on the same mismatch when the asset is retired, so the copy can never be
  pruned off the machine.

The bytes on disk are the correct new ones. Only the record is stale, and the
report blames the user for a rewrite HypAware made itself, which is the same
misattribution [LLP 0284](./0284-recorded-digests-are-per-path.decision.md)
found in the prune and for the same underlying reason: a record can go stale
about a path HypAware itself wrote.

What 0284 fixed was *which* recorded digests the gate reads. It explicitly
re-recorded nothing ("No new evidence, and none re-recorded"), because for a
shared destination the bytes were already covered by some other client's record.
Here no record covers them at all: every record for the path names the replaced
bytes. So the widening this window needs is not another digest column to read,
it is a second kind of evidence.

## Decision {#decision}

**A copy whose bytes digest equal to the current source is HypAware's own, and
its record is healed to the digest observed on disk** {#source-equality-is-ownership}.

- **Equality with the source is ownership evidence.** A recorded digest says
  "HypAware put these bytes here". Bytes identical to what a refresh would write
  right now say the same thing about the same path, from the other end: they are
  what this pass would have produced, so no copy is made and nothing on disk
  changes. The only thing that changes is the record, which stops claiming bytes
  that are not there.

- **Healing rides the pass's one ledger write** {#one-write}. The healed digest
  joins the map of digests the pass already carries into the single post-loop
  write, so a boot that heals and copies nothing writes the ledger once, and a
  boot that heals nothing writes it as before. Per-asset writes stay rejected:
  they multiply one write into N and leave the same window they were meant to
  close.

- **The gate on the rewrite is unchanged.** A copy the user took over still
  matches no recorded digest *and* differs from the source, so it is still named
  and still left alone. Healing can only ever move a copy from "reported as
  edited" to "recorded as ours", and only where the bytes are ones a refresh
  would have written anyway. A user who edited a copy into byte-identity with
  the current source has written our bytes, and gets our bytes.

- **Nothing else about 0219 or 0284 moves** {#not-changed}. The prune's
  evidence gate is untouched: it still acts only on a recorded digest that
  matches, still reads every digest recorded for the path, still treats "no
  recorded digest" as no evidence, and still refuses a candidate whose shape
  contradicts its record. Source equality is evidence for *healing a record*,
  never for removing a file. The prune benefits only downstream, because the
  record it later reads is no longer stale.

- **Healing is reported.** `client_assets.refresh_record_healed` names the
  destination at info level, so a boot that repairs an interrupted predecessor
  says so rather than silently differing from the boot before it.

## Consequences {#consequences}

- An interrupted refresh costs one boot, not the asset, as long as the sources
  have not moved on again: the next boot heals every record the killed pass
  left behind and reports them as unchanged.
- The healing is not total, and the evidence is why. A copy left holding bytes
  the source itself no longer holds, because a second update landed between the
  kill and the healing boot, matches neither its record nor the source. It is
  still reported as an edit, still never refreshed, and still not prunable, and
  `hyp skills install` is still the repair. Nothing at that later boot can tell
  our orphaned rewrite from a copy the user took over, and the two things that
  could (recording the digest before the swap, a write per asset) are the ones
  #one-write rejects.
- A copy frozen as `edited` by this window on an already-shipped version repairs
  itself on the first boot after this change whose source still holds the bytes
  the copy holds, with no `hyp skills install`.
- The source digest is now read for a copy that matches no record, which the
  previous order skipped. That is one extra hash of a source tree per unmatched
  copy per boot, bounded by the ledger. A copy that cannot be read at all is
  still decided before any source is hashed.
- The two reasons a copy is reported as edited are no longer distinguishable
  from the record alone: a report now means the bytes are neither recorded nor
  the source's. That is the stronger claim, and it is the one the message makes.
