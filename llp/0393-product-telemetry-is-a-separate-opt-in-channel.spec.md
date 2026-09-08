# LLP 0393: Product telemetry is a separate opt-in channel

**Type:** Spec
**Status:** Draft
**Systems:** Observability, CLI, Daemon, Privacy
**Author:** Phil / Codex
**Date:** 2026-09-08
**Extends:** LLP 0021, LLP 0318

## Contract {#contract}

This request adds a product reporting channel without changing operational OTEL
exporter activation, attributes, temporality or shutdown. It implements the
September 8 product telemetry proposal, with the agreed 30-second basic runtime
sample and five-minute summary correction. `contract.js` holds the coordinated
client/server v1 vocabulary. `productEvent` constructs only approved fields;
unknown command names and extension values become finite unknown/other labels.
Never forward the operational span/log stream, argv values, user resource
attributes, customer content or free-text errors. Receiver attribution comes
from authenticated gateway credentials, not client-supplied organization fields.

One completion summary represents an outer invocation including initialization,
help, version, dispatch misses, boot failures and handled cancellation. Recursive
setup dispatch contributes bounded steps. A hard kill has no completion and
must not be counted as success. Actual loaded versions and process UUIDs preserve
the difference between a new CLI and an old running daemon.

## Policy {#policy}

Collection defaults off. `hyp telemetry enable local` creates a random local
installation identity and a preview queue; it grants no network permission.
`enable organization` explicitly binds consent to an existing enrolled gateway,
its org and HTTPS destination (HTTP only on loopback for hermetic tests).
`off` removes pending copies. Each opt-in creates a new consent generation;
old local or organization history is never copied into that generation.
`status` shows effective collection, destination, queue and delivery state;
`preview` prints the exact next queued wire payload. Vendor sharing and
standalone registration are unavailable pending separately settled policy,
receiver registration, credentials and retention/deletion prerequisites.

## Outbox {#outbox}

The new `product-telemetry/queue-v1` is independent of the captured-data spool.
160 exclusive filesystem slots reserve at most 32 KiB each, including the
private local binding wrapper: aggregate pending payloads cannot exceed 5 MiB
across concurrent CLI writers. This adds a count bound and leaves unused space
when records are small. Writers never wait for the sender and do not boot the
kernel just to append. Full queues drop new copies; a single coalesced marker
reports a dropped-record lower bound instead of claiming an exact count during
a concurrent storm. The sender expires seven-day records and mismatched consent
copies. Local-only queues receive the same retention maintenance on invocation.

Batch IDs and serialized bytes are immutable across retries. The sender has
one process-liveness lock, one in-flight pass, a bounded response body and a
network deadline. Backoff and Retry-After survive restart. Capability absence
pauses delivery; schema, byte-size and ID-conflict refusals discard the poison
batch. Only a durable 202 receipt acknowledges a copy. CLI completion aborts
network work synchronously and never waits for delivery. Without a daemon, the
last invocation may remain undelivered until later ordinary work.

## Runtime {#runtime}

Basic RSS, heap used and interval CPU cores are sampled every 30 seconds and
summarized every five minutes as coverage-weighted average, highest observed
value and latest value. CPU is process CPU delta divided by monotonic elapsed
time, not lifetime percent. Coverage per sample is capped at 30 seconds;
stalls greater than a minute reset the window. Interval duration may reach ten
minutes for scheduling drift, with at most eleven samples; longer windows are
discarded. Missing coverage remains missing. Detailed GC/heap-space/event-loop
diagnostics keep LLP 0318's opt-in contract.

Pipeline counters are deltas over explicit intervals, kept from completed work
with fixed stage labels. No conversation/cache scans are added. Product delivery
uses its own endpoint and never enables capture_self_telemetry. Product queue
writes and sends do not increment customer capture/export counters.

## Validation and rollout {#validation}

The companion server must ship first with its receiver explicitly enabled;
this client change enables no production destination. Tests cover construction,
version attribution, canonicalization, nested/early dispatch, runtime arithmetic,
queue capacity/concurrent writers, restart retry, destination changes and errors.
Benchmarks report measurements separately from targets (10 ms p95 queue append,
1% idle CPU, 10 MiB pipeline memory). A 24-hour installed-daemon outage/idle soak
and cross-version durable-spool acceptance remain manual release gates.
