---
name: hypaware-ai-adoption-report
description: AI Adoption Profile for a HypAware server — descriptive "who's using the fleet and how": per-gateway utilization (volume + focus — top models, tools, repos, themes) and parallelism/fan-out (multi-agent adoption, concurrency, main-vs-subagent split, payoff).
---

# AI Adoption Profile

The one **descriptive** report on *who's using the fleet and how* — no actions, just a clear
picture. Two lenses over one window:

- **Utilization** — per `gateway_id` (≈ one machine/user): *how much* (messages, sessions,
  active days, tokens, cache-read ratio) and *what it's focused on* (top models, tools, repos,
  work themes).
- **Parallelism / fan-out** — *how sophisticated*: multi-agent adoption, fan-out breadth/depth,
  true concurrency vs serial, the main-loop-vs-subagent token split, and whether fan-out appears
  to earn its cost.

IMPORTANT: Don't assume which logs to read — **ask first.** Start by listing the data sources
and let the user choose which to query: **local logs** (this machine's own recordings —
`hyp query sql …`, no `--remote`) and **each remote HypAware server** (every target from
`hyp remote list`, plus any hypaware MCP server already available to you as MCP tools (a
`query_sql` / `graph_neighbors` tool in your toolset); the same server can appear both ways —
list it once). Present the options,
ask which one (or more) to profile, then proceed against the chosen source.

**Descriptive only** — route every *action* out: "fan out more/less" and tooling go to
**hypaware-ai-improvement-report**, token waste to **hypaware-ai-spend-report**. Query mechanics
live in the **hypaware-query** skill; reuse hypaware-ai-spend-report's deduped token spine for
any token figure.

## Procedure
1. **Scope + coverage.** Distinct `gateway_id` (the unit — `user_id` is ~always null, so don't
   measure reach by it); window; coverage of `gateway_id`, token usage, and subagent provenance
   (`agent_id` / `is_sidechain` / `parent_thread_id` — transcript-enriched, may not survive
   ingest). Decide cost-capable vs volume-only, and which parallelism dimensions are real vs
   proxied (the `Task`-call proxy). State N; if it's effectively one gateway / dogfood, say so.
2. **Per-gateway utilization.** One row per gateway: volume (messages, sessions, active days,
   first/last seen), tokens + cache-read ratio `cache_read/(cache_read+input)`, then its focus —
   top models (+ `(unknown)`), tools (Bash dominance + top commands), repos, client
   (claude/codex), and 2–4 recurring work themes (sampled, redacted). Distill each into a
   one-line **focus label**. Use the activity graph for structural focus (Session→Repo/PR via
   GitHub enrichment) where projected.
3. **Parallelism / fan-out.** Adoption (% conversations with ≥1 subagent, incl. the zero
   bucket); breadth (subagents per parent) and depth (`parent_thread_id` chains); concurrency
   (do subagent time-spans actually *overlap*, or is it serial?); cost split (token share main
   loop vs subagent). Read the payoff *descriptively* — fan-out vs tokens-to-resolution — and
   route the "fan out more/less" recommendation to hypaware-ai-improvement-report.

## Output — SAVE A MARKDOWN FILE
- **Path:** `hypaware-reports/<YYYY-MM-DD>-adoption-profile.md` (create the dir if needed).
  Dated so reports accumulate.
- **Bottom line (1 sentence):** how many gateways are active, the busiest one and its focus, and
  the headline fan-out adoption %.
- **Per-gateway profile (sortable table):** one row per gateway — **gateway** · **volume**
  (messages / sessions) · **tokens** · **cache-read %** · **fan-out** (adoption + main-vs-subagent
  split) · **focus label**. Busiest first — this table is the spine.
- **Then the detail**, in these sections: **Scope & coverage · Per-gateway utilization ·
  Per-gateway focus · Parallelism & fan-out · Payoff (descriptive) · Fleet view · Caveats**.
- **Formatting (human-readable):** open each section with its takeaway; **bold** headline
  numbers; one sortable footprint table as the centerpiece; keep the bottom line + table a
  ~1-minute read.
- **Capture-health note:** if subagent provenance doesn't reach the server, the standing #1
  caveat is "subagent identity must survive ingest" — run adoption off the sub-agent-invocation
  proxy (the tool calls that spawn sub-agents) and flag it.
