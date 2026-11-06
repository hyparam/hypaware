# LLP 0550: Central uploads coordinate across CLI and daemon processes

**Type:** Spec
**Status:** Draft
**Systems:** Sinks, Plugins, Daemon
**Author:** Phil / Codex
**Date:** 2026-10-19
**Related:** LLP 0014, LLP 0040, LLP 0417, LLP 0471, LLP 0497

@ref LLP 0471#manual-work [extends]: a foreground sync and the daemon share upload ownership even though they have separate runtimes
@ref LLP 0040#watermark-contract [constrained-by]: read progress after acquiring ownership and commit it before releasing ownership

## Request and evidence

Prevent a foreground central sync and the daemon from uploading the same
partition concurrently. On October 19, 2026, at 15:09-15:12 Pacific, one
gateway produced 79 `batch_in_flight` refusals while its original connection
completed 181 successful uploads. Server receipts recorded 181 distinct
batches. A second upload pass overlapped the first; an original upload failure
was not needed. The exact client commands were not available in server logs.

The server continues to reserve in-flight batch IDs. Its separate change
raises `Retry-After` from one to five seconds, preserving retryable 503s and
durable acknowledgement semantics (server LLP 0594).

## Upload ownership {#ownership}

Each persisted central sink instance uses its existing receipts directory to
coordinate foreground and daemon processes. Hash the destination URL, gateway
identity and stable logical partition path into an upload claim name. Ordinary
exports and history replay share this claim, independent of receipt replay
mode. Different destinations and partitions remain independent. No new config,
schema or runtime dependency is introduced.

Reuse the non-expiring PID/nonce directory guard from LLP 0417. Hold it from
before the forward pass flushes or reads the partition, loads the watermark or
opens receipts, through all chunk acknowledgements, the final watermark commit
and receipt cleanup. A waiting exporter's forward pass reads progress only
after acquiring the claim, so it observes the completed upload instead of
replaying a stale cursor. Open-dataset rollout preparation runs before the
claim, as it did before this change: it may flush the partition, check that
known progress exists and seed zero progress for a new partition. The cursor an
upload sends from is the one the claimed pass reloads, so suffix-only resend
holds once a partition has progress. It does not yet hold for a new partition:
the zero seed is a read then a write outside the claim, and a process that read
absent progress can overwrite another's committed progress with zero. That race
predates this spec and is tracked separately (hyparam/hypaware#2786). The
existing per-runtime scheduling and partition guards remain in place.

A live owner is never displaced by elapsed time. A dead PID can be reclaimed
by the existing guard protocol. Empty, malformed or unverifiable claims fail
closed. A missing receipts directory is created for the claim; an unwritable
one fails the upload closed before any request, so receipt caching's
best-effort fallback cannot bypass ownership. In-memory
embedders that supply no receipts directory retain their existing lifecycle;
production sink creation always supplies the durable instance directory.

## Waiting and shutdown {#waiting}

Poll a busy claim once per second, with an abortable wait. Log
`central.forward.partition_wait` once and `partition_acquired` on handoff,
including only dataset and elapsed wait. Bound admission waiting by the
existing 330-second central operation interval, then return a retryable export
failure. This is not a deadline on a whole partition export: an admitted
upload may legitimately run longer, and retains its existing per-chunk bounds.
Close cancels waiting ownership requests and awaits their settlement alongside
active uploads. Every admitted pass releases its own claim in `finally`.

## Cost and verification {#verification}

One small owner entry exists per active persisted-instance partition upload.
Contention does one bounded guard probe per second, not per row or retry body.
Waiting retains no scanned rows or serialized chunk. Successful completion
removes its owner entry. The guard retains its existing fail-closed PID-reuse
and interrupted-publication limitations; it does not use a time-based steal.

Tests run the actual central sink in separate Node processes sharing real
watermark and receipt files. Pin an upload at a barrier, prove the contender
waits, then prove it reloads the watermark and sends no duplicate. Cover dead
owner recovery, cancellation without releasing another process's claim,
failure release, old-but-live ownership and independent destinations. Assert
the wait/acquire telemetry as well as external behavior. Retain the existing
chunk backpressure, receipt recovery, history replay and cancellation tests.
