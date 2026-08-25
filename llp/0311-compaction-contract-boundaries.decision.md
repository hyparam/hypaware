# LLP 0311: The boundaries in-place compaction leans on are contracts, not coincidences

**Type:** Decision
**Status:** Accepted
**Systems:** Cache, Plugins
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-08-25
**Related:** LLP 0027, LLP 0085, LLP 0209, LLP 0217, LLP 0310

> In-place subset compaction (LLP 0310) rests on three properties nothing
> stated: that a plugin's settle hook is safe to call speculatively, that
> snapshot retention outlives what one tick commits, and that every dueness
> condition names work the routine writer can actually do. Each is now held
> by something other than the current shape of the code: the enricher
> contract says `settle` must be pure and idempotent, the round cap is
> clamped by `min_snapshots_to_keep`, config validation rejects
> `compact_avg_file_bytes > compact_batch_bytes`, and the metadata-size
> trigger is left to the layout whose writer can clear it.

## Context {#context}

LLP 0310 landed the in-place subset rewrite. Review of that change recorded
three findings and classified none as a defect at the shipped head: the
in-tree enrichers happen to be pure, the default retention (10) happens to
exceed the default round cap (8), and the default `compact_avg_file_bytes`
happens to equal `compact_batch_bytes`. All three are true by coincidence of
the values, and each fails silently when the coincidence stops holding: no
error, no wrong answer, just a partition that is due forever, a reader whose
snapshot vanished, or a plugin side effect fired for rows that were never
committed. This decision converts each coincidence into something that
holds it.

## The settle probe requires a pure hook {#settle-purity}

`victimFallbacksSettleable` asks the dataset's settle hook "would settlement
change these rows" and throws the answer away; the hook's real run happens
inside the whole-generation rewrite the probe routes to. It is a
SPECULATIVE call, and LLP 0310's round-2 correction made it run on every
round's unprobed victims rather than only round 0, so it runs often.

`AiGatewaySettlementEnricher.settle` is third-party plugin code and its
contract said nothing about side effects. An enricher that marked a
transcript line consumed on first resolution, or advanced a cursor, or
wrote a cache to disk, would do so for rows the probe never commits, and
for the same rows again on the next tick.

The requirement therefore goes on the hook, not on the caller: `settle`
MUST be free of observable side effects and MUST be idempotent, so calling
it on the same rows twice, or calling it and discarding the result, is
indistinguishable from not calling it. In-memory memoisation is fine (both
in-tree enrichers do it); anything a later run or another process can
observe is not. A hook that cannot meet this has to be a different hook,
not a quietly-unsafe one. Stated on `AiGatewaySettlementEnricher` in
`hypaware-plugin-kernel-types.js`, which is where a plugin author reads.

## One tick may not spend the whole retention window {#round-cap-under-retention}

Snapshot retention is the reader-safety window (LLP 0310#unreferenced-sweep):
the sweep reclaims a file only once expiry has released every snapshot that
could read it. A tick that commits as many snapshots as retention keeps
therefore hands the next tick's expiry a snapshot list holding nothing but
its own commits, and a reader that opened the table before the tick loses
the files under it. With a fixed cap of 8 rounds and a retention of 10, one
busy tick already came within two snapshots of that, and lowering
`min_snapshots_to_keep` (or raising the cap) crossed it with nothing to say
so.

The cap is now derived rather than constant: `inPlaceRoundCap(cfg)` is
`min_snapshots_to_keep - 1`, clamped to at least 1 and at most the
`MAX_INPLACE_COMPACT_ROUNDS` ceiling. Strictly fewer commits than retention
keeps means at least one pre-tick snapshot survives every tick, whatever the
two knobs are set to. The floor of 1 covers a config that retains nothing:
there is no window to protect, and a cap of 0 would stall compaction rather
than slow it. Convergence is not lost, only paced: what a capped tick leaves
fragmented drains on later ticks, which is already how the ceiling behaved.

## The average-size threshold must sit under the batch bound {#avg-below-batch}

An in-place merge materializes its victims in memory, so a merged file never
exceeds `compact_batch_bytes` (LLP 0310#consequences). A
`compact_avg_file_bytes` above that bound is therefore a threshold the
routine writer can never reach: the partition converges, still reads as due
on every growth tick, and collects the floor verdict forever. LLP 0310
recorded the rule as advice ("keep `compact_avg_file_bytes` at or below
`compact_batch_bytes`"); it is now enforced by `parseConfigShape`, which
rejects the pairing with a message naming both keys.

The comparison is on EFFECTIVE values, not written ones. Setting only
`compact_avg_file_bytes` pairs it with the default batch bound, and setting
only `compact_batch_bytes` (lower) pairs it with the default average, which
is the likelier way to write the mistake; a rule that compared just the two
written numbers would pass both. The consequence is that a config that
lowered `compact_batch_bytes` alone is now rejected at load rather than
running with a partition that is due forever, and the error says which key
to move.

## Routine dueness names only work the routine writer can do {#metadata-dueness}

`needsCompaction` flagged a partition whose metadata directory passed 64 MB.
The generation-swap writer can answer that: it builds a fresh directory, so
a bloated version history dies with the old one. An in-place merge commits
INTO the same directory and can only add versions, so on a source table the
condition names work the writer routed to it cannot do, every growth tick,
forever.

Metadata on that layout has a bound of its own since LLP 0310:
`METADATA_VERSIONS_KEPT` trims the version list and the unreferenced-file
sweep drops orphaned manifests, both every tick and both independent of
dueness. The trigger is therefore left to the legacy epoch layout, where a
rewrite clears it. `--force` still routes a source table to the
generation-swap writer, so the operator escape survives.

## Consequences {#consequences}

- An existing config that set `compact_batch_bytes` below the default
  `compact_avg_file_bytes` (or the reverse) now fails config load with a
  message naming the fix, where before it ran with a permanently-due
  partition. This is deliberate: silent unbounded work is the worse of the
  two failures.
- A deployment that lowers `min_snapshots_to_keep` gets proportionally
  slower in-place convergence, which is the correct trade: it asked for a
  shorter history, and the rounds it gives up are the ones that would have
  eaten the history it kept.
- A source-table partition with a large metadata directory no longer
  re-lists its files on every growth tick. Nothing else changes: the sweep
  and the version trim were already what shrank it.
- Enricher authors gain a real constraint. Any future hook needing to
  record consumption has to do it somewhere the flush path owns, not inside
  `settle`.

## References {#references}

- [LLP 0310](./0310-in-place-subset-compaction.decision.md): the decision
  whose boundaries this one holds; `#unreferenced-sweep` for retention as
  the reader-safety window, `#consequences` for the batch-bytes ceiling on
  a merged file.
- [LLP 0027](./0027-cache-settlement.decision.md) and
  [LLP 0085](./0085-settlement-may-drop-late-ignore.decision.md): the
  settlement contract the purity requirement extends.
- [LLP 0217](./0217-compaction-effectiveness-verdict.decision.md): the
  floor verdict a permanently-due partition collects.
- Code: `src/core/cache/maintenance.js` (`inPlaceRoundCap`,
  `needsCompaction`, `victimFallbacksSettleable`),
  `src/core/cache/maintenance_defaults.js`,
  `src/core/config/schema.js` (`parseQueryCacheConfig`),
  `hypaware-plugin-kernel-types.d.ts` (`AiGatewaySettlementEnricher`).
