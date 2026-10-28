# LLP 0561: Product telemetry measures query and MCP usage

**Type:** Spec
**Status:** Draft
**Systems:** Observability, CLI, Query, MCP, Privacy
**Author:** Hernan / Claude
**Date:** 2026-10-27
**Extends:** LLP 0393 (#contract: three additions to the finite v1 vocabulary; #policy unchanged), LLP 0408 (#policy: the same consent covers the additions)
**Related:** LLP 0021 (operational telemetry stays separate), LLP 0425 (#tool-owner: MCP tool resolution), LLP 0562 (#pack: CLI batches pack into full uploads), hypaware-server LLP 0666 (the receiver side: wire version 2 and its advert)

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
`hyp mcp serve`, including calls refused as an unknown tool or bad arguments:

| Field | Values |
|---|---|
| `tool` | `query_sql`, `grep_search`, `graph_neighbors`, `session_evidence`, `list_recommendations`, `get_recommendation`, `set_recommendation_status`, `open_recommendations`, `fix_recommendation`, `check_team_history`; any other tool becomes `other` |
| `outcome` | `success`, or `failure` for a protocol error or an `isError` result |
| `error_code` | The finite error codes (see #errors); `other` on success |
| `duration_ms` | Whole milliseconds, 0 to one day |
| query fields | Only when the tool is a query tool (the first four) and the call succeeded; see #query |

The lists in `contract.js` are the receiver's (LLP 0666#vocabulary). Adding a
tool is a receiver change first.

Records are buffered in the serving process and appended to the outbox in
batches (at most once per minute or every 100 records, whichever comes first).
They are also flushed on shutdown, so a chatty agent does not cost one queue
slot per call. A flush that would overflow one outbox slot (32 KiB) is split
rather than dropped. `mcp serve` itself keeps its single `cli.invocation`. The
MCP server reports each call through an observer hook; with collection off no
observer is installed and a call does no telemetry work.

## Query fields {#query}

Query executions that produced a result, from the CLI and from MCP, carry four
more fields. They travel together: all four or none. A query that failed
before it resolved anything sends none, and its failure is in `error_code`.
On the CLI they ride the `cli.invocation` of a `query ...` command; on MCP,
the `mcp.tool_call` of a query tool. Each field takes its value from a fixed
list:

| Field | Question it answers | Values |
|---|---|---|
| `datasets` | What data do they query? | The datasets the result names (`query_sql` lists the tables it resolved), else the tool's own (`grep_search` reads `ai_gateway_messages`, `graph_neighbors` reads `node` and `edge`). Each is mapped to `ai_gateway_messages`, `claude_telemetry_events`, `logs`, `traces`, `metrics`, `github_events`, `node`, `edge`, `session_summaries_daily`, `audit_events`, `product_events`, `product_metrics`, else `other`; at most 4, de-duplicated, possibly empty |
| `location` | Their machine or the org server? | `local`, `remote` (`--remote`) |
| `rows` | Did it find anything? | The length of the result's row list (`rows`, `hits` or `neighbors`) as `0`, `1-10`, `11-100`, `101-1000`, `>1000`; `unknown` when the result has none |
| `surface` | A person or an agent? | `cli`, `mcp`, `agent_shell`, `unknown` |

`agent_shell` means the CLI ran with an environment marker that a known agent
harness sets for the shell commands it runs. The markers are listed in
`contract.js` (`AGENT_SHELL_MARKERS`: `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`,
`CODEX_THREAD_ID`, `CODEX_SANDBOX`, `GEMINI_CLI`, `CURSOR_AGENT`). Only a
marker's presence is read; its value is never read or forwarded. Without a
marker the surface is `cli`. This undercounts agents that set no marker; it
never sends anything the user typed.

The CLI fields are recorded at the verb boundary (`runVerbCommand`), so they
cover the verb-backed queries: `query sql`, `query grep` and `query graph
neighbors`, local or remote. `query overview` and `query vector search` are
plain commands and send none yet.

Query text, table names outside the allow-list, column names, filters, and row
contents are never sent.

## Error codes {#errors}

The v1 `ERROR_CODES` vocabulary already exists, but the client fills it with
`other` (or `startup_failed`). The CLI boundary (`coded.failure`), the MCP
event and the daemon's boot failure (`daemon.lifecycle`) now map failures they
can classify onto the existing codes. The mapping is by error `code` or class
`name`, on the error and up to two `cause`s, never by message text:

| Code | From |
|---|---|
| `disk_full` | `ENOSPC`, `EDQUOT` |
| `timeout` | `ETIMEDOUT`, `TimeoutError`, `ServiceCommandTimeoutError` |
| `unavailable` | `ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND`, `EAI_AGAIN`, `EHOSTUNREACH`, `ENETUNREACH` |
| `unauthorized` | `invalid_grant` |
| `revoked` | `service_token_revoked`, `service_account_disabled` |
| `query_failed` | `GrepQueryError`, `timestamp_literal_uncoercible`; and any other failure a query verb's operation or query tool throws |
| `budget_exceeded` | `QueryExecutionBudgetError` (`query_budget_exceeded`) |

One code is added: `budget_exceeded`, for a query refused by its execution
budget, which is distinct from a query that failed. It is a v2 code; a v1
batch carries it as `query_failed`. A daemon boot failure nothing classifies
stays `startup_failed`; any other unclassified failure stays `other`. A
`--remote` failure arrives as a message, not an error, so it stays `other`.
`invalid_config` and `rate_limited` have no typed error to map from yet.

## Rollout {#rollout}

The receiver validates records against the exact v1 key sets. A record with a
new key or event is refused as a schema error, and the outbox discards such a
batch as poison (LLP 0393 #outbox). The receiver must therefore ship first, and
the client must not send the additions to a receiver that does not accept them.

The additions are wire version 2: v1 plus exactly the fields, event and code
above (hypaware-server LLP 0666#advert). The receiver lists the versions it
accepts in `schema_versions` of its `GET /v1/telemetry` capability answer.

- Delivery saves the known versions of the last capability answer it saw
  (`schema_versions`, default `[1]`) in its state file beside the binding.
- Emission builds a `schema_version: 2` batch only when that state is for the
  current binding and lists 2. Otherwise it builds v1: `mcp.tool_call` records
  are left out, query fields are stripped and `budget_exceeded` becomes
  `query_failed`. Records are built in the v2 shape and projected at batch
  time, so the gate lives in one place. The version is per batch.
- A batch is never sent to a receiver whose current answer does not list its
  version. A v2 batch queued before the receiver stopped advertising v2 is
  discarded unsent and counted as loss, and emission falls back to v1 from the
  next batch. Packing never merges batches of different versions.

Milestones are v1 and need no gate. Until the first upload after a v2 receiver
ships, the client still sends v1, so the first batch from each host after the
upgrade carries no additions.

## Settled questions {#open}

1. **Gate.** A schema version bump, not a per-event or per-field capability
   list (hypaware-server LLP 0666#advert). The version is checked once, at the
   envelope, and a later addition is version 3, advertised the same way.
2. **`agent_shell` markers.** The list lives in `contract.js` beside the other
   vocabularies (`AGENT_SHELL_MARKERS`, see #query). A new harness is a client
   change only, since the surface value itself is unchanged.
3. **Datasets.** Only the fixed list known at release, which is the
   receiver's. A plugin dataset, bundled or not, is `other` until it is added
   to the receiver's list and then the client's.
