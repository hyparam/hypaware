---
name: hypaware-ai-adoption-report
description: AI Adoption Profile for a HypAware server — descriptive "who's using the fleet and how": per-gateway utilization (volume + focus — top models, tools, repos, themes) and parallelism/fan-out (multi-agent adoption, concurrency, main-vs-subagent split, payoff).
---

# AI Adoption Profile

The one **descriptive** report on *who's using the fleet and how* — no actions, just a clear
picture. Two lenses over one window:

- **Utilization** — per gateway (≈ one machine/user): *how much* (messages, sessions,
  active days, tokens, cache-read ratio) and *what it's focused on* (top models, tools, repos,
  work themes).
- **Parallelism / fan-out** — *how sophisticated*: multi-agent adoption, fan-out breadth/depth,
  true concurrency vs serial, the main-loop-vs-subagent token split, and whether fan-out appears
  to earn its cost.

IMPORTANT: Don't assume which source to read — **ask first.** Enumerate every HypAware source
available — local logs, remote servers, and any attached hypaware MCP tools; the same server can
be attached more than one way, so list it once (see **hypaware-query** for how to discover them).
Present the options, ask which one (or more) to profile, then proceed against the chosen source.

**Descriptive only** — route every *action* out: "fan out more/less" and tooling go to
**hypaware-ai-improvement-report**, token waste to **hypaware-ai-spend-report**. Query mechanics —
plus the column/schema reference (which columns exist, the Claude-vs-Codex differences, and what
transcript backfill does and doesn't populate) — live in the **hypaware-query** skill; read it
first and don't assume a column is present or provider-agnostic. Reuse hypaware-ai-spend-report's
deduped token spine for any token figure.

## Procedure
1. **Scope + coverage.** Distinct gateways (the unit — user-level reach isn't available, so don't
   measure reach that way); window; coverage of gateways, token usage, and subagent provenance
   (see **hypaware-query**). Decide cost-capable vs volume-only, and which parallelism dimensions
   are real vs proxied (the subagent-spawn tool-call proxy). State N; if it's effectively one
   gateway / dogfood, say so.
2. **Per-gateway utilization.** One row per gateway: volume (messages, sessions, active days,
   first/last seen), tokens + cache-read ratio, then its focus — top models (with an unknown
   bucket), tools (Bash dominance + top commands), repos, client (claude/codex), and 2–4 recurring
   work themes (sampled, redacted). Distill each into a one-line **focus label**. Use the activity
   graph for structural focus (sessions → repos/PRs) where projected.
3. **Parallelism / fan-out.** Adoption (% conversations with ≥1 subagent, incl. the zero
   bucket); breadth (subagents per parent) and depth (delegation chains); concurrency
   (do subagent time-spans actually *overlap*, or is it serial?); cost split (token share main
   loop vs subagent). Read the payoff *descriptively* — fan-out vs tokens-to-resolution — and
   route the "fan out more/less" recommendation to hypaware-ai-improvement-report.

## Output — SAVE A SHORT MAIN FILE + ONE FILE PER SECTION
A **progressively-disclosed one-pager** is the deliverable: a reader can stop after the
overview, skim what we found, or follow any link into a detail
**section** — and each section is its own markdown file. Build the one-pager top-to-bottom so each
layer is shorter and more glanceable than the one it summarizes.

- **Main one-pager:** `hypaware-reports/<YYYY-MM-DD>-adoption-profile.md` (create the dir if
  needed). Dated so reports accumulate. Lay it out in exactly these blocks, separated by `---` rules:
  1. **Title + scope** — `# AI Adoption Profile`, then a `## <server> · <window>` subtitle
     (e.g. `## HYP_CENTRAL · 30-day view`).
  2. **`## Overview`** — a heading (never open the page with a bare sentence), then ONE **bold**,
     plain-English sentence carrying the whole story: how many people are using it, who the busiest
     is + what they focus on, and the one headline number (e.g. the share of sessions that use
     subagents). No jargon — see the plain-language rule below.
  3. **`## What we found`** — 3–5 numbered findings, highest-signal first, with **no separate
     key-numbers table** (fold each headline number into the finding it belongs to). Each is a
     `### N. <plain headline>` followed by 1–2 plain-language sentences with the **bold** number
     inline, then a single `[<section> →](<dir>/<file>.md)` link on its own line (e.g. adoption is
     concentrated, the busiest power-user, subagent use, how consistent the parallel work is, each
     person's distinct focus). Don't repeat the same `[… →]` link across findings — if several
     share a section file, group them under one `### <subsection>` heading with a single link.
  4. **`## Caveat`** — the single most important caveat in plain language + a `[caveats →]` link
     (for a transcript-only window: a volume-only profile, no cost/cache; note whether subagent
     identity survived ingest).
  5. **`## Report details`** — a one-line footer linking **every** section file written this run (not
     just the cited ones), so nothing is orphaned — e.g.
     `[scope & coverage](<dir>/scope-coverage.md) · [per-gateway utilization](<dir>/per-gateway-utilization.md) · [per-gateway focus](<dir>/per-gateway-focus.md) · [parallelism & fan-out](<dir>/parallelism-fan-out.md) · [payoff](<dir>/payoff.md) · [caveats](<dir>/caveats.md)`.
- **Section files:** one markdown file per detail section, under a per-report folder
  `hypaware-reports/<YYYY-MM-DD>-adoption-profile/` (e.g. `scope-coverage.md`,
  `per-gateway-utilization.md`, `per-gateway-focus.md`, `parallelism-fan-out.md`, `payoff.md`,
  `fleet-view.md`, `caveats.md`). Write only the sections this run actually has, and link each
  from the relevant bullet.
  - **`per-gateway-utilization.md` (sortable table):** one row per gateway — **gateway** ·
    **volume** (messages / sessions) · **tokens** · **cache-read %** · **fan-out** (adoption +
    main-vs-subagent split) · **focus label**. Busiest first — this table is the spine.
  - Other sections, each its own file: **Scope & coverage · Per-gateway utilization · Per-gateway
    focus · Parallelism & fan-out · Payoff (descriptive) · Fleet view · Caveats**.
- **Formatting — write for a human, not an LLM.** The one-pager stays a ~30-second read: thesis,
  then a short numbered list of findings with the key number inline — **no tables**. **Ban internal
  jargon** a non-engineer wouldn't follow (don't write "fan-out", "sidechain",
  "single-gateway"/"fleet-wide"; say "subagent use", "just phil", "all the users"). Push every table
  into the section files; open each section file with its takeaway; **bold** headline numbers; the
  sortable footprint table is the centerpiece of `per-gateway-utilization.md`.
- **Capture-health note:** if subagent provenance doesn't reach the server, the standing #1
  caveat is "subagent identity must survive ingest" — run adoption off the sub-agent-invocation
  proxy (the tool calls that spawn sub-agents) and flag it.
