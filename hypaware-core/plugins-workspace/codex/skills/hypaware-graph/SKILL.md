---
name: hypaware-graph
description: Explore the HypAware context graph: the activity graph projected from ai_gateway_messages (Sessions, Apps, Models, Tools, Files, Skills, Programs, and git Repos/Commits, and how they connect), plus optional server-side GitHub enrichment (Repos, PullRequests, Commits, Reviewers) that bridges AI sessions to code review. Use when the user asks what connects to a file/session/tool/model, which sessions ran a skill or invoked a program, wants co-occurrence or N-hop traversal, wants to join AI sessions to GitHub repos/PRs/reviewers, or wants to build/refresh the graph. Covers `hyp graph project` and `hyp graph neighbors`.
---

# HypAware Graph

`hyp graph` turns HypAware recordings into a queryable **activity graph** and walks it. The graph is a derived projection of the `ai_gateway_messages` dataset (the same data the `hypaware-query` skill reads), read as *relationships* instead of rows.

## Availability: is the graph enabled here?

If `hyp graph` comes back as an unknown command, or `node`/`edge` are missing from the datasets in `hyp query status`, the graph plugins are not in the active config. They ship bundled with the package but activate only when the config names them, and on fleet-joined hosts the plugin set comes from the central config layer, which may omit them.

The fix is additive and works even on fleet-locked installs (the central layer locks only the plugin names it declares; the local layer may contribute the rest): add `{"name": "@hypaware/context-graph"}` and `{"name": "@hypaware/ai-gateway-graph"}` to the `plugins` array of the local `<HYP_HOME>/hypaware-config.json`, verify with `hyp config validate`, then build the graph with `hyp graph project`. **This edits the user's config - propose the change and get their go-ahead rather than editing it silently.** If the central config later adds the same plugins, the local duplicates are dropped benignly (recorded as `collides_with_central`, visible in `hyp status`).

A fleet server may have the graph enabled even when this machine does not (or vice versa): `hyp graph neighbors ... --remote <target>` and `hyp query sql "... from node ..." --remote <target>` use the server's graph and the server's projection schedule, not the local ones. Local and remote graphs answer at different scopes (this machine vs the fleet) and can legitimately disagree; treat the difference as coverage, not error.

## Build or refresh the graph

The projection runs **on demand**; it does not auto-update. Run it before querying, and again after new sessions are recorded:

```bash
hyp graph project              # project ai_gateway_messages -> node/edge tables (idempotent)
hyp graph project --dry-run    # show what would be written
hyp graph compact              # merge duplicate rows, rewrite partitions sorted (maintenance)
```

`hyp graph project` prints `N node(s), M edge(s) - wrote ...`. If `node`/`edge` come back empty, the projection has not been run yet (or there are no recordings). For recency-sensitive questions, check `max(first_seen)` in `node`, or just re-project first: it is idempotent and cheap.

## The graph model

Deterministic T0 projection: exact-key, no models. The core is **Session-rooted**, plus a small git-provenance sub-web (`Repo`, `Commit`) that doubles as the bridge to GitHub enrichment (see below).

