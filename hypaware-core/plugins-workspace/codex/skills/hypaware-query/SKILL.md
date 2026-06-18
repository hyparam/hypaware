---
name: hypaware-query
description: Inspect HypAware recordings with the hyp query CLI. Use when the user asks about recorded logs, traces, metrics, AI gateway exchanges, query cache freshness, or wants SQL over local HypAware data (or a remote central server via `hyp query sql --server` / `hyp query connect`), including collected JSONL tables.
---

# HypAware Query

Use `hyp query` to inspect HypAware recordings. By default it reads **local** JSONL recordings and an explicit local query cache. A single `hyp query sql` can also run against a **remote** central server with `--server` (see [Querying a remote server](#querying-a-remote-server)); `schema`, `status`, and `refresh` are always local. Default to local unless the user explicitly wants server/remote results.

## Workflow

1. Run `hyp query status` first to verify the recording root and cache state.
2. If the command cannot find the intended config, discover the service config once with `hyp status`, a LaunchAgent/systemd unit, or the user, then reuse `--config <path>` only for that setup.
3. Cache freshness is handled asymmetrically:
   - **Stale partitions are queried by default** and the CLI prints a `warning: query cache last refreshed at …` line to stderr. Read stderr alongside stdout, and surface the refresh timestamp to the user so they know the cache may not include newer source rows. Prefer the file-targeted `hyp query refresh <file.jsonl>` command the CLI prints when updating cache data; use `--refresh always` only when the query should refresh before it runs.
   - **Missing partitions still error.** Run the exact `hyp query refresh …` command the CLI prints, or rerun the target query with `--refresh always`.
   - Broad manual refreshes are explicit: `hyp query refresh --all [dataset]`. Do not run a broad refresh when the printed file-targeted command is enough.
4. Prefer structured output for analysis: use `--format json` for follow-up reasoning and `--format markdown` when showing a table to the user. Inline output is context-budgeted, not row-capped: each string cell is truncated to ~200 code points (a `…(+N)` marker shows how much was elided) and rows are dropped once a row-data byte budget (~32KB) is hit, with a `notice: showing X of Y rows …` line on stderr. To get a full, untruncated result, spill it to a file with `--output <file>` (prints only a receipt to stdout — the data never floods context) and post-process the file. Override the caps with `--max-cell <n>` / `--max-bytes <n>` (`0` disables either).
5. For unfamiliar SQL tables, run `hyp query schema <table> --format json` before querying. Registered datasets can have different column sets even when they share a logical shape (e.g., per-user `agent_logs_*` S3 datasets) — check each table's schema before writing cross-table SQL. If `schema` reports `columns: 0` for a dataset that is still queryable, fall back to `SELECT * FROM <table> LIMIT 1`; failed queries also list the available columns in their error message.

## Common Commands

```bash
hyp query status
hyp query schema <table> --format json
hyp query sql "<sql>" --format json
hyp query sql "<sql>" --format jsonl --output <file>   # full result, lossless
hyp query refresh <file.jsonl>
hyp query refresh --all logs
hyp collect list
hyp collect remove <name>
```

These are the only subcommands in the installed CLI (`hyp query`: schema, status, sql, refresh, maintain, connect, disconnect; `hyp collect`: list, remove). There are no high-level `catalog`/`logs`/`traces`/`metrics` query commands — answer questions with `hyp query sql`, and discover datasets from the `hyp query status` output.

## Querying a remote server

`hyp query sql` can run on a central HypAware server instead of local recordings. Only `sql` is remote-capable — `schema`, `status`, and `refresh` are always local.

- **One-off:** `hyp query sql "<sql>" --server <url>`
- **Save the URL** so a bare `--server` reuses it: `hyp query connect <url>` (and `hyp query disconnect` to forget). `--server` is the *only* thing that selects the server — a bare `hyp query sql` with no `--server` is **always local**, so connecting never silently reroutes a query.
- **Auth:** the operator **admin** bearer token in `HYP_ADMIN_TOKEN` (this is the server's `HYPSERVER_ADMIN_TOKEN` value — same secret, different env-var name on each side). `connect` also accepts `--token-file <path>` for its verify ping; `sql` reads only the env var.
- The query runs on the **server's** kernel and spans its cache + Iceberg archive, so it returns **org-wide** data, not just this host's. Results are server-capped (~10k rows / 32 MB) and a truncation notice prints to stderr.
- This is an **admin operation against shared data**. Do not run it unless the user explicitly wants remote/server results; default to local. The admin token is fleet-grade — never echo it.

## SQL dialect notes

- `json_extract_scalar()` does not exist. `JSON_EXTRACT` does, but it errors on rows where a JSON-typed column (notably `tool_args`) holds a plain string instead of a JSON object ("first argument must be JSON string or object, got string").
- The robust pattern for extracting fields from `tool_args` is a regex over the raw text, e.g. `regexp_extract(CAST(tool_args AS VARCHAR), '"command":"([^"]+)', 1)`.

## AI gateway message model

Recorded AI-gateway traffic is exposed through one dataset: `ai_gateway_messages`. Each row is a normalized message content part owned by the HypAware AI gateway schema.

Key columns:

- `session_id`, `conversation_id`, `message_id`, `message_index`, `part_id`, `part_index` — stable identity. `session_id` is the always-present session key (group/scope on it); `conversation_id` is a nullable thread within a session (a Codex thread; null for Claude).
- `provider`, `model`, `role`, `part_type`, `content_text` — normalized provider/message content fields.
- `tool_name`, `tool_call_id`, `tool_args`, `status` — tool-call/result joins and sparse status such as `finish_reason`.
- `attributes` (JSON) — request settings, propagated `dev_run_id`, and gateway diagnostics under `attributes.gateway` (e.g. `exchange_id`, `request_bytes`). Token usage is **not** here.
- `raw_frame` (JSON) — the full client message envelope. Token usage is at `raw_frame.message.usage`, the Anthropic response id at `raw_frame.message.id`, the model at `raw_frame.message.model`. See **Token / cost accounting** below.

Claude transcript enrichment adds `provider_uuid`, `parent_uuid`, `request_id`, `entrypoint`, `client_version`, `user_type`, `permission_mode`, and `hook_event` when the local Claude Code JSONL transcript can be matched.

Run `hyp query schema ai_gateway_messages --format markdown` for the authoritative column reference.

## Token / cost accounting

Usage is in `raw_frame.message.usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`), on `role='assistant'` rows only.

**Dedup by `raw_frame.message.id`** (the Anthropic `msg_…` = one billed response), `max()` per id — never `sum` (streaming emits usage twice per id). Do **not** group by the column `message_id` (per content-block → overcounts ~2.5×) or `exchange_id` (too coarse → undercounts). `model` is null as a column — use `raw_frame.message.model`.

```sql
SELECT dim, count(*) AS calls, sum(in_t) AS input, sum(out_t) AS output, sum(cr) AS cache_read
FROM (SELECT CAST(JSON_EXTRACT(raw_frame,'$.message.id') AS VARCHAR) AS rid,
        max(CAST(JSON_EXTRACT(raw_frame,'$.message.usage.input_tokens') AS BIGINT)) AS in_t,
        max(CAST(JSON_EXTRACT(raw_frame,'$.message.usage.output_tokens') AS BIGINT)) AS out_t,
        max(CAST(JSON_EXTRACT(raw_frame,'$.message.usage.cache_read_input_tokens') AS BIGINT)) AS cr,
        max(session_id) AS dim   -- or date / gateway_id / raw_frame.message.model
      FROM ai_gateway_messages WHERE role='assistant' AND raw_frame IS NOT NULL
      GROUP BY rid) GROUP BY dim
```

## Guardrails

- Do not assume the cache auto-refreshes. Query commands default to `--refresh never`.
- Always read stderr, and never pipe it to /dev/null (especially in shell loops over multiple datasets) — errors and staleness warnings land there, and an empty stdout is indistinguishable from zero rows. A successful exit code does not mean the cache is current.
- Keep SQL read-only and use only datasets listed by `hyp query status`.
- `hyp query sql` inline output is context-budgeted (cells truncated to ~200 chars, rows dropped past a ~32KB row-data budget) and emits a `notice:` on stderr when it withholds rows — it is not a fixed row cap. Prefer aggregates/filters for analysis; use `--output <file>` for a complete, untruncated result and read it back from the file rather than from stdout.
