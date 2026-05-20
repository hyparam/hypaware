# Collectivus Query CLI Reference

`ctvs query` reads local Collectivus recordings. It materializes JSONL source files into a local query cache under:

```text
<recording-root>/.collectivus-query/cache/datasets/<dataset>/gateway_id=<id>/date=<YYYY-MM-DD>/cursor.json
```

External JSONL collections registered with `ctvs collect <file.jsonl> --name <name>` are recorded in:

```text
<recording-root>/.collectivus-query/collections.json
```

Their query cache lives under `<recording-root>/.collectivus-query/cache/collections/<table>/source=<hash>/cursor.json`, with rows stored in local Iceberg tables below each source partition. SQL can reference either the normalized table name (`--name random-log` exposes `random_log`) or the original quoted collection name (`"random-log"`).

The cache is explicit. Query commands do not refresh it unless `--refresh always` is passed.

Freshness is asymmetric (since v1.7.0):

- `fresh` — query proceeds silently.
- `stale` (cache exists, source changed since refresh) — query proceeds and writes a `warning: query cache last refreshed at ...; N partition(s) differ from source [...] — run '...' to refresh` line to stderr. Stdout is unchanged.
- `missing` (no cache table/cursor) — query exits with the exact `ctvs query refresh ...` command to run.

Pass `--strict-freshness` to restore the pre-1.7 behavior where stale partitions are a hard error.

Commands default to `~/.hyp/collectivus.json`. If the running gateway or OTEL collector was installed with another config, discover it once with `ctvs status` or the service definition, then add `--config <path>` to the examples below.

## Shared Options

- `--config <path|url>`: Collectivus config. Defaults to `~/.hyp/collectivus.json`.
- `--cache-dir <dir>`: Override the query cache directory.
- `--from <timestamp>` / `--to <timestamp>`: Inclusive timestamp bounds.
- `--since <duration>`: Relative lower bound such as `15m`, `2h`, or `7d`.
- `--date <YYYY-MM-DD>`: Restrict to one UTC date partition. Repeat it to query or refresh multiple days.
- `--gateway-id <id>`: Restrict to one gateway id.
- `--service <name>`: Restrict `serviceName` for logs, traces, and metrics.
- `--limit <n>`: Maximum rows to return. Default `100`, maximum `100`.
- `--format <fmt>`: `table`, `json`, `jsonl`, or `markdown`.
- `--refresh <mode>`: `never` or `always`. Default `never`.
- `--all`: Refresh all matching source files for `ctvs query refresh`.
- `--force`: Rebuild fresh cache partitions too for `ctvs query refresh`.
- `--strict-freshness`: Treat stale partitions as a hard error (pre-1.7 behavior). Off by default.

## Commands

- `ctvs query doctor`: Check config, recording root, source files, and cache freshness.
- `ctvs query status`: Inspect source partitions and cache freshness.
- `ctvs query catalog`: List logical datasets, columns, source partitions, and cached row counts.
- `ctvs query schema <table>`: Print schema for a built-in or collected query table.
- `ctvs query refresh <file.jsonl>... [--force]`: Materialize selected JSONL source files into the query cache.
- `ctvs query refresh --all [dataset] [--force]`: Materialize all matching JSONL source files into the query cache.
- `ctvs query sample <dataset>`: Show sample rows.
- `ctvs query sql <select-sql>`: Run read-only SQL over logical datasets.
- `ctvs query logs [count|tail]`: List logs, count logs, or tail live JSONL without requiring cache.
- `ctvs query traces [slow|errors]`: List traces, slow traces, or error spans.
- `ctvs query trace <trace-id>`: Show spans for one trace.
- `ctvs query metrics <list|series|latest|summary> [metric-name]`: Inspect metrics.
- `ctvs query proxy [get|stats|tail] [conversation-id]`: Inspect LLM proxy conversations.
- `ctvs query activity`: Combined recent activity from logs, traces, metrics, and proxy messages.
- `ctvs query service <service-name>`: Service-focused summary across logs, traces, and metrics.
- `ctvs query errors`: Recent log, trace, and proxy errors.

## External JSONL collections

Use `ctvs collect` to register arbitrary local JSONL files as dynamic query tables:

```bash
ctvs collect random-log.jsonl --name random-log
ctvs collect --glob '/path/to/segments/**/*.jsonl' --name segments
ctvs query sql "select * from random_log" --format json
ctvs query sql 'select * from "random-log"' --format json
```

`ctvs collect` stores the absolute source path (or glob) and immediately refreshes the query cache. If the source file changes later, normal query freshness rules apply: stale cached data is queryable with a stderr warning, `--strict-freshness` turns that into an error, and `ctvs query refresh <file.jsonl>` refreshes selected files. Use `--refresh always` to refresh before running the query. SQL can reference the normalized table name or the original quoted collection name, such as `"random-log"`.

