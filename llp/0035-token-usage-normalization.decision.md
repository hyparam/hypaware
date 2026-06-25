# LLP 0035: Normalize token-usage semantics in `attributes.usage`

**Type:** Decision
**Status:** Draft
**Systems:** Gateway, Plugins
**Author:** Brendan / Claude
**Date:** 2026-06-23
**Related:** LLP 0016 (ai-gateway), LLP 0026 (claude-native-granularity), LLP 0030 (session-id-partition-key)

## Summary

`attributes.usage` on `ai_gateway_messages` carries token counts from multiple
providers. Two cross-cutting rules keep the column analyzable without the
analyst (human or model) having to special-case the provider:

1. **`input_tokens` is net of cache, everywhere.** It counts only *uncached*
   prompt tokens. Cached prompt reads ride `cache_read_tokens`, and (Claude
   only) cache writes ride `cache_write_tokens`. So for every provider
   `input_tokens + cache_read_tokens [+ cache_write_tokens] = total prompt`,
   and a naive `SUM(input_tokens)` or `SUM(input_tokens + cache_read_tokens)`
   means the same thing across rows.
2. **Per-message usage is per-response (a delta), never cumulative.** A row's
   usage describes the one model response that produced it; summing rows over a
   conversation reconstructs the conversation total.

`total_tokens`, when a provider supplies it, is stored **raw** (the provider's
own total, which is gross-input + output). Because input is stored net, the
identity `input_tokens + cache_read_tokens + output_tokens == total_tokens`
holds — a cheap reconciliation check.

## Context

`attributes.usage` was first shaped by the Claude adapter, whose transcript
`usage` block is already per-response and **net**: Anthropic reports
`input_tokens` (uncached), `cache_read_input_tokens`, and
`cache_creation_input_tokens` as three additive, non-overlapping fields
(`anthropic.js#anthropicMessageAttributes` maps the latter two to
`cache_read_tokens` / `cache_write_tokens`).

OpenAI and ChatGPT Codex report usage differently:

- `input_tokens` (Responses) / `prompt_tokens` (Chat) is **gross** — it
  *includes* the cached reads. The cached subset is
  `input_tokens_details.cached_tokens` (live) or `cached_input_tokens` (the
  Codex rollout `token_count` event).
- The Codex rollout emits a `token_count` event after each turn carrying both
  `total_token_usage` (cumulative session running total) and
  `last_token_usage` (this turn).

If those raw shapes were stored as-is, `usage.input_tokens` would mean
"uncached input" for Claude and "input incl. cache" for Codex — the same
column, two meanings. Any cross-provider `SUM`/comparison would silently
mismix net and gross, and `input_tokens + cache_read_tokens` would
double-count cache for Codex. That is a confidently-wrong-numbers trap for an
LLM querying the data, which is HypAware's primary consumer.

## Decision

- <a id="net-input"></a>**Net input.** Both the live Codex exchange projector
  (`exchange-projector.js#openAiUsageAttributes`) and the Codex backfill
  (`backfill.js#codexUsageAttributes`) compute
  `input_tokens = grossInput − cachedInput` (floored at 0) and put the cached
  count on `cache_read_tokens`. The Claude adapter already produces net input
  and is unchanged — Claude/net is the anchor convention.
- <a id="per-turn"></a>**Per-turn, not cumulative.** Codex backfill reads the
  `token_count` event's `last_token_usage`, never `total_token_usage`. The
  event is consumed as a turn-boundary marker (it never projects a row); its
  usage is stamped per the one-carrier rule below.
