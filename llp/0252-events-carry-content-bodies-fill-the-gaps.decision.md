# LLP 0252: Events carry the content, body files fill the gaps, and the body is deleted

**Type:** Decision
**Status:** Draft
**Systems:** Sources, Plugins, Privacy
**Author:** Phil / Claude
**Date:** 2026-08-17
**Related:** LLP 0012, LLP 0016, LLP 0030, LLP 0032, LLP 0245 (the RFC this
decision realizes; Draft until 0245 is accepted), LLP 0251, LLP 0253, LLP 0257

> The OTEL event stream is the primary producer: it arrives pre-deduplicated
> and supplies identity, content, usage, and behavioral data. Raw body files
> are read only for what events do not carry (system text, the tools list,
> message ordering, untruncated tool args), and each body file is deleted as
> soon as it has been projected.

## Context

Claude Code exports two things at once: an event stream over OTLP, and raw
request and response bodies written to a directory. Either alone is incomplete
(LLP 0245 records the measurements). This decision settles how the two are
combined, and what happens to a body file afterwards.

## Decision

### Events are the spine {#events-first}

**Each piece of content is taken from the event that carries it exactly once.**
`user_prompt`, `assistant_response`, and `tool_result` are emitted once per
occurrence, so the stream is naturally incremental and needs no windowing,
no replay, and no settlement pass to decide what is new. `message.uuid` on the
event is the row identity.

### Bodies are consulted, not ingested wholesale {#bodies-for-gaps}

**A body file is read for the fields events lack and for nothing else**:
`system_text`, the `tools` list, message ordering, and untruncated tool
arguments (event `tool_input` clips values at 512 characters). The body is
located through `api_request_body.body_ref`. Ingesting bodies as the primary
content source would re-import the whole message history every turn and put the
part-level dedupe back on the hot path for content the events already delivered
once.

### Projected, then deleted {#project-then-delete}

**A body file is deleted immediately after it is projected**, successfully or
not: a body that cannot be projected is not retried forever, because the same
session is recoverable from transcript backfill and an undeleted body is a raw
prompt sitting on disk. Deletion is the normal end of a body's life, not a
cleanup pass, which is what keeps the spool transient rather than an archive.

### OTEL is a third producer, not a new table {#projection-unchanged}

**The listener yields the same `ai_gateway.projected_exchange` values the live
proxy and the backfill providers yield today.** The `ai_gateway_messages`
dataset, its `part_id` dedupe, its partitioning (LLP 0030), and its repo
identity columns (LLP 0032) are untouched. The overlap window during migration
is therefore harmless: two producers writing the same parts dedupe into one
row.

## Consequences

- Every existing query, report, and graph consumer of `ai_gateway_messages`
  keeps working with no change.
- A session captured while the daemon was down loses its events but keeps its
  bodies until the spool cap evicts them (LLP 0253); what neither survives,
  transcript backfill recovers.
- `parent_uuid`, `logical_parent_uuid`, `user_type`, and `permission_mode`
  read null on this path. They stay in the schema; `query_source` and
  `agent.name` are the attribution source for sidechain and agent identity.
- A body-format change upstream degrades exactly one axis (system text, tools,
  ordering, long tool args) instead of stopping capture, because the events
  still carry the content.
