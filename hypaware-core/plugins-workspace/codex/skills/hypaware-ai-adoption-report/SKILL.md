---
name: hypaware-ai-adoption-report
description: AI Adoption Profile for a HypAware server: descriptive "who's using the fleet and how": per-gateway utilization (volume + focus: top models, tools, repos, themes) and parallelism/fan-out (multi-agent adoption, concurrency, main-vs-subagent split, payoff).
---

# AI Adoption Profile

A profile of *who's using the fleet and how*, read through two lenses over one window:

- **Utilization:** per `gateway_id` (≈ one machine/user): *how much* (messages, sessions,
  active days, tokens, cache-read ratio) and *what it's focused on* (top models, tools, repos,
  work themes).
- **Parallelism / fan-out:** *how sophisticated*: multi-agent adoption, fan-out breadth/depth,
  true concurrency vs serial, the main-loop-vs-subagent token split, and whether fan-out appears
  to earn its cost.

IMPORTANT: Don't assume which logs to read: **ask first.** Start by listing the data sources
and let the user choose which to query: **local logs** (this machine's own recordings,
`hyp query sql …`, no `--remote`) and **each remote HypAware server** (every target from
`hyp remote list`, plus any hypaware MCP server already available to you as MCP tools (a
`query_sql` / `graph_neighbors` tool in your toolset); the same server can appear both ways,
list it once). Present the options,
ask which one (or more) to profile, then proceed against the chosen source.

**Descriptive only.** Route every *action* out: "fan out more/less" and tooling go to
**hypaware-ai-improvement-report**, token waste to **hypaware-ai-spend-report**. Query mechanics
live in the **hypaware-query** skill; reuse hypaware-ai-spend-report's token spine for
any token figure. For descriptive who-used-what rollups (distinct sessions per
repo/model/tool/file), prefer the **hypaware-graph** skill, which reads them from the projected
graph instead of scanning messages; keep token figures on messages.

## Procedure
1. **Scope + coverage.** Distinct `gateway_id` (the unit; `user_id` is ~always null, so don't
   measure reach by it); window; coverage of `gateway_id`, token usage, and subagent provenance
   (`agent_id` / `is_sidechain` / `parent_thread_id`, transcript-enriched, may not survive
   ingest). Decide cost-capable vs volume-only, and which parallelism dimensions are real vs
   proxied (the `Task`-call proxy). State N; if it's effectively one gateway / dogfood, say so.
   **ALWAYS verify GitHub enrichment before deciding it's out of scope: probe, never assume.**
   A conditional ("if enriched…") obligates you to *test* the condition, not guess it. Run the
   probe every run: `hyp query sql "SELECT node_type, projector, count(*) AS n, max(first_seen)
   AS newest FROM node GROUP BY node_type, projector" --remote <SRC>` (and check `edge` exists via
   `hyp query status`). If a `github.t0` projector with `PullRequest` / `Review` nodes is present,
   **GitHub reach is IN SCOPE and MUST be computed in step 2**: record the node counts and the max
   `first_seen` per type as the graph's as-of date, and treat every reach figure as a floor (a stale
   projection undercounts). If the probe returns no `github.t0` / PR / Review nodes, state
   **"checked - no GitHub enrichment present"** explicitly. **Never write "not assessed" / "not
   queried" for reach**: that phrasing means you skipped the probe, which is the one thing this step
   forbids.
