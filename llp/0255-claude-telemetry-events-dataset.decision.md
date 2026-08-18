# LLP 0255: Behavioral telemetry lands in its own `claude_telemetry_events` dataset

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Query, Sources
**Author:** Phil / Claude
**Date:** 2026-08-17
**Related:** LLP 0012, LLP 0014, LLP 0015, LLP 0016, LLP 0030, LLP 0262 (the
RFC this decision realizes, accepted 2026-08-17), LLP 0252, LLP 0257

> The events that describe behavior rather than conversation (tool accept and
> reject decisions, permission mode changes, hook executions, MCP server
> health, cost and activity metrics) get their own dataset owned by
> `@hypaware/claude`: one row per event, typed columns for the hot fields, an
> attributes JSON column for the rest.

## Context

The OTEL stream carries two different kinds of thing. One is the conversation,
which already has a home in `ai_gateway_messages`. The other is behavior the
wire never showed, and it has no home at all. LLP 0262 resolved that it needs
one; this decision settles which one.

## Decision

### A dataset of its own {#own-dataset}

**`claude_telemetry_events` is a new dataset, not a widening of
`ai_gateway_messages` and not a route through `@hypaware/otel`'s generic
`logs` / `metrics` datasets.** Widening the message table would add columns
that are null for every row from every other producer and for most rows from
this one. Routing through the generic OTEL datasets would put Claude-specific
attributes behind a shape whose columns describe OTLP, not Claude Code, so
every question would be asked through JSON extraction.

### One row per event, hot fields typed {#row-shape}

**Each event becomes one row.** Typed columns cover the fields queries filter
and group by (event name, session id, tool name, decision, decision source,
cost); everything else rides in an `attributes` JSON column. The split is a
query-ergonomics judgment, not a completeness one: no attribute is dropped, and
a field that turns out to be hot can be promoted to a column later without
re-deriving the data.

### Owned by `@hypaware/claude` {#owned-by-claude}

**The dataset is contributed by the `@hypaware/claude` manifest and registered
at activation**, its first dataset. The payload shapes are Claude Code's, so
the plugin that already interprets them owns the table. Registration sets the
source signal, so the rows forward centrally by the same rules message rows
follow.

### Consumers come later {#consumers-later}

**Shipping the dataset is the whole of this decision.** No report, graph
projection, or status surface reads it yet. Recording the signal is cheap and
irreversible in the other direction: data not captured today cannot be
back-queried tomorrow.

## Consequences

- `hyp query sql` answers questions like "which tool calls did I reject this
  week" without touching `ai_gateway_messages`.
- Two datasets now describe one session, joined on `session_id`, which is the
  join a report or graph consumer will use.
- The `@hypaware/claude` plugin gains a dataset registration path it did not
  have, so its activation now has a cache-writing responsibility as well as an
  attach one.
- An upstream event we do not model still lands: unknown names keep their
  attributes in JSON rather than being discarded.
