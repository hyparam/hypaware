---
name: hypaware-query
description: Inspect local HypAware recordings with the hyp query CLI and the context graph. Use when the user asks about recorded logs, traces, metrics, AI gateway exchanges, query cache freshness, wants SQL over local HypAware data (including collected JSONL tables), or asks entity-level activity questions like which sessions touched a file, ran a skill, invoked a program, or used a model.
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
4. Prefer structured output for analysis: use `--format json` for follow-up reasoning and `--format markdown` when showing a table to the user. Inline output is context-budgeted, not row-capped: each string cell is truncated to ~200 code points (a `…(+N)` marker shows how much was elided) and rows are dropped once a byte budget (~32KB) is hit, with a `notice: showing X of Y rows …` line on stderr. To get a full, untruncated result, spill it to a file with `--output <file>` (prints only a receipt to stdout - the data never floods context) and post-process the file. Override the caps with `--max-cell <n>` / `--max-bytes <n>` (`0` disables either).
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

Recorded AI-gateway traffic is exposed through one dataset: `ai_gateway_messages`. Each row is a normalized message content part owned by the HypAware AI gateway schema.

Key columns:

- `session_id` (NOT NULL) - the session identity; filter and group by this. `conversation_id` is nullable and often null; do not use it as the session key.
- `message_id`, `message_index`, `part_id`, `part_index` - stable message and part identity.
- `cwd`, `git_remote`, `git_branch`, `repo_root`, `head_sha` - per-row workspace context; useful for repo-scoped raw filters.
- `provider`, `model`, `role`, `part_type`, `content_text` - normalized provider/message content fields.
- `tool_name`, `tool_call_id`, `tool_args`, `status` - tool-call/result joins and sparse status such as `finish_reason`.
- `attributes` (JSON) - request settings, usage, propagated `dev_run_id`, and gateway diagnostics under `attributes.gateway`.

Claude transcript enrichment adds `provider_uuid`, `parent_uuid`, `request_id`, `entrypoint`, `client_version`, `user_type`, `permission_mode`, and `hook_event` when the local Claude Code JSONL transcript can be matched.

Run `hyp query schema ai_gateway_messages --format markdown` for the authoritative column reference.

## Context graph: route entity questions through the graph first

The activity graph is a structural index projected from `ai_gateway_messages` into two small datasets, `node` and `edge`. It answers "which sessions / files / skills / repos relate to X" questions in one sub-second lookup that would otherwise be a fragile LIKE-scan over hundreds of thousands of raw message rows. Decide the route before writing SQL:

**The routing rule.** Ask: does answering require *reading* rows, or only knowing they *exist and connect*? Route to the graph when the question is any of: (1) the answer is a set of identifiers, not text (membership/reachability); (2) the predicate is derived, not stored - the concept has no column and is computed by canonical projection rules, so ad hoc reconstruction is slower AND disagrees with the canonical answer; (3) it crosses two or more relationships (co-occurrence, indirect association) - the graph pre-materialized the join the raw route would express as a brittle correlated subquery; (4) it is an inventory/existence question - the node table is a pre-computed DISTINCT over all history; (5) identity needs normalizing across raw spellings. Route to the raw table when the question needs quantity/frequency (edges are existence-only), content, ordering/time, or row-level attributes. Compose them asymmetrically: graph decides WHICH scope matters, raw reads WHAT happened inside it - a scoped raw query is as fast as the graph, an unscoped one grows with history.

**Reach for the graph first when the question is entity-shaped** (the answer is a set of sessions, files, skills, programs, models, or repos, not message content):

