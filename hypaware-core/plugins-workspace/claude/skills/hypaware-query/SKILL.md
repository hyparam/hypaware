---
name: hypaware-query
description: Inspect local HypAware recordings with the hyp query CLI. Use when the user asks about recorded logs, traces, metrics, AI gateway exchanges, query cache freshness, or wants SQL over local HypAware data.
---

# HypAware Query

Use `hyp query` to inspect local HypAware recordings. By default it reads local JSONL recordings and an explicit local query cache, not the central server. To run the same query against a remote HypAware host (a fleet server) over its MCP endpoint, add `--remote <target>` — see [Remote queries](#remote-queries-other-hypaware-hosts).

## Workflow

1. Run `hyp query status` first to verify the recording root and cache state.
2. If the command cannot find the intended install, discover the right home once with `hyp status`, a LaunchAgent/systemd unit, or the user, then set `HYP_HOME` (default `~/.hyp`) for those invocations.
3. Cache freshness: query commands default to `--refresh auto`.
   - **Stale partitions can still be served**, with a `warning: query cache last refreshed at …` line on stderr. Read stderr alongside stdout, and surface the refresh timestamp to the user so they know the cache may not include newer source rows.
   - Force freshness for one query with `--refresh always`, or refresh a dataset explicitly with `hyp query refresh <dataset>` (bare `hyp query refresh` refreshes every dataset - prefer the targeted form). If a query errors on a missing partition, the same two moves apply.
4. Prefer structured output for analysis: use `--format json` for follow-up reasoning and `--format markdown` when showing a table to the user. Inline output is context-budgeted, not row-capped: each string cell is truncated to ~200 code points (a `…(+N)` marker shows how much was elided) and rows are dropped once a row-data byte budget (~32KB) is hit, with a `notice: showing X of Y rows …` line on stderr. To get a full, untruncated result, spill it to a file with `--output <file>` (prints only a receipt to stdout — the data never floods context) and post-process the file. Override the caps with `--max-cell <n>` / `--max-bytes <n>` (`0` disables either).
5. For unfamiliar SQL tables, run `hyp query schema <table> --format json` before querying. Registered datasets can have different column sets even when they share a logical shape (e.g., per-user `agent_logs_*` S3 datasets) — check each table's schema before writing cross-table SQL. If `schema` reports `columns: 0` for a dataset that is still queryable, fall back to `SELECT * FROM <table> LIMIT 1`; failed queries also list the available columns in their error message.

## Common Commands

```bash
hyp query status
hyp query schema <table> --format json
hyp query sql "<sql>" --format json
hyp query sql "<sql>" --format jsonl --output <file>   # full result, lossless
hyp query refresh <dataset>
```

These are the only subcommands in the installed CLI (`hyp query`: schema, status, sql, refresh, maintain). There are no high-level `catalog`/`logs`/`traces`/`metrics` query commands — answer questions with `hyp query sql`, and discover datasets from the `hyp query status` output.

## Remote queries (other HypAware hosts)

By default `hyp query` is local-only. To run a verb against a remote HypAware host (a fleet server) over its MCP endpoint (`/v1/mcp`), add `--remote <target>`: `hyp` acts as an MCP client, runs the same SQL against the remote `query_sql` tool, and renders the result with the same formatter. Only read-class tools are reachable remotely (`query_sql`, `graph_neighbors`); the credential is **query-scoped** (read/compute only — it cannot author configs or mint tokens), distinct from the server's operator/admin token, which never leaves the server.

- **Discover configured targets:** `hyp remote list` (`--json` for machine output). Each row shows the target URL and a `token:` status — `env` (a `HYP_REMOTE_TOKEN_<NAME>` var is set), `stored` (saved by `hyp remote login`), or `missing`. This reflects local config + credentials only; it is **not** a liveness check. The real connectivity/auth test is running a `--remote` query: rows back means reachable + authorized; a 401/timeout tells you which half failed.
- **Set up a target (two steps):** `hyp remote add <name> <url>` registers the URL: pass the server **base** URL (e.g. `https://host:8740` or `https://hypaware.hyperparam.app`), and the client derives the MCP endpoint as `<base>/v1/mcp`. A URL whose path already ends in `/v1/mcp` is honored verbatim, so the older full-endpoint form still works. Then supply the query-scoped token one of two ways: `hyp remote login <name>` (token via `--token-file <path>` or piped stdin — never a CLI argument, never an interactive prompt), or a per-target env var `HYP_REMOTE_TOKEN_<NAME>` (name uppercased, non-alphanumeric runs → `_`; e.g. `prod` → `HYP_REMOTE_TOKEN_PROD`). The env var is checked first and wins.
- **Query it:** `hyp query sql "<sql>" --remote <name> --format json`.
- **Truncation is doubled on remote — read both stderr lines.** A server-side data cap (`remote: showing first N rows (server cap …)`) clips before rows leave the server and you **cannot** lift it; the usual local display budget (`notice:` / `--output`) clips again on your side. Never `2>/dev/null` a remote query.
- **`--remote` together with `--refresh` is a hard error** — refresh is a local-cache operation, meaningless against a server that owns its own freshness.
- A remote target may be reachable only over a private network (e.g. a tailnet / `100.x` address); a timeout often means you are off that network, not that the server is down.

### Two ways a HypAware host's MCP may be attached

A HypAware host exposes its read-class verbs (`query_sql`, `graph_neighbors`) as an **MCP tool**, and that MCP can be attached by **two independent routes** — be aware of both:

- **Via `hyp --remote`** — the CLI path above: `hyp` acts as the MCP client (`hyp query sql … --remote <name>`) and renders locally. Discover these by running `hyp remote list`.
- **Via a direct client connection** — the host's `/v1/mcp` endpoint is registered in this client's MCP config (out of band), surfacing the `query_sql` / `graph_neighbors` **tools** directly as the `mcp__hypaware__*` tools already in your toolset — no `hyp` in the data path.

The routes are independent, so the **same server may be attached both ways at once** — an `mcp__hypaware__*` tool and a `hyp remote list` target can point at the identical `/v1/mcp` URL. Expect that overlap; don't treat them as two different servers.

Both routes run the identical `query_sql` operation, so **the data is the same** — but the surfaces are **not byte-identical**:

- **MCP tool:** returns the **full structured result** (every matching row, as JSON) with **no ~32 KB display budget**; a large result can overflow the AI client's own output limit and spill to a file.
- **`hyp --remote` CLI:** applies the ~32 KB display budget and prints `notice: showing N of M rows …` on stderr; lift it with `--max-bytes 0` or `--output <file>` to recover the tool's full set.

Never read a smaller CLI row count as "fewer rows matched" — it is the display budget, not the result set.

## SQL dialect notes

The engine is SELECT-only with a deliberately small SQL surface. Every bullet below is a rejection observed in recorded sessions; when a query fails, the error message echoes the available columns, so read it before retrying.

- SELECT-only: `SHOW`, `DESCRIBE`, DDL, and `information_schema` are parse errors. Discover a table's columns with `hyp query schema <table>` or `SELECT * FROM <table> LIMIT 1`, never introspection statements. Dataset names come from `hyp query status` (on a standard install: `ai_gateway_messages`, `node`, `edge`); never guess a table name.
- Boolean predicates: `IS NOT TRUE` / `IS TRUE` are not parsed (`NOT` must be followed by `NULL`). Compare directly: `col = true`, `col = false`, or `col IS NULL`.
- Cast types are only STRING, INT, BIGINT, FLOAT, BOOL. `TRY_CAST`, `CAST(... AS TIMESTAMP)`, and `TIMESTAMP '...'` literals do not exist. Filter time ranges on the STRING `date` column (`date >= 'YYYY-MM-DD'`); the event-time column is `message_created_at` (there is no `timestamp` column).
- `ANY_VALUE` does not exist: use `MAX`/`MIN`. `regexp_like` does not exist: use `REGEXP_MATCHES` for a boolean match, `REGEXP_SUBSTR` to extract, or plain `LIKE`. `LIKE ... ESCAPE` is not parsed.
- Regexp position arguments are 1-based: `regexp_extract(str, pattern, 1)`, never `0`.
- `json_extract_scalar()` does not exist. `JSON_EXTRACT` does, but it errors on rows where a JSON-typed column (notably `tool_args`) holds a plain string instead of a JSON object ("first argument must be JSON string or object, got string"). Dotted identifiers (`usage.output_tokens`) are not columns; extract JSON fields explicitly.
- The robust pattern for extracting fields from `tool_args` is a regex over the raw text, e.g. `regexp_extract(CAST(tool_args AS VARCHAR), '"command":"([^"]+)', 1)`.
- Never invent a `--remote` target name: discover configured targets with `hyp remote list` first.

## AI gateway message model

Recorded AI-gateway traffic is exposed through one dataset: `ai_gateway_messages`. Each row is a normalized message content part owned by the HypAware AI gateway schema.

Key columns:

- `session_id`, `conversation_id`, `message_id`, `message_index`, `part_id`, `part_index` — stable identity. `session_id` is the always-present session key (group/scope on it); `conversation_id` is a nullable thread within a session (a Codex thread; null for Claude).
- `provider`, `model`, `role`, `part_type`, `content_text` — normalized provider/message content fields.
- `tool_name`, `tool_call_id`, `tool_args`, `status` — tool-call/result joins and sparse status such as `finish_reason`.
- `attributes` (JSON) — request settings, usage, propagated `dev_run_id`, and gateway diagnostics under `attributes.gateway`.

**Token counts** live under `attributes.usage` on `role='assistant'` rows (NOT in `raw_frame`): `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`. Codex (`provider='openai'`) omits `cache_write_tokens` and adds `reasoning_tokens` + `total_tokens`. Extract with `CAST(JSON_EXTRACT(attributes,'$.usage.input_tokens') AS BIGINT)`. Usage rides exactly one row per response (the last assistant part; non-carrier parts are null), so a plain `SUM` over assistant rows is correct with no dedup (the one-carrier rule, LLP 0035). If you prefer a defensive dedup, `max(...) GROUP BY session_id, message_id` returns the same number: key on `session_id` (`conversation_id` is null for Claude, and only separates threads within a Codex session).

Claude transcript enrichment adds `provider_uuid`, `parent_uuid`, `request_id`, `entrypoint`, `client_version`, `user_type`, `permission_mode`, and `hook_event` when the local Claude Code JSONL transcript can be matched.

Run `hyp query schema ai_gateway_messages --format markdown` for the authoritative column reference.

## When the graph answers it cheaper

Before writing SQL, ask: does the question need to *read* rows, or only to know they *exist and connect*? If the answer is a set of entities - which sessions touched a file, ran a skill, invoked a program, used a model or repo; co-occurrence; inventories of the skills/models/repos that appear in the recordings - that is a graph question: the **hypaware-graph** skill reads compact `node` / `edge` adjacency instead of scanning `ai_gateway_messages`, and it reaches GitHub facets (repos, PRs, reviewers) that are not in the messages at all. Two facets, skills and programs, are derived at projection time and have no message column; ad hoc SQL reconstruction of them measurably disagrees with the canonical projection, so always route those through the graph.

Check availability with `hyp query status`: if the `node` and `edge` datasets are registered, stop and use the hypaware-graph skill for these questions. If they are not, the graph plugins are not enabled on this install (the hypaware-graph skill covers enabling them) and raw SQL is the only surface. Keep per-message measures here on `ai_gateway_messages` regardless: token sums, `count(*)` call totals, error / stop-reason, ordering and time inside a session, and `content_text`. See the hypaware-graph skill for the full boundary.

## Guardrails

- Query commands default to `--refresh auto`: stale partitions can still be served with only a stderr warning. Force with `--refresh always` when currency matters.
- Always read stderr, and never pipe it to /dev/null (especially in shell loops over multiple datasets) — errors and staleness warnings land there, and an empty stdout is indistinguishable from zero rows. A successful exit code does not mean the cache is current.
- Keep SQL read-only and use only datasets listed by `hyp query status`.
- `hyp query sql` inline output is context-budgeted (cells truncated to ~200 chars, rows dropped past a ~32KB row-data budget) and emits a `notice:` on stderr when it withholds rows — it is not a fixed row cap. Prefer aggregates/filters for analysis; use `--output <file>` for a complete, untruncated result and read it back from the file rather than from stdout.
