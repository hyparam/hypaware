# LLP 0027: Flush-time identity settlement for ai_gateway_messages

**Type:** Decision
**Status:** Draft
**Systems:** Gateway, Cache
**Author:** Brendan / Claude
**Date:** 2026-06-13
**Related:** LLP 0013, LLP 0016, LLP 0026

## Summary

Fallback-identity rows in `ai_gateway_messages` are **provisional**. At cache-flush
time the owning dataset may run a `settleBatch` pass that upgrades a fallback row to
its native transcript identity (once the Claude Code transcript line has landed on
disk) and dedupes the upgraded row against the uuid copy already written by a later
replay. This collapses the finalize-vs-transcript race duplicates that LLP 0026's
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

Post-LLP-0026 these are clean 1:1 pairs (one fallback row, one uuid row, identical
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

## Re-settle sweep {#re-settle-sweep}

Flush-time settlement above only collapses a fallback/uuid twin pair when both
rows land in the **same flush batch**. The finalize-vs-transcript race can flush
a fallback row **alone** — its transcript line not yet on disk, so the enricher
can't upgrade it, and its uuid twin is still in a later flush. That row commits
unsettled, and the flush path (append-only, no row-delete, short-circuits on a
batch with no fallback rows) can never revisit it. `--refresh always` forces a
query-time flush that lands in the gap, so it surfaces the duplicate reliably,
but natural flushing hits the same race — the zero-dup result is empirical, not
guaranteed. This is the residue Option B (compaction-time) was rejected for; we
adopt it now as a **backstop**, not a replacement for the flush-time pass.

**Decision.** Cache maintenance runs a re-settle sweep during compaction:

1. **Same partition, guaranteed.** Twins share content/role/conversation/date,
   so they share the Iceberg partition key (`conversation_id`/`cwd`/`date`) and
   always live in the **same** partition. A single-partition compaction rewrite
   is therefore enough to collapse them — no cross-partition scan.
2. **Reuse the flush enricher.** The dataset exposes a second hook,
   `resettleBatch`, that the maintenance pass threads in alongside a storage
   handle (resolving Option B's "`maintainCache` has no registry/storage handle"
   blocker: `runDaemon` and `hyp query maintain` now pass
   `getSettleHook: d => query.getDataset(d)?.resettleBatch` + `storage`).
   `resettleBatch` runs the **same** transcript upgrade as `settleBatch` but
   **omits** the committed-`part_id` dedupe — at sweep time the rows are already
   committed, so a committed-scan would match a non-upgraded fallback against its
   own committed copy and wrongly drop it. The rewrite owns the de-twin instead.
3. **De-twin within the rewrite.** During the rewrite, non-fallback rows emit
   immediately (bounded heap) while committed fallback rows are buffered; at
   end-of-scan the buffer is upgraded, and an **upgraded** row whose native
   `part_id` now collides with one already emitted from this partition (its
   native twin) is dropped — the native twin wins. A row whose identity did not
   change is never dropped.
4. **Force the rewrite when needed — but only on new data.** A cheap
   `attributes`-only scan gates the sweep: a partition holding any
   `identity_source = 'gateway_fallback'` row is rewritten even when file-count
   heuristics say compaction isn't due, so a split pair in a small,
   never-compacted partition still gets collapsed. To avoid forcing that rewrite
   *every* tick, the gate also requires the partition's live data-file count to
   have moved off the **re-settle baseline** — the file count recorded in the
   cursor's `compaction` block at the previous sweep. A fallback row whose
   transcript line never lands (harness aux, wire-only reminders) is genuinely
   unmatchable; without the baseline it would re-trigger a full rewrite forever
   (the marker persists, and after a clean rewrite the forced sweep is the only
   trigger left). The baseline makes an unchanged fallback set retried only when
   new data has flushed.

Conservative and bounded: an enricher miss/failure leaves the fallback row
untouched for a later sweep; a matchable second sweep collapses the twin and the
survivor is no longer fallback; and an **unmatchable** fallback set, once swept,
does not force another rewrite until new data flushes past the baseline. The only
coupling between core compaction and the gateway is the documented
`gateway_fallback` marker.

## Open questions / residue (out of scope here)

- ~~A fallback row committed before its uuid twin arrives, then never re-flushed,
  is not merged.~~ **Resolved** by the [re-settle sweep](#re-settle-sweep): a
  committed fallback row is upgraded and de-twinned during compaction.
- Backfill-vs-spool same-id duplicates (flush spool before `hyp backfill`, or scan
  spooled rows in the materializer) — separate fix.
- Restart-replay seen-set seeding from committed `part_id`s.

## References

- [LLP 0013](./0013-local-query-cache.decision.md) — cache write path / spool
- [LLP 0016](./0016-ai-gateway.decision.md) — gateway owns schema; adapters contribute
- [LLP 0026](./0026-claude-native-granularity.decision.md) — granularity convergence
- `src/core/cache/storage.js` — `appendChunk` flush hook point
- `hypaware-core/plugins-workspace/ai-gateway/src/dataset.js` — `settleBatch`, `resettleBatch`, dedup
- `hypaware-core/plugins-workspace/claude/src/settle.js` — the enricher
- `src/core/cache/maintenance.js` — the re-settle sweep (buffer/upgrade/de-twin during compaction)
