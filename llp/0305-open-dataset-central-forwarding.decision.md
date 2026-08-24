# LLP 0305: Central forwards eligible open datasets from a fresh baseline

**Type:** Decision
**Status:** Accepted
**Systems:** Sinks, Cache, Plugins, Usage-Policy
**Author:** Phil / Codex
**Date:** 2026-08-24
**Related:** LLP 0014, LLP 0040, LLP 0070, LLP 0105, LLP 0255, LLP 0262, LLP 0278

**Extended-by:** LLP 0307 (durable dataset rollout manifest disambiguates existing, future, and damaged partition progress)

> The central server already accepts catalog registration with
> `PUT /v1/datasets/{name}` followed by `POST /v1/ingest/{name}`. The client
> adopts that protocol for datasets outside the four legacy signal paths, but
> only when their rows can pass the existing export privacy seam safely. A
> newly eligible open dataset starts at its current local high-water, so adding
> support does not replay historical rows or duplicate a prior capture lane.

## Context

The client forward sink historically allowed only `logs`, `traces`, `metrics`,
and `proxy`. Claude's OTEL adapter records behavioral events in
`claude_telemetry_events`, a plugin-owned dataset with its own schema and
`sourceSignal`. The fleet server's accepted catalog protocol already opens the
wire namespace beyond those four names, but the client did not announce or
forward such datasets.

Simply removing the four-signal guard is too broad. The sink driver offers
every registered dataset to every sink. Some derived datasets deliberately
lack per-row `cwd` provenance and instead declare `localOnlyContentColumns` so
the query seam can suppress content. The shared export seam cannot suppress
those columns. Sending their raw rows would bypass the local-only guarantee.

A second migration hazard is history. LLP 0040 intentionally treats a missing
watermark as "export from the beginning" for an established sink. Applying
that default to a dataset that only just became forwardable would replay its
entire local table. For Claude OTEL this can duplicate history already captured
through the prior proxy or transcript lanes.

## Decision

### Routing keeps the legacy four stable {#routing}

The four legacy `sourceSignal` values keep their existing
`/v1/ingest/{signal}` paths and require no registration handshake. Every other
eligible dataset is announced once per sink instance with
`PUT /v1/datasets/{dataset}`. After a successful announcement, its rows are
sent to `/v1/ingest/{dataset}`. The dataset name is URL-escaped identically on
both requests. `sourceSignal` remains registration metadata for an open
dataset; it does not select that dataset's ingest path.

Registration is a capability gate. The client never sends rows for an open
dataset until the server positively acknowledges its schema. A failed
registration leaves only that partition retryable. Legacy behavior is
unchanged.

### Open-dataset eligibility fails closed on unprovenanced content {#eligibility}

A dataset declaring any `localOnlyContentColumns` is ineligible for raw-row
central forwarding. The client rejects it before registration or ingest. This
preserves LLP 0070 and LLP 0105's privacy invariant for derived tables whose
content cannot prove per-row provenance.

All other registered datasets are eligible. This is intentionally a dataset
contract rather than a central-sink allowlist: a dataset with row-level `cwd`
uses the shared export filter, while a plugin declaring unprovenanced content
must remain local until the shared export seam gains an equivalent safe
suppression mechanism.

### A newly eligible open dataset starts from now {#start-now}

When an eligible open dataset has no durable watermark, the forward sink scans
its current sequence high-water without sending rows and persists that value as
the initial watermark with `exportedRowCount: 0`. Pre-sequence legacy rows are
excluded from this baseline scan and remain local. If the partition is empty,
sequence zero is persisted so the first future row is not skipped.

The same sink instance single-flights this initialization per logical
partition. Overlapping ticks therefore share one baseline and cannot race two
scans that skip rows arriving between them. Rows appended after the baseline
snapshot have larger sequence values and are sent by the ordinary incremental
read, including later in the same tick when visible.

This is a narrow extension of LLP 0040. Legacy signals retain its full first
export and at-least-once recovery behavior. Existing open-dataset watermarks
also retain ordinary ship-first, advance-second semantics. Only the transition
from "not forwardable" to "open-dataset forwardable" starts at the current
high-water.

## Consequences

- `claude_telemetry_events` forwards under its dataset name after schema
  registration, while the server catalog retains `sourceSignal:
  claude_telemetry` for discovery and attribution.
- Historical Claude OTEL rows are not backfilled when this support first
  appears. Only events after the baseline reach central, avoiding duplicate
  coverage with the retired proxy lane.
- Context-graph and other datasets declaring `localOnlyContentColumns` do not
  leave the machine through this raw-row protocol.
- The first eligible open-dataset tick scans local history once to derive the
  high-water but sends zero historical bytes.
- Registration and baseline failures remain partition-local and retryable.

## Alternatives considered

- **Add only `claude_telemetry` to the fixed-signal allowlist.** Rejected: the
  server already has a schema-aware open protocol, and another fixed path would
  duplicate catalog behavior while keeping plugin datasets closed.
- **Forward every registered dataset.** Rejected: datasets with
  `localOnlyContentColumns` can contain private derived content that the shared
  export seam cannot classify per row.
- **Replay the full table on first support.** Rejected: it duplicates prior
  capture lanes and contradicts the rollout requirement to begin with new OTEL
  events only.
- **Suppress declared content columns in the central sink.** Rejected for now:
  LLP 0070 keeps privacy enforcement in the shared export read so every sink
  honors it. A central-only redaction would create a second privacy mechanism
  and still leave other sinks inconsistent.
