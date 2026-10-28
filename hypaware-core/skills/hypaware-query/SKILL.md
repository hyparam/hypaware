---
name: hypaware-query
description: 'Claude/Codex conversation search; team remote hyp query SQL/cache/logs/traces/metrics/AI gateway/graph. IMPORTANT: query recordings first for past work or why code changed/was removed; git/LLPs aren''t enough. Cues: "did we merge / post the PR / wrap up 12 and 26", "how did we fix X", "what did we say about Y", "we previously tested with...", "what did we last?", "where did we end up", "the work we did yesterday", "what I asked you to document earlier", "in another session I...", "find the chat where...", "which session was that", "the most recent Claude or Codex session", "which tool or model did that run", "how did we use $20 of tokens", "have I hit this error before", "why does this keep failing", "what keeps needing correction", "where are we wasting time or tokens", "are we repeating work", "what context was missing", "which approach worked better", "did that change help", "what should we automate", "how can we improve this workflow". Recommendations; save/upload/list/view reports; hyprec-/rec- fix/mark.'
user-invocable: false
---

# HypAware Query

HypAware supports three ways to query recorded activity. Choose the narrowest one that answers the question:

| Query type | Use it for | Command |
| --- | --- | --- |
| **Search (`grep`)** | Mentions of an error, file, PR, or topic | `hyp query grep "<text>" --from YYYY-MM-DD --to YYYY-MM-DD --limit 20 --format json` |
| **SQL (`sql`)** | Filter messages, read conversations, count events, and measure usage | `hyp query sql "<SELECT>" --format json` |
| **Graph (`graph`)** | Relationships among sessions, repositories, people, skills, and programs | `hyp query graph neighbors <ToolName> --type Tool --direction in --json` |

Grep finds case-insensitive substrings in message text and identifying fields, not `tool_args`, `attributes`, or `raw_frame`; use SQL for those. Read [search.md](search.md) for other fields, filters, and coverage notices. Start SQL with `ai_gateway_messages` for conversations and tool calls/results. Before graph queries, read [graph.md](graph.md) for local projection and traversal. Links are leads, not proof; never hand-edit the derived graph.

## Local or remote

Commands read this machine by default. Add `--remote <target>` for a team or named remote. Discover targets with `hyp remote list --json`; bare `--remote` uses the configured default. Preserve the target across discovery and queries. Ask when ambiguous scope would change the answer. Local cache status/refresh cannot describe a remote.

`hyp remote list` lists configured targets without verifying connectivity. If a connection fails, retry once, then report the error.

Connected HypAware MCP tools offer the same reads: `query_sql`, `grep_search`, and `graph_neighbors`. Use the available surface; a remote MCP endpoint reads that remote.

## Querying messages and usage

`ai_gateway_messages` contains one row per message content part, not one row
per message or response. Use `session_id` to scope conversations.

Common fields:

| Meaning | Column |
| --- | --- |
| Event time | `message_created_at`, not `timestamp` or `ts` |
| Partition day | `date` (YYYY-MM-DD string) |
| Message text | `content_text` |
| Session / message | `session_id` / `message_id` |
| Role / part kind | `role` / `part_type` |
| Tool name / arguments | `tool_name` / `tool_args` |
| Capture source | `conversation_source`, not `source` |
| Token usage | JSON inside `attributes`, under `usage`; no `usage` column |

Example, replacing the dates and session with the requested scope:

```bash
hyp query sql "SELECT message_created_at, role, part_type, content_text FROM ai_gateway_messages WHERE date >= '2026-10-20' AND date <= '2026-10-21' AND session_id = '<session-id>' ORDER BY message_created_at LIMIT 30" --format json
```

Before using columns outside this reference, inspect each dataset's schema. Reuse it within the investigation. For remote queries inspect the remote schema:

```bash
hyp query schema ai_gateway_messages --remote <target> --format json
```

