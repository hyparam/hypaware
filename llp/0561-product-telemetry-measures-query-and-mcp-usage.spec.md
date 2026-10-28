# LLP 0561: Product telemetry measures query and MCP usage

**Type:** Spec
**Status:** Draft
**Systems:** Observability, CLI, Query, MCP, Privacy
**Author:** Hernan / Claude
**Date:** 2026-10-27
**Extends:** LLP 0393 (#contract: three additions to the finite v1 vocabulary; #policy unchanged), LLP 0408 (#policy: the same consent covers the additions)
**Related:** LLP 0021 (operational telemetry stays separate), LLP 0425 (#tool-owner: MCP tool resolution)

> The operator console needs to answer "how is HypAware used": which installs
> query, what they query, whether it helps, and whether a person or an agent is
> asking. Product telemetry today records only the command name of each CLI
> run. An agent's queries through `hyp mcp serve` are one long-lived invocation,
> so each tool call is never counted, and failures are almost all reported as
> `other`. This spec adds bounded fields for those three gaps and settles when
> the two existing milestones are sent. It adds no free text, no argument
> values and no client-supplied identity.

## Attribution stays on the server {#attribution}

Nothing here adds a user, gateway or org field to records or the resource.
LLP 0393 #contract stands: the receiver attributes each batch from the
authenticated gateway credential (JWT `sub` and `org`). Mapping a gateway to an
org member is a server-side join over enrollment records, and it lives in the
server repository.

## Milestones {#milestones}

`installation.milestone` was in the v1 vocabulary but never sent. The client now
sends it:

- `first_query` is sent from the outer CLI boundary when an execution of
  `query sql`, `query grep`, `query overview`, `query vector search` or
  `query graph neighbors` succeeds. `query schema` describes tables and does not
  count. Once the MCP event below ships, a successful MCP query tool call also
  counts.
- `first_capture` is sent from the daemon's five-minute flush when the write
  stage has written rows since the last flush. It is not sent for rows written
  by a foreground process with no daemon collector; the daemon reports its first
  write instead.

Each milestone is sent once per **consent generation**: a marker
`milestones.json` under the product-telemetry root holds the policy binding and
the milestones reached. A new opt-in, org or enrollment yields a new binding,
and the milestones are reported again, consistent with LLP 0393 #policy (a
generation never inherits another's history). The marker is written before the
record is queued. If queueing then fails, the milestone is lost, not duplicated.
A CLI and the daemon reaching different milestones at the same moment can still
race; the worst case is one duplicate milestone, which the console can dedupe per
gateway.

## Hook runs {#hooks}

Claude Code runs `hyp claude-hook session-context` and `hyp claude-hook
classify-cwd` on every session start, so they are about four in five of all
`cli.invocation` records. Each queued its own batch, and that volume filled the
receiver's fleet-wide batch budget (`429 telemetry_capacity`), so other records
were refused and queues backed up. They also say nothing about deliberate use.

A successful hook run now queues nothing. A failed or cancelled one still sends
its `cli.invocation` and `coded.failure`, because a broken hook is worth seeing.
The console therefore cannot count successful hook runs from this channel.

## MCP tool calls {#mcp}

A new event `mcp.tool_call` is sent once per `tools/call` handled by
`hyp mcp serve`:

| Field | Values |
|---|---|
| `tool` | A finite allow-list of core and bundled-plugin tool names in `contract.js` (`query_sql`, `grep_search`, `graph_neighbors`, the recommendation tools, and so on); any other tool becomes `other` |
| `outcome` | The existing outcome vocabulary |
| `error_code` | The finite error codes (see #errors) |
| `duration_ms` | Bounded as elsewhere |
| query fields | When the tool is a query, the fields in #query |

Records are buffered in the serving process and appended to the outbox in
batches (at most once per minute or every 100 records, whichever comes first).
They are also flushed on shutdown, so a chatty agent does not cost one queue
slot per call. `mcp serve` itself keeps its single `cli.invocation`.

## Query fields {#query}

Successful and failed query executions, from the CLI and from MCP, carry four
more fields. Each field takes its value from a fixed list:

| Field | Question it answers | Values |
|---|---|---|
| `datasets` | What data do they query? | The tables the query resolved, each mapped to a fixed list of bundled dataset names (`ai_gateway_messages`, `claude_telemetry_events`, `logs`, `traces`, `metrics`, `github_events`, `node`, `edge`, ...), else `other`; at most 4, de-duplicated |
| `location` | Their machine or the org server? | `local`, `remote` |
| `rows` | Did it find anything? | `0`, `1-10`, `11-100`, `101-1000`, `>1000`, `unknown` |
| `surface` | A person or an agent? | `cli`, `mcp`, `agent_shell`, `unknown` |

`agent_shell` means the CLI ran with an environment marker that a known agent
harness sets for the shell commands it runs (Claude Code, Codex, and similar).
The marker is detected, never forwarded. Without a marker the surface is `cli`.
This undercounts agents that set no marker; it never sends anything the user
typed.

Query text, table names outside the allow-list, column names, filters, and row
contents are never sent.

## Error codes {#errors}

The v1 `ERROR_CODES` vocabulary already exists, but the client fills it with
`other` (or `startup_failed`). The CLI boundary, the MCP event and the daemon
lifecycle now map failures they can classify onto the existing codes
(`unavailable`, `timeout`, `unauthorized`, `revoked`, `invalid_config`,
`disk_full`, `rate_limited`, `query_failed`, ...). The mapping is by error class
or code, never by message text. One code is added: `budget_exceeded`, for a
query refused by its scan budget, which is distinct from a query that failed.
Unclassified failures stay `other`.

## Rollout {#rollout}

The receiver validates records against the exact v1 key sets. A record with a
new key or event is refused as a schema error, and the outbox discards such a
batch as poison (LLP 0393 #outbox). The receiver must therefore ship first, and
the client must not send the additions to a receiver that does not accept them.

Proposed gate: the receiver advertises the additions in its capability
response (a new `schema_versions` entry, `2`). Delivery records the last
capability it saw in its state file. Emission constructs the extended records
only once that state shows the receiver accepts them, and the v1 shape
otherwise. Milestones are v1 and need no gate.

## Open questions {#open}

1. Is a schema version bump the right gate, or should the capability response
   list accepted events and fields individually?
2. Which environment markers define `agent_shell`, and is the list kept in
   `contract.js` beside the other vocabularies?
3. Should `datasets` include plugin-registered datasets by name when the plugin
   is bundled, or only kernel and bundled-plugin tables known at release?
