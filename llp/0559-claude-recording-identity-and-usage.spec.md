# LLP 0559: Confirm Claude assistant identity and retain committed usage

**Type:** Spec
**Status:** Draft
**Systems:** Gateway, Sources, Cache, Plugins
**Author:** Phil / Codex
**Date:** 2026-10-26
**Related:** LLP 0026, LLP 0027, LLP 0035, LLP 0252, LLP 0254, LLP 0389, LLP 0390

## Evidence

The October 23 core-team investigation identified request-history snapshots
being imported as messages, assistant text events naming a tool block's uuid,
and successive partial transcript reads placing one response's usage on two
different native blocks. On October 26, an independent replay reproduced all
three through the client projector, materializer and settlement paths. A
read-only October 25 production sample also contained two tool-call pairs
with equal call IDs, names and arguments but different part IDs, including
`api-request-blob` copies.

## Snapshot admission {#snapshots}

Reject `api-request-blob` records in the shared transcript parser, before
either full backfill or incremental identity indexing. A request snapshot is
replayed history without native DAG identity. It cannot replace a native
entry in a content-key or tool-ID index. Other transcript metadata, including
titles, remains admissible.

## Assistant identity {#assistant-identity}

Extend LLP 0252's events-first rule and LLP 0254's identity-at-ingest rule:
`user_prompt` retains its event uuid, but `assistant_response` text needs
native content confirmation. Its event uuid can identify another block in
the same API response. Assign a provisional identity scoped by session,
request ID (event uuid when absent), and canonical text. Preserve the event
uuid in the existing minimized `raw_frame.uuid` and mark the row with the
existing fallback marker and match key.

At flush, use the event uuid as a response anchor, then match text within its
native API-message group. A request-ID index supplies the same lookup when
the anchor is absent. A native text anchor whose content agrees wins
directly. A mismatch between explicit request IDs, absent text, or multiple
matching lines leaves the row provisional. Do not give it a tool's uuid or
match equal text from an unrelated request. Native identity also resolves
the event's provisional agent display label. Reuse settlement's existing
thread relinking and part-ID dedupe.

## Usage carrier {#usage-carrier}

Extend LLP 0035's one-carrier rule and LLP 0390's last-block convention:
complete response projections still select the last block, but a committed
carrier wins over any later carrier for that same response. A growing
transcript's last visible block is not a stable ownership decision.

Before committing a flush, find already counted Claude responses using
explicit session plus API-message ID or request ID, across source/date
partitions. Remove only `attributes.usage` from a new competing row. Within
one flush, the first carrier wins. Keep the content, provenance and unrelated
attributes. No content-based accounting joins or process-lifetime ledger is
introduced. If a storage scan fails, fail the flush for its normal retry;
unknown accounting state is not permission to count again.

This check runs after identity settlement and part dedupe, including native
backfill rows that need no identity upgrade. It does not read its own spool
as committed data. The flush owner serializes commits, so a later chunk sees
the earlier chunk's committed carrier.

## Cost and limits

Snapshot rejection avoids redundant hashing, indexing and row storage. The
request index holds references to entries already retained by the bounded
transcript loader. Assistant projection adds one text match key and one
scoped hash. Settlement still indexes once per selected session per batch.

The usage check performs one session-scoped committed scan per flush with
Claude counters, independent of the number of messages in that flush. It
retains only candidate response keys, O(batch), and stops once they are all
found. CPU and I/O scale with the retained history of candidate sessions;
there is no whole-fleet identity preload, per-message scan, busy loop or
additional lifetime state. Non-Claude and usage-free batches pay no storage
I/O for this check.

No runtime dependency, dataset column, configuration key or part type changes.
As with existing body fallback settlement, a transcript that is still missing
at flush can leave a committed fallback. A later native copy in another
source partition is outside the existing single-partition maintenance
collapse; this patch does not add cross-partition historical reconciliation.
Already committed rows and counters are not rewritten, including counters
that differ between producers and OTEL-only fields tracked by issue #1472.
The maintenance re-settle hook does not run the accounting check. Repair of
historical local/server copies and rebuilding derived rollups are separate
work, not a migration in this client patch.

## Verification

Regressions must exercise snapshot admission and indexing, tool-uuid text
events in both producer orders, late transcript arrival, ambiguous/request
mismatch cases, identical text across requests, and partial reads across
committed flushes and within one flush. Verify independent requests/sessions
retain their counters and that unrelated attributes survive suppression.
The hermetic Claude backfill smoke must assert durable SQL totals after a
partial response grows and the suppression telemetry for that run.
