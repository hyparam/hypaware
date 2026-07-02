---
name: hypaware-graph
description: Explore the HypAware context graph: the activity graph projected from ai_gateway_messages (Sessions, Apps, Models, Tools, Files, and git Repos/Commits, and how they connect), plus optional server-side GitHub enrichment (Repos, PullRequests, Commits, Reviewers) that bridges AI sessions to code review. Use when the user asks what connects to a file/session/tool/model, wants co-occurrence or N-hop traversal, wants to join AI sessions to GitHub repos/PRs/reviewers, or wants to build/refresh the graph. Covers `hyp graph project` and `hyp graph neighbors`.
---

# HypAware Graph

`hyp graph` turns local HypAware recordings into a queryable **activity graph** and walks it. The graph is a derived projection of the `ai_gateway_messages` dataset (the same local data the `hypaware-query` skill reads), read as *relationships* instead of rows.

## Build or refresh the graph

The projection runs **on demand**; it does not auto-update. Run it before querying, and again after new sessions are recorded:

```bash
hyp graph project              # project ai_gateway_messages → node/edge tables (idempotent)
hyp graph project --dry-run    # show what would be written
hyp graph compact              # merge duplicate rows, rewrite partitions sorted (maintenance)
```

`hyp graph project` prints `N node(s), M edge(s) - wrote …`. If `node`/`edge` come back empty, the projection has not been run yet (or there are no recordings).

## The graph model

Deterministic T0 projection: exact-key, no models. The core is **Session-rooted**, plus a small git-provenance sub-web (`Repo`, `Commit`) that doubles as the bridge to GitHub enrichment (see below).

- **Node types:** `Session` (one per session), `App` (client), `Model`, `Tool`, `File`, and, when the session's git context is captured, `Repo` and `Commit`.
- **Edge types:** `via` (Session→App), `used_model` (Session→Model), `used` (Session→Tool), `touched` (Session→File), `in` (Session→Repo), `at` (Session→Commit, the HEAD the session sat on), and `in` (Commit→Repo).
- **natural_key** is the human key per type: Session = `session_id` (the always-present session container; `conversation_id` is a nullable thread identity, null for Claude), App = `client_name`, Model = model id, Tool = tool name, File = full path (or `owner/repo:relpath` when the repo remote is known; its `label` is the basename), Repo = `owner/repo`, Commit = full 40-hex sha. Every row carries inline provenance (`source_dataset`, `projector`, …).
- **Bridge-ready keys.** `Repo`, `Commit`, and `File` use shared, content-addressed natural keys, so a node minted from a session's git context and the same node minted by the GitHub source converge on one id. This is what lets an AI session and a pull request meet at the same commit.

## GitHub enrichment (server-side)

The base graph above comes from `ai_gateway_messages` and is available anywhere, including a local install. A **server** can additionally run the `@hypaware/github` source, which captures repo / commit / PR / issue / review events and projects a second contract into the **same** `node` / `edge` tables. This is the graph's biggest payoff, and none of it is answerable from the message data alone.

**Caveats first, so you don't query nodes that aren't there:**

- **Server-only and opt-in.** GitHub nodes exist only on a host where the `@hypaware/github` source is configured and has captured events (normally the central server, reached with `--remote`). A plain local projection has none of them. An empty GitHub query usually means the source is not configured on that host, or the graph has not been re-projected since capture, not that the true answer is zero.
- **`Actor` is a GitHub login, not the AI user.** The identity that authored a commit or opened a PR is the git actor, not the `user_id` of whoever ran the agent. Cross-domain identity merge is later work (T1/T2); never equate an `Actor` with an AI operator.
- **Freshness applies here too.** The GitHub domain is only as current as the last projection on that host, and you cannot project through the read-only query token (projection is admin-side). On a stale central graph, recent PRs and reviews are simply missing. One subtlety: freshly projected rows sit in a spool until a settling read runs **on the server** (an admin-side query; the remote query surface never settles), and `node` and `edge` settle independently, so a graph can briefly show fresh nodes joined by stale edges. If a cross-domain join returns implausibly few rows against fresh-looking nodes, suspect an unsettled `edge` dataset before doubting the data.

**What it adds:**

- **Nodes:** `Actor` (login), `Issue`, `PullRequest`, `Review`, plus enriched `Repo` / `Commit` / `File`.
- **Edges:** `authored` (Actor→Commit), `opened` and `commented` (Actor→Issue | PullRequest), `submitted` (Actor→Review), `on` (Review→PullRequest), `references` (PullRequest→Commit), `touched` (Commit→File and PullRequest→File), `in` (Commit | File | Issue | PullRequest→Repo).

**Why it matters, the possibility.** Because `Repo`, `Commit`, and `File` are bridge-ready, the AI-session web and the GitHub web are *one graph*. The commit a session sat on (`Session -at-> Commit`) is the same node GitHub knows through `PullRequest -references-> Commit` and `Actor -authored-> Commit`. So you can walk from an agent's activity into the code-review reality around it, questions `ai_gateway_messages` cannot express:

- **AI work to the PR that shipped it:** `Session -at-> Commit <-references- PullRequest`.
- **AI work to who reviewed it:** continue `PullRequest <-on- Review <-submitted- Actor`.
- **Coverage, honestly:** which repos and PRs an agent's work actually reached, not just which cwd it ran in.
- **Reverse:** start from a `PullRequest` or `Repo` and walk inbound to every AI session that touched it.

