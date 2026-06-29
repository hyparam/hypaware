---
name: hypaware-ai-improvement-report
description: Analyze AI agent logs and generate a markdown report identifying additions or modifications to skills, subagents, and AGENTS.md/CLAUDE.md, to improve quality and efficiency of the AI agent performance.
---

# AI Improvement Review

Read how the team's agents actually behave in the logs, then propose the **additions and
edits to skills, subagents, and AGENTS.md/CLAUDE.md** that make them do **better work
(quality)** with **less wasted effort and spend**.

IMPORTANT: Don't assume which source to read — **ask first.** Enumerate every HypAware source
available — local logs, remote servers, and any attached hypaware MCP tools; the same server can
be attached more than one way, so list it once (see **hypaware-query** for how to discover them).
Present the options, ask which one (or more) to run the review against, then proceed against the
chosen source.
Query mechanics — plus the column/schema reference (which columns exist, the Claude-vs-Codex
differences, and what transcript backfill does and doesn't populate) — live in the
**hypaware-query** skill; read it first and don't assume a column is present or provider-agnostic.

Focus on these signals:

- **Repeated work** — work the team repeats successfully → package it once (skill / subagent).
- **Sticking points** — where agents get stuck or redo work (errors, loops, refusals,
  abandonment) → the missing or too-weak instruction that would prevent it (an AGENTS.md
  rule, or a skill).
- **Inefficiency** — expensive patterns (model over-spec, context bloat, low cache-read,
  retry loops) → the setup change that costs less (right-size the model in AGENTS.md / a
  subagent, a context-hygiene rule, a skill that avoids the redo).

## Procedure
1. **Footprint + basis.** Window; distinct contributors (gateways), repos, sessions;
   claude/codex mix. State N and breadth; flag if single-contributor.
2. **Scan the signals for possible improvements.** Work the three signals above; each turns
   up candidates. Note frequency (sessions, distinct gateways) and redact examples.
   - **Repeated work** — cluster sessions by shared-file overlap and tool-set signature into
     recurring kinds of work (reuse a recent `hypaware-reports/` *Leverage candidates*
     handoff if present). Flag parallelizable work done serially (little subagent use), and
     recurring asks / multi-step workflows / re-sent instructions in sampled prompts.
   - **Sticking points** — where agents got stuck or redid work, ranked by impact: failing
     tools (errors by tool), retry loops (same tool + same first argument ≥3×/session),
     refusals/truncations, abandoned costly sessions, repeatedly-violated conventions.
   - **Inefficiency** (reuse the spend spine) — model over-spec, context bloat, low cache-read
     ratio, redo loops.
3. **Collect, dedup, prioritize.** Gather the candidates into a list of possible
   improvements; drop anything an existing artifact already covers — a quick scan of the
   repo's `.claude/skills/`, subagents, and AGENTS.md/CLAUDE.md (the only repo read — every
   other signal is the logs), used to dedup and to mark each survivor **new** vs **edit to
   an existing artifact**. For each, suggest a likely form
   where one obviously fits — a **skill**, a **subagent**, or an **AGENTS.md/CLAUDE.md
   edit** (propose the concrete line(s) as a diff, not "consider documenting") — but don't
   force a mapping. Attach evidence (frequency/impact + distinct gateways + token prize) and
   rank by it.
   - **Size the token prize** off the deduped token spine (defined in **hypaware-query**). Give
     two numbers, kept distinct: **exposure (measured)** — tokens
     currently flowing through the issue (sum across a repeated cluster, or tokens in
     error/retry/abandoned turns) — and **est. saving (assumption)** only where the
     counterfactual is clean (cache-read ratio, model right-size). Both are floors — capture
     is partial; never present a saving as if it were measured.

## Output — SAVE A SHORT MAIN FILE + ONE FILE PER SECTION
A **progressively-disclosed one-pager** is the deliverable: a reader can stop after the
overview, skim the list of recommended changes, or follow any link into a detail
**section** — and each section is its own markdown file. Build the one-pager top-to-bottom so each
layer is shorter and more glanceable than the one it summarizes.

