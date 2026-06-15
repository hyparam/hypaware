---
name: hypaware-graph
description: Explore the local HypAware context graph — the activity graph projected from ai_gateway_messages (Sessions, Apps, Models, Tools, Files and how they connect). Use when the user asks what connects to a file/session/tool/model, wants co-occurrence or N-hop traversal, or wants to build/refresh the graph. Covers `hyp graph project` and `hyp graph neighbors`.
---

# HypAware Graph

`hyp graph` turns local HypAware recordings into a queryable **activity graph** and walks it. The graph is a derived projection of the `ai_gateway_messages` dataset — the same local data the `hypaware-query` skill reads — read as *relationships* instead of rows.

## Build or refresh the graph

The projection runs **on demand** — it does not auto-update. Run it before querying, and again after new sessions are recorded:

```bash
hyp graph project              # project ai_gateway_messages → node/edge tables (idempotent)
hyp graph project --dry-run    # show what would be written
hyp graph compact              # merge duplicate rows, rewrite partitions sorted (maintenance)
```

`hyp graph project` prints `N node(s), M edge(s) — wrote …`. If `node`/`edge` come back empty, the projection has not been run yet (or there are no recordings).

## The graph model

Deterministic T0 projection — exact-key, no models. All edges are **Session-rooted**:

- **Node types:** `Session` (one per conversation), `App` (client), `Model`, `Tool`, `File`.
- **Edge types:** `via` (Session→App), `used_model` (Session→Model), `used` (Session→Tool), `touched` (Session→File).
- **natural_key** is the human key per type: Session = `conversation_id`, App = `client_name`, Model = model id, Tool = tool name, File = full path (its `label` is the basename). Every row carries inline provenance (`source_dataset`, `projector`, …).

## Two ways to query

### 1. SQL over `node` / `edge` — counts, filters, aggregates

Flat SQL through the normal query surface (no recursion). Use for "how many", "top N", "group by", one- or two-hop joins:

```bash
hyp query sql "select node_type, count(*) n from node group by node_type" --refresh always
hyp query sql "select t.natural_key tool, count(*) n from edge e join node t on e.dst_id = t.node_id
  where e.edge_type = 'used' group by tool order by n desc" --refresh always
```

`node`/`edge` are ordinary datasets — see the `hypaware-query` skill for `hyp query` mechanics (read stderr, freshness, `--format json`). Use `--refresh always` so the read settles freshly-projected rows.

### 2. Traversal — `hyp graph neighbors` — relationships and depth

For "what connects to X", co-occurrence, and N-hop walks — what flat SQL can't express.

```bash
hyp graph neighbors <node> [--depth N] [--type T] [--edge-type T] [--direction out|in|both] [--limit N] [--json]
```

- **`<node>`** resolves by `node_id`, then `natural_key`, then `label` — so pass a conversation id, a file path (or basename), a model id, or a tool/app name. If it's ambiguous the command lists the candidates; narrow with `--type Session|App|Model|Tool|File`.
- **`--direction`** is load-bearing because edges are Session-rooted:
  - `out` from a **Session** → its app, model, tools, files.
  - `in` from a **File / Tool / Model / App** → the **Sessions** that touched/used it.
  - `both` at `--depth 2` from a **File** → **co-occurrence**: the other files/tools/models reached through the sessions that share it.
- **`--edge-type`** restricts which relations are walked (e.g. `--edge-type used`); repeatable or comma-separated.
- **`--limit`** caps output in BFS order and reports the true total when it truncates (`3 of 7 … — truncated`).
- **`--json`** emits `{ seed, neighbors: [{ hop, edge_type, direction, node }], reachable, truncated }` for follow-up reasoning.

Examples:

```bash
hyp graph neighbors conv-abc123 --direction out                  # what a session used / touched
hyp graph neighbors src/auth.py --direction in                   # which sessions touched a file
hyp graph neighbors src/auth.py --depth 2 --direction both       # files/tools that co-occur with it
hyp graph neighbors Bash --direction in --edge-type used         # sessions that ran a tool
hyp graph neighbors claude-opus-4-8 --type Model --direction in  # sessions that used a model
```

## Choosing the right tool

- Counting, ranking, grouping, "how often" → **`hyp query sql`** over `node`/`edge`.
- "What connects to X", paths, neighborhoods, co-occurrence, depth → **`hyp graph neighbors`**.

## Guardrails

- **Project first.** The graph is only as fresh as the last `hyp graph project`; empty results usually mean it has not run.
- **Read stderr.** `graph neighbors` writes not-found / ambiguity / truncation notes to stderr; exit `1` is a resolution error, `2` is a usage error.
- The graph is **derived and rebuildable** — never the source of truth. To change what it contains, fix capture/projection and re-project; don't hand-edit `node`/`edge`.
- Basic traversal loads the graph in memory per call — fine at activity-graph scale; a very large graph prints a note pointing at the future indexed path.