With `--glob`, one logical table is backed by many source files: each matched file becomes its own cache partition under `.collectivus-query/cache/collections/<table>/source=<hash>/cursor.json`, and refresh appends from each file's recorded cursor when possible. Files that no longer match the glob remain queryable as cache-only partitions. Inside SQL, use `_ctvs_source_path` to see which file a row came from.

Collection tables always include `_ctvs_source_path`, `_ctvs_line_number`, and `_ctvs_raw`, plus inferred top-level JSON fields. Use `--timestamp-column <field>` when registering a file if `--from`, `--to`, `--since`, or `--date` should use a specific field.

## Logical Datasets

- `logs`: OTLP log records. Common columns include `gateway_id`, `date`, `timestamp`, `observedTimestamp`, `severityNumber`, `severityText`, `serviceName`, `body`, `traceId`, `spanId`, `resource`, `scope`, and `attributes`.
- `traces`: OTLP spans. Common columns include `gateway_id`, `date`, `traceId`, `spanId`, `parentSpanId`, `name`, `kind`, `startTimestamp`, `endTimestamp`, `durationMs`, `status`, `serviceName`, `resource`, `scope`, and `attributes`.
- `metrics`: OTLP metric points. Common columns include `gateway_id`, `date`, `metricName`, `metricType`, `timestamp`, `startTimestamp`, `serviceName`, `value`, `valueInt`, `count`, `sum`, `unit`, `resource`, `scope`, and `attributes`.
- `proxy_messages`: One row per LLM proxy content part (text block, tool call, tool result, etc.), globally deduped by content-derived `message_id`. See **proxy_messages columns** below for the full 26-column schema; `gateway_id` and `date` are added as partition columns in the query cache.
- `gascity_messages`: One row per content block from gascity-captured agent sessions (text, thinking, tool_use, tool_result, attachment). Captured by the `ctvs gascity` supervisor source — agent-attributed (`gascity_template` / `gascity_rig` / `gascity_alias`) and includes per-frame token usage with cache breakdown. Always fresh: the daemon writes Parquet directly to `~/.collectivus/sink/gascity_messages/date=<YYYY-MM-DD>/city=<name>/` (no JSONL stage, no `.meta.json` sidecar). The constant `gateway_id = 'gascity-scribe'` tags the source for cross-source UNIONs with `proxy_messages`. Run `ctvs query schema gascity_messages --format markdown` for the full 47-column schema.

Run `ctvs query schema <table> --format json` for the exact columns in the installed version. Schema lookup works for built-in tables and tables registered with `ctvs collect`.

## proxy_messages columns

Grain is one row per content part. Rows are deduplicated by `message_id` so a single message that appears in many exchanges (e.g., user history replayed on each turn) is written once. Each value below shows the derivation in `messages-parquet.js` / `messages-walker.js`.

