# LLP 0204: ai-gateway daemon leaks memory until GC thrash (recorder retention + unbounded dedupe/seed scans)

**Type:** Issue
**Status:** Draft
**Systems:** Sources, Plugins, Cache
**Author:** Phil / Claude
**Date:** 2026-08-08
**Related:** LLP 0026, LLP 0030

> Incident 2026-08-08 ~23:30 UTC: the `hyp daemon` gateway proxying all
> Claude Code traffic for 3 autonomous 24/7 reconcile loops (hypebox-1,
> `neutral-loop` container) grew to ~4.8 GB RSS and entered GC thrash: the
> TCP port kept accepting but never answered, so every loop timed out for
> ~3.5 h. The supervisor only detects a dead tmux session, not a
> hung-but-alive process, so recovery required a manual kill. Supporting
> evidence: 9 supervisor restarts in the 9 days before the incident
> (~daily), and a fresh daemon reaching ~870 MB RSS within 2 minutes of
> boot on the same box.

## Root causes (ranked by contribution)

1. **Recorder retains every finished exchange forever.** The proxy
   recorder tracked in-flight exchanges in an `active` set
   (`hypaware-core/plugins-workspace/ai-gateway/src/recorder.js`) with an
   `add` on start and NO removal on finish: every finalized exchange,
   holding the full raw request body twice (chunk buffers plus the decoded
   `request_body` string), all SSE stream events, and headers, stayed
   reachable for the life of the listener. At 100-200 KB per exchange and
   tens of thousands of calls/day this is gigabytes/day of linear growth,
   the daily-death driver.
2. **Flush-time dedupe materialized every committed part_id per tick.**
   The settle pass's committed-scan
   (`.../ai-gateway/src/dataset.js` `dedupeByPartId` ->
   `scanExistingPartIds`) built a Set of EVERY `part_id` ever written, on
   every fallback-carrying flush (roughly per minute). Millions of rows
   means hundreds of MB allocated and churned per tick: the main GC-thrash
   driver and a large part of the boot floor.
3. **Every new session paid a whole-table seed scan.** The live
   projector's restart-dedup seed
   (`.../ai-gateway/src/message_projector.js`, LLP 0026#consequences)
   scans committed rows per session. Its partition skip keyed on
   `part.partition?.session_id`, but directory partitioning is by
   `source=` only (`src/core/cache/partition.js`), so the guard never
   fired and each NEW session id (which autonomous loops mint constantly)
   scanned the entire multi-GB table to find nothing.
4. **Projector per-thread chain state was an unbounded array with linear
   membership.** `messageIdsByConversation` kept every message id per
   thread in an ordered array whose only read was its tail, and checked
   membership with `includes`: O(n^2) projection over a long thread.
5. **OTLP exporter `pending` array only drained on `forceFlush()`**
   (`src/core/observability/otlp_exporters.js`): a settled promise per
   export accumulated indefinitely in a process that never flushes.

Cleared during diagnosis (not leaks): the central sync sink is
bounded/disk-backed, the spool streams to disk, the SSE parser drains,
`pendingFinalizers` is cleaned correctly, and ai-gateway-graph does not
run in the daemon.

## Fix

All in one change set, code-`@ref`ed to this issue:

- Recorder: a finished exchange removes itself from `active` via its
  `finishedSignal`; `finalize()` also releases the raw chunk buffers once
  the decoded bodies are on the row.
- Recorder drain timer: `drain()`'s force-finish timeout is ref'd instead
  of unref'd, so its `Promise.race` always settles within `timeoutMs`
  instead of the timer being droppable by an otherwise-idle event loop
  and the await hanging forever. Consequence: `drain()` can now hold the
  process open for up to `timeoutMs` when an exchange never settles,
  where before the process could exit early regardless.
- Settle dedupe: `scanExistingPartIds` accepts a `restrictTo` key set;
  the flush passes its batch keys, bounding memory to O(batch) and
  stopping the read once every batch key is resolved. Backfill keeps the
  unrestricted scan (its per-run memo legitimately needs the full set).
- Seed scan: a lazily-built committed-session-id index (one
  `session_id`-column scan, shared per listener) answers "does this
  session have committed rows at all"; unseen sessions skip the
  per-session scan outright. A miss older than 10 minutes rebuilds the
  index once, so rows committed by a concurrent writer (`hyp backfill` in
  another process) are seen at most that late; a stale miss only risks
  the duplicate seeding guards against, which settlement/compaction still
  collapse (the seed scan's documented failure envelope).
- Projector chain state: per-thread `{ seen: Set, last }` replaces the
  ordered array (only the tail was ever read).
- OTLP exporter: each export self-drains from `pending` on settle.

## Follow-ups (not in this change)

- **Projector state eviction:** `seenMessages`,
  `messageIdsByConversation`, `conversationStartedAt`, and
  `toolCallLookupByConversation` still grow for the listener's lifetime
  (bounded per-entry now, but unbounded in session count). A long-lived
  daemon accumulates them across weeks; TTL/LRU eviction by threadScope
  needs care because evicting a still-active thread resets its fallback
  chain.
- **Claude projector transcript re-parse:** the claude adapter re-parses
  the full transcript per exchange
  (`hypaware-core/plugins-workspace/claude/src/projector.js`); a parsed
  index cached by `(transcriptPath, size, mtime)` with incremental tail
  append (pattern exists in `session_context.js`) would cut sustained CPU
  and allocation churn.
- **Daemon self-guard:** the supervisor cannot see a hung-but-alive
  daemon; a max-RSS self-restart or supervisor RSS probe closes that
  blind spot (candidate for its own request LLP).
