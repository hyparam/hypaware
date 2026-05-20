---
name: collectivus-query
description: Inspect local Collectivus recordings with the ctvs query CLI. Use when the user asks about recorded logs, traces, metrics, LLM proxy exchanges, query cache freshness, or wants SQL over local Collectivus data, including collected JSONL tables.
---

# Collectivus Query

Use `ctvs query` to inspect local Collectivus recordings. It reads local JSONL recordings and an explicit local query cache; it does not query S3.

## Workflow

1. Run `ctvs query doctor` or `ctvs query status` first to verify the recording root and cache state.
2. If the command cannot find the intended config, discover the service config once with `ctvs status`, a LaunchAgent/systemd unit, or the user, then reuse `--config <path>` only for that setup.
3. Cache freshness is handled asymmetrically:
   - **Stale partitions are queried by default** and the CLI prints a `warning: query cache last refreshed at …` line to stderr. Read stderr alongside stdout, and surface the refresh timestamp to the user so they know the cache may not include newer source rows. Prefer the file-targeted `ctvs query refresh <file.jsonl>` command the CLI prints when updating cache data; use `--refresh always` only when the query should refresh before it runs.
   - **Missing partitions still error.** Run the exact `ctvs query refresh …` command the CLI prints, or rerun the target query with `--refresh always`.
   - Broad manual refreshes are explicit: `ctvs query refresh --all [dataset]`. Do not run a broad refresh when the printed file-targeted command is enough.
   - Pass `--strict-freshness` only when the user explicitly needs the pre-1.7 strict mode (e.g., scheduled checks that must never read stale data); it turns stale partitions back into a hard error.
4. Prefer structured output for analysis: use `--format json` for follow-up reasoning and `--format markdown` when showing a table to the user. Query output is hard-capped at 100 rows (`--limit` defaults to 100 and cannot exceed 100), so use filters, `COUNT(*)`, aggregations, `ORDER BY`, and `OFFSET`/narrower predicates when you need more than the first page. For random samples, use `ORDER BY RANDOM() LIMIT n`; top-level random ordering is reservoir-sampled.
5. Use high-level query commands before custom SQL. Switch to `ctvs query sql` only when the built-in commands cannot answer the question.
6. For unfamiliar SQL tables, run `ctvs query schema <table> --format json` before querying. It works for built-in recording tables and tables registered with `ctvs collect`.

## Common Commands

These commands assume the service uses the default config path. Add `--config <path>` only when the installed gateway or OTEL collector uses a non-default config.

```bash
ctvs query status
ctvs query catalog --format json
ctvs query logs --since 1h --format json
ctvs query traces slow --limit 20 --format json
ctvs query metrics list --format json
ctvs query metrics series <metric-name> --format json
ctvs query schema <table> --format json
ctvs query proxy get <conversation-id> --format json
ctvs query proxy stats --format json
ctvs query errors --since 24h --format json
ctvs query refresh <file.jsonl>
ctvs query refresh --all logs
ctvs collect <file.jsonl> --name <name>
ctvs collect --glob '<pattern>' --name <name>
```

`ctvs collect` registers an external local JSONL file as a dynamic SQL table and immediately refreshes its query cache. `ctvs query sql` resolves table names from the SQL AST and injects built-in recording tables plus registered collection tables by name. Collection SQL can use either the normalized table name (`random-log` -> `random_log`) or the original quoted collection name (`"random-log"`), for example `ctvs query sql 'select * from "random-log"'`. Pass `--glob '<pattern>'` instead of a single path to back one logical table with many files; each matched file becomes its own cache partition and `_ctvs_source_path` tells you which file a row came from.

Repeat `--date` to query or refresh multiple UTC date partitions at once, for example `ctvs query sql "select count(*) from proxy_messages" --date 2026-05-14 --date 2026-05-15`.

## Proxy conversation log model

Recorded LLM proxy traffic is exposed through one logical dataset: `proxy_messages`. Each row is a single content part (text block, tool call, tool result, etc.); rows are globally deduplicated by a content-derived `message_id`, so identical history blocks shared across exchanges are represented once.

Key columns:

