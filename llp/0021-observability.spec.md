# LLP 0021: Observability and Self-Instrumentation

**Type:** Spec
**Status:** Active
**Systems:** Observability
**Author:** Phil / Claude
**Date:** 2026-06-01
**Related:** LLP 0002, LLP 0012, LLP 0014

> How HypAware instruments itself. Lifts the "Self-Instrumentation Contract" from
> the tombstoned implementation plan ([LLP 0018](./tombstones/0018-implementation-plan.plan.md))
> into live guidance, grounded in `src/core/observability/`. This is the spec the
> log-driven-development workflow in `AGENTS.md` depends on.

## Summary

The kernel emits its own traces, logs, and metrics through OpenTelemetry. The
same signal stream is the basis for smoke assertions (via on-disk JSONL) and for
production export (via OTLP) — and the two paths are **mutually exclusive** so a
daemon never exports into its own listener. Every emission carries a small,
normalized, queryable attribute set so `hyp query` / `ctvs query` can run SQL
over it.

## OTEL is the substrate

`installObservability()` builds tracer, logger, and meter providers from a
single shared `Resource` derived from env. It is **idempotent** — a second call
returns the existing handle — and returns a `shutdown()` that flushes and closes
exporters in reverse order. Telemetry is **safe-by-default**: `getTracer()`
always returns a usable tracer (the global no-op when no provider is installed),
so instrumented code never has to null-check the telemetry layer.

## Exporter selection

The provider's exporter set is chosen from env, with three states:

- **`HYP_DEV_TELEMETRY=1`** → JSONL exporters write
  `<state>/dev-telemetry/{traces,logs,metrics}-<pid>.jsonl`. Smoke flows assert
  against these on-disk artifacts without needing a live OTLP receiver.
- **`OTEL_EXPORTER_OTLP_ENDPOINT` set *and* dev telemetry off** → the OTLP HTTP
  exporter, pointed at `<endpoint>/v1/traces` (etc.).
- **Neither** → no exporter; the global tracer stays a no-op.

### Self-loop guard

The OTLP branch is gated on `!devTelemetry && otlpEndpoint` — the two export
modes are **mutually exclusive by construction**. This is the load-bearing
invariant behind the `otel_self_loop_guard` acceptance smoke
([LLP 0002](./0002-v1-scope.decision.md#v1-acceptance-criteria-summary)): a
daemon that runs its own OTLP listener must not also export *into* it, or it
feeds itself in a runaway loop. Any change that lets both exporters install at
once reintroduces that loop.

## The attribute contract

Every kernel/plugin emission uses the normalized vocabulary in `Attr` and is
passed through `buildAttrs`, which:

- normalizes keys to **snake_case**,
- constrains `status` to a fixed set — **`ok` / `failed` / `skipped` /
  `degraded` / `cancelled`** — coercing anything else to `failed`,
- bounds cardinality (≤64 attrs) and value length (≤512 chars).

The canonical keys: `hyp_component`, `hyp_plugin`, `hyp_capability`,
`hyp_operation`, `hyp_dataset`, `hyp_sink_instance`, `status`, `error_kind`,
`smoke_name`, `smoke_step`, `dev_run_id`. This constraint is **deliberate, not
cosmetic**: the JSONL exporters flatten each span/log/metric into one record per
line (one file per signal per pid) precisely so a smoke can query a single named
signal by attribute without unpacking the OTel resource tree. Loosening the
vocabulary breaks queryability.

## Span helpers

Two wrappers carry the contract so callers don't hand-roll spans:

- **`withSpan(name, attrs, fn)`** — runs `fn` inside a span that inherits the
  active OTel context as parent. Records `status` from the attrs, captures thrown
  errors as `error_kind` (default `unhandled_exception`), and always ends the
  span.
- **`runRoot(name, attrs, fn)`** — same, but starts a *fresh root* span with no
  parent. For units of work that are logically a boot or a top-level command.

These are the sanctioned way to instrument a lifecycle transition. The source
and sink registries wrap every transition this way (see
[LLP 0012](./0012-sources.spec.md#observable-lifecycle)) so `hyp status` and
smokes can observe the active set without reaching into plugin internals.

## Secret safety

Dev telemetry is local and must stay secret-safe: **never record credentials,
raw prompts, private customer data, or hidden reasoning.** Use hashes or short
redacted excerpts when payload identity matters. The 512-char value truncation
in `buildAttrs` is a backstop, not the policy — emitters are responsible for not
putting secrets in attributes in the first place.

## Shutdown and flush

`shutdown()` closes exporters in reverse install order. Dev telemetry gets a
longer budget (5s vs 500ms) and an explicit `forceFlush` before close, so a
smoke that shuts the kernel down and then reads the JSONL sees a complete
artifact rather than a truncated one. JSONL files are opened lazily on first
write, so a no-op run leaves no empty files behind.