- **Node types:** `Session` (one per session), `App` (client), `Model`, `Tool`, `File`, `Skill`, `Program`, and, when the session's git context is captured, `Repo` and `Commit`.
- **Edge types:** `via` (Session->App), `used_model` (Session->Model), `used` (Session->Tool), `touched` (Session->File), `ran` (Session->Skill), `invoked` (Session->Program), `in` (Session->Repo), `at` (Session->Commit, the HEAD the session sat on), and `in` (Commit->Repo).
- **natural_key** is the human key per type: Session = `session_id` (the always-present session container; `conversation_id` is a nullable thread identity, null for Claude), App = `client_name`, Model = model id, Tool = tool name, File = full path (or `owner/repo:relpath` when the repo remote is known; its `label` is the basename), Skill = bare skill name, Program = lowercased basename, Repo = `owner/repo`, Commit = full 40-hex sha. Every row carries inline provenance (`source_dataset`, `projector`, ...).
- **Skills and programs are derived facets.** They have no column in `ai_gateway_messages`: `ran` edges come from multi-surface skill-activation detection (and carry `dispatch_*` boolean props saying how the skill was activated), `invoked` edges from argv[0] extraction with wrapper unwrapping. Ad hoc reconstruction from raw rows measurably disagrees with the canonical derivation (a 3-surface LIKE approximation returned 52 sessions where the strict rules give 44; a first-token approximation of "programs" returned 470 garbage tokens against the graph's 86 clean ones). Always answer skill/program questions from the graph.
- **Keys converge where raw spellings diverge.** Skill and Program nodes are keyed identically across claude and codex, so per-skill and per-program questions span both clients for free. Repo nodes normalize remote-URL forms that a raw `git_remote LIKE` misses (in one measurement the graph found 312 sessions in a repo where the LIKE found 240).
- **Bridge-ready keys.** `Repo`, `Commit`, and `File` use shared, content-addressed natural keys, so a node minted from a session's git context and the same node minted by the GitHub source converge on one id. This is what lets an AI session and a pull request meet at the same commit.

## GitHub enrichment (server-side)

The base graph above comes from `ai_gateway_messages` and is available anywhere, including a local install. A **server** can additionally run the `@hypaware/github` source, which captures repo / commit / PR / issue / review events and projects a second contract into the **same** `node` / `edge` tables. This is the graph's biggest payoff, and none of it is answerable from the message data alone.

**Caveats first, so you don't query nodes that aren't there:**

- **Server-only and opt-in.** GitHub nodes exist only on a host where the `@hypaware/github` source is configured and has captured events (normally the central server, reached with `--remote`). A plain local projection has none of them. An empty GitHub query usually means the source is not configured on that host, or the graph has not been re-projected since capture, not that the true answer is zero.
- **`Actor` is a GitHub login, not the AI user.** The identity that authored a commit or opened a PR is the git actor, not the `user_id` of whoever ran the agent. Cross-domain identity merge is later work (T1/T2); never equate an `Actor` with an AI operator.
- **Freshness applies here too.** The GitHub domain is only as current as the last projection on that host, and you cannot project through the read-only query token (projection is admin-side). On a stale central graph, recent PRs and reviews are simply missing. One subtlety: freshly projected rows sit in a spool until a settling read runs **on the server** (an admin-side query; the remote query surface never settles), and `node` and `edge` settle independently, so a graph can briefly show fresh nodes joined by stale edges. If a cross-domain join returns implausibly few rows against fresh-looking nodes, suspect an unsettled `edge` dataset before doubting the data.

**What it adds:**

- **Nodes:** `Actor` (login), `Issue`, `PullRequest`, `Review`, plus enriched `Repo` / `Commit` / `File`.
- **Edges:** `authored` (Actor->Commit), `opened` and `commented` (Actor->Issue | PullRequest), `submitted` (Actor->Review), `on` (Review->PullRequest), `references` (PullRequest->Commit), `touched` (Commit->File and PullRequest->File), `in` (Commit | File | Issue | PullRequest->Repo).

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

- **`<node>`** resolves by `node_id`, then `natural_key`, then `label`, so pass a session id, a file path (or basename), a model id, or a tool/skill/program/app name. If it's ambiguous the command lists the candidates; narrow with `--type Session|App|Model|Tool|File|Skill|Program|Repo|Commit|Actor|Issue|PullRequest|Review` (the last four require GitHub enrichment).
- **`--direction`** is load-bearing because edges are Session-rooted:
  - `out` from a **Session** -> its app, model, tools, files, skills, programs.
  - `in` from a **File / Tool / Skill / Program / Model / App** -> the **Sessions** that touched/used/ran/invoked it.
  - `both` at `--depth 2` from a **File** -> **co-occurrence**: the other files/tools/models reached through the sessions that share it.
- **`--edge-type`** restricts which relations are walked (e.g. `--edge-type used`); repeatable or comma-separated.
- **`--limit`** caps output in BFS order and reports the true total when it truncates (`... - truncated; raise --limit`).
- **`--json`** emits `{ seed, neighbors: [{ hop, edge_type, direction, node }], reachable, truncated }` for follow-up reasoning, with **full node ids**. Note the flag is `--json`, not `--format json` (the latter is silently ignored and you get the text table). The bracketed id in the text output (`[c1446c4f2b01]`) is display-truncated - pasting it into SQL matches nothing; take full ids from `--json`, or resolve them from the `node` table by `natural_key`.

Examples:

```bash
hyp graph neighbors sess-abc123 --direction out                  # what a session used / touched / ran
hyp graph neighbors src/auth.py --direction in                   # which sessions touched a file
hyp graph neighbors src/auth.py --depth 2 --direction both       # files/tools that co-occur with it
hyp graph neighbors Bash --direction in --edge-type used         # sessions that ran a tool
hyp graph neighbors dataviz --type Skill --direction in          # sessions that ran a skill
hyp graph neighbors aws --type Program --direction in            # sessions that invoked a program
hyp graph neighbors claude-opus-4-8 --type Model --direction in  # sessions that used a model
```

**File-node identity is split**: the same physical file can exist as both a repo-scoped node (`owner/repo:src/x.js`) and one or more absolute-path nodes (worktree and tmp-dir copies included). For a complete "who touched this file" answer, enumerate the keys first, then walk each:

```bash
hyp query sql "select node_id, natural_key from node where node_type='File' and natural_key like '%src/core/runtime/bundled.js'" --format json
hyp graph neighbors <each-key> --direction in
```

## Choosing the right tool

Ask: does answering require *reading* rows, or only knowing they *exist and connect*? Route to the graph when the question is any of: (1) the answer is a set of identifiers, not text (membership/reachability); (2) the predicate is derived, not stored (skills, programs - see the model section); (3) it crosses two or more relationships (co-occurrence, indirect association) - the graph pre-materialized the join the raw route would express as a brittle correlated subquery; (4) it is an inventory/existence question - the node table is a pre-computed DISTINCT over all history; (5) identity needs normalizing across raw spellings (repos, cross-client skills).

Then pick the surface:

- Counting, ranking, grouping, "how often" -> **`hyp query sql`** over `node`/`edge`. Distinct-session counts key on the edge (`count(distinct src_id)`), far fewer rows than `count(distinct session_id)` over messages (benchmarked ~12x fewer for the repo rollup): sessions per tool = `used`, per model = `used_model`, per file = `touched`, per skill = `ran`, per program = `invoked`, per app = `via`, per repo = `in`, per commit = `at`.
- "What connects to X", paths, neighborhoods, co-occurrence, depth -> **`hyp graph neighbors`**.

Stay on `ai_gateway_messages` when the measure lives on the message, not the relationship:

- token sums and cache-read ratios; `count(*)` call totals (the graph keeps one edge per (session, entity) pair - an edge means "at least once", never a count); `is_error` / `is_sidechain` / stop-reason; ordering and time inside a session; and `content_text` classification.
- per-`gateway_id` or per-`user_id` rollups: there are no Gateway or User nodes yet.

**Default strategy is two-stage**: the graph decides WHICH sessions or entities matter, then raw SQL reads WHAT happened inside them - a `session_id`-scoped messages query is as fast as the graph (~0.15s), while an unscoped one grows with history. The join is direct: a `Session` node's `natural_key` IS the `session_id` column in `ai_gateway_messages`.

```bash
# 1. Which sessions used the tool (take full ids and session UUIDs from --json)
hyp graph neighbors <ToolName> --type Tool --direction in --json
# 2. The calls themselves, with args
hyp query sql "select message_index, tool_call_id, json_extract(tool_args,'\$.<arg>') a
  from ai_gateway_messages where session_id='<uuid>' and part_type='tool_call' and tool_name='<ToolName>'" --format json
# 3. Each call's result: tool_result rows point back via tool_result_for
hyp query sql "select content_text from ai_gateway_messages
  where session_id='<uuid>' and tool_result_for='<tool_call_id>'" --format json
# 4. Surrounding conversation: window on message_index
hyp query sql "select message_index, role, part_type, content_text from ai_gateway_messages
  where session_id='<uuid>' and message_index between <n-3> and <n+3> order by message_index, part_index" --format json
```

Coverage of graph and messages is near-identical when the graph is freshly projected, but they can drift (the graph only updates on `hyp graph project`; message rows can be pruned by retention), so treat an empty drill-down as "check freshness", not "no data".

## SQL performance over node/edge

SQL over `node`/`edge` has sharp performance tiers (measured): `graph neighbors` traversal ~0.2s; an edge self-join anchored on a **literal node_id** ~3s; the same join with a scalar subquery (`e1.dst_id = (select node_id from node where ...)`) ~33s. Resolve seed node_ids first (via `--json` or a separate lookup query) and inline them as literals. Use SQL only when you need per-edge weights (`count(distinct e.src_id)`) that `neighbors` (a deduplicating BFS) cannot report.

The join planner has intermittently failed non-trivial edge self-joins with `Column ... not found`. If that happens, keep the edge self-join adjacent and early, or materialize it as a subquery and join `node` in the outer query; resolve a second node lookup in a separate query.

## Guardrails

- **Project first.** The graph is only as fresh as the last `hyp graph project`; empty results usually mean it has not run.
- **Read stderr for errors.** `graph neighbors` writes not-found / ambiguity notes (and the large-graph note) to stderr; exit `1` is a resolution error, `2` is a usage error. **Truncation is part of the result**, so it goes to **stdout** (`... - truncated; raise --limit`) and the `--json` `truncated` field, not stderr.
- The graph is **derived and rebuildable**, never the source of truth. To change what it contains, fix capture/projection and re-project; don't hand-edit `node`/`edge`.
- Basic traversal loads the graph in memory per call, fine at activity-graph scale; a very large graph prints a note pointing at the future indexed path.
