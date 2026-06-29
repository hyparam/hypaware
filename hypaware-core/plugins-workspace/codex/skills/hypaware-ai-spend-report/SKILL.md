---
name: hypaware-ai-spend-report
description: AI Spend Review for a HypAware server — where tokens go (by user/repo/model/gateway), what work they go on (graph-clustered), and how to spend less (waste scorecard + cost levers). Deduped token volume, never dollars. Saves a dated report under hypaware-reports/; first asks which HypAware source to query (local logs or a remote server) via the hypaware-query skill.
---

# AI Spend Review

Where the team's tokens go, on what work, and how to spend less — read off one deduped token
spine. One story in three moves: **where it goes** (by user / repo / model / gateway, over
time), **on what work** (sessions clustered into recurring work-types, sized by tokens), and
**how to spend less** (a waste scorecard + ranked cost levers).

IMPORTANT: Don't assume which source to read — **ask first.** Enumerate every HypAware source
available — local logs, remote servers, and any attached hypaware MCP tools; the same server can
be attached more than one way, so list it once (see **hypaware-query** for how to discover them).
Present the options, ask which one (or more) to run the review against, then proceed against the
chosen source.

**Tokens, never dollars** — capture is partial, so stop at token volume and behavioral proxies.
Query mechanics (remote access, date-pruning the query timeout, the SQL dialect, sampling) and the
column/schema reference (which columns exist, the Claude-vs-Codex differences, and what transcript
backfill does and doesn't populate) live in the **hypaware-query** skill; read it first and don't
assume a column is present or provider-agnostic.

**Every token figure comes off one canonical deduped token spine** — dedup per message, the four
token types kept split (cache-read is usually the bulk; output the scarce slice). The spine, the
dedup, and the per-provider token keys are defined once in the **hypaware-query** skill; reconcile
every breakdown to it and don't re-derive the math here.

## Procedure
1. **Coverage + footprint.** Window; usage coverage, model coverage (token-weighted), user/repo
   coverage; distinct gateways, sessions, claude/codex mix. Attribute by gateway (≈ one
   machine/user; user-level attribution isn't available — see **hypaware-query**) and always show
   an explicit **unattributed** row. State N; if it's a dogfood window, say so. If usage is thin,
   fall back to behavioral proxies (turns, tool calls, length), labeled as estimates.
2. **Where it goes + on what work.** Slice the spine by user / repo / model (with an explicit
   unknown bucket) / gateway with shares, plus trends (by week, WoW deltas vs the last report) and
   top-spend outliers. Then cluster sessions into recurring **work-types** — shared-file overlap
   for code work, tool-set signature for no-file work (context graph if projected, else SQL) —
   and size each by deduped tokens.
3. **How to spend less.** Score the waste — the cache-read ratio (the biggest lever — feature it),
   retry loops, abandoned costly sessions, model over-spec, context bloat — and turn the top few
   into ranked cost levers, each with an estimated weekly token saving. Hand the expensive
   recurring work-types to **hypaware-ai-improvement-report** as packaging
   candidates (surface them; don't build them here).

## Output — SAVE A SHORT MAIN FILE + ONE FILE PER SECTION
A **progressively-disclosed one-pager** is the deliverable: a reader can stop after the
overview, skim what we found, or follow any link into a detail
**section** — and each section is its own markdown file. Build the one-pager top-to-bottom so each
layer is shorter and more glanceable than the one it summarizes.

- **Main one-pager:** `hypaware-reports/<YYYY-MM-DD>-spend-review.md` (create the dir if needed).
  Dated so reviews accumulate. Lay it out in exactly these blocks, separated by `---` rules:
  1. **Title + scope** — `# AI Spend Review`, then a `## <server> · <window>` subtitle.
  2. **`## Overview`** — a heading (never open the page with a bare sentence), then ONE **bold**,
     plain-English sentence: total tokens this window, the trend vs the last report (▲/▼ %), and the
     single biggest driver. No jargon — see the plain-language rule below.
  3. **`## What we found`** — 3–5 numbered findings, highest-leverage first, with **no separate
     key-numbers table** (fold each headline number into the finding it belongs to). Each is a
     `### N. <plain headline>` followed by 1–2 plain-language sentences with the **bold** number
     inline, then a single `[<section> →](<dir>/<file>.md)` link on its own line (where the tokens
     go, on what work, the biggest waste lever, the top cost action). Don't repeat the same
     `[… →]` link across findings — if several share a section file, group them under one
     `### <subsection>` heading with a single link.
  4. **`## Caveat`** — tokens-never-dollars and partial capture, in plain language + a `[caveats →]` link.
  5. **`## Report details`** — a one-line footer linking **every** section file written this run (not
     just the cited ones), so nothing is orphaned — e.g.
     `[coverage](<dir>/coverage.md) · [allocation](<dir>/allocation.md) · [trends](<dir>/trends.md) · [work-types](<dir>/work-types.md) · [waste scorecard](<dir>/waste-scorecard.md) · [cost actions](<dir>/cost-actions.md) · [caveats](<dir>/caveats.md)`.
- **Section files:** one markdown file per detail section, under a per-report folder
  `hypaware-reports/<YYYY-MM-DD>-spend-review/` (e.g. `coverage.md`, `allocation.md`, `trends.md`,
  `outliers.md`, `work-types.md`, `waste-scorecard.md`, `cost-actions.md`, `caveats.md`). Write
  only the sections this run actually has findings for, and link each from the relevant bullet.
  - **`cost-actions.md` (ranked table):** one row per lever — **action** · **evidence**
    (tokens/share + cause) · **est. weekly saving** · **where it lands**. Highest-saving first.
  - Other sections, each its own file: **Coverage & footprint · Total spend (4 token types) ·
    Allocation (user / repo / model / gateway) · Trends · Outliers · Spend by work-type · Waste
    scorecard · Leverage candidates (handoff to hypaware-ai-improvement-report) · Caveats**.
- **Formatting — write for a human, not an LLM.** The one-pager stays a ~30-second read: thesis,
  then a short numbered list of findings with the key number inline — **no tables**. **Ban internal
  jargon** a non-engineer wouldn't follow; say what you mean. Push every table into the section
  files; open each section file with its one-sentence takeaway, then the table; **bold** headline
  numbers; split the four token types (never collapse them).