| # | Column | Type | Null? | Derivation | Notes |
| - | --- | --- | --- | --- | --- |
| 1 | `schema_version` | INT32 | no | Constant `2` | Bumped when the row shape changes incompatibly. |
| 2 | `conversation_id` | STRING | no | Claude Code `metadata.user_id.session_id`, else 16-hex of canonical first user content, else 16-hex of `exchange_id` | Stable conversation key. |
| 3 | `user_id` | STRING | yes | `request.body.metadata.user_id.account_uuid` when present | Anthropic account UUID. Not the per-session id used for conversation grouping. |
| 4 | `provider` | STRING | no | Walker `opts.upstream` (string or `.provider`/`.name`), else `"anthropic"` | LLM provider tag. |
| 5 | `model` | STRING | yes | `request.body.model` | Provider-specific model id (e.g., `claude-opus-4-7`). |
| 6 | `system_text` | STRING | yes | `request.body.system` joined with `\n\n` when an array; pass-through when a string | Single concatenated system prompt; `null` when none was sent. |
| 7 | `tools` | JSON | yes | `request.body.tools` verbatim | Tool catalogue as Anthropic received it. |
| 8 | `conversation_started_at` | TIMESTAMP | no | `exchange.ts_start` of the first exchange to use this `conversation_id` in the walker | Stable per conversation. |
| 9 | `conversation_source` | STRING | yes | `"claude_code"` when `client.user_agent` starts with `claude-cli/`, else `"api"` | Lets queries split CLI traffic from API callers. |
| 10 | `cwd` | STRING | yes | Proxy-recorded Claude session context from the Collectivus attach hook, else Claude Code transcript metadata | Working directory for the conversation when available. |
| 11 | `git_branch` | STRING | yes | Proxy-recorded Claude session context from the Collectivus attach hook, else Claude Code transcript `gitBranch` | Git branch for the conversation when available. |
| 12 | `message_id` | STRING | no | `sha256(conversation_id:role:canonicalJson(content)).slice(0,16)` | Content-derived; identical content in the same conversation always hashes the same. |
| 13 | `previous_message_id` | STRING | yes | Walker — `message_id` of the immediately preceding emitted/seen message in this conversation | `null` for the first message. |
| 14 | `message_index` | INT32 | no | Walker — 0-based index in `request.body.messages` (assistant gets the next slot after history) | Stable across re-emissions because of dedup. |
| 15 | `message_created_at` | TIMESTAMP | no | `exchange.ts_start` of the exchange that produced this message | Same value across all parts of a single message. |
| 16 | `role` | STRING | no | `message.role` | `system` / `user` / `assistant` / `tool`. |
| 17 | `part_id` | STRING | no | `${message_id}#${part_index}` | Stable per-part identity. |
| 18 | `part_index` | INT32 | no | Walker — 0-based position in `message.content` | Ordering within a message. |
| 19 | `part_type` | STRING | no | Anthropic block `type` mapped via `mapPartType` | `text`, `reasoning`, `tool_call`, `tool_result`, `image`, `file`, `error`, or pass-through. |
| 20 | `content_text` | STRING | yes | Block-specific text extraction: `text` / `thinking` / `redacted_thinking.data` / `tool_result.content` / `error.message` | `null` for non-text parts such as `tool_call`. |
| 21 | `tool_name` | STRING | yes | `block.name` on tool_use; walker `tool_call_lookup` on tool_result | Resolves the original tool name even on the result row. |
| 22 | `tool_call_id` | STRING | yes | `block.id` (tool_use) or `block.tool_use_id` (tool_result) | Joinable across `tool_call` ↔ `tool_result` rows. |
| 23 | `tool_args` | JSON | yes | `block.input` on tool_use / server_tool_use | Argument object Anthropic returned. |
| 24 | `thinking_signature` | STRING | yes | `block.signature` on thinking / redacted_thinking | Provider integrity signature. |
| 25 | `status` | JSON | yes | Sparse: `tool_status` on tool_result, `finish_reason` on the last assistant part, `error_code` / `error_message` on error blocks | `null` when no key applies. |
| 26 | `attributes` | JSON | yes | `request` settings (`max_tokens`, `thinking`, `output_config`, `context_management`, `stream`), `usage` (assistant only — `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`), `timing.latency_ms`, `client.claude_version`, `provider_raw.metadata` | `null` when no key applies. |

The query-cache table additionally carries `gateway_id` (STRING, not null) as the leading column and `date` (STRING, not null) at the end. Both are partition keys; `date` is derived from `message_created_at` in UTC.

## Example SQL

```bash
ctvs query sql "select serviceName, count(*) as logs from logs group by serviceName order by logs desc" --format json
ctvs query sql "select traceId, name, durationMs from traces order by durationMs desc limit 20" --refresh always --format json
ctvs query sql "select model, count(distinct message_id) as messages, count(*) as parts from proxy_messages where role = 'assistant' group by model order by messages desc" --format markdown
ctvs query sql "select conversation_id, count(distinct message_id) as messages from proxy_messages group by conversation_id order by messages desc limit 10" --format markdown
ctvs query sql "select date, count(*) as parts from proxy_messages group by date order by date" --date 2026-05-14 --date 2026-05-15 --format markdown
```

For JSON columns (`attributes`, `status`, `tools`, `tool_args`), extract scalars with `JSON_VALUE(<col>, '$.path')`:

```bash
ctvs query sql "select model, sum(cast(JSON_VALUE(attributes, '\$.usage.input_tokens') as bigint)) as input_tokens from (select distinct message_id, model, attributes from proxy_messages where role = 'assistant') group by model order by input_tokens desc" --format markdown
```

SQL must be a read-only `select` over known query tables. Table names are resolved from the SQL AST and may be built-ins (`logs`, `traces`, `metrics`, `proxy_messages`, `gascity_messages`) or registered collection tables from `ctvs query catalog`.

`ctvs query sql` hard-caps top-level result sets at 100 rows. If the SQL omits a top-level `LIMIT`, the CLI applies `LIMIT 100`; if the SQL asks for a larger top-level limit, the CLI clamps it to 100. Use aggregates/counts for complete summaries, or add filters and `OFFSET` to page through wider table-shaped results.

Top-level `ORDER BY RANDOM() LIMIT n` uses reservoir sampling instead of sorting the full result set. It is still capped at 100 rows by the normal top-level limit rules.
