# LLP 0301: Compaction re-settlement retains keys, not gateway history

**Type:** Issue
**Status:** Active
**Systems:** Cache, Gateway
**Author:** Phil / Codex
**Date:** 2026-08-24
**Related:** LLP 0027, LLP 0199, LLP 0209, LLP 0217, LLP 0220

> @ref LLP 0027#re-settle-sweep [constrained-by]: preserve conservative re-settlement and native-twin collapse
> @ref LLP 0209#decision [constrained-by]: reuse the compactor's existing in-memory byte bound without coupling it to file size

> The re-settle sweep must preserve cross-scan twin detection without holding
> every fallback gateway row in memory. It first discovers native identity
> keys through a narrow projection, then settles fallback rows in byte-bounded
> batches during the rewrite.

## Problem {#problem}

`compactGeneration` normally bounds resident rows with
`compact_batch_bytes`. Gateway re-settlement bypassed that bound: every row
whose `attributes.gateway.identity_source` was `gateway_fallback` went into
one `fallbackBuffer`, and the buffer was settled only after the full table
scan. A large source-table therefore retained its historical content and
attributes strings for the duration of compaction.

This is reachable in the daemon but easy to miss through `hyp query maintain`:
the daemon supplies the dataset's `resettleBatch` hook, while a standalone
maintenance call without registry wiring does not. On the Neutral loop cache,
the hourly full-generation rewrite entered this path and the child daemon died
near the V8 heap limit. Its supervisor restarted it, the cursor still named the
old generation, and the next hourly tick retried the same rewrite.

An isolated fixture reproduces the failure with a 96 MiB V8 heap: compact 4,000
historical gateway tuples, append 128 rows across 16 recent tuples, and run
daemon-shaped maintenance. The process exits 134 with `Reached heap limit`.
The identical table and heap complete when re-settlement is disabled, locating
the unbounded retention rather than the streaming parquet writer as the
necessary cause.

## Requirements {#requirements}

1. Peak retained fallback-row bytes must be bounded by
   `compact_batch_bytes`, with the existing row-count cap as a second bound.
2. A fallback row must still collapse onto a native twin that appears later in
   table scan order or in a different settle batch.
3. An unchanged or unmatchable fallback row must survive conservatively.
4. The cursor swap remains atomic: a crash before the completed rewrite must
   not expose a partial generation.
5. The production-shaped constrained-heap reproduction must complete after the
   fix without increasing the heap limit.

## Decision {#bounded-resettle}

When a dataset supplies a re-settle hook, compaction makes two streaming
passes:

1. A narrow projection of `attributes`, `part_id`, `message_id`, and
   `part_index` records the native `part_id` keys. It retains only identity
   strings, not content bodies, tool arguments, or full attributes objects.
2. The ordinary full-row rewrite accumulates fallback rows only until the
   configured byte or row cap, invokes the re-settle hook for that batch, and
   de-twins upgraded rows against the native-key set. Upgraded survivor keys
   join the set so duplicates across later settle batches also collapse.

The extra narrow scan trades bounded I/O for a hard memory bound. It does not
change LLP 0199's compaction dueness or turn the 60-minute scheduler cadence
into an event-time lookback. Incremental selected-partition rewriting remains
a separate storage-layout change; this issue removes the crash from the
current whole-generation contract without claiming that broader optimization.

## Verification {#verification}

- A deterministic regression records every re-settle hook invocation and
  proves no batch exceeds the configured byte-shaped fixture bound.
- Existing re-settle tests prove a fallback/native pair still collapses when
  the fallback scans first and the native twin later.
- The isolated 4,000-history / 128-recent fixture runs under
  `--max-old-space-size=96` before and after the patch.
