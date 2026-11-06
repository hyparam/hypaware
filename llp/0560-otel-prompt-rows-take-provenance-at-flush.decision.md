# LLP 0560: An OTEL prompt row takes its transcript line's provenance at flush, keyed by the uuid it already has

**Type:** Decision
**Status:** Accepted
**Systems:** Gateway, Sources, Cache, Plugins
**Author:** Brendan / Claude
**Date:** 2026-10-27
**Related:** LLP 0027, LLP 0254 (extended here), LLP 0262 (open question 3),
LLP 0389 (extended here), LLP 0435, LLP 0312

> LLP 0254 made a row projected from an OTEL content event final when written,
> because the event carries `message.uuid`. That settled identity. It also, by
> omission, settled that such a row never reads its transcript line again, and
> the line records facts the event does not: who submitted the turn
> (`origin.kind`, `promptSource`), and the columns the proxy and sweep lanes
> fill from the same line (`entrypoint`, `user_type`, `permission_mode`,
> `parent_uuid`). This decision keeps identity final at ingest and lets a
> user-prompt row take that provenance at flush, from the one line its uuid
> names, through the settlement pass LLP 0389 already runs on this path.

## Context {#context}

Claude Code writes `origin` and `promptSource` on every submitted user turn in
the transcript (from 2.1.241). Neither field is on the wire request, and the
`user_prompt` telemetry event carries `message.uuid`, `prompt`, `prompt.id`,
`prompt_length`, `session.id`, `terminal.type` and `user.id`, nothing about
how the turn was submitted (verified against a raw OTLP export of 2.1.311 and
the published event reference). Injected user-role turns, such as task
notifications, peer messages and skill expansions, produce the same event.

LLP 0262 open question 3 dropped the transcript join for live capture on a
survey that found no consumer of the transcript-only columns. That was true of
the identity columns it named. It did not weigh the attributes that exist only
in the transcript, and the consumers arrived later: `tool_use_result`,
`spawned_by_tool_use_id` (issue #1794), and now the human-message count, whose
only deterministic signal is `origin.kind` on exactly the rows the gap covers.

The sweep cannot fill the gap. Its copy of a typed prompt shares the live row's
uuid, so the backfill materializer's pre-write `part_id` dedupe skips it; the
committed row wins and keeps its event-only attributes. On the team remote for
2026-10-13 to 2026-10-27, 7,991 typed Claude prompts on 15 machines arrived on
the OTEL lane with no transcript field at all, against 8,856 through the sweep
that have them. The proxy lane for Claude carried zero rows in that window.

Tool rows do not have the gap. LLP 0389 gave body-derived rows a match-key so
settlement finds their line and adopts its uuid, which is why 741 of 930
tool-result rows in a week carry `parent_uuid` and typed prompts carry none.
The settlement pass, the per-session transcript load and the index with its
`byUuid` map therefore already run on this lane for most agentic batches. The
prompt row in the same batch is skipped only because the gateway's selection
cannot see anything provisional about it.

## Decision {#decision}

### The plugin names the rows the gateway cannot see {#wants}

**`AiGatewaySettlementEnricher` gains an optional `wants(row)`, and the
gateway's flush-time selection admits a row its client's enricher answers
`true` for.** The gateway's own three shapes (LLP 0027 fallback, null cwd,
LLP 0441 successor) each describe a row with something provisional about it.
A row can also be final in identity and still owe its native log a field only
that log records, and which rows those are is the client's knowledge. The
enricher answers per row, from the row alone, at flush; the answer is not
stored. A wanted row does not set the batch's fallback flag, so the
committed-`part_id` scan stays off for a batch that holds only such rows.

The Claude enricher answers `true` for a row with role `user`, a native
`provider_uuid`, `gateway.source = otel`, no `claude.match_key`, and no
`claude.origin`. The last clause makes the stamp idempotent under any pass that
revisits committed rows.

