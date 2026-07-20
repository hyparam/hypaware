# LLP 0120: hermes rows are ai_gateway_messages rows, not a new table

**Type:** Decision
**Status:** Accepted
**Systems:** Sources, Plugins, Cache
**Author:** Phil / Claude
**Date:** 2026-07-20
**Related:** LLP 0012, LLP 0015, LLP 0026, LLP 0030, LLP 0035, LLP 0118, LLP 0119, LLP 0122

> Hermes activity materializes into the existing `ai_gateway_messages` dataset
> through the `ai_gateway.projected_exchange` materializer, with
> `client_name = 'hermes'`. No new dataset is minted.

## Context

Pulled hermes sessions ([LLP 0119](./0119-hermes-pull-from-state-db.decision.md))
have to land somewhere. Three candidates:

1. A dedicated `hermes_messages` table, per the
   [LLP 0012](./0012-sources.spec.md) "one source, one table" default.
2. The otel `logs` dataset (hermes rows flattened to severity/body log
   records).
3. The canonical `ai_gateway_messages` dataset, via the
   `ai_gateway.projected_exchange` backfill materializer that
   `@hypaware/ai-gateway` registers for exactly this purpose
   (`ai-gateway/src/dataset.js`, `AI_GATEWAY_PROJECTED_EXCHANGE_KIND`).

## Decision

**`ai_gateway_messages`, via the materializer.** The hermes adapter is a
backfill provider yielding `AiGatewayProjectedExchange` items; the ai-gateway
plugin's materializer expands them into canonical rows, the same path
`@hypaware/claude` and `@hypaware/codex` use.

- Hermes data **is** AI-conversation data: sessions, turns, tool calls,
  token usage. Every downstream consumer, `hyp query` conventions, the usage
  reports, context-graph projection ([LLP 0023](./0023-context-graph-projection.decision.md)),
  export/sink policy seams, `hyp purge`, keys off `ai_gateway_messages`. Rows
  landing there make hermes visible to all of it with zero consumer changes
  (spec R1). A parallel table would fork every one of those consumers.
- **"One source, one table" is not violated.** The hermes adapter owns no
  table at all; like claude and codex, it registers no dataset. The single
  owner of `ai_gateway_messages` remains `@hypaware/ai-gateway`, and the
  materializer contract exists precisely so client adapters can feed the
  owner's table without owning it.
- Rejecting otel `logs`: flattening conversations to severity/body log
  records destroys the message/part semantics the dataset consumers rely on,
  and `logs` is invisible to the AI-usage reports and the graph.

## Row semantics {#row-semantics}

- **`client_name` / `conversation_source`:** `'hermes'`. This is the join key
  that distinguishes hermes rows, symmetrical to the claude/codex adapters.
- **`provider`:** derived from the session's billing metadata
  (`billing_provider` / `billing_base_url` in hermes's `sessions` table),
  normalized to the existing provider vocabulary where possible (`openai`,
  `openrouter`, `nous`, ...). Hermes talks to arbitrary OpenAI-compatible
  upstreams, so `provider` reflects the upstream, never `'hermes'` itself:
  hermes is a client, not a provider.
- **Identity (spec R2):** hermes message ids are integers scoped to the
  store, not UUIDs. `message_id` / `part_id` are minted deterministically from
  hermes's stable keys (session id + message id + part index), so re-imports
  dedupe via the existing pre-write `part_id` guard. `session_id` carries the
  hermes session id (namespaced to avoid collision with other clients'
  id spaces; exact format in
  [LLP 0122](./0122-hermes-log-forwarding.design.md#projection)).
- **Usage:** token counts map through
  [LLP 0035](./0035-token-usage-normalization.decision.md) normalization into
  `attributes.usage`; hermes-specific extras (estimated/actual cost,
  api_call_count, end_reason, hermes `source` channel) ride in `attributes`.
- **Threading:** `parent_session_id` maps to `parent_thread_id`, giving
  subagent/delegation links the same shape Claude sidechains have.

## Consequences

- The hermes plugin declares `requires.plugins: ["@hypaware/ai-gateway"]` in
  its manifest; the materializer is a hard dependency
  ([LLP 0006](./0006-dependencies-and-capabilities.spec.md)).
- Schema evolution stays additive and owned by ai-gateway
  ([LLP 0029](./0029-additive-cache-schema-evolution.decision.md)); hermes
  needs no new columns, only `attributes` payloads.
- `session_id` partitioning ([LLP 0030](./0030-session-id-partition-key.decision.md))
  applies to hermes rows unchanged.
- Code that lands this carries `@ref LLP 0120 [implements]` on the projector
  that builds `AiGatewayProjectedExchange` items.
