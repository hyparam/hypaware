# LLP 0389: Body-derived rows on the OTEL path carry a match-key and settle at flush

**Type:** Decision
**Status:** Accepted
**Systems:** Gateway, Sources, Cache, Plugins
**Author:** Phil / Claude
**Date:** 2026-09-08
**Related:** LLP 0027, LLP 0252, LLP 0254 (narrowed here), LLP 0262
**Tracker:** hyparam/hypaware#1464

> LLP 0254 retired flush-time settlement on the OTEL path because events carry
> `message.uuid`. That holds for the rows a content event produces. It does not
> hold for the blocks only a spooled body carries - tool_use, tool_result,
> thinking - which have no uuid anywhere, so the gateway synthesizes a content
> hash for them while the transcript sweep writes the same block under the
> transcript line's uuid. Those rows carry the LLP 0027 match-key and settle at
> flush like any other fallback row.

## Context

LLP 0262 keeps transcript backfill as the recovery path after the OTEL flip and
records that "capture overlap is harmless because both producers dedupe into the
same rows". LLP 0254 explains why no settlement pass is needed to make that
true: identity arrives on the event.

LLP 0252 #bodies-for-gaps then added a second content source on the same path.
A body file is read for what events lack, and each gap block becomes its own
projected message. Neither the body event nor the block inside it carries a
native uuid, so those messages reach the gateway with no `message_id` and are
given the fallback content hash. The transcript sweep gives the identical block
the transcript line's uuid. The two ids never meet, the `part_id` dedupe never
fires, and one tool call is stored twice - once per lane - inflating tool-call
counts and token sums on every OTEL-attached machine that also runs the sweep
(hyparam/hypaware#1464: 29 of 50 sessions dual-captured, 1,155 tool calls and
571k output tokens counted twice).

## Decision

### A body-derived row is provisional, so it carries a match-key {#match-key-on-bodies}

**A projected message with no native uuid carries
`attributes.claude.match_key`, on every producer.** The proxy projector has
stamped it since LLP 0027; the OTEL projection now stamps it on the messages
`spooledBodyGapMessages` produces, for the same reason and by the same rule
(role plus canonical content). Flush-time settlement then upgrades the row to
the transcript line's uuid, the `part_id` becomes `<uuid>#<part_index>` on both
lanes, and the dataset's dedupe collapses the overlap whichever lane wrote
first.

### LLP 0254 narrows to event-derived rows {#scope-of-0254}

**"Final when written" is a property of the rows a content event produces, not
of the path.** LLP 0254 #identity-at-ingest stands for `user_prompt` and
`assistant_response` rows, and its #policy-inline decision is untouched: the
usage-policy check still runs at ingest with cwd in hand, and no row on this
path is written provisionally with respect to privacy. Only identity settles
late, and only for the blocks a body carries.

## Consequences

- Body-derived rows are hashed twice at projection (once for the match-key,
  once for the gateway's fallback id) exactly as proxy-projected fallback rows
  already are. The added work is one sha256 over content already canonicalized
  for the fallback id, on a path that only runs for blocks a body carries.
- A block whose transcript line has not landed yet stays on its fallback id and
  is repaired by the LLP 0027 re-settle sweep, the same backstop the proxy path
  uses.
- Rows written before this decision carry no match-key, so nothing can re-match
  them: the duplicates already in a cache stay there, and a report over that
  window has to collapse them itself (group on `session_id` plus
  `tool_call_id`, or read one `conversation_source`).
- A subagent's body-derived rows are attributed by `agent.name` while the
  transcript scopes by `agentId`, so they do not match a transcript line and
  stay on the fallback id. They already did; this decision does not change it.
