# Search and query recorded activity

[Documentation](README.md) / Querying

Use this guide after [setup](CLI.md). Start with local activity, then select a
remote explicitly when you need data from other machines or your team.

## See what is available

```sh
hyp cache status
hyp query overview
hyp query schema ai_gateway_messages
```

Cache status lists local datasets and freshness. The overview summarizes models,
tokens, repositories, and tools over the period printed in its heading. Its
default window adapts to the amount of data; use `--days 7` for a chosen window,
`--json` for structured output, or `--sql` to inspect its queries.

`ai_gateway_messages` contains message **parts**: one message can contribute
several text, tool-call, or tool-result rows. A row count is not a count of
sessions, messages, or API requests. Other datasets depend on enabled sources;
inspect their schema before writing SQL.

## Find a conversation

```sh
hyp query grep "connection refused" --limit 20
hyp query grep "daemon" --from 2026-09-01 --to 2026-09-07 --format json
```

Replace the dates with the period you need. Search is a case-insensitive
substring match unless you pass `--regex`. Each hit identifies a session,
message, and part, with newest hits first. One part can match several columns.

Search covers `content_text`, `tool_name`, `session_id`, `conversation_id`,
`agent_id`, `model`, `cwd`, `git_branch`, and `git_remote`. It does not search
system prompts or tool arguments. Inspect those with SQL when needed.

Take a `session_id` from a hit and read its conversation:

```sh
hyp query sql "select message_index, part_index, role, part_type, content_text, tool_name
  from ai_gateway_messages
  where session_id = 'SESSION_ID'
  order by message_index, part_index
  limit 100" --format json
```

To inspect that session's tool calls:

```sh
hyp query sql "select message_index, tool_name, tool_args
  from ai_gateway_messages
  where session_id = 'SESSION_ID' and part_type = 'tool_call'
  order by message_index
  limit 50" --format json
```

## Summarize a known period

Use explicit date bounds so the result has a clear scope. This counts sessions
and parts per client per day; a session spanning days can count on each day.

```sh
hyp query sql "select date, client_name,
    count(distinct session_id) as sessions, count(*) as parts
  from ai_gateway_messages
  where date >= '2026-09-01' and date < '2026-09-08'
  group by date, client_name
  order by date desc, client_name" --format markdown
```

For token summaries, start with `hyp query overview --days 7 --sql` and its
existing usage extraction. Token usage is stored in structured attributes;
do not assume every message part has usage or represents another request.

Keep scans economical: choose dates or a session before selecting large text
fields. Use `LIMIT` for exploration and select only the columns you need.

## Save complete results

Terminal output truncates long cells and limits the displayed byte count.
Notices on standard error explain omitted data. Write to a file when you need
complete results from your query:

```sh
hyp query sql "select message_index, part_index, role, content_text
  from ai_gateway_messages where session_id = 'SESSION_ID'
  order by message_index, part_index" --format jsonl --output ./session.jsonl
```

`--output` avoids terminal display truncation; it does not remove a SQL `LIMIT`.
Available formats include `table`, `json`, `jsonl`, and `markdown`. Keep stderr
separate from JSON output so freshness and privacy notices remain visible.

Local-only rows can be withheld depending on the querying session's privacy
class. `--include-local-only` explicitly includes them in local results, so use
it only where the output can remain private. See [privacy controls](PRIVACY.md).

## Query a team server

```sh
hyp remote list
hyp query grep "connection refused" --remote team --limit 20
hyp query sql "select date, count(distinct session_id) as sessions
  from ai_gateway_messages
  where date >= '2026-09-01' and date < '2026-09-08'
  group by date order by date" --remote team --format json
```

Replace `team` with a configured target. A bare `--remote` uses the default.
[Team sign-in](TEAM_SETUP.md) normally configures remote access;
`hyp remote login --no-forward` signs in for queries without enrolling this
machine for forwarding.

`hyp cache status`, `hyp query schema`, and `hyp query overview` describe local
state. They are not a remote inventory. A server can have different datasets,
retention, and permissions; query it directly to establish what is available.
The server enforces visibility and rejects `--include-local-only`.

## Follow relationships in the activity graph

When `@hypaware/context-graph` is active, project local recordings before
walking relationships:

```sh
hyp graph project
hyp query graph neighbors src/core/cli/dispatch.js --type File --direction in --depth 2 --limit 25
```

Replace the example file with one from your recorded work. A seed can be a node
ID, natural key, or label. An ambiguous seed needs a type or exact ID. A file can
have both a repository-relative identity and an absolute-path identity.

Use the graph for questions such as which sessions touched a file or ran a
skill. A `Session` node's natural key is the `session_id` to use in the SQL
examples above. The `node` and `edge` datasets are also queryable with SQL.
Remote graph traversal uses `--remote`; projecting the local graph does not
refresh the server's graph.

## Ask an assistant or connect MCP

```sh
hyp ask --list
hyp ask "Which sessions mentioned connection refused this week on this machine?"
hyp client skills install --client codex
```

`hyp ask` launches an attached, executable AI client. Skill installation adds
the registered HypAware skills to the chosen supported client.

For an MCP client, configure a **stdio** server with executable `hyp` and
arguments `mcp`, `serve`. For a remote proxy, add `--remote`, `team` to those
arguments. The host must be able to find the installed binary and use the
intended `HYP_HOME`. MCP configuration file syntax belongs to your MCP client;
`hyp mcp serve` itself speaks protocol on stdout, not an interactive shell.

## Turn findings into a report

The report renderer builds HTML from a local Markdown report tree. For a small
report, create `./usage-reports/weekly-usage.md` with your findings, query scope,
and tables, then run:

```sh
hyp report render ./usage-reports
```

Open `./usage-reports/index.html`. The renderer rebuilds `html/`, so edit
the source Markdown instead of generated HTML. It renders findings you write;
it does not run SQL or invent a report from an empty directory.

To share a reviewed Markdown report with your organization:

```sh
hyp report publish ./usage-reports/weekly-usage.md --kind usage-review --period 2026-W36 --remote team
hyp report list --kind usage-review --limit 10 --remote team
```

Publishing uploads the file and requires a write-capable credential. Review
the report for private content first. See the [report command reference](CLI_REFERENCE.md#render-and-manage-reports)
for bundles, downloads, and organization-wide deletion.