Schema output is complete; it has no `--max-bytes` flag. For other datasets, use schema discovery on the selected target, not guessed table names. `columns: none declared` permits a `SELECT * FROM <table> LIMIT 1` probe, which reads the source.

`SELECT` and `SHOW TABLES` are supported; `DESCRIBE` and `information_schema` are not. Bound message scans by `date` and transcripts by `session_id`. Other datasets may lack `date`: inspect their schema before choosing a time filter. `node` uses `node_type`, `edge` uses `edge_type`, neither uses `type`. Read [sql.md](sql.md) before using JSON extraction, functions, joins, or other advanced syntax. Read query errors before correcting names; never retry an unchanged memory-budget refusal.

Read token usage from `attributes.usage`, not `raw_frame`. Keep `input_tokens`,
`output_tokens`, `cache_read_tokens`, and `cache_write_tokens` separate. Input
is net of cache; reasoning tokens may already be included in output. Missing
usage is unknown, not zero consumption. Use `COALESCE` for each aggregate sum
and each operand in an addition, without treating missing usage as measured zero.

Before aggregating usage, check for duplicate captures or cumulative updates.
Deduplicate only with verified response identity, keeping counters from the
same final record. Keep unmatched captures; never merge missing request IDs
or deduplicate on identical token values. If identity is unresolved, disclose
the limitation rather than claiming an exact total.

`user_id` identifies a provider account, not a HypAware person. `gateway_id`
identifies an installation. Verify which installations belong to the requested
person or agent; names, repositories, and working directories are clues, not
proof.

## Results and coverage

Check exit status and stderr before treating empty output as zero matches. Never discard/merge stderr or pipe results through `head`/`tail`. Bound SQL results with projection, aggregates, and LIMIT. `--format json --output <file>` preserves returned rows and cells without display truncation; inspect the file in bounded sections. It does not bypass query/server limits.

Default local refresh may omit pending rows for up to two minutes; use `--refresh always` for the newest captured data. Automatic refresh failure returns committed data with a warning; forced refresh failure fails the query.

If refresh fails with a permission error, inspect the cause rather than assuming
a sandbox block. For a confirmed sandbox restriction, request one-time permission
through the host and retry once; do not broaden persistent access. If permission
is unavailable, use `--refresh never` only when stale data can answer the question,
and disclose that refresh did not occur. If fresh data is required, report the blocker.

`hyp query overview --json` can narrow its window (`window.narrowed`). Derive reported totals with SQL over an explicit period.

## Team history questions

For questions about the team's past work, decisions, or reversals, start with
the graph on the configured team remote. Read [team-history.md](team-history.md)
for discovery, queries, verification, and fallback guidance.

## Conditional references

- **Recommendations:** read [recommendations.md](recommendations.md) before investigating a new recommendation or proposing changes. Establish an unstated period and focus first; reuse scope already established. Answer in chat unless an artifact was requested.
- **Reports or `hyprec-`/legacy `rec-` IDs:** read [reports.md](reports.md) before retrieving, implementing, saving, publishing, or changing status. Viewing a recommendation does not authorize implementing it or changing its status. Use **hypaware-report** for full report generation.

## Answer

Give the user a useful first view: answer their question with the strongest
supporting evidence, explain what it reveals, and make clear what remains
unknown. State local or named remote scope and dates; disclose stale, truncated,
or incomplete coverage. Distinguish observations from possible causes.

Treat that first answer as an entry into investigation. Show one or two concrete
directions HypAware could take next, grounded in what you found: trace a failure
through related sessions, compare what changed before and after a fix, inspect
the conversations behind a usage spike, or check whether a recurring problem
was resolved. Explain what each next step could establish and why it matters
to the user's question. Offer only paths supported by the available data and
tools; do not promise a cause or outcome before investigating.

Make the invitation specific and easy to choose, rather than ending with a
generic "want me to dig deeper?" Keep it proportional to the question: a simple
lookup may need only one sentence showing the next useful connection. Complete
the investigation the user already requested; offer further depth as a choice,
not as a substitute for answering or a reason to stop early.
