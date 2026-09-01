# LLP 0347: An append refuses a cursor it cannot read

**Type:** Decision
**Status:** Accepted
**Systems:** Cache
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-09-01
**Extends:** [LLP 0323](./0323-cursor-names-a-generation-in-its-own-partition.decision.md)
(#consequences: the healing append that decision recorded as a bad trade is
withdrawn for the case that made it bad, and the rows wait in the spool
instead)
**Related:** LLP 0013, LLP 0027, LLP 0310, LLP 0322, LLP 0326, LLP 0332,
LLP 0334, LLP 0344, hyparam/hypaware#1170

> `tryReadCursorSync` answers null for a `cursor.json` that is missing and
> for one that is present but does not read, and the two append paths in
> `src/core/cache/partition.js` then spelled out `readCursorSync`'s epoch-0
> default over both. On a fresh partition that default is the truth. On a
> partition already compacted onto a `table-<ms>` it is a guess, and the
> wrong one: the append publishes `table` as the live generation, the real
> one is left named by nothing, and the orphan sweep reclaims it once it
> ages past `ORPHAN_GRACE_MS`. The rows the partition held before that
> append are then gone. An append onto a cursor that is present and
> unreadable is refused, and the distinction is drawn on the file's
> presence, not on the reader's answer.

## Context {#context}

