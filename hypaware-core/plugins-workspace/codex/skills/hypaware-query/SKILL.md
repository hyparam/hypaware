---
name: hypaware-query
description: Inspect local HypAware recordings with the hyp query CLI. Use when the user asks about recorded logs, traces, metrics, AI gateway exchanges, query cache freshness, or wants SQL over local HypAware data, including collected JSONL tables.
---

# HypAware Query

Use `hyp query` to inspect local HypAware recordings. It reads local JSONL recordings and an explicit local query cache; it does not query the central server.

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

These are the only subcommands in the installed CLI (`hyp query`: schema, status, sql, refresh, maintain; `hyp collect`: list, remove). There are no high-level `catalog`/`logs`/`traces`/`metrics` query commands — answer questions with `hyp query sql`, and discover datasets from the `hyp query status` output.

## SQL dialect notes

- `json_extract_scalar()` does not exist. `JSON_EXTRACT` does, but it errors on rows where a JSON-typed column (notably `tool_args`) holds a plain string instead of a JSON object ("first argument must be JSON string or object, got string").
- The robust pattern for extracting fields from `tool_args` is a regex over the raw text, e.g. `regexp_extract(CAST(tool_args AS VARCHAR), '"command":"([^"]+)', 1)`.

## AI gateway message model

Recorded AI-gateway traffic is exposed through one dataset: `ai_gateway_messages`. Each row is a normalized message content part owned by the HypAware AI gateway schema.

Key columns:

- `session_id`, `conversation_id`, `message_id`, `message_index`, `part_id`, `part_index` — stable identity. `session_id` is the always-present session key (group/scope on it); `conversation_id` is a nullable thread within a session (a Codex thread; null for Claude).
- `provider`, `model`, `role`, `part_type`, `content_text` — normalized provider/message content fields.
- `tool_name`, `tool_call_id`, `tool_args`, `status` — tool-call/result joins and sparse status such as `finish_reason`.
- `attributes` (JSON) — request settings, usage, propagated `dev_run_id`, and gateway diagnostics under `attributes.gateway`.

Claude transcript enrichment adds `provider_uuid`, `parent_uuid`, `request_id`, `entrypoint`, `client_version`, `user_type`, `permission_mode`, and `hook_event` when the local Claude Code JSONL transcript can be matched.

Run `hyp query schema ai_gateway_messages --format markdown` for the authoritative column reference.

## Guardrails

- Do not assume the cache auto-refreshes. Query commands default to `--refresh never`.
- Always read stderr, and never pipe it to /dev/null (especially in shell loops over multiple datasets) — errors and staleness warnings land there, and an empty stdout is indistinguishable from zero rows. A successful exit code does not mean the cache is current.
- Keep SQL read-only and use only datasets listed by `hyp query status`.
- `hyp query sql` inline output is context-budgeted (cells truncated to ~200 chars, rows dropped past a ~32KB row-data budget) and emits a `notice:` on stderr when it withholds rows — it is not a fixed row cap. Prefer aggregates/filters for analysis; use `--output <file>` for a complete, untruncated result and read it back from the file rather than from stdout.