- <a id="one-carrier"></a>**One carrier per response, on the last assistant
  row.** A billed response fans into several rows — Claude splits one API
  message into one row per content block (LLP 0026); Codex fans a response into
  separate messages and a turn into reasoning/text/tool rows. Response-level
  `usage` is stamped onto exactly **one** of those rows: the **last** assistant
  row of the response (the terminal output item — a `tool_use` on tool-calling
  turns, else the final `text`). This holds for all four paths:
  - Claude live (`projector.js#projectAssistantMessage`) and backfill
    (`backfill.js`, last block per `messageId`) — usage rides the same
    last-block row as `stop_reason`, instead of being duplicated onto every
    block.
  - Codex live (`exchange-projector.js#stampUsageOnLastAssistant`) and backfill
    (`backfill.js#stampUsageOnTurn`, last eligible) — switched from first to
    last so the carrier row matches Claude. Both apply the **same** eligibility
    predicate (`hasTextOrToolUse`: the last assistant row carrying text or a
    tool_use, skipping reasoning-only rows), so the two paths select the same
    carrier *by rule* rather than by the coincidence that a live Responses reply
    never ends in a reasoning-only assistant message. A turn with no eligible
    assistant (e.g. windowed out) drops its usage rather than mis-attributing
    it to an earlier row.

  Two payoffs: a plain `SUM(attributes.usage.*)` over rows is correct with no
  dedupe, and a human scanning the table sees one identical shape for both
  providers (a run of assistant rows, usage on the final one). Live and backfill
  pick the same last row, so they dedupe onto it (the dedup hash excludes
  `attributes`, so placement is safe). The within-message carrier rule is
  enforced structurally too: when a single usage-bearing *message* has multiple
  content blocks, `expandMessageParts` stamps `usage` on only its **last** part
  (`message_projector.js#stripUsage`), so a multi-block carrier no longer
  replicates (over-counts) its usage across every block. This edge was assumed
  not to occur ("carrier messages are single-block"), but Claude backfill does
  emit multi-block carrier messages — `reasoning + text`, `reasoning + tool_use`,
  and parallel-tool-call turns (`reasoning + reasoning + tool_use + tool_use`) —
  where the transcript records several blocks under one `messageId`. Those were
  the only rows where a plain `SUM` over-counted before this rule was made
  unconditional.
- **Raw total.** `total_tokens` is passed through unmodified; net input keeps
  the reconciliation identity intact.

No information is lost: the provider's gross input is recoverable as
`input_tokens + cache_read_tokens`.

## Canonical query surface

Token accounting reads **`attributes.usage`** (a JSON column), never
`raw_frame`. `attributes.usage` is the only path populated for every provider
and capture mode (Claude live + backfill, Codex live + backfill). The
provider-raw frame is unreliable: `raw_frame` is null for Claude *live* and all
Codex; only Claude *backfill* stashes the transcript line. And the id, when
present, is the **flat `raw_frame.message_id`** — not the nested
`raw_frame.message.id` / `raw_frame.message.usage` some older notes cite (both
null in the data).

With the one-carrier rule above, each response contributes usage to exactly one
row, so a plain sum is correct:

```sql
SELECT
  SUM(CAST(JSON_EXTRACT(attributes, '$.usage.input_tokens')      AS BIGINT)) AS input,
  SUM(CAST(JSON_EXTRACT(attributes, '$.usage.output_tokens')     AS BIGINT)) AS output,
  SUM(CAST(JSON_EXTRACT(attributes, '$.usage.cache_read_tokens') AS BIGINT)) AS cache_read,
  SUM(CAST(JSON_EXTRACT(attributes, '$.usage.cache_write_tokens')AS BIGINT)) AS cache_write,
  SUM(CAST(JSON_EXTRACT(attributes, '$.usage.reasoning_tokens')  AS BIGINT)) AS reasoning
FROM ai_gateway_messages
WHERE role = 'assistant' AND JSON_EXTRACT(attributes, '$.usage') IS NOT NULL
```

A defensive `max()`-per-`COALESCE(raw_frame.message_id, message_id)` rollup also
remains correct (the non-carrier blocks are null and ignored), so it's safe to
keep in queries written before this decision. Field union across providers:
Codex carries `reasoning_tokens` and no `cache_write_tokens`; Claude is the
reverse; `input_tokens` is net for both (#net-input). `COALESCE(..., 0)` the
union.

### Consequences

- Cross-provider input-token analysis is apples-to-apples; cache is never
  double-counted in a prompt-token sum.
- **Codex `input_tokens` no longer equals the provider's raw number.** Anyone
  comparing a HypAware row against an OpenAI dashboard must add
  `cache_read_tokens` back. This is the deliberate cost of one consistent
  column.
- The live Codex usage extraction was uncommitted when this decision landed, so
  no shipped Codex rows used the gross form.
- Claude **field values** are unchanged (already net), but Claude usage
  **placement** changed: it now rides one row (the last block) instead of every
  block — see #one-carrier and the LLP 0026 consequence revision. No in-app
  consumer reads `attributes.usage` (verified: context graph, enrichment, sinks,
  datasets, and vector search all ignore it), so only ad-hoc/skill SQL is
  affected, and the `max()`-per-message-id form still works.

## Alternatives considered

- **Gross everywhere** (fold Claude's cache into `input_tokens`): rewrites the
  meaning of already-shipped Claude rows and touches more adapters. Rejected —
  larger blast radius, and it discards the clean additive cache breakdown.
- **Leave provider-native, document the asymmetry**: zero code, but the
  footgun stays in the data forever and every consumer must re-learn it.
  Rejected — pushes the cost onto every future query.
