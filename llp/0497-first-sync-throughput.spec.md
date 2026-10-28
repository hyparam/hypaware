# LLP 0497: First-sync throughput and interrupted uploads

**Type:** Spec
**Status:** Draft
**Systems:** Sinks, Plugins, CLI
**Author:** Codex
**Date:** 2026-10-14
**Related:** LLP 0014, LLP 0040, LLP 0345, LLP 0471; server LLP 0604

The first upload is part of onboarding. Reduce avoidable transfer and retry
cost without changing privacy, acknowledgement durability, or the server's
configured ingest capacity. Daily inventory/diff is outside this change.

## Compression {#compression}

Send the first chunk plain. A successful ingest response advertising
`Accept-Encoding: gzip` enables asynchronous gzip level 1 for later chunks.
Only use the compressed result when smaller. Encode once per chunk and reuse
it across attempts, preserving the idempotency key over the original NDJSON.
Send `X-Hyp-Uncompressed-Length` with gzip. The server bounds decoding to that
length and charges its admission budget for the larger of encoded and decoded
lengths. A 415 for gzip retries once in plain form, preserving the batch id.
Older servers require no discovery request or configuration change.

## Receipts {#receipts}

@ref LLP 0040#watermark-contract [constrained-by]: keep the end-of-partition watermark because physical scans can be unordered

Persist a receipt only after a successful chunk acknowledgement. Namespace the
journal by sink instance, server URL, gateway identity, partition, signal, and
incremental versus source-history mode. Hash the existing chunk id (which
includes position and exact content), never content alone. No payloads or
credentials are stored. A newly enrolled gateway cannot reuse old receipts.

On restart reread the partition through current privacy filters. Skip the POST
only for an exact matching acknowledged chunk. Changed content, filtering, or
chunk boundaries may resend data; the existing server deduplication applies.
This saves network/ingest work, not local scans. A receipt is evidence of a
past durable ack, not a current server inventory or a repair of deleted data.
After the entire partition succeeds, commit its ordinary watermark, then clear
the journal. History replay still never changes the ordinary watermark.

Use append-only mode-0600 journals with fsync after each receipt. Bound each
journal to 65,536 SHA-256 lines (about 4 MiB), and its loaded set to that size.
At the cap continue uploading without adding receipts. Ignore torn/invalid
lines, which can cause safe resends. Unavailable journal storage logs a warning
and falls back to normal delivery. A power loss that loses a new directory
entry can only lose the optimization, never acknowledge unshipped rows.

## Retry {#retry}

@ref LLP 0471#chunk-lifetime [constrained-by]: retain the existing single 330-second chunk lifetime and abortable waits

HTTP 502 and 504 share the transport-error budget: at most three additional
attempts with 2, 4, and 6 second delays. Retry the same chunk and batch id.
429/503 continue honoring positive Retry-After with the existing inline budget.
No new retry layer or independent deadline is introduced.

## Progress {#progress}

Ordinary sync and source-history replay both report acknowledged rows, encoded
bytes uploaded, rows covered by saved receipts, and explicit retry countdowns.
Receipt-covered rows advance completion but do not inflate upload rate.
Chunk telemetry includes raw bytes, wire bytes, and whether it was resumed.
No user payload or credential is added to telemetry.

## Cost and validation {#validation}

Compression adds bounded per-chunk CPU and buffer memory; level 1 uses the
async zlib worker pool. The serialized chunk is still bounded by the existing
row/byte thresholds (a single oversized row remains an existing exception).
Receipts add one small fsync per newly acknowledged chunk and a bounded read
per partition attempt. No whole-backlog arrays or per-row disk writes.

Tests cover exact-prefix resume across new sink instances, changed privacy
filters, retry budgets, compression negotiation/fallback, progress accounting,
and the existing unordered-scan watermark invariant. Server tests cover
bounded decoding, admission accounting, durable append and duplicate requests.
