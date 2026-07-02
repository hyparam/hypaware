---
name: hypaware-ai-improvement-report
description: Analyze AI agent logs and generate a markdown report identifying additions or modifications to skills, subagents, and AGENTS.md/CLAUDE.md, to improve quality and efficiency of the AI agent performance.
---

# AI Improvement Review

Read how the team's agents actually behave in the logs, then propose the **additions and
edits to skills, subagents, and AGENTS.md/CLAUDE.md** that make them do **better work
(quality)** with **less wasted effort and spend**.

IMPORTANT: Don't assume which logs to read: **ask first.** Start by listing the data sources
and let the user choose which to query: **local logs** (this machine's own recordings,
`hyp query sql …`, no `--remote`) and **each remote HypAware server** (every target from
`hyp remote list`, plus any hypaware MCP server already available to you as MCP tools (a
`query_sql` / `graph_neighbors` tool in your toolset); the same server can appear both ways,
list it once). Present the options,
ask which one (or more) to run the review against, then proceed against the chosen source.
Query mechanics live in the **hypaware-query** skill; read it first. For descriptive
who-used-what rollups (distinct sessions per repo/model/tool/file), prefer the **hypaware-graph**
skill: it reads relationships from the projected graph instead of scanning messages.

Focus on these signals:

- **Repeated work:** work the team repeats successfully → package it once (skill / subagent).
- **Sticking points:** where agents get stuck or redo work (errors, loops, refusals,
  abandonment) → the missing or too-weak instruction that would prevent it (an AGENTS.md
  rule, or a skill).
- **Inefficiency:** expensive patterns (model over-spec, context bloat, low cache-read,
  retry loops) → the setup change that costs less (right-size the model in AGENTS.md / a
  subagent, a context-hygiene rule, a skill that avoids the redo).

## Procedure
1. **Footprint + basis.** Window; distinct contributors (`gateway_id`), repos, sessions;
   claude/codex mix. State N and breadth; flag if single-contributor.
2. **Scan the signals for possible improvements.** Work the three signals above; each turns
   up candidates. Note frequency (sessions, distinct gateways) and redact examples.
   - **Repeated work:** cluster sessions by shared-file overlap and tool-set signature into
     recurring kinds of work (reuse a recent `hypaware-reports/` *Leverage candidates*
     handoff if present). Flag parallelizable work done serially (low `is_sidechain`, few
     `agent_id`), and recurring asks / multi-step workflows / re-sent instructions in
     sampled prompts + `system_text`.
   - **Sticking points:** where agents got stuck or redid work, ranked by impact: failing
     tools (`is_error` by `tool_name`), retry loops (same tool + first `tool_args` token
     ≥3×/session), refusals/truncations (stop-reason), abandoned costly sessions,
     repeatedly-violated conventions. Optional outcome lens where the graph is GitHub-enriched:
     work that never landed (sessions whose commits reach no `PullRequest`) or drew heavy review
     churn can corroborate a sticking point, but treat it as a proxy, not proof (unmerged or
     heavily-reviewed work is not necessarily bad).
   - **Inefficiency** (reuse the spend spine): model over-spec, context bloat (no
     `is_compact_summary`), low cache-read (`cache_read/(cache_read+input)`), redo loops.
3. **Collect, dedup, prioritize.** Gather the candidates into a list of possible
   improvements; drop anything an existing artifact already covers: a quick scan of the
   repo's `.claude/skills/`, subagents, and AGENTS.md/CLAUDE.md (the only repo read; every
   other signal is the logs), used to dedup and to mark each survivor **new** vs **edit to
   an existing artifact**. For each, suggest a likely form
   where one obviously fits: a **skill**, a **subagent**, or an **AGENTS.md/CLAUDE.md
   edit** (propose the concrete line(s) as a diff, not "consider documenting"), but don't
   force a mapping. Attach evidence (frequency/impact + distinct gateways + token prize) and
   rank by it.
   - **Size the token prize** off the spend spine (usage is one row per response, so a plain `SUM`
     over assistant `attributes.usage` rows is correct; no dedup needed, LLP 0035). Give two numbers, kept distinct: **exposure (measured)**: tokens
     currently flowing through the issue (sum across a repeated cluster, or tokens in
     error/retry/abandoned turns), and **est. saving (assumption)** only where the
     counterfactual is clean (cache-read ratio, model right-size). Both are floors; capture
     is partial; never present a saving as if it were measured.

## Output - SAVE A SHORT MAIN FILE + ONE FILE PER SECTION
A **progressively-disclosed one-pager** is the deliverable: a reader can stop after the thesis
sentence, glance the key-numbers table, skim the findings, or follow any link into a detail
**section**, and each section is its own markdown file. Build the one-pager top-to-bottom so each
layer is shorter and more glanceable than the one it summarizes.

- **Main one-pager:** `hypaware-reports/<YYYY-MM-DD>-improvement-review.md` (create the dir if
  needed). Dated so reviews accumulate. Lay it out in exactly these blocks, separated by `---` rules:
  1. **Title + scope** - `# AI Improvement Review`, then a `## <server/fleet> · <window>` subtitle.
  2. **Thesis** - ONE **bold** sentence: "Create/edit these N things and what it will improve."
  3. **`### Key numbers`** - a small metric→readout table, ~4-6 rows, each one glanceable fact with
     no link (# improvements, new-vs-edit split, the single biggest token prize, the basis:
     gateways / sessions / repos). This is the ONLY table on the one-pager.
  4. **`## What this shows`** - 3-5 numbered findings = the top improvements, highest-leverage
     first; each is a `### N. <headline>` naming **what + its form** (skill / subagent / AGENTS.md
     edit), followed by 2-3 plain-language sentences with the evidence and the **bold** token prize,
     then a single `[<section> →](<dir>/<file>.md)` link on its own line. Show AGENTS.md edits as
     real diffs/code blocks in their section file, not prose.
  5. **`## Caveat`** - token prizes are floors and capture is partial, in plain language + a
     `[caveats →]` link.
  6. **`## Report details`** - a one-line footer linking **every** section file written this run
     (not just the cited ones), so nothing is orphaned - e.g.
     `[basis](<dir>/basis.md) · [skill candidates](<dir>/skill-candidates.md) · [subagent candidates](<dir>/subagent-candidates.md) · [AGENTS.md edits](<dir>/agents-md-edits.md) · [efficiency → setup](<dir>/efficiency-setup.md) · [caveats](<dir>/caveats.md)`.
- **Section files are analysis, not inventory.** Each detail section is its own `<dir>/<file>.md`, held to the same standard as the one-pager: it argues one claim, opens with that takeaway, and ties every number to what it means for the reader. A section file that is only a stat table has failed - fold it back into the one-pager rather than shipping it as a page. Cut table narration ("how to read the table") and standing bookkeeping prose; compress source/window/method to a few lines.
- **No scope apologies (in any file).** Scope rules (what routes to which report) are authoring guidance, never report copy. Don't write "descriptive only", "no recommendations here", or routing disclaimers in the one-pager or any section file; state findings plainly, and where a sibling report owns the action a plain cross-link is enough.
