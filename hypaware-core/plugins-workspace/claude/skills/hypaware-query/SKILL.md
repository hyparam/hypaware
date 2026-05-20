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
4. Prefer structured output for analysis: use `--format json` for follow-up reasoning and `--format markdown` when showing a table to the user. Query output is hard-capped at 100 rows.
5. Use high-level query commands before custom SQL. Switch to `hyp query sql` only when the built-in commands cannot answer the question.
6. For unfamiliar SQL tables, run `hyp query schema <table> --format json` before querying.

## Common Commands

```bash
hyp query status
hyp query catalog --format json
hyp query logs --since 1h --format json
hyp query traces slow --limit 20 --format json
hyp query metrics list --format json
hyp query metrics series <metric-name> --format json
hyp query schema <table> --format json
hyp query sql "<sql>" --format json
hyp query refresh <file.jsonl>
hyp query refresh --all logs
hyp collect <file.jsonl> --name <name>
hyp collect --glob '<pattern>' --name <name>
```

## AI gateway message model

Recorded AI-gateway traffic is exposed through one dataset: `ai_gateway_messages`. Each row is a single exchange with the upstream provider.

Key columns:

- `upstream` — name of the upstream preset that handled the request.
- `path`, `status_code`, `request_bytes`, `response_bytes`, `is_sse` — wire-level facts about the exchange.
- `metadata` (JSON) — request settings, propagated `dev_run_id`, and adapter-supplied enrichment columns.

Claude transcript enrichment adds `provider_uuid`, `parent_uuid`, `request_id`, `entrypoint`, `client_version`, `user_type`, `permission_mode`, and `hook_event` when the local Claude Code JSONL transcript can be matched.

Run `hyp query schema ai_gateway_messages --format markdown` for the authoritative column reference.

## Guardrails

- Do not assume the cache auto-refreshes. Query commands default to `--refresh never`.
- Always read stderr. A successful exit code does not mean the cache is current.
- Keep SQL read-only and use only query tables from `hyp query catalog`.
- `hyp query sql` never returns more than 100 rows. Use aggregates or filters for completeness.