### Provenance lands at flush, by uuid {#provenance-at-flush}

**For a wanted row the enricher looks its transcript line up in the session
index by `provider_uuid`, accepts it only when the line's role is `user`, and
copies onto the row what the row lacks:** `origin` and `promptSource` into
`attributes.claude.origin` and `attributes.claude.prompt_source`, verbatim,
and, only where the row holds nothing, `entrypoint`, `user_type`,
`permission_mode`, `parent_uuid`, `logical_parent_uuid`, `provider_type`,
`provider_subtype`, the compaction fields, and the minimized `raw_frame`. The
event's own attributes (`query_source`, `terminal_type`, `organization_id`,
`client.*`, `gateway.*`) survive the merge.

This is a key lookup, not a match. There is no content key, no agent-scoped
key and no single-block rule, because the row was born with the line's uuid.
The one failure mode is absence: a line not yet on disk at flush yields no
stamp, and the row commits as it would have before this decision. The line is
written when the turn is submitted and the event is exported after, so absence
is the rare case, and the same limit already bounds the tool rows.

### Identity stays final, so the chain and twin logic never see this row move {#identity-untouched}

**`message_id`, `part_id`, `previous_message_id`, `agent_id` and
`is_sidechain` are not copied.** LLP 0254 #identity-at-ingest continues to
hold for the row's identity; this decision extends it only by letting
provenance arrive later. Every settlement defect of September 2026 (#2150,
#2172, #2178, #2179) came from a row's identity or scope being rewritten and
its chain pointers or its twin following late. A stamp that leaves identity
alone cannot reproduce them. The row is returned as a fresh object so the
dispatcher records the change, and the #2179 twin gate, which compares part
identity rather than object identity, keeps it.

### Scope {#scope}

Flush-time settlement only. The maintenance re-settle sweep (LLP 0027,
LLP 0301) still selects fallback rows alone, so rows committed before this
decision keep their event-only attributes. Widening that sweep would heal the
backlog for transcripts still under retention, but needs a stopping rule other
than "has `origin`" (a line without `origin` would be re-read on every pass)
and sits in the part of the code the September defects came from, so it is a
separate request if wanted. Assistant rows are out of scope: `assistant_response`
also carries `message.uuid`, but nothing on the human-message question needs
them.

## Consequences {#consequences}

- A typed turn on an OTEL-attached machine carries `claude.origin.kind = human`
  and `claude.prompt_source` within one flush of being sent; an injected turn
  carries its own kind; a turn whose line has no `origin` gains the empty
  columns and no label, which is itself the answer.
- The human-message predicate is the same on every Claude lane:
  `role = 'user'` and `claude.origin.kind = 'human'`, with `entrypoint` on the
  row to decide the Claude Desktop `!` echo case. The text-prefix classifier
  becomes the fallback for rows older than this decision only.
- Cost: a batch that already loaded the session transcript for a tool row pays
  one map lookup and one shallow merge per prompt row. A batch holding a prompt
  row and no tool row pays the transcript load it would not have paid before,
  bounded by the incremental loader; the Desktop container scan stays armed
  only through the existing per-group guard.
- The gateway reads no `claude.*` key by name; the coupling is the `wants`
  call. A second client with a transcript-only field implements the same
  method and nothing in the gateway changes.

## Verification {#verification}

- `test/plugins/claude-settlement.test.js`: `wants` names exactly the OTEL
  user-prompt rows without `origin`; a typed, an injected and an origin-less
  line each stamp as described while identity, chain and event attributes are
  unchanged; a line not yet landed leaves the row the same object; a wanted row
  with no fallback row in the batch reaches the enricher and triggers no
  committed scan; a prompt row and a fallback tool row in one batch share one
  transcript load.
- On a live OTEL-attached machine: type one prompt, wait for the flush, and
  query `ai_gateway_messages` for the row's `attributes.claude.origin`.
