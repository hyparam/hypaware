---
name: hypaware-ai-improvement-report
description: Analyze AI agent logs and generate a markdown report identifying additions or modifications to skills, subagents, and AGENTS.md/CLAUDE.md, to improve quality and efficiency of the AI agent performance.
---

# AI Improvement Review

Read how the team's agents actually behave in the logs, then propose the **additions and
edits to skills, subagents, and AGENTS.md/CLAUDE.md** that make them do **better work
(quality)** with **less wasted effort and spend**.

IMPORTANT: Don't assume which logs to read — **ask first.** Start by listing the data sources
and let the user choose which to query: **local logs** (this machine's own recordings —
`hyp query sql …`, no `--remote`) and **each remote HypAware server** (every target from
`hyp remote list`, plus any hypaware MCP server already available to you as MCP tools (a
`query_sql` / `graph_neighbors` tool in your toolset); the same server can appear both ways —
list it once). Present the options,
ask which one (or more) to run the review against, then proceed against the chosen source.
Query mechanics live in the **hypaware-query** skill; read it first.

Focus on these signals:

- **Repeated work** — work the team repeats successfully → package it once (skill / subagent).
- **Sticking points** — where agents get stuck or redo work (errors, loops, refusals,
  abandonment) → the missing or too-weak instruction that would prevent it (an AGENTS.md
  rule, or a skill).
- **Inefficiency** — expensive patterns (model over-spec, context bloat, low cache-read,
  retry loops) → the setup change that costs less (right-size the model in AGENTS.md / a
  subagent, a context-hygiene rule, a skill that avoids the redo).

## Procedure
1. **Footprint + basis.** Window; distinct contributors (`gateway_id`), repos, sessions;
   claude/codex mix. State N and breadth; flag if single-contributor.
2. **Scan the signals for possible improvements.** Work the three signals above; each turns
   up candidates. Note frequency (sessions, distinct gateways) and redact examples.
   - **Repeated work** — cluster sessions by shared-file overlap and tool-set signature into
     recurring kinds of work (reuse a recent `hypaware-reports/` *Leverage candidates*
     handoff if present). Flag parallelizable work done serially (low `is_sidechain`, few
     `agent_id`), and recurring asks / multi-step workflows / re-sent instructions in
     sampled prompts + `system_text`.
   - **Sticking points** — where agents got stuck or redid work, ranked by impact: failing
     tools (`is_error` by `tool_name`), retry loops (same tool + first `tool_args` token
     ≥3×/session), refusals/truncations (stop-reason), abandoned costly sessions,
     repeatedly-violated conventions.
   - **Inefficiency** (reuse the spend spine) — model over-spec, context bloat (no
     `is_compact_summary`), low cache-read (`cache_read/(cache_read+input)`), redo loops.
3. **Collect, dedup, prioritize.** Gather the candidates into a list of possible
   improvements; drop anything an existing artifact already covers — a quick scan of the
   repo's `.claude/skills/`, subagents, and AGENTS.md/CLAUDE.md (the only repo read — every
   other signal is the logs), used to dedup and to mark each survivor **new** vs **edit to
   an existing artifact**. For each, suggest a likely form
   where one obviously fits — a **skill**, a **subagent**, or an **AGENTS.md/CLAUDE.md
   edit** (propose the concrete line(s) as a diff, not "consider documenting") — but don't
   force a mapping. Attach evidence (frequency/impact + distinct gateways + token prize) and
   rank by it.
   - **Size the token prize** off the spend spine (deduped `max()` per `message_id`; a plain
     `SUM` overcounts ~3×). Give two numbers, kept distinct: **exposure (measured)** — tokens
     currently flowing through the issue (sum across a repeated cluster, or tokens in
     error/retry/abandoned turns) — and **est. saving (assumption)** only where the
     counterfactual is clean (cache-read ratio, model right-size). Both are floors — capture
     is partial; never present a saving as if it were measured.

## Output — SAVE A MARKDOWN FILE
- **Path:** `hypaware-reports/<YYYY-MM-DD>-improvement-review.md` (create the dir
  if needed). Dated so reviews accumulate.
- **Bottom line (1 sentence):** "Create/edit these N things and what it will improve.".
- **Improvements (ranked table):** one row per improvement — **what** · **suggested form**
  (skill / subagent / AGENTS.md edit, where one fits) · **evidence** (recurs N× across G
  gateways, sticking-point impact) · **token prize** (exposure measured / est. saving,
  labeled) · **where it lands**. Highest-leverage first.
- **Then the detail**, in these sections: **Basis · Skill candidates · Subagent candidates
  (fan-out + roles) · AGENTS.md/CLAUDE.md edits · Efficiency → setup changes · Caveats** —
  plus the proposed AGENTS.md lines verbatim. Each candidate is marked **new** or **edit to
  <artifact>**; don't list artifacts that aren't being changed.
- **Formatting (human-readable):** every candidate states its evidence inline; show
  AGENTS.md edits as real diffs/code blocks, not prose; **bold** the artifact type; keep
  it a ~1-minute read.
