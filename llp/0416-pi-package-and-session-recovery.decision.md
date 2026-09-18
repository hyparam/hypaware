# LLP 0416: Pi package and session recovery

**Type:** Decision
**Status:** Draft
**Systems:** Sources, Plugins, Backfill, Privacy
**Author:** Phil / Codex
**Date:** 2026-09-17
**Related:** LLP 0306, LLP 0035, LLP 0359

## Capture {#capture}

A standalone, dependency-free Pi package observes the supported session API.
It sends completed entries after append, at turn and lifecycle boundaries.
Pi 0.85.1 awaits message_end handlers before assigning the native entry ID, so
message_end is not a capture boundary. Startup sets a leaf checkpoint rather
than retransmitting history. Ephemeral sessions are not recorded.

The bundled endpoint-free Pi adapter receives bounded batches on loopback and
uses the existing ai_gateway_messages projector/writer. Scheduled native JSONL
recovery shares its Pi projector, respects existing backfill controls, and
skips unchanged files. Source paths follow PI_CODING_AGENT_DIR and
PI_CODING_AGENT_SESSION_DIR; process-only --session-dir overrides need the same
session-root override in the collector environment for historical recovery.

## Identity and accounting {#identity}

Message IDs namespace native entry IDs by Pi session ID and cwd. Parent IDs
refer explicitly to native entry identities, including metadata entries which
do not themselves become conversation rows. Parts derive from canonical
message ID and block order. Streaming partial messages never become rows.

Fork recovery verifies copied entries against the immediate parent's native
IDs, timestamps and payloads, ignoring re-chained parentId. Copied context is
retained under the child session but carries no additive usage. A missing,
unsupported, over-budget or excluded parent refuses that fork's recovery
instead of guessing ownership or reading excluded history. Normal live capture
starts after the copied prefix, so new child activity does not depend on the
parent being available. Nested tool usage is preserved as source detail, not
added to response usage: it may aggregate independently recorded child work.
Compaction and branch-summary usage is additive once per new summary entry.
Pi input is already net of cache and is not reduced a second time.

## Bounds and policy {#bounds}

The extension limits entry traversal, queued bytes and request size, sends
serially with timeouts, and never awaits network delivery in an agent hook.
Shutdown drains for a bounded interval. Overflow or outage relies on native
history. The listener admits one batch at a time and uses batch-scoped writer
state; durable identity dedupe remains owned by the dataset. Historical files
are streamed in bounded batches, with bounded line/file/identity budgets and
observable refusal when exceeded. This is not an exactly-once transport.

Live encoding visits and string sizes are bounded before materializing JSON;
entries are encoded once, with a per-hook work budget and early queue
backpressure. Recovery assembles each JSONL line once and uses its original
byte length for batching. Payload hashes are computed only for IDs present in
a fork parent index. Fingerprints are pruned before processing a discovered
file set, including runs later interrupted by cancellation.

A scheduled sweep reserves at most 256 MiB of session and parent input. Its
process-local starting file rotates on deferral so continuously changing or
invalid early files cannot starve later files. Deferred input is retried by
later sweeps and reported in scan telemetry; manual imports keep their explicit
full-range behavior. This bounds provider input, not total daemon RAM: shared
gateway dedupe retains a spool snapshot and emitted identities for each run,
and live pre-write dedupe still scans pending spool rows per batch.

Both lanes apply persistent session exclusions and directory policy before
storage. Local-only rows retain cwd for export withholding. No payloads or
credentials are emitted in collector diagnostics. Custom root discovery does
not scan unrelated home directories or OpenClaw storage.

## Installation {#installation}

packages/pi-extension is an independently packable Pi package. The same
single-file extension is shipped with HypAware for managed-file attach, so the
normal picker can work without invoking npm. Marker-owned detach touches only
that managed file. Pi package installs remain Pi-owned. A process-local lease
prevents simultaneous package and managed-file instances from both recording.
The package uses the default loopback endpoint unless explicitly overridden;
managed attach embeds the configured endpoint. Disabling the HypAware Pi
adapter stops live and scheduled collection; removing an extension alone does
not disable historical import.

## Validation {#validation}

Deterministic tests and a hermetic smoke cover projection, replay, accounting,
privacy, package lifecycle and health. An isolated actual Pi 0.85.1 run with a
fake provider verifies extension loading and append ordering without credentials
or paid model calls. Real-provider, TUI and upstream-version acceptance remains
a release gate; source inspection and fixtures cannot replace it.