- **Main one-pager:** `hypaware-reports/<YYYY-MM-DD>-improvement-review.md` (create the dir if
  needed). Dated so reviews accumulate. Lay it out in exactly these blocks, separated by `---` rules:
  1. **Title + scope** — `# AI Improvement Review`, then a `## <server> · <window>` subtitle.
  2. **`## Overview`** — a heading (never open the page with a bare sentence), then ONE **bold**,
     plain-English sentence capturing the benefit of making these changes, plus optionally one short
     context sentence (what's already healthy, where the wins concentrate). No internal jargon —
     see the plain-language rule below.
  3. **`## Recommended changes`** — the heart of the page: a **numbered list of the improvements**,
     highest-leverage first, with **no separate key-numbers table**. **Lead each item with the
     problem, then the fix** — name what the agents keep getting wrong or re-doing first, then the
     change that solves it (never the reverse). Each item is short and self-contained:
     - **the problem**, in plain words (what's going wrong and how often);
     - **then the change** that fixes it, with its form (a **skill**, a **subagent**, or an
       **AGENTS.md/CLAUDE.md edit**), in one sentence;
     - the **single most relevant number** (its evidence or token prize, **bold**), next to the
       change it justifies, never in a detached table;
     - who it helps, in plain words (**everyone**, or one person by name);
     - a `[<section> →](<dir>/<file>.md)` link.
     **When several items point to the same section file, group them under one `### <subsection>`
     heading with a single link** rather than repeating the same `[… →]` link on each — e.g. put
     all the AGENTS.md edits under one `### AGENTS.md edits` subsection that links to
     `agents-md-edits.md` once.
  4. **`## Caveat`** — token prizes are floors and capture is partial, in plain language + a
     `[caveats →]` link.
  5. **`## Report details`** — a one-line footer linking **every** section file written this run (not
     just the cited ones), so nothing is orphaned — e.g.
     `[basis](<dir>/basis.md) · [improvements](<dir>/improvements.md) · [skill candidates](<dir>/skill-candidates.md) · [subagent candidates](<dir>/subagent-candidates.md) · [AGENTS.md edits](<dir>/agents-md-edits.md) · [caveats](<dir>/caveats.md)`.
- **Section files:** one markdown file per detail section, under a per-report folder
  `hypaware-reports/<YYYY-MM-DD>-improvement-review/` (e.g. `basis.md`, `improvements.md`,
  `skill-candidates.md`, `subagent-candidates.md`, `agents-md-edits.md`, `efficiency.md`,
  `caveats.md`). Write only the sections this run actually has, and link each from the relevant bullet.
  - **`improvements.md` (ranked table):** one row per improvement — **what** · **suggested form**
    (skill / subagent / AGENTS.md edit, where one fits) · **evidence** (recurs N× across G
    gateways, sticking-point impact) · **token prize** (exposure measured / est. saving, labeled)
    · **where it lands**. Highest-leverage first.
  - Other sections, each its own file: **Basis · Skill candidates · Subagent candidates (fan-out
    + roles) · AGENTS.md/CLAUDE.md edits · Efficiency → setup changes · Caveats** — `agents-md-edits.md`
    carries the proposed AGENTS.md lines verbatim. Each candidate is marked **new** or **edit to
    <artifact>**; don't list artifacts that aren't being changed.
- **Formatting — write for a human, not an LLM.** The one-pager stays a ~30-second read: thesis,
  then the numbered list of changes — no tables. **Ban internal jargon** a non-engineer wouldn't
  follow: don't write "package", "fan-out", "sidechain", "single-gateway"/"fleet-wide" — say what
  you mean ("turn the repeated PR-review steps into a reusable `/pr-review` skill so it isn't
  rebuilt by hand each time"; "affects everyone" / "just phil"). One sentence per change with its
  number beside it; keep the section files for the depth. In `agents-md-edits.md`, show AGENTS.md
  edits as real diffs/code blocks, not prose; **bold** the artifact type.