- `conversation_id` — stable conversation grouping (Claude Code session id when present, hashed first-user-message content otherwise).
- `message_id` — 16-char hex prefix of `sha256(conversation_id:role:canonical(content))`. Same content in the same conversation always produces the same id.
- `message_index`, `part_index` — message order inside the conversation; part order inside that message. `part_id = <message_id>#<part_index>`.
- `role` — `system`, `user`, `assistant`, or `tool`.
- `part_type` — `text`, `reasoning`, `tool_call`, `tool_result`, `image`, `file`, `error`, or a passed-through provider type.
- `cwd`, `git_branch` — Claude Code local context when available from transcript metadata or the Collectivus attach hook.
- `provider_uuid`, `parent_uuid`, `request_id`, `entrypoint`, `client_version`, `user_type` — Claude Code JSONL metadata when local transcript rows can be matched to proxy messages.
- `content_text` — extracted text payload for text / reasoning / tool_result / error parts; null otherwise.
- `tool_name`, `tool_call_id`, `tool_args` — populated on `tool_call` parts; `tool_result` parts carry the matching `tool_call_id` and a `status.tool_status` of `success` or `error`.
- `attributes` (JSON) — request settings, per-message `usage` (assistant only), exchange-level `timing`, and `client.claude_version` when available.
- `status` (JSON) — sparse; carries `finish_reason` on the last assistant part, `tool_status` on tool results, and `error_code` / `error_message` on error parts.

Run `ctvs query schema proxy_messages --format markdown` for the authoritative column reference.

## Example SQL

```sql
-- Find all assistant text in a conversation
SELECT message_index, content_text
FROM proxy_messages
WHERE conversation_id = '<id>' AND role = 'assistant' AND part_type = 'text'
ORDER BY message_index, part_index;

-- Tool calls paired with their results
SELECT
  c.tool_name,
  c.tool_args,
  r.content_text AS result,
  JSON_VALUE(r.status, '$.tool_status') AS tool_status
FROM proxy_messages c
LEFT JOIN proxy_messages r
  ON c.tool_call_id = r.tool_call_id AND r.part_type = 'tool_result'
WHERE c.part_type = 'tool_call';

-- Token usage by model (one assistant message can have many parts;
-- dedupe by message_id so we sum each message's usage once)
SELECT
  model,
  SUM(CAST(JSON_VALUE(attributes, '$.usage.input_tokens') AS BIGINT)) AS input_tokens,
  SUM(CAST(JSON_VALUE(attributes, '$.usage.output_tokens') AS BIGINT)) AS output_tokens
FROM (
  SELECT DISTINCT message_id, model, attributes
  FROM proxy_messages
  WHERE role = 'assistant'
)
GROUP BY model
ORDER BY input_tokens DESC;

-- Largest conversations by part count
SELECT conversation_id, MAX(message_index) + 1 AS turns, COUNT(*) AS parts
FROM proxy_messages
GROUP BY conversation_id
ORDER BY turns DESC
LIMIT 20;
```

Use `JSON_VALUE(<col>, '$.path')` to extract scalars from the `attributes` / `status` / `tools` / `tool_args` JSON columns. The `--format json` renderer parses these columns back into structured objects on the way out, so a `SELECT attributes FROM proxy_messages` returns a nested object rather than a JSON string.

## Guardrails

- Do not assume the cache auto-refreshes. Query commands default to `--refresh never`, and stale partitions return data with a stderr warning rather than refreshing themselves.
- Always read stderr. A successful exit code does not mean the cache is current — a `warning: query cache last refreshed at …` line on stderr means stdout reflects cache rows from that refresh, and the user should be told before drawing conclusions.
- Do not paste `--config` into every command by habit. Use it when discovery shows the service is not using `~/.hyp/collectivus.json`.
- Do not read arbitrary Parquet or Iceberg files directly for `ctvs query sql`; the CLI resolves SQL table names and injects only known query tables.
- Keep SQL read-only and use only query tables from `ctvs query catalog`: built-ins (`logs`, `traces`, `metrics`, `proxy_messages`, `gascity_messages`) and registered collection tables.
- `ctvs query sql` never returns more than 100 rows, even if the SQL text asks for a larger top-level `LIMIT`. Treat table-shaped results as samples unless the query is an aggregate/count that proves completeness.
- Use UTC dates with `--date YYYY-MM-DD`; repeat `--date` when the user wants a union across multiple date partitions.
- Use `--service`, `--gateway-id`, `--from`, `--to`, or `--since` to narrow broad investigations.

## Reference

For full command details, datasets, and example SQL, read [references/query-cli.md](references/query-cli.md).
