# LLP 0012: Sources

**Type:** Spec
**Status:** Active
**Systems:** Sources
**Author:** Phil / Claude
**Date:** 2026-06-01
**Related:** LLP 0013, LLP 0015, LLP 0016

> The source subsystem: how plugins contribute sources and how the kernel drives
> their lifecycle. Decomposed from `hypaware-design.md#sources`. This is the LLP
> the kernel source registry (`src/core/registry/sources.js`) references.

## Summary

A **source** produces normalized rows and owns a daemon lifecycle. Source
plugins implement `start` and return a `StartedSource` handle; the kernel owns
everything around it — registration, lifecycle, status reporting, and the cache
write path. A source never sees sinks. Rows go to the intrinsic local query
cache ([LLP 0013](./0013-local-query-cache.decision.md)) and nowhere else.

## Source kinds

In the V1 user-facing wizard the sources divide into:

- **Client source** — a known tool the kernel configures (`claude`, `codex`).
  Adds its gateway upstream *and* its adapter plugin, which attaches the tool,
  installs hooks/skills, and can backfill local history. Only client sources are
  autodetectable (there is an installed tool to find).
- **Raw proxy source** — `raw-anthropic` / `raw-openai`. Opens the gateway with
  that provider upstream but configures no client; the user points their own SDK
  app at the local gateway. Not autodetectable.
- **OTEL** — a local OTLP receiver for apps that export OpenTelemetry. Manual,
  not autodetectable.

(See `CONTEXT.md` for the canonical glossary of `Source`, `Autodetect`,
`Default`.)

## Contribution surface

A plugin registers a source through `ctx.sources`:

```js
ctx.sources.register({
  name: 'gascity',
  plugin: '@hypaware/gascity',
  summary: 'Gascity supervisor subscription source',
  configSection: 'gascity',
  start: startGascitySource,
})
```

`register` is contract-validated: `name`, `plugin`, and a `start` function are
required, and source names must be unique across the registry.

## StartedSource handle

`start(ctx)` returns a handle:

```ts
interface StartedSource {
  status?(): Promise<SourceStatus>
  reload?(ctx: ActivationContext): Promise<void>
  stop(): Promise<void>
}
```

Only `stop` is required. A handle that does not return a `stop` function is a
contract violation and the kernel rejects it.

## Lifecycle and reload-context invariant

The kernel — not the plugin — drives `start` / `stop` / `reload` / `status`. Two
invariants matter:

### reload-context

`reload` and `start` take the **same `ActivationContext` shape**, carrying a
fresh `config` slice. A plugin reads its current config from `ctx.config` in
both calls and never handles two parameter conventions. Whether a source is a
long-lived listener (proxy, OTLP) or a polling subscriber (gascity) is opaque to
core.

### observable-lifecycle

Every lifecycle transition is wrapped in a `source.*` span and ticks the
`hyp_sources_started` gauge, so `hyp status` can report the active set without
reaching into plugin internals. A `reload` on a source that omits `reload()` is
**not** an error — the kernel emits a `status: skipped` span so an operator can
grep for "reload requested but not supported" rather than seeing silence.

## Constraints

- **Sources never depend on sinks.** If no sink is configured, data lives in the
  cache until retention expires. The source has no sink-facing API.
- **One source, one table.** A source's dataset is named after its producer and
  has exactly one owner. See [LLP 0016](./0016-ai-gateway.decision.md#naming-rule).
- **Status has a safe fallback.** A started source with no `status()` reports
  `{ state: 'ready' }` rather than erroring.