2. **Per-gateway utilization.** One row per gateway: volume (messages, sessions, active days,
   first/last seen), tokens + cache-read ratio `cache_read/(cache_read+input)`, then its focus:
   top models (+ `(unknown)`), tools (Bash dominance + top commands), repos, client
   (claude/codex), and 2–4 recurring work themes (sampled, redacted). Distill each into a
   one-line **focus label**. When the step-1 probe found `github.t0` enrichment, you **MUST** add
   each gateway's real *reach* from it: the repos and PRs its work actually landed in (`Session -at->
   Commit <-references- PullRequest`), and whether that work drew review (`... PullRequest <-on- Review
   <-submitted- Actor`); attribute sessions to a gateway/person via session `cwd` (`/Users/<name>`).
   This is footprint the messages cannot show and is not optional when the graph supports it. Keep it descriptive (route any "review
   more" action to hypaware-ai-improvement-report) and dated to the graph's freshness from step 1.
3. **Parallelism / fan-out.** Adoption (% conversations with ≥1 subagent, incl. the zero
   bucket); breadth (subagents per parent) and depth (`parent_thread_id` chains); concurrency
   (do subagent time-spans actually *overlap*, or is it serial?); cost split (token share main
   loop vs subagent). Read the payoff *descriptively*: fan-out vs tokens-to-resolution, and
   route the "fan out more/less" recommendation to hypaware-ai-improvement-report.

## Output - SAVE A SHORT MAIN FILE + ONE FILE PER SECTION
A **progressively-disclosed one-pager** is the deliverable: a reader can stop after the thesis
sentence, glance the key-numbers table, skim the findings, or follow any link into a detail
**section**, and each section is its own markdown file. Build the one-pager top-to-bottom so each
layer is shorter and more glanceable than the one it summarizes.

- **Main one-pager:** `hypaware-reports/<YYYY-MM-DD>-adoption-profile.md` (create the dir if
  needed). Dated so reports accumulate. Lay it out in exactly these blocks, separated by `---` rules:
  1. **Title + scope** - `# AI Adoption Profile`, then a `## <server/fleet> · <window>` subtitle
     (e.g. `## HYP_CENTRAL fleet · 30-day view`).
  2. **Thesis** - ONE **bold** sentence carrying the whole story: how many gateways are active,
     the busiest one + its focus, and the headline fan-out adoption %.
  3. **`### Key numbers`** - a small metric→readout table, ~4-6 rows, each one glanceable fact with
     no link (e.g. `**3 active gateways** | phil, brendan, kenny`; busiest-gateway share; % sessions
     using a subagent; % volume inside subagents; cost-capable vs volume-only). This is the ONLY
     table on the one-pager.
  4. **`## What this shows`** - 3-5 numbered findings, highest-signal first; each is a
     `### N. <headline>` followed by 2-3 plain-language sentences with **bold** numbers, then a
     single `[<section> →](<dir>/<file>.md)` link on its own line (e.g. adoption concentration, the
     busiest power-user, subagent adoption, concurrency consistency, distinct per-gateway identities).
  5. **`## Caveat`** - the single most important caveat in plain language + a `[caveats →]` link
     (for a transcript-only window: a volume-only profile, no cost/cache; note whether subagent
     identity survived ingest).
  6. **`## Report details`** - a one-line footer linking **every** section file written this run
     (not just the cited ones), so nothing is orphaned - e.g.
     `[scope & coverage](<dir>/scope-coverage.md) · [per-gateway utilization](<dir>/per-gateway-utilization.md) · [per-gateway focus](<dir>/per-gateway-focus.md) · [parallelism & fan-out](<dir>/parallelism-fan-out.md) · [payoff](<dir>/payoff.md) · [fleet view](<dir>/fleet-view.md) · [caveats](<dir>/caveats.md)`.
- **GitHub reach (where enriched):** the per-gateway-focus section file shows each gateway's repos
  and PRs reached, as of the graph's projection date from step 1 (a stale graph makes reach a floor,
  not an upper bound).
- **Section files are analysis, not inventory.** Each detail section is its own `<dir>/<file>.md`, held to the same standard as the one-pager: it argues one claim, opens with that takeaway, and ties every number to what it means for the reader. A section file that is only a stat table has failed - fold it back into the one-pager rather than shipping it as a page. Cut table narration ("how to read the table") and standing bookkeeping prose; compress source/window/method to a few lines.
- **No scope apologies (in any file).** Scope rules (what routes to which report) are authoring guidance, never report copy. Don't write "descriptive only", "no recommendations here", or routing disclaimers in the one-pager or any section file; state findings plainly, and where a sibling report owns the action a plain cross-link is enough.
- **Capture-health note:** if subagent provenance doesn't reach the server, the standing #1
  caveat is "subagent identity must survive ingest", run adoption off the sub-agent-invocation
  proxy (the tool calls that spawn sub-agents) and flag it.
