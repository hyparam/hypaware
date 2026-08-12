# GitHub enrichment: AI sessions joined to code review

Loaded on entry to a question that spans **both** AI activity and code collaboration (sessions to PRs, agents to reviewers, work to repos). If the question is purely one side, the base graph or plain message SQL is enough and this file is not needed.

The base graph comes from `ai_gateway_messages` and exists anywhere, including a local install. A **server** can additionally run the `@hypaware/github` source, which captures repo / commit / PR / issue / review events and projects a second contract into the **same** `node` / `edge` tables.

## Caveats first, so you do not query nodes that are not there

- **Server-only and opt-in.** GitHub nodes exist only on a host where `@hypaware/github` is configured and has captured events, normally the central server, reached with `--remote`. A plain local projection has none of them. **An empty GitHub result usually means the source is not configured on that host, or the graph has not been re-projected since capture, not that the true answer is zero.**
- **`Actor` is a GitHub login, not the AI user.** The identity that authored a commit or opened a PR is the git actor, not the `user_id` of whoever ran the agent. Never equate an `Actor` with an AI operator; cross-domain identity merge is later work.
- **Freshness applies here too**, and you cannot project through a read-only query token: projection is admin-side. On a stale central graph, recent PRs and reviews are simply missing.
- **`node` and `edge` settle independently.** Freshly projected rows sit in a spool until a settling read runs *on the server*; the remote query surface never settles. So a graph can briefly show fresh nodes joined by stale edges. If a cross-domain join returns implausibly few rows against fresh-looking nodes, suspect an unsettled `edge` dataset before doubting the data.

## What it adds

- **Nodes:** `Actor` (login), `Issue`, `PullRequest`, `Review`, plus enriched `Repo` / `Commit` / `File`.
- **Edges:** `authored` (Actor->Commit), `opened` and `commented` (Actor->Issue | PullRequest), `submitted` (Actor->Review), `on` (Review->PullRequest), `references` (PullRequest->Commit), `touched` (Commit->File and PullRequest->File), `in` (Commit | File | Issue | PullRequest->Repo).

## Why the join works

`Repo`, `Commit`, and `File` use shared, content-addressed natural keys, so a node minted from a session's git context and the same node minted by the GitHub source converge on **one id**. The AI-session web and the GitHub web are therefore one graph, and the commit a session sat on (`Session -at-> Commit`) is the same node GitHub knows through `PullRequest -references-> Commit` and `Actor -authored-> Commit`.

That is what lets you walk from an agent's activity into the code-review reality around it, which `ai_gateway_messages` cannot express at all:

- **AI work to the PR that shipped it:** `Session -at-> Commit <-references- PullRequest`
- **AI work to who reviewed it:** continue `PullRequest <-on- Review <-submitted- Actor`
- **Coverage, honestly:** which repos and PRs an agent's work actually reached, not just which cwd it ran in
- **Reverse:** start from a `PullRequest` or `Repo` and walk inbound to every AI session that touched it

```bash
# Sessions whose HEAD commit is referenced by a PR (AI work that reached code review).
# No --refresh with --remote: the server owns its freshness.
hyp query sql "select distinct s.natural_key session
  from edge a join node s on a.src_id = s.node_id
  join edge r on r.dst_id = a.dst_id and r.edge_type = 'references'
  where a.edge_type = 'at'" --remote HYP_CENTRAL

# From a PR, walk out to its reviews, actors, and referenced commits.
hyp graph neighbors owner/repo#123 --type PullRequest --depth 2 --direction both --remote HYP_CENTRAL
```

The performance tiers in the main skill apply here too: resolve seed node_ids first and inline them as literals rather than using a scalar subquery.
