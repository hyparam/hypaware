# LLP 0318: Runtime diagnostics are opt-in, periodic, and batched

**Type:** Decision
**Status:** Accepted
**Systems:** Observability
**Author:** Phil / Codex
**Date:** 2026-08-27
**Related:** LLP 0021 (#otel-is-the-substrate, #exporter-selection, #self-loop-guard, #shutdown-and-flush)

> Extends [LLP 0021](./0021-observability.spec.md). HypAware can sample the
> running Node process deeply enough to diagnose memory pressure and CPU
> spikes, but only when an operator opts in and an exporter exists. One tick is
> one bounded OTLP batch, never one request per data point.

## Context {#context}

HypAware already records the work it performs: commands, source transitions,
cache writes, queries, and sink exports. Those signals explain what the daemon
was doing, but not why the host became unhealthy. An out-of-memory failure can
come from the JavaScript heap, external buffers, native allocation, or simple
host pressure. A CPU spike can be ordinary application work, garbage
collection, event-loop congestion, or a resource leak that keeps work alive.
The existing metrics do not distinguish those cases.

Always-on high-frequency runtime sampling would create the problem it is meant
to diagnose. V8 heap inspection, event-loop histograms, JSON encoding, file
writes, and OTLP requests all consume the same CPU and memory being measured.
The failure mode gets worse if every gauge is exported as a separate request.

## Decision {#decision}

### Explicit activation {#activation}

`HYP_OTEL_RUNTIME_METRICS=1` enables runtime diagnostics. It does not select an
exporter. The existing exporter rules still apply, so sampling starts only when
`HYP_DEV_TELEMETRY=1` or `OTEL_EXPORTER_OTLP_ENDPOINT` installed a meter
provider. Setting the flag without an export destination creates no timer,
histogram, or observer.

`HYP_OTEL_RUNTIME_METRICS_INTERVAL_MS` controls the interval. The default is 30
seconds and every valid value is clamped to a minimum of five seconds. Invalid
values fall back to the default. The floor is load-bearing: an operator can ask
for more resolution, but cannot accidentally turn diagnostic sampling into a
tight loop.

### Diagnostic surface {#surface}

Each sample records a bounded, secret-free set of gauges:

- process RSS, JavaScript heap, external, array-buffer, and V8 allocator memory;
- used and available bytes for V8's finite heap-space set;
- process CPU consumption expressed as cores used during the interval;
- event-loop utilization and delay distribution summaries;
- garbage-collection count and duration accumulated during the interval;
- host total/free memory and one, five, and fifteen minute load averages;
- counts for Node's finite active-resource type set; and
- process uptime plus the sampler's own collection duration.

No payload, path, prompt, credential, customer value, or unbounded application
identifier is inspected or attached. Attribute values come only from small
runtime enums such as heap-space, resource, GC kind, statistic, and load
window.

### One sample, one export {#batching}

All points from one tick share a timestamp and are handed to the meter provider
as one batch. The OTLP exporter therefore sends at most one metrics request per
interval. Dev JSONL still writes one queryable line per point, but receives the
points in the same batch.

The interval timer is unreferenced, collection is synchronous and
non-overlapping, and exporter failures never escape into the application. The
event-loop delay monitor uses a coarse 100 millisecond resolution. The sampler
stops before the meter provider is flushed and shut down.

## Consequences {#consequences}

- Runtime diagnostics are suitable for a temporary incident window or a
  deliberately enabled daemon, not an invisible default cost.
- Short CLI processes emit an initial memory/host snapshot. Interval-derived
  CPU, event-loop, and GC values appear once enough time has elapsed.
- One slow collector can leave at most the exporter's existing bounded timeout
  overlapping a tick; the five-second floor is longer than that timeout.
- The collection-duration gauge makes sampler overhead observable in the same
  dataset used to diagnose the target process.
- Adding a high-cardinality attribute, a payload-derived value, or a separate
  request per point changes this decision and requires a new LLP.