- "Which sessions touched file X?" - `hyp graph neighbors <key> --direction in` (~0.2s vs ~0.9s raw, and the raw route has footguns - see below).
- "What did session S do?" (files, tools, skills, programs, model, repo) - `hyp graph neighbors <session-id> --direction out`, optionally `--edge-type touched|ran|invoked|used`.
- "Which sessions ran skill X / invoked program Y?" - these facets are derived at projection time (multi-surface skill-activation detection, argv[0] extraction with wrapper unwrapping). Ad hoc reconstruction from raw rows measurably disagrees with the canonical derivation (a 3-surface LIKE approximation returned 52 sessions where the graph's strict rules give 44) and a first-token approximation of "programs" returned 470 garbage tokens against the graph's 86 clean ones. Always use the graph for skill/program questions.
- Inventories: "what skills / models / programs / repos appear in the recordings?" - `select natural_key from node where node_type = 'Skill'` (~0.13s; even `select distinct model` on the messages table costs ~0.6s and scales with the cache).
- Co-occurrence and multi-hop: "what files co-occur with X via shared sessions", "which repos does skill Z run against" - `graph neighbors <seed> --depth 2 --direction both --edge-type <t>...`. This is the graph's biggest win: the raw equivalent needed a correlated subquery that either threw on a malformed row or timed out (>120s vs 0.17s).
- Cross-client joins: Skill and Program nodes are keyed to converge across claude and codex, so per-skill and per-program questions span both clients for free. Repo nodes normalize remote-URL forms that a raw `git_remote LIKE` misses (graph found 312 sessions in a repo; the LIKE found 240).

**Stay in `ai_gateway_messages` when the question is content- or event-shaped**: what was said, prompt/tool text, ordering and timing inside a session, token usage and other `attributes`, and any "how many times" question. Graph edges are deduplicated per (session, entity) pair - a `touched` edge means "at least once", never a count. Session-scoped raw aggregates are fast (~0.15s with a `session_id` filter), so once you have a session id there is no reason to avoid the messages table.

**Default strategy is two-stage**: use the graph to discover which sessions or entities matter, then drill into content with `ai_gateway_messages` filtered by `session_id`. Coverage of the two surfaces is near-identical when the graph is freshly projected, but they can drift (the graph only updates on `hyp graph project`; messages rows can be pruned by retention), so treat an empty drill-down as "check freshness", not "no data".

### From graph results to session content

The join is direct: a graph `Session` node's `natural_key` IS the `session_id` column in `ai_gateway_messages`. The standard drill-down for analyzing a tool's usage across chats:

```bash
# 1. Which sessions used the tool (human-readable; session UUIDs printed inline)
hyp graph neighbors <ToolName> --type Tool --direction in
# 1b. Machine-readable session list (resolve the node_id first; see pitfall below)
hyp query sql "select s.natural_key session_id from edge e join node s on e.src_id=s.node_id \
  where e.edge_type='used' and e.dst_id='<full-node-id>'" --format json
# 2. The calls themselves, with args
hyp query sql "select message_index, tool_call_id, json_extract(tool_args,'\$.<arg>') a \
  from ai_gateway_messages where session_id='<uuid>' and part_type='tool_call' and tool_name='<ToolName>'" --format json
# 3. Each call's result: tool_result rows point back via tool_result_for
hyp query sql "select content_text from ai_gateway_messages \
  where session_id='<uuid>' and tool_result_for='<tool_call_id>'" --format json
# 4. Surrounding conversation: window on message_index
hyp query sql "select message_index, role, part_type, content_text from ai_gateway_messages \
  where session_id='<uuid>' and message_index between <n-3> and <n+3> order by message_index, part_index" --format json
```

Two pitfalls in this handoff: `graph neighbors` ignores `--format json` (parse the table, or use the SQL form for machine-readable lists), and the bracketed id it prints (`[1a585e06adf4]`) is **display-truncated** - pasting it into SQL matches nothing; resolve the full `node_id` from the `node` table by `natural_key`. Note that for a single known tool, discovery via raw SQL is also fine (`tool_name` is a real column); the graph earns its keep when the tool question chains into other entities (which repos, which skills, co-used tools).

### Raw-route footguns (when you do query messages directly)

- **`tool_args` and `attributes` are JSON-typed columns. `tool_args LIKE '%x%'` silently matches zero rows** - it is not an error, it just returns nothing. Extract first: `json_extract(tool_args, '$.file_path') = '...'` or `json_extract(...) LIKE '%...%'`.
- **`json_extract` throws on malformed rows** (`invalid JSON string`) when scanned broadly. Always pre-filter to the tool names whose args you are extracting (`tool_name in ('Read','Edit','Write','MultiEdit','NotebookEdit')`) so the scan never reaches a bad row.
- **Avoid correlated `IN (select ...)` subqueries over `json_extract`** - observed to run past a 2-minute timeout on a 143k-row table. If you need a two-stage raw query, resolve the inner set first and inline the literal values, or route the discovery hop through the graph.

### Graph shape

Node types: `Session`, `App` (claude/codex), `Model`, `Tool`, `File`, `Skill`, `Program`, `Repo`, `Commit`. Edges are Session-rooted: `via` -> App, `used_model` -> Model, `used` -> Tool, `touched` -> File, `ran` -> Skill, `invoked` -> Program, `in` -> Repo, `at` -> Commit (plus Commit -`in`-> Repo). Direction is load-bearing: `--direction out` from a Session lists its resources; `--direction in` from a resource lists the sessions that touched it; depth-2 `both` from a resource is co-occurrence.

Natural keys (what you pass as a seed): Session = session UUID; File = `owner/repo:path` when the session had git metadata, absolute path otherwise; Skill = bare skill name; Program = lowercased basename; Model = model id; Repo = `owner/repo`. Seeds resolve by node_id, then natural_key, then label; an ambiguous seed errors and lists candidates (pass the fuller key). `ran` edges carry `dispatch_*` boolean props saying how the skill was activated.

**File-node identity is split**: the same physical file can exist as both a repo-scoped node (`hyparam/hypaware:src/x.js`) and one or more absolute-path nodes (including worktree and tmp-dir copies). For a complete "who touched this file" answer, enumerate the keys first, then walk each:

```bash
hyp query sql "select node_id, natural_key from node where node_type='File' and natural_key like '%src/core/runtime/bundled.js'" --format json
hyp graph neighbors <each-key> --direction in
```

### Graph commands

```bash
hyp graph neighbors <seed> [--depth N] [--type <NodeType>] [--edge-type <t>...] [--direction out|in|both] [--limit N]
hyp graph project     # (re)project the graph from source datasets; idempotent
hyp query sql "select ... from node ..." --format json
hyp query sql "select ... from edge e join node n on ..." --format json
```

### Graph caveats

- **Availability**: `node`/`edge` must appear in `hyp query catalog`. If missing, the graph plugins are not in the active config (fleet-locked installs may need a separate config via `HYP_CONFIG`); discover once, as with `--config`, and reuse.
- **Eventual freshness**: the graph only updates when `hyp graph project` runs; there is no daemon hook. For recency-sensitive questions, check `max(first_seen)` in `node` (or just re-run `hyp graph project` - it is idempotent and cheap) before trusting the graph.
- **SQL over `node`/`edge` is for weights and aggregation only, and has sharp performance tiers** (measured): `graph neighbors` traversal ~0.2s; an edge self-join anchored on a **literal node_id** ~3s; the same join with a scalar subquery (`e1.dst_id = (select node_id from node where ...)`) ~33s. Resolve seed node_ids in a separate query first and inline them. Use SQL only when you need per-edge weights (`count(distinct e.src_id)`) that `neighbors` (a deduplicating BFS) cannot report.
- **SQL join planner**: multi-join queries over `edge`/`node` usually work, but the planner has intermittently failed non-trivial edge self-joins with `Column ... not found`. If that happens, keep the edge self-join adjacent and early, or materialize it as a subquery and join `node` in the outer query; resolve a second node lookup in a separate query.

## Guardrails

- Do not assume the cache auto-refreshes. Query commands default to `--refresh never`.
- Always read stderr. A successful exit code does not mean the cache is current.
- Keep SQL read-only and use only query tables from `hyp query catalog`.
- `hyp query sql` inline output is context-budgeted (cells truncated to ~200 chars, rows dropped past ~32KB) and emits a `notice:` on stderr when it withholds rows - it is not a fixed row cap. Prefer aggregates/filters for analysis; use `--output <file>` for a complete, untruncated result and read it back from the file rather than from stdout.
