# LLP 0016: AI Gateway as a Plugin

**Type:** Decision
**Status:** Active
**Systems:** Gateway
**Author:** Phil / Claude
**Date:** 2026-06-01
**Related:** LLP 0006, LLP 0012, LLP 0015

> The load-bearing capability for client adapters. Decomposed from
> `hypaware-design.md` (AI Gateway as a Plugin).

## Knows nothing about Claude or Codex

`@hypaware/ai-gateway` is worth calling out because it is the load-bearing
capability for client adapters and deliberately knows nothing about any specific
client. It owns:

- the local HTTP listener
- upstream routing
- SSE capture
- redaction
- request/response recording
- the `ai_gateway_messages` dataset registration
- the `hypaware.ai-gateway` capability

Client adapters (`@hypaware/claude`, `@hypaware/codex`) **require** the
`hypaware.ai-gateway` capability ([LLP 0006](./0006-dependencies-and-capabilities.spec.md))
and use it to register upstream presets, attach/detach client settings, install
client-side skills, and enrich rows in `ai_gateway_messages` from local
transcripts (Claude only).

The gateway exposes typed hooks — `registerUpstreamPreset`, `registerClient`,
`registerMessageEnricher` — so a new adapter never modifies gateway code.

## Naming rule

**One source, one table.** Each dataset table has exactly **one producer
plugin**, and the table is named after that producer (`ai_gateway_messages`,
`gascity_messages`, `logs`, `traces`, `metrics`). There is no shared
`proxy_messages` schema that multiple plugins contribute to. This keeps schema
ownership unambiguous: the producing plugin evolves its own shape without
cross-plugin coordination, and adapter enrichers/skills compile against a
stable, single-owner table.

A different source for similar data — say a `@hypaware/litellm` plugin —
registers its **own** table (`litellm_messages`). It may adopt the same column
shape as a stylistic convergence, but that is not a shared contract enforced by
core. Users who run both and want a unified view define a SQL view over the
union themselves; HypAware does not federate across producers for them.

The pattern extends to anticipated proxies: `@hypaware/mcp-proxy` →
`mcp_proxy_messages`, `@hypaware/http-proxy` → `http_proxy_messages`. The shared
substrate is the **plugin shape** (local listener, upstream routing,
SSE/streaming capture, redaction hooks, structured recording), not the table.
