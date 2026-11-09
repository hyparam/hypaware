# LLP 0593: Cursor Cloud capture in the managed VM

**Type:** RFC
**Status:** Draft
**Systems:** Sources, Plugins, Privacy, CLI, Daemon
**Author:** Phil / Codex
**Date:** 2026-11-09
**Related:** LLP 0012, LLP 0017, LLP 0298, LLP 0399, LLP 0403

## Scope and consent {#scope}

Extend the bundled Cursor adapter with an explicitly connected Cloud VM mode.
`hyp cursor-cloud connect` binds one canonical workspace and the current native
Cloud agent ID, derived from Cursor's documented local metadata socket. A
machine-local grant contains those identities and the repository, never an API
key. Central configuration, a present key, and ordinary Cursor attachment do
not grant Cloud access. Disconnect revokes the grant before removing owned
repository hooks. A copied grant from another agent refuses capture.
The four fixed command names extend LLP 0393's finite telemetry vocabulary;
arguments, agent IDs, workspace paths and credentials are never telemetry labels.

The runtime requires `CURSOR_API_KEY`. Only fixed TLS `api.cursor.com` GET
requests receive it, with redirects disabled. There is no account inventory,
arbitrary agent selection, credential file, browser-cookie extraction, or new
dataset. Existing Cursor recording and export policy applies to Cloud rows.

## Two complementary sources {#identity}

The November 9 disposable Cloud-to-central experiment confirmed that Cursor
omitted first-turn prompt/response hooks but returned both through its documented
conversation API. Generic tool hooks omitted edit details; `afterFileEdit`
supplied explicit old/new strings. Probe commits f5f04a9 and ab485a2 in
philcunliffe/cursor-cloud-capture-probe established the combined path, including
native-ID replay, central receipt, config restart and graceful shutdown.

The conversation API exclusively owns main-agent user and assistant text.
Require FINISHED status before and after the bounded conversation read, and
unchanged type/text for a native ID in two consecutive completed snapshots.
A fast follow-up can otherwise start and finish between the status checks,
freezing a body read mid-turn under its immutable ID. Keep at most 256 ID/hash
pairs, never pending text; clear them on running state, refusal or failure.
Pending text never enters append-only storage. Native message IDs identify rows across
retries and daemon restarts. Unknown original timestamps remain unknown, with
receipt time used by the existing storage contract. No model or usage is guessed.

Cloud hooks own supplied tool calls/results and separate file observations.
Native tool IDs keep identical commands distinct and deduplicate redelivery.
File edits retain path and old/new strings as system hook observations, without
inventing a tool ID or success result. Child text can be recorded only when its
own hooks supply it; no parent relationship is inferred. Main-agent text hooks
cannot race the API into duplicate rows. Local editor/CLI native recovery stays
as specified by LLP 0399.

## Admission and failure {#admission}

Reuse the loopback listener, session control, projected writer and cache/export
contract. Require one workspace matching the grant. Check the live grant,
session exclusions and workspace policy before API requests and again before
each write. Parent-agent exclusion also withholds child hooks. File observations
require canonical containment and no stricter lexical/canonical directory
policy than the workspace. No raw hook spool, hidden reasoning or whole API
envelope is persisted. Known runtime credentials are redacted from projections.

Unlike the disposable probe's local queue, production hooks reuse the existing
bounded HTTP receiver without another disk spool. Unconfirmed callbacks warn
and fail open; tool/edit callbacks missed during collector downtime cannot be
recovered. API text remains recoverable after a restart. This is an explicit
best-effort hook contract, not a durable tool-event journal.

API errors leave hook ingestion usable and recovery visibly degraded until a
successful retry. Fixed error codes and structured step telemetry identify the
failed operation without response bodies or credentials. Disconnect or source
shutdown cancels in-flight recovery and prevents later appends.

## Runtime and bounds {#runtime}

Repository hook installation reuses exact-command ownership and atomic writes.
Only this VM's repository hooks are changed; user hooks survive disconnect.
The packaged start command detaches a foreground supervisor so Cursor's Start
script can finish. The supervisor relaunches only exit 75 (applied central
configuration), using LLP 0529's five relaunches per ten minutes and bounded
backoff. No new supervisor or restart policy is added. Normal stop and
unexpected failures do not restart. Existing daemon stop and
sync commands own teardown and delivery.

Recovery uses one timer, one eight-second operation and one snapshot at a time,
every thirty seconds. A response is at most 2 MiB/256 native messages; records
are at most 256 KiB. Larger conversations fail visibly rather than truncate.
Bounded successful-message identity state suppresses repeat work; durable
writer dedupe remains authoritative after eviction or restart. Hook bodies,
in-flight callbacks and writer rotation retain the existing receiver bounds.

## Compatibility and release evidence {#validation}

Synthetic tests and a hermetic smoke cover real writer/cache dedupe, first-turn
recovery, tool identity, errors, edits, privacy, disconnect, cancellation and
secret-safe telemetry. A packaged live Cloud-to-central run validates the
shipping integration. The API endpoint is documented legacy v0 and metadata is
preview. Hook fidelity remains whatever Cursor supplies; this is not a claim
of complete tool output, billing usage, arbitrary historical backfill, or
recovery after VM destruction.

- https://cursor.com/docs/cloud-agent/api/v0
- https://cursor.com/docs/cloud-agent/metadata
- https://cursor.com/docs/hooks