LLP 0323#whole-cursor refuses a non-string `tableDir` rather than dropping
the field, and says why in as many words: dropping it would leave a cursor
that still reads as source-table, still names the default `table`, and costs
a `table-<ms>` partition its live generation to the orphan sweep. The read
path holds that line for every destructive reader (LLP 0323#one-gate). The
write path re-derived the same guess one function later.

LLP 0323#consequences saw the consequence and accepted it: "Healing restores
maintenance, not rows. On a partition whose live generation was a
`table-<ms>`, the append writes a fresh `table` and the previous generation
is left named by nothing ... This is a cache and the rows are re-derivable,
and the pre-fix behaviour was a destructive sweep OUTSIDE the cache, so it
is the better end of a bad trade."

Two things have moved since.

The trade is no longer between those two ends. That paragraph priced healing
against the escaping-cursor sweep it was replacing, and the alternative on
the table was not "refuse". Refusing costs neither the outside directory nor
the rows.

And "the rows are re-derivable" is a claim about the cache, not about every
row in it. It holds for a projection with a live source (the context graph
re-projects, LLP 0023). It does not hold for `ai_gateway_messages`, whose
rows are the only record of traffic that has already happened: nothing
re-derives a proxied exchange from a transcript the client has since rotated
away. `hyp` deleting those locally and silently is the outcome retention
itself is written to avoid doing by accident (LLP 0344#unreadable-cursor
opens on the asymmetry: an under-delete is a disk bug an operator can see,
an over-delete is unrecoverable).

An independent reproduction of #1170 on a compacted partition holding six
rows: corrupt the cursor, append one row, age past the grace window, run
`maintainCache`. The partition reads back as `[7]`.

## An unreadable cursor is not a fresh one, and the file says which {#file-not-reader}

`readCursorForAppend` in `src/core/cache/partition.js` is the whole of the
change. It reads through `tryReadCursorSync`, and on a null it asks the
filesystem whether a `cursor.json` is there at all:

- **Absent.** The partition is provably new and the epoch-0 default is a
  fact about it, not a guess. The first append publishes `table` exactly as
  it always has. This is the carve-out the change exists around: without it
  the refusal breaks every first write in the cache.
- **Absent, over a committed Iceberg table.** A crash between an append and
  its cursor write. The append restores the cursor over the table that is
  there, unchanged, because a cursor that is gone names no other generation
  to lose.
- **Present and unreadable.** The live generation is unknown, and no
  default recovers it. The append throws.

That predicate is not new. `partitionHasCommittedRows`, five lines further
down the same file, already draws it for the pending-fallback tally and
already says why: it is "deliberately NOT 'did `tryReadCursorSync` return a
cursor', which also answers null for a file that exists but cannot be
parsed, and a partition whose cursor is unreadable is not a fresh one". The
decision here is that the same sentence governs whether the append may run
at all, not only what it counts.

Both append paths take it, the source-table one and the legacy epoch one.
The epoch path reaches the identical default through `cursor.epoch` rather
than `cursor.tableDir`, so an unreadable cursor over a partition at
`epoch=3/` would republish epoch 0 and orphan the real generation by the
same route. A gate on one of two write paths is a gate that is wrong the day
the other one is used.

The refusal is silent on its own channel. `tryReadCursorSync` has reported
the cause since LLP 0332#transition-plus-rewarn, under a per-partition
window that retracts when a read stops refusing (LLP 0334
#recovery-is-announced); the thrown error says what the refusal cost, and
adding a second log line here would spend that window's whole point.

## The rows wait in the spool {#rows-wait}

"Refuse the append" is a write-path behaviour change, and the question it
has to answer is where the rows go. They go nowhere: they stay where they
already were.

Every append into the cache arrives from a spool flush
(`createQueryStorageService`'s `appendChunk` in
`src/core/cache/storage.js`). A flush whose append throws does not remove
the flush file it was draining, writes a failure stamp, and rethrows
(LLP 0322#stamp-the-failure). The next pass reads the stamp, skips the
rotation, and coalesces the stranded set rather than growing it
(LLP 0322#coalesce-the-retry). So a partition whose cursor stops reading
stops accepting rows, and the rows it did not accept are durable on disk
waiting for a cursor that reads. That machinery is already there for exactly
this: an append that cannot be completed now.

The cost is that such a partition's spool grows with ingest until something
repairs the cursor, and `hyp` does not repair one. That is the direction to
fail in. A stranded spool is bounded by the traffic to one partition, is
visible as pending bytes and a standing flush failure, and is recoverable by
hand; the behaviour it replaces destroyed committed rows on a schedule, with
nothing to look at afterwards.

## What this does not decide {#not-decided}

LLP 0344#unreadable-cursor holds the read side of the same fault and is
still open. This is the write-path analogue of its Option 2 (read through
`tryReadCursorSync` and refuse, rather than act on a synthesized default),
applied to the one caller whose action is not a delete but a publish, and it
settles nothing about retention's own reads. In particular it does not
decide whether a partition whose cursor cannot be read may be deleted at
all, and it adds no field to `RetentionResult` or to any status surface.

Two things are deliberately left uncovered.

**A cursor that is gone over a compacted partition.** No `cursor.json` and a
live `table-<ms>` is, on the evidence available at the call site, the same
picture as a crash between an append and its cursor write, and the append
heals it to `table` as before. Separating them means re-deriving a live
generation from the directory listing, which is LLP 0344 Option 4 and the
guess LLP 0323#whole-cursor already refused to make at read time. Nothing
observed on this fault path produces that state: compaction writes the
cursor before it retires the old generation, and `writeCursor` is atomic.

**Repair.** A refused partition stays refused until its `cursor.json` is
replaced. Nothing here rebuilds one, quarantines the partition, or surfaces
it anywhere the WARN does not. That is LLP 0344's question and it should get
one answer for both sides of it, not two.

## References {#references}

- [LLP 0323](./0323-cursor-names-a-generation-in-its-own-partition.decision.md):
  `#whole-cursor`, the refusal this stops the write path from re-deriving;
  `#consequences`, the healing append this withdraws.
- [LLP 0322](./0322-a-failed-automatic-refresh-cools-down-and-is-visible.decision.md): the stamp and the
  coalesced retry that make a refused append a wait rather than a loss.
- [LLP 0344](./0344-retention-under-fault.rfc.md): `#unreadable-cursor`, the
  read side of the same fault, still open.
- [LLP 0310](./0310-in-place-subset-compaction.decision.md):
  `#unreferenced-sweep`, the sweep that reclaimed the orphaned generation.
