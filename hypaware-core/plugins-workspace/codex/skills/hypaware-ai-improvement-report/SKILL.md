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
Query mechanics are step 0 of the procedure — a mandatory read, not a reference.

Focus on these signals:

- **Repeated work:** work the team repeats successfully → package it once (skill / subagent).
- **Sticking points:** where agents get stuck or redo work (errors, loops, refusals,
  abandonment) → the missing or too-weak instruction that would prevent it (an AGENTS.md
  rule, or a skill).
- **Inefficiency:** expensive patterns (model over-spec, context bloat, low cache-read,
  retry loops) → the setup change that costs less (right-size the model in AGENTS.md / a
  subagent, a context-hygiene rule, a skill that avoids the redo).

## Procedure
0. **Load query mechanics BEFORE the first query — skills, not memory.** After the user picks a
   source and before any `hyp query sql`, read the **hypaware-query** skill (invoke it or Read
   its SKILL.md), and the **hypaware-graph** skill if `hyp query status` lists `node`/`edge`
   datasets. Memory notes from past runs do NOT substitute — stale notes have cost real runs
   failed queries and server crashes (a phantom "100-row output cap"; message-table `cwd` scans
   that 504'd then OOM'd the prod server). Route by shape, per hypaware-query's "when the graph
   answers it cheaper" boundary: entity/connection questions go to the graph's tiny `node`/`edge`
   tables — sessions per repo/model/tool/file, **skill and program rollups (graph-only facets —
   SQL reconstructions measurably disagree with the projection)**, client mix, shared-file
   clustering via `touched` edges, and gateway→person attribution (`min/max(session_id)` per
   gateway from messages — an ID-only aggregate — then look those session_ids up in graph
   Session nodes' `props.cwd`). The messages table is for per-message measures only — token
   sums (the spend spine), `is_error`/retry loops, stop-reasons, ordering, prompt sampling —
   date-sliced to server-sized ranges, and **never GROUP BY / DISTINCT / row-fetch wide content
   columns (`cwd`, `content_text`) at scale** (that query shape kills servers). Capture stderr
   and check it even on success — truncation and server-cap notices land there. If a query
   fails, come back to this step; don't iterate on the failing SQL.
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
sentence, skim the numbered change list, or follow any link into a detail **section**, and each
section is its own markdown file. Build the one-pager top-to-bottom so each layer is shorter and
more glanceable than the one it summarizes.

**Report language (applies to every file).** The reader may be a supervisor with no HypAware
knowledge. Plain literal language only: no pipeline vocabulary (ingest, sidechain, part,
projection), no metaphors or report-coined shorthand ("marathon sessions" was flagged as vague -
write "sessions kept open across days re-read their entire history each morning"); coined names
(a harness, an internal tool) get a one-line gloss at first mention on each page; when a skill or
tool is named as a fix, add one clause saying what it literally does ("`/handoff` writes a short
end-of-day note of where the work stands so the next day starts a fresh session"), never just its
name; absolute dates, never "last week". Findings equip, never direct: state who/size/driver/what
a change returns, never "ask X" / "talk to Y". In section files, any list item carrying several
facts is a bold topic line + 2-3 short sub-bullets, not a multi-sentence prose bullet.

- **Main one-pager:** `hypaware-reports/<YYYY-MM-DD>-improvement-review.md` (create the dir if
  needed). Dated so reviews accumulate. It is a **terse bullet brief** (user feedback 2026-07-14:
  dense multi-clause sentences and prose paragraphs were both rejected as hard to read). Its only
  headings are **Proposed changes / Data limitations / Supporting analysis** - standard
  business-report vocabulary, never coinages like "What this shows" / "Key numbers" / "Report
  details", and no metrics or findings section (the evidence rides inside the change list). Blocks:
  1. **Title + scope** - an eyebrow line `<server/fleet> · <window>`, then `# AI Improvement Review`.
  2. **Thesis** - one SHORT bold sentence (the create/edit-these-N-things claim). If it needs
     supporting clauses, put them in 2-3 plain sub-bullets under it, never packed into the sentence.
  3. **`## Proposed changes`** - the changes themselves lead, NOT a metrics block, and there is
     NO separate findings/evidence section (user feedback 2026-07-14: a Key findings section
     alongside the change list is redundant - the strongest evidence rides with each change). A
     **numbered list**, one item per improvement, highest-leverage first, each exactly:
     - the **what**: a short bold imperative naming ONE action (mechanics in parens after the
       bold), nothing else on the line. Never join two actions with ";" or "+" in the bold line
       (user feedback: "sounds like two suggestions, unclear") - when a change pairs a skill
       move with a companion AGENTS.md rule, the bold names the primary action and the companion
       rides in a sub-bullet;
     - sub-bullet 1, the **why**: one short sentence with the token prize or headline number;
     - sub-bullet 2, the **evidence**: one short line with the 1-2 strongest supporting numbers,
       ending with the section link.
     Never pack what+why+prize into the bold line (rejected as too long). Close with one line
     linking the ready-to-apply artifacts (which live in section files, not here). No tables on
     the one-pager.
     **Every proposed change ships its artifact in its section file** (user feedback 2026-07-14
     - not only AGENTS.md diffs): AGENTS.md/CLAUDE.md edit → a real diff; new skill or subagent
     → the full proposed file (frontmatter + body) in a code block, ready to save; move of an
     existing artifact → concrete source → destination paths, flagging any machine-specific
     content to review (if the source file lives on another machine, say so - name the move,
     don't fake the file); tool/config change → the exact proposed text.
  4. **`## Data limitations`** - ~3 bullets: the basis (gateways / sessions / window), token
     prizes are floors, capture is partial, plus any window-specific data-quality incident + a
     `[caveats]` link.
  5. **`## Supporting analysis`** - a one-line footer linking **every** section file written this
     run (not just the cited ones), so nothing is orphaned - e.g.
     `[basis](<dir>/basis.md) · [skill candidates](<dir>/skill-candidates.md) · [subagent candidates](<dir>/subagent-candidates.md) · [AGENTS.md edits](<dir>/agents-md-edits.md) · [efficiency → setup](<dir>/efficiency-setup.md) · [caveats](<dir>/caveats.md)`.
- **Section files are analysis, not inventory.** Each detail section is its own `<dir>/<file>.md`, held to the same standard as the one-pager: it argues one claim, opens with that takeaway, and ties every number to what it means for the reader. A section file that is only a stat table has failed - fold it back into the one-pager rather than shipping it as a page. Cut table narration ("how to read the table") and standing bookkeeping prose; compress source/window/method to a few lines.
- **No scope apologies (in any file).** Scope rules (what routes to which report) are authoring guidance, never report copy. Don't write "descriptive only", "no recommendations here", or routing disclaimers in the one-pager or any section file; state findings plainly, and where a sibling report owns the action a plain cross-link is enough.
