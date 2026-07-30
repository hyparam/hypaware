# LLP 0144: One shadow provider per API shape, not per vendor

**Type:** Decision
**Status:** Draft
**Systems:** Plugins, Gateway
**Author:** Phil / Claude
**Date:** 2026-07-29
**Related:** LLP 0016 (ai-gateway), LLP 0109 (OpenClaw client adapter), LLP 0142 (plugin-steered shadow providers), LLP 0146 (host-signed providers out of scope)

> LLP 0109 captured Anthropic only. OpenClaw speaks exactly two model API
> shapes, so two shadow providers cover the whole catalog — OpenRouter,
> OpenAI, Groq, and the rest — without a shadow entry per vendor.

## Context

LLP 0109 declared `required_upstreams: ["anthropic"]` and one injected
provider with `api: "anthropic-messages"`. Anything the user ran on another
vendor was never captured, and nothing said so.

OpenClaw normalizes every model provider to one of two API shapes:
`anthropic-messages` or `openai-completions`. The shape is a property of
the provider entry, not the vendor — verified in the `openclaw` repo, where
`anthropic-vertex`, minimax, synthetic, kimi-coding, cloudflare-ai-gateway
and vercel-ai-gateway all declare `api: "anthropic-messages"` while
OpenRouter, OpenAI, Groq and most of the catalog are `openai-completions`.

This is also visible in OpenClaw's own diagnostics: its payload logger
(`src/agents/anthropic-payload-log.ts`) gates on
`model.api === "anthropic-messages"`, not on provider id, so it happens to
log several non-Anthropic vendors and logs nothing at all for the
`openai-completions` half of the catalog. OpenClaw itself has no
full-fidelity record of its own OpenRouter traffic. That is an argument for
capturing it rather than deferring.

## Options considered

1. **One shadow provider per vendor** (`hypaware-openrouter`,
   `hypaware-openai`, `hypaware-groq`, …). Rejected: unbounded mirroring
   work, a new HypAware release every time OpenClaw adds a provider, and
   nothing gained — the wire shape is what the gateway and projectors care
   about.
2. **One shadow provider total, with the gateway sniffing the shape.**
   Rejected: OpenClaw's client SDK selection is driven by the provider
   entry's declared `api`, so a single entry cannot serve both shapes. The
   shape must be declared, not inferred.
3. **One shadow provider per API shape**, with the real upstream carried as
   request metadata. Chosen.

## Decision

The plugin contributes exactly two shadow providers:

- `hypaware-anthropic` — `api: "anthropic-messages"`
- `hypaware-openai` — `api: "openai-completions"`

`before_model_resolve` (LLP 0142) maps the resolved provider to whichever
shadow matches its declared `api`, and the real upstream identity travels
to the gateway as request metadata alongside the existing
`x-hypaware-client: openclaw` header, so the gateway routes to the right
vendor and the projection records the true provider rather than the shadow
id.

Gateway side: one upstream preset per shape family, registered by this
plugin iff not already present, following the last-write-wins
`registerUpstreamPreset` convention LLP 0109 established. The
`anthropic` preset stays named `anthropic` per LLP 0016.

Providers whose `api` is neither shape, or whose authentication is bound to
the request host, are not steered — see LLP 0146.

## Consequences

- Coverage becomes a property of the API shape rather than a vendor
  allowlist, so new OpenClaw providers are captured on arrival without a
  HypAware release.
- The exchange projector must stop assuming Anthropic. Today
  `createOpenclawExchangeProjector` hardcodes `provider: 'anthropic'` and
  parses Anthropic Messages only; it needs a shape-aware branch, or a
  second projector for `openai-completions` with the same header gate. The
  `priority: 110` ordering above the Claude projector still applies.
- `contributes.client.required_upstreams` grows from `["anthropic"]` to
  both presets.
- Session identity keeps LLP 0109's system-prompt-head hash for v1.
  Verified against OpenClaw source: the contexts a plugin controls at
  request time (`wrapStreamFn`, `prepareRuntimeAuth`) carry no
  `sessionId`, and the hooks that do carry it (`before_model_resolve`,
  `llm_input`) cannot set request headers — correlating them through
  shared plugin state would race under concurrent runs. Native session
  identity is a settlement-time enrichment from OpenClaw's session JSONL
  (`~/.openclaw/agents/<id>/sessions/`), the LLP 0027 pattern, exactly as
  LLP 0109's open question anticipated — a follow-up, not part of this
  set.

## Open questions

- Does `openai-completions` need one preset or several? Vendors differ on
  path suffix (`/chat/completions` vs `/v1/chat/completions`) and on
  streaming details. If per-vendor base URLs force per-vendor presets, the
  saving here is smaller than stated, though still bounded by shape for the
  provider entries themselves.
- Reasoning/thinking blocks, tool-call encodings and cache accounting
  differ across `openai-completions` vendors. LLP 0035 normalization may
  need extending per vendor even though the transport is shared.

## References

- LLP 0016, 0035, 0109, 0142, 0146
- `hypaware-core/plugins-workspace/openclaw/src/projector.js`
- `openclaw` repo: `src/agents/anthropic-payload-log.ts`,
  `extensions/*/provider-catalog.ts`
- https://docs.openclaw.ai/concepts/model-providers
