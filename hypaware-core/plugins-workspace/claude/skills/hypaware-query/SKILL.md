---
name: hypaware-query
description: Inspect local HypAware recordings with the hyp query CLI. Use when the user asks about recorded logs, traces, metrics, AI gateway exchanges, query cache freshness, or wants SQL over local HypAware data, including collected JSONL tables.
---

# HypAware Query

Use `hyp query` to inspect local HypAware recordings. By default it reads local JSONL recordings and an explicit local query cache, not the central server. To run the same query against a remote HypAware host (a fleet server) over its MCP endpoint, add `--remote <target>` — see [Remote queries](#remote-queries-other-hypaware-hosts).

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

## Remote queries (other HypAware hosts)

By default `hyp query` is local-only. To run a verb against a remote HypAware host (a fleet server) over its MCP endpoint (`/v1/mcp`), add `--remote <target>`: `hyp` acts as an MCP client, runs the same SQL against the remote `query_sql` tool, and renders the result with the same formatter. Only read-class tools are reachable remotely (`query_sql`, `graph_neighbors`); the credential is **query-scoped** (read/compute only — it cannot author configs or mint tokens), distinct from the server's operator/admin token, which never leaves the server.

- **Discover configured targets:** `hyp remote list` (`--json` for machine output). Each row shows the target URL and a `token:` status — `env` (a `HYP_REMOTE_TOKEN_<NAME>` var is set), `stored` (saved by `hyp remote login`), or `missing`. This reflects local config + credentials only; it is **not** a liveness check. The real connectivity/auth test is running a `--remote` query: rows back means reachable + authorized; a 401/timeout tells you which half failed.
- **Set up a target (two steps):** `hyp remote add <name> <full-url>` registers the URL — pass the full endpoint including the path (e.g. `https://host:8740/v1/mcp`); it is used verbatim, never auto-suffixed. Then supply the query-scoped token one of two ways: `hyp remote login <name>` (token via `--token-file <path>` or piped stdin — never a CLI argument, never an interactive prompt), or a per-target env var `HYP_REMOTE_TOKEN_<NAME>` (name uppercased, non-alphanumeric runs → `_`; e.g. `prod` → `HYP_REMOTE_TOKEN_PROD`). The env var is checked first and wins.
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

- `json_extract_scalar()` does not exist. `JSON_EXTRACT` does, but it errors on rows where a JSON-typed column (notably `tool_args`) holds a plain string instead of a JSON object ("first argument must be JSON string or object, got string").
- The robust pattern for extracting fields from `tool_args` is a regex over the raw text, e.g. `regexp_extract(CAST(tool_args AS VARCHAR), '"command":"([^"]+)', 1)`.

## AI gateway message model

Recorded AI-gateway traffic is exposed through one dataset: `ai_gateway_messages` (56 columns).
This section is the **authoritative column + availability reference** — the report skills name
columns but defer here for *which columns exist, how Claude and Codex differ, and what backfill
does and doesn't populate*. When a number matters, confirm with a quick `count(col)` per
`provider`; for the full list run `hyp query schema ai_gateway_messages --format markdown`.

Each row is one normalized message **content part**: a single provider message fans out into
several rows (one per part), so most analysis dedups per `message_id` first.

**`source` is a partition, not a column.** `hyp query status` lists partitions as
`ai_gateway_messages/source=claude` and `…/source=codex`, but there is **no `source` column** —
`WHERE source='claude'` errors with "Column source not found". Filter by `provider` instead:
`'anthropic'` = Claude, `'openai'` = Codex.

### Columns by group (the analytically useful ones)

- **Identity / dedup:** `gateway_id` (NOT NULL — ≈ one machine/user; the unit most reports group
  on. `user_id` is effectively always null — don't group on it), `session_id` (always present,
  the session key), `conversation_id` (a thread — set for Codex, **null for Claude**),
  `message_id`, `message_index`, `part_id`, `part_index`.
- **Source context:** `repo_root`, `git_branch`, `git_remote`, `head_sha`, `cwd`, `model`,
  `provider`, and `date` (a STRING partition, `YYYY-MM-DD` — put it in every `WHERE` to prune the
  30s timeout).
- **Subagent provenance:** `is_sidechain` is the **portable subagent boolean** (true on both
  providers); the *id* column is provider-specific — `agent_id` for Claude, `parent_thread_id`
  (+ `user_type='subagent'`) for Codex (see the table below).
- **Content:** `role`, `part_type`, `content_text`, `tool_name`, `tool_call_id`, `tool_args`
  (JSON, sometimes a bare string — see the dialect note), `status`, `is_error`. Message text lives
  in `content_text` on `part_type='text'` rows; `system_text` is its own column but is **empty in
  practice** (sample `content_text`, not `system_text`). Tool-result rows are `role='user'` for
  Claude but `role='tool'` for Codex.
- **Settings / diagnostics:** `permission_mode`, `entrypoint`, `client_name`, `client_version`,
  `user_type`, `is_compact_summary`, `attributes` (JSON: `attributes.usage`, `attributes.gateway`,
  request settings, propagated `dev_run_id`), `raw_frame` (JSON: the raw provider frame — Claude
  only).

### Tokens — the deduped token spine (`attributes.usage`, `role='assistant'`)

Token counts live under `attributes.usage` on `role='assistant'` rows (NOT in `raw_frame`). Usage
repeats across a message's content parts, so a plain `SUM` overcounts ~3× — **dedup per message
with `max()` first**. This is the canonical **deduped token spine** every report reconciles to;
build token figures off it rather than re-deriving the dedup:

```sql
WITH msg AS (
  SELECT COALESCE(CAST(JSON_EXTRACT(raw_frame,'$.message_id') AS VARCHAR), message_id) mid,
    max(CAST(JSON_EXTRACT(attributes,'$.usage.input_tokens')       AS BIGINT)) inp,
    max(CAST(JSON_EXTRACT(attributes,'$.usage.output_tokens')      AS BIGINT)) outp,
    max(CAST(JSON_EXTRACT(attributes,'$.usage.cache_write_tokens') AS BIGINT)) cwrite,
    max(CAST(JSON_EXTRACT(attributes,'$.usage.cache_read_tokens')  AS BIGINT)) cread
  FROM ai_gateway_messages
  WHERE date BETWEEN '<start>' AND '<end>'
    AND role='assistant' AND JSON_EXTRACT(attributes,'$.usage') IS NOT NULL
  GROUP BY mid)
SELECT sum(inp) t_in, sum(outp) t_out, sum(cwrite) t_cw, sum(cread) t_cr FROM msg;
-- slice by adding max(gateway_id)/max(model)/max(repo_root)/max(date) inside, GROUP BY outside.
```

Report the four types separately (cache-read is usually the bulk, output the scarce slice); the
**cache-read ratio** is `cache_read/(cache_read+input)`. Token keys differ by provider:

- **Claude (`anthropic`):** `input_tokens`, `output_tokens`, `cache_read_tokens`,
  `cache_write_tokens`.
- **Codex (`openai`):** `input_tokens`, `output_tokens`, `cache_read_tokens`, `reasoning_tokens`,
  `total_tokens` — **no `cache_write_tokens`**.

`usage` is **partial even on assistant rows** (locally only ~43% of Claude and ~68% of Codex
assistant rows carry a `usage` block). Always measure usage coverage rather than assuming every
assistant row has tokens.

### Capture origin & backfill (so you're not surprised)

`attributes.gateway.source` marks how a row was captured. Local recordings are reconstructed from
the on-disk Claude/Codex transcript and carry `source='backfill'`; rows captured live through the
running gateway carry a different value (check the distinct values). **Backfill recovers
structure, identity, git/repo context, and subagent provenance, but only *some* token usage
survives** — which is why `attributes.usage` is partial above. A missing `usage` block means "this
row was reconstructed without token counts", **not** "no activity here".

### Claude vs Codex availability

Same dataset, very different columns populated per provider — check before writing cross-provider
SQL or attributing by a column one provider doesn't fill:

| Signal | Claude (`anthropic`) | Codex (`openai`) |
| --- | --- | --- |
| `conversation_id` (thread) | null | always set |
| `user_id` | null | null |
| `repo_root` | set (~93%) | **none** — use `git_branch`/`head_sha` |
| `git_branch` / `head_sha` | sparse (~10%) | dense (~96%) |
| subagent flag | `is_sidechain=true` | `is_sidechain=true` |
| subagent id | `agent_id` (`parent_thread_id` null) | `parent_thread_id` + `user_type='subagent'` (`agent_id` null) |
| `permission_mode` | **sparse (~3%)** | dense (~99%) |
| `request_id` / `provider_uuid` / `prompt_id` | set | none |
| `raw_frame` | set | none |
| `system_text` | empty | empty |
| usage token keys | …/**`cache_write`** | …/**`reasoning`**/**`total`** (no `cache_write`) |

Percentages are from the local dataset and will drift — the *which-columns-exist* pattern is the
stable part; confirm a figure with `count(col)` per `provider` when it matters. Claude transcript
enrichment is what fills `provider_uuid`, `parent_uuid`, `request_id`, `entrypoint`,
`client_version`, `user_type`, `permission_mode`, and `hook_event` (when the local Claude Code
JSONL transcript can be matched), so those are Claude-leaning.

Run `hyp query schema ai_gateway_messages --format markdown` for the authoritative column reference.

## Guardrails

- Do not assume the cache auto-refreshes. Query commands default to `--refresh never`.
- Always read stderr, and never pipe it to /dev/null (especially in shell loops over multiple datasets) — errors and staleness warnings land there, and an empty stdout is indistinguishable from zero rows. A successful exit code does not mean the cache is current.
- Keep SQL read-only and use only datasets listed by `hyp query status`.
- `hyp query sql` inline output is context-budgeted (cells truncated to ~200 chars, rows dropped past a ~32KB row-data budget) and emits a `notice:` on stderr when it withholds rows — it is not a fixed row cap. Prefer aggregates/filters for analysis; use `--output <file>` for a complete, untruncated result and read it back from the file rather than from stdout.
