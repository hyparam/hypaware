# LLP 0024: Flush-time identity settlement for ai_gateway_messages

**Type:** Decision
**Status:** Draft
**Systems:** Gateway, Cache
**Author:** Brendan / Claude
**Date:** 2026-06-13
**Related:** LLP 0013, LLP 0016, LLP 0023

## Summary

Fallback-identity rows in `ai_gateway_messages` are **provisional**. At cache-flush
time the owning dataset may run a `settleBatch` pass that upgrades a fallback row to
its native transcript identity (once the Claude Code transcript line has landed on
disk) and dedupes the upgraded row against the uuid copy already written by a later
replay. This collapses the finalize-vs-transcript race duplicates that LLP 0023's
granularity convergence reduced to clean 1:1 pairs.

## Context

The live gateway records a Claude message under a fallback content-hash `message_id`
when the transcript line for it is not yet on disk — the **finalize-vs-transcript
race**: an exchange finalizes a few milliseconds before the CLI appends the
response's JSONL line. The *next* exchange replays that message, now matches the
transcript, and writes it again under its native uuid. The two rows share
conversation/role/content/`part_index` but differ on `message_id` (16-hex fallback
vs 36-char uuid), so no id-keyed dedup layer (`seenMessages`, the backfill `part_id`
scan, compaction's `_hyp_cache_row_id` content hash) can see they are the same
message.

Post-LLP-0023 these are clean 1:1 pairs (one fallback row, one uuid row, identical
single-block content), which makes a deterministic upgrade-and-dedupe tractable.

## Options considered

**A. Flush-time `settleBatch` hook (chosen).** A generic optional hook on
`DatasetRegistration`, invoked from the kernel flush path (`appendChunk` in
`src/core/cache/storage.js`) before partition write. The spool's ~2-minute flush
debounce guarantees the transcript has landed by then, and both rows of a pair are
normally in the same flush window (race gap ~30 s).

**B. Compaction-time pass (rejected).** `maintainCache` receives no dataset-registry
or storage handle, and compaction's only dedup is a content hash over
`_hyp_cache_row_id` — which can never collapse a fallback/uuid pair because their
differing `message_id` yields different hashes. Adopting it would mean threading the
registry + storage through compaction and reimplementing `part_id` dedup that already
lives in the gateway.

**C. Reconstruct content from the stored row at flush (rejected).** A persisted
fallback row's original content array is gone — per-part expansion keeps only
`content_text` (text blocks). Reconstructing tool_use/tool_result blocks to recompute
the match key is fragile.

## Decision

1. **Match-key at projection.** When the Claude projector emits a message as fallback
   (no transcript match at projection time), it stamps
   `attributes.claude.match_key = contentKey(role, content)` — the same key
   `findTranscriptMatch` uses against the transcript. The wire content is in hand at
   projection, so the stored key is exactly what will match the transcript line once
   it lands. Settlement is then a pure `index.byContentKey` lookup, not a
   reconstruction.

2. **Generic `settleBatch(rows, ctx)` hook** on `DatasetRegistration`, optional.
   Invoked once per flush batch before partition grouping. Datasets without it are
   unaffected; the kernel flush path stays plugin-agnostic.

3. **Gateway owns dispatch, adapters contribute enrichers.** The gateway registers
   `settleBatch`; Claude contributes a settlement enricher via
   `registerSettlementEnricher` (mirroring `registerExchangeProjector`). Dispatch is
   by `client_name`, so the gateway stays provider-agnostic (LLP 0016).

4. **Committed row wins.** After an upgrade, the batch is deduped by `part_id` against
   committed partitions and within-batch (reusing `scanExistingPartIds`/`partIdKey`).
   An upgraded row whose `part_id` already exists is dropped — the flush path has no
   row-delete, so collapsing onto the already-committed canonical uuid row is the only
   achievable and the safe outcome.

5. **No schema change.** `match_key` rides in the existing `attributes` JSON column;
   settlement rewrites only existing columns. No Iceberg table recreate. Identity
   upgrade never moves a row across partitions (partition keys are
   `conversation_id`/`cwd`/`date`, not `message_id`/`part_id`).

## Consequences

- Race-pair duplicates collapse at flush; re-flush is idempotent (a settled row is no
  longer fallback, so it short-circuits).
- The hot path stays cheap: `settleBatch` returns immediately when the batch holds no
  fallback rows (no transcript I/O).
- Identity becomes **settled-at-flush, not settled-at-capture** — a query against
  un-flushed spool rows can still see a provisional fallback id. For a local cache
  this is an acceptable contract (continues LLP 0013's spool-is-provisional stance).

## Open questions / residue (out of scope here)

- A fallback row committed (flushed) *before* its uuid twin arrives, then never
  re-flushed, is not merged — compaction can't collapse it. Rare given the debounce
  vs race gap; a future maintenance sweep could re-settle committed fallback rows.
- Backfill-vs-spool same-id duplicates (flush spool before `hyp backfill`, or scan
  spooled rows in the materializer) — separate fix.
- Restart-replay seen-set seeding from committed `part_id`s.

## References

- [LLP 0013](./0013-local-query-cache.decision.md) — cache write path / spool
- [LLP 0016](./0016-ai-gateway.decision.md) — gateway owns schema; adapters contribute
- [LLP 0023](./0023-claude-native-granularity.decision.md) — granularity convergence
- `src/core/cache/storage.js` — `appendChunk` flush hook point
- `hypaware-core/plugins-workspace/ai-gateway/src/dataset.js` — `settleBatch`, dedup
- `hypaware-core/plugins-workspace/claude/src/settle.js` — the enricher
