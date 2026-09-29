# LLP 0449: Reconcile mutable Hermes transcripts locally

**Type:** Spec
**Status:** Draft
**Systems:** Sources, Cache, Plugins
**Author:** Phil / Codex
**Date:** 2026-09-29
**Related:** LLP 0118, LLP 0119, LLP 0120, LLP 0122, LLP 0104

## Intent

@ref LLP 0122#watermark [extends]: Hermes now rewrites existing message rows.
The highest ID and an append-only dedupe set cannot represent edits or rewinds.
The local cache must converge to Hermes's visible history, preserving compacted
history but excluding withdrawn rows. This extends the capture mechanism in
LLP 0120 without adding a dataset or changing other clients' append semantics.

## Detection {#detection}

Use SQLite data_version on the read-only connection to skip unchanged stores.
After a database change, compute a SHA-256 digest per session from the session
metadata and visible message payloads, streaming rows through the digest. Keep
only one digest per session; never cache historical payloads in the daemon.
Compare to the last successfully reconciled digest. Old watermarks without a
digest trigger reconciliation on upgrade. A failed write must not advance it.

Visibility is active=1 OR compacted=1. Compaction history is intentional;
active=0 AND compacted=0 means withdrawn. Older schemas without these additive
columns remain readable. An empty visible session is a valid snapshot.

## Reconciliation {#reconciliation}

A BackfillItem may declare an exact reconciliation scope and a row identity
column. Hermes uses client_name=hermes AND session_id, keyed by part_id. The
shared projector emits the full snapshot instead of discarding existing IDs.
Both polling and explicit backfill use the same kernel storage operation;
dry runs perform no mutation.

Validate the complete snapshot before changing data. Hold the existing cache
partition mutation guards, preserve equal rows and their ingest sequences, and
publish changed rows and position deletions in one Iceberg transaction per
table. New or changed rows receive ingest sequences from the same allocator as
spool flushes. No stale-prefix append, unversioned parallel copy, or content
hash in the public part identity is required. Rewinding all messages removes
all of the session's parts, without waiting for a new message ID.

Drain pending legacy spool writes first. Publish the canonical source table
before removing that scope from legacy poll/backfill partitions. Migration
across tables is retryable, not globally atomic: a failure can temporarily
leave legacy copies, but retry converges and the poll watermark stays behind.
Reconciliation never changes another client's or session's rows. Usage-policy
and explicit session-purge exclusions still govern every incoming row.

## Boundaries

This is local query-cache reconciliation, not remote erasure. Already exported
copies, derived graph/vector projections, retired generations and historical
Iceberg snapshots are not certified erased. Explicit purge remains the erasure
operation. Whole-session deletion and upstream state.db replacement are outside
this change; the source is not a general remote deletion protocol.

## Cost and verification

An unchanged database requires no payload scan. A changed database requires a
streaming pass over visible Hermes history because upstream provides no durable
per-session payload change counter. Cache reconciliation prunes files using
manifest bounds and reads row groups; memory is bounded by a changed session's
projection and delete positions plus a parquet row group. The existing Iceberg
reader also retains the table's manifest metadata and live deletion masks until
the operation completes; those scale with cache size and compaction backlog. Retain this cost in
the PR; do not describe full-history hashing as constant-time.

Verify real SQLite to real Iceberg capture, edits without ID advancement,
shifted tool/text positions, usage carriers, pure and all-message rewinds,
compaction visibility, old-schema compatibility, restart/old-watermark repair,
backfill parity, failure retry and isolation. Existing Hermes smoke coverage
must pass, alongside npm test and typecheck.
