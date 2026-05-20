---
name: ctvs-gascity
description: Query the gascity event log, session-reconciler segments, and `gascity_messages` agent transcripts. Use when the user asks about gc agents, beads, orders, mail, sessions, session-reconciler decisions, agent tool calls, or LLM token usage by rig/template.
---

# Gascity Query

This workspace has been registered with the `ctvs query` cache via `ctvs init gascity`. Three tables are available alongside the global built-in datasets:

- **`events`** — one row per gascity event from `.gc/events.jsonl` (bead lifecycle, order execution, mail, sessions, controller events). Single source file, registered as a collection.
- **`session_segments`** — one row per tracepoint from `.gc/runtime/session-reconciler-trace/segments/**/*.jsonl` (baseline, decision, mutation, operation records per session reconciler cycle). Glob-backed collection; many source files, one cache partition each.
- **`gascity_messages`** — one row per content block from gascity-captured agent sessions (text, thinking, tool_use, tool_result, attachment). Captured by the `ctvs gascity` source from the supervisor REST API; provider-native frames preserved verbatim in `raw_frame`. Built-in dataset (no `ctvs init gascity` needed) — partitioned at `~/.collectivus/sink/gascity_messages/date=<YYYY-MM-DD>/city=<name>/`.

Refer to the global [`collectivus-query`](../collectivus-query/SKILL.md) skill for cache freshness rules, `--format` options, and the wire-level `proxy_messages` dataset.

## Agent targeting

Each table identifies the originating agent through a different column. There is no `cwd` on `events` or `session_segments`; on `gascity_messages` the `cwd` is the agent's working directory at frame time.

- `events.actor` — e.g. `hypcity-overrides.mayor`, `hypcity-overrides.refinery`, `hypcity-overrides.deacon`.
- `session_segments.template` — e.g. `hypcity-overrides.mayor` (city-scoped) or `collectivus/hypcity-overrides.polecat` (rig-scoped: `<rig>/<pack>.<agent>`).
- `gascity_messages.gascity_template` — same shape as `session_segments.template`. Pair with `gascity_rig` and `gascity_alias` for finer cuts. The provider-side session id is `gascity_session_id` / `provider_session_id`.

Matching patterns:

```sql
-- a specific agent (city-scoped)
where actor = 'hypcity-overrides.mayor'
where gascity_template = 'hypcity-overrides.mayor'

-- any rig's refinery
where template LIKE '%/hypcity-overrides.refinery'
where gascity_template LIKE '%/hypcity-overrides.refinery'

-- everything in the collectivus rig
where template LIKE 'collectivus/%'
where gascity_rig = 'collectivus'
```

To cross-reference an agent's actions with its proxied LLM calls, join `template` against `cwd` (`proxy_messages`) via the workspace path embedded in the rig prefix, or join `gascity_messages.provider_session_id` to `proxy_messages.conversation_id` when both sources captured the same Claude Code session.

## `gascity_messages` schema highlights

Grain is one row per content block (text, thinking, tool_use, tool_result, attachment). Run `ctvs query schema gascity_messages --format markdown` for the authoritative column list — there are 40+ columns; the highlights below are the ones you reach for first.

- **Identity:** `gascity_template`, `gascity_rig`, `gascity_alias`, `gascity_session_id`, `provider`, `provider_session_id`, `provider_uuid`, `gateway_id` (constant `gascity-scribe` so cross-source unions can tag the source).
- **Frame metadata:** `part_type` (`text` / `thinking` / `tool_use` / `tool_result` / `attachment`), `part_index`, `message_id`, `message_created_at`, `conversation_started_at`, `cwd`, `git_branch`, `permission_mode`, `is_sidechain`, `parent_uuid`, `prompt_id`, `request_id`.
- **Assistant-only hoist (null elsewhere):** `model`, `stop_reason`, `stop_details`, `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `ephemeral_1h_input_tokens`, `ephemeral_5m_input_tokens`, `service_tier`, `inference_geo`, `speed`.
- **Content-block specific:** `content_text`, `thinking_signature`, `tool_name`, `tool_call_id`, `tool_args` (JSON), `caller_type`, `tool_result_for`, `is_error`, `attachment_type`, `hook_event`.
- **Overflow:** `attributes` (unmapped fields, JSON) and `raw_frame` (verbatim original envelope, JSON) keep nothing the supervisor sent from being lost.

> Note: `gascity_messages` does not carry a `role` column. Use `part_type` to split assistant-side frames (`text` / `thinking` / `tool_use`) from user/tool-side frames (`tool_result`).

## Common queries

```sql
-- Recent beads closed by the mayor (last 24h)
SELECT ts, subject
FROM events
WHERE type = 'bead.closed'
  AND actor = 'hypcity-overrides.mayor'
  AND ts >= NOW() - INTERVAL '1 day'
ORDER BY ts DESC
LIMIT 50;

-- Order failures grouped by actor (last 24h)
SELECT actor, COUNT(*) AS failures
FROM events
WHERE type = 'order.failed'
  AND ts >= NOW() - INTERVAL '1 day'
GROUP BY actor
ORDER BY failures DESC;

-- Sleep reason distribution per template (session_baseline records)
SELECT
  template,
  JSON_VALUE(fields, '$.sleep_reason') AS sleep_reason,
  COUNT(*) AS n
FROM session_segments
WHERE _ctvs_raw LIKE '%session_baseline%'
GROUP BY template, sleep_reason
ORDER BY n DESC;

