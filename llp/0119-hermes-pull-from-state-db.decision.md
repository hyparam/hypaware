# LLP 0119: hermes capture pulls from state.db, not push, not the wire

**Type:** Decision
**Status:** Accepted
**Systems:** Sources, Plugins
**Author:** Phil / Claude
**Date:** 2026-07-20
**Related:** LLP 0012, LLP 0016, LLP 0026, LLP 0118, LLP 0120, LLP 0122

> The capture seam for [LLP 0118](./0118-hermes-log-forwarding.spec.md) is a
> HypAware-side read of hermes's own canonical store, `~/.hermes/state.db`.
> HypAware pulls; hermes is never modified, configured, or proxied.

## Context

Three viable seams exist for getting hermes activity into HypAware:

1. **Push: a hermes-side observability plugin.** Hermes has a first-class
   observer-hook contract (`hermes.observer.v1`): a Python plugin under its
   `plugins/observability/` tree registers hooks (`pre/post_api_request`,
   `pre/post_tool_call`, session lifecycle) and receives sanitized, correlated
   payloads. Its bundled `nemo_relay` plugin already exports JSONL locally, so
   the precedent is real.
2. **Wire: attach hermes to the AI gateway.** Hermes talks to any
   OpenAI-compatible endpoint via `model.base_url`; pointing that at the
   HypAware gateway ([LLP 0016](./0016-ai-gateway.decision.md)) would capture
   raw LLM traffic inline, the way Claude/Codex live capture works.
3. **Pull: read `~/.hermes/state.db`.** Hermes's SQLite store is its canonical
   conversation record: sessions (model, cwd, parent session, token counts,
   costs) and messages (role, content, tool calls, reasoning, timestamps),
   secret-redacted before write.

## Decision

**Pull from `state.db`.** The `@hypaware/hermes` adapter reads the store
read-only: a backfill provider for history and a polling source for ongoing
capture ([LLP 0122](./0122-hermes-log-forwarding.design.md)).

This is the same shape as the existing client adapters:
`@hypaware/claude` and `@hypaware/codex` read the client's own native on-disk
record and replay it through the `ai_gateway.projected_exchange` materializer
([LLP 0026](./0026-claude-native-granularity.decision.md)). Hermes differs
only in the container (one SQLite file instead of JSONL trees).

Reasons the pull seam wins:

- **Canonical and complete.** state.db is what hermes itself treats as the
  record: every session and message, with the correlation keys, token counts,
  `cwd`, and cost fields already normalized by hermes. History that predates
  HypAware's arrival imports for free.
- **Zero hermes-side footprint.** No Python code to ship, version, or enable
  per machine; no `plugins.enabled` edit in every user's hermes config; no
  coupling to hermes's release cycle. Fleet rollout is just the HypAware
  plugin ([LLP 0031](./0031-layered-config.decision.md) governs enablement).
- **Fail-open by construction.** A read-only reader cannot break hermes; a
  push plugin or an inline proxy sits in hermes's execution path.

## Why not push (observer plugin)

- Requires shipping and maintaining Python inside another project's plugin
  system, enabled per-machine by hand; unenabled machines silently capture
  nothing.
- Only sees events from enablement forward; history needs a second mechanism
  anyway, which would end up being this pull path.
- Hook payloads are sanitized and truncated relative to what state.db keeps.
- HypAware would need a receiving surface: reusing the OTLP listener lands
  rows in `logs`/`traces`, the wrong dataset
  ([LLP 0120](./0120-hermes-rows-are-ai-gateway-messages.decision.md)), and a
  bespoke push endpoint is new gateway surface for one client.

## Why not wire (base_url attach)

- Captures only the LLM wire traffic. Session boundaries, parent/subagent
  links, cwd, cost accounting, and end reasons live in hermes, not on the
  wire; the store has them, the wire does not.
- Intrusive: it edits the user's hermes model config, and hermes users point
  `base_url` at many different providers (Nous Portal, OpenRouter, Ollama,
  custom). The gateway would need generic OpenAI-compatible passthrough per
  upstream, and every provider switch would silently detach capture.
- Violates the spec's R8 posture (capture must not sit in hermes's live call
  path). Wire attach stays open as a possible future complement for raw
  request/response fidelity; it is not the seam.

## Consequences

- The adapter needs a SQLite read path in Node; reader choice and the runtime
  floor it implies are a design concern
  ([LLP 0122](./0122-hermes-log-forwarding.design.md#sqlite)).
- Capture lag is the poll interval, not zero. Acceptable: every downstream
  consumer of `ai_gateway_messages` is already asynchronous.
- Content fidelity is bounded by what hermes persists. That bound is also a
  privacy feature: hermes redacts secrets before writing state.db, so the
  captured record inherits that redaction.
- Code that lands this carries `@ref LLP 0119 [implements]` on the reader and
  poll/backfill entry points.