```bash
# Sessions whose HEAD commit is referenced by a PR (AI work that reached code review).
# Note: no --refresh with --remote; the server owns its freshness.
hyp query sql "select distinct s.natural_key session
  from edge a join node s on a.src_id = s.node_id
  join edge r on r.dst_id = a.dst_id and r.edge_type = 'references'
  where a.edge_type = 'at'" --remote HYP_CENTRAL

# From a PR, walk out to its reviews, actors, and referenced commits.
hyp graph neighbors owner/repo#123 --type PullRequest --depth 2 --direction both --remote HYP_CENTRAL
```

Reach for the GitHub domain whenever a question spans **both** AI activity and code collaboration (sessions to PRs, agents to reviewers, work to repos). If it is purely one side, the base graph or plain message SQL is enough.

## Two ways to query

### 1. SQL over `node` / `edge`: counts, filters, aggregates

Flat SQL through the normal query surface (no recursion). Use for "how many", "top N", "group by", one- or two-hop joins:

```bash
hyp query sql "select node_type, count(*) n from node group by node_type" --refresh always
hyp query sql "select t.natural_key tool, count(*) n from edge e join node t on e.dst_id = t.node_id
  where e.edge_type = 'used' group by tool order by n desc" --refresh always
```

`node`/`edge` are ordinary datasets; see the `hypaware-query` skill for `hyp query` mechanics (read stderr, freshness, `--format json`). Use `--refresh always` so the read settles freshly-projected rows.

### 2. Traversal with `hyp graph neighbors`: relationships and depth

For "what connects to X", co-occurrence, and N-hop walks, what flat SQL can't express.

```bash
hyp graph neighbors <node> [--depth N] [--type T] [--edge-type T] [--direction out|in|both] [--limit N] [--json]
```

- **`<node>`** resolves by `node_id`, then `natural_key`, then `label`, so pass a session id, a file path (or basename), a model id, or a tool/app name. If it's ambiguous the command lists the candidates; narrow with `--type Session|App|Model|Tool|File|Repo|Commit|Actor|Issue|PullRequest|Review` (the last five require GitHub enrichment).
- **`--direction`** is load-bearing because edges are Session-rooted:
  - `out` from a **Session** → its app, model, tools, files.
  - `in` from a **File / Tool / Model / App** → the **Sessions** that touched/used it.
  - `both` at `--depth 2` from a **File** → **co-occurrence**: the other files/tools/models reached through the sessions that share it.
- **`--edge-type`** restricts which relations are walked (e.g. `--edge-type used`); repeatable or comma-separated.
- **`--limit`** caps output in BFS order and reports the true total when it truncates (`… - truncated; raise --limit`).
- **`--json`** emits `{ seed, neighbors: [{ hop, edge_type, direction, node }], reachable, truncated }` for follow-up reasoning.

Examples:

```bash
hyp graph neighbors sess-abc123 --direction out                  # what a session used / touched
hyp graph neighbors src/auth.py --direction in                   # which sessions touched a file
hyp graph neighbors src/auth.py --depth 2 --direction both       # files/tools that co-occur with it
hyp graph neighbors Bash --direction in --edge-type used         # sessions that ran a tool
hyp graph neighbors claude-opus-4-8 --type Model --direction in  # sessions that used a model
```

## Choosing the right tool

- Counting, ranking, grouping, "how often" → **`hyp query sql`** over `node`/`edge`.
- "What connects to X", paths, neighborhoods, co-occurrence, depth → **`hyp graph neighbors`**.

### When the graph is cheaper than scanning `ai_gateway_messages`

For descriptive "who used what" rollups, the graph answers from compact adjacency instead of scanning every message row. Prefer it when the rollup keys on an entity that is already a node:

- sessions per tool = `used` · per model = `used_model` · per file = `touched` · per app = `via` · per repo = `in` (Session→Repo) · per commit = `at`.
- distinct-session counts over any of these are `count(distinct src_id)` on the edge, far fewer rows than `count(distinct session_id)` over messages (benchmarked ~12x fewer for the repo rollup).

Stay on `ai_gateway_messages` when the measure lives on the message, not the relationship:

- token sums and cache-read ratios; `count(*)` call totals (the graph keeps one edge per pair, so it cannot count repeat calls); `is_error` / `is_sidechain` / stop-reason; and `content_text` classification.
- per-`gateway_id` or per-`user_id` rollups: there are no Gateway or User nodes yet.

Rule of thumb: "which sessions relate to X" or "how many distinct sessions" is a graph question; anything needing a per-message measure (tokens, errors, call counts, text) stays on messages.

## Guardrails

- **Project first.** The graph is only as fresh as the last `hyp graph project`; empty results usually mean it has not run.
- **Read stderr for errors.** `graph neighbors` writes not-found / ambiguity notes (and the large-graph note) to stderr; exit `1` is a resolution error, `2` is a usage error. **Truncation is part of the result**, so it goes to **stdout** (`… - truncated; raise --limit`) and the `--json` `truncated` field, not stderr.
- The graph is **derived and rebuildable**, never the source of truth. To change what it contains, fix capture/projection and re-project; don't hand-edit `node`/`edge`.
- Basic traversal loads the graph in memory per call, fine at activity-graph scale; a very large graph prints a note pointing at the future indexed path.