-- Decision/mutation trace for one session in a time window
SELECT ts, template, _ctvs_raw
FROM session_segments
WHERE template = 'hypcity-overrides.mayor'
  AND ts BETWEEN '2026-05-14T00:00:00Z' AND '2026-05-14T01:00:00Z'
ORDER BY ts;
```

Use `_ctvs_source_path` to see which segment file a row came from, and `_ctvs_line_number` for the line inside that file.

## `gascity_messages` queries

```sql
-- All tool calls by the mayor today
SELECT message_created_at, tool_name, JSON_VALUE(tool_args, '$.command') AS command
FROM gascity_messages
WHERE gascity_template = 'hypcity-overrides.mayor'
  AND part_type = 'tool_use'
  AND date = strftime(NOW(), '%Y-%m-%d')
ORDER BY message_created_at DESC
LIMIT 50;

-- Token usage by rig over the last 24h. `input_tokens` is set only on
-- assistant frames, so summing across the whole table picks up exactly the
-- assistant-side cost (NULL inputs from tool_use / tool_result / text are
-- skipped by SUM).
SELECT gascity_rig,
       SUM(input_tokens) AS input,
       SUM(output_tokens) AS output,
       SUM(cache_read_input_tokens) AS cache_hits,
       SUM(cache_creation_input_tokens) AS cache_creates
FROM gascity_messages
WHERE message_created_at >= NOW() - INTERVAL '1 day'
  AND input_tokens IS NOT NULL
GROUP BY gascity_rig
ORDER BY input DESC;

-- Tool result that came back as an error, last hour, any agent
SELECT gascity_template, tool_name, content_text
FROM gascity_messages
WHERE part_type = 'tool_result'
  AND is_error = true
  AND message_created_at >= NOW() - INTERVAL '1 hour'
ORDER BY message_created_at DESC;

-- Sanity-check: for a Claude Code session captured by both sources,
-- compare token counts. `proxy_messages.conversation_id` is the Claude
-- Code session id, which gascity records as `provider_session_id`.
SELECT
  COALESCE(p.conversation_id, g.provider_session_id) AS session,
  SUM(CAST(JSON_VALUE(p.attributes, '$.usage.input_tokens') AS BIGINT)) AS proxy_input,
  SUM(g.input_tokens) AS gascity_input
FROM proxy_messages p
FULL OUTER JOIN gascity_messages g
  ON p.conversation_id = g.provider_session_id
WHERE p.role = 'assistant'
   OR g.input_tokens IS NOT NULL
GROUP BY session
ORDER BY proxy_input DESC NULLS LAST
LIMIT 20;

-- Cross-source UNION: text content from both sources for one Claude Code session
SELECT 'proxy' AS source, message_index AS idx, content_text
FROM proxy_messages
WHERE conversation_id = '<session-id>' AND role = 'assistant' AND part_type = 'text'
UNION ALL
SELECT 'gascity' AS source, part_index AS idx, content_text
FROM gascity_messages
WHERE provider_session_id = '<session-id>' AND part_type = 'text'
ORDER BY source, idx;
```

## When to use which source

- Use **`gascity_messages`** when you want: agent identity (`gascity_template` / `gascity_rig`), structured content blocks, tool calls + arguments + results in one table, per-frame token usage with cache breakdown, no need for HTTP wire detail.
- Use **`proxy_messages`** when you want: HTTP retry visibility, request timing, response status codes, end-user attribution via the Anthropic `user_id`, conversation-grain dedup of replayed history.
- Use **both** (UNION ALL or FULL OUTER JOIN) for cross-source aggregations, sanity checks, or to recover content that one source missed (e.g., gascity captured an in-process supervisor frame the proxy never saw).

## Freshness

`session_segments` is glob-backed: new segment files only appear in the cache after a refresh. Run `ctvs query refresh <segment-file.jsonl>` for selected segment files, `ctvs query refresh --all session_segments` to pick up every matching segment, or use `--refresh always` on any query. Deleted segment files remain queryable from their cache-only partitions.

`events` is append-only single-file; mtime/size changes trigger re-materialization on refresh.

`gascity_messages` is **always fresh** — the daemon writes Parquet directly into the sink (no JSONL stage, no `.meta.json` sidecar), so query-time discovery picks up every part-file the writer has flushed. `ctvs query refresh --all gascity_messages` is a documented no-op (it lists existing partitions as already-fresh). To pull in newly-flushed rows simply rerun the query.

Full schemas: `ctvs query schema events --format markdown`, `ctvs query schema session_segments --format markdown`, `ctvs query schema gascity_messages --format markdown`. Catalog: `ctvs query catalog --format markdown`.

## Refresh cost

Refreshing isn't free. `events.jsonl` and the `session_segments/**/*.jsonl` files registered by `ctvs collect` can be large — gascity ships hundreds of decision/mutation tracepoints per agent per hour — and the query cache appends newly changed bytes since the last refresh. On a busy workspace, a full refresh of `session_segments` can still take tens of seconds and write tens of megabytes.

Recommended workflow:

1. Run `ctvs query status` first. The summary shows which date ranges are already cached and which are stale; cheap queries against a covered range never need a refresh.
2. Only invoke `--refresh always`, `ctvs query refresh <file.jsonl>`, or `ctvs query refresh --all <dataset>` when a needed date range is missing or `status` reports staleness in the window you care about.
3. Do not reflexively pass `--refresh always` "just in case". Stale-data queries print a warning to stderr (the default behavior); reading that warning is cheaper than re-materializing the cache. Treat refresh as a deliberate step, not a default.
