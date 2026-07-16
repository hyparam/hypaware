---
name: hypaware-ai-usage-report
description: Team AI Usage Review for a HypAware server — a team improvement report written to be shared in the open, that engineers and supervisors both enjoy reading. Supervisors (eng manager, lead, CTO — no HypAware knowledge assumed) get the overview — how much AI the team uses and what it costs in tokens, what the work is and whether it pays off, which way it's trending; engineers get section detail they can act on, ending in ranked improvements (cost levers plus skill/subagent/AGENTS.md changes) with estimated weekly token savings and ready-to-apply artifacts on a dedicated proposed-changes page — one skill, one report, with the changes list as its own linked page. Findings attach to patterns and defaults, never person-rankings; granularity scales with team size. Token volume, never dollars. Saves a dated report under hypaware-reports/; first asks which HypAware source to query (local logs or a remote server) via the hypaware-query skill. Supersedes hypaware-ai-adoption-report, hypaware-ai-spend-report, and hypaware-ai-improvement-report — run this instead of any of them.
---

# Team AI Usage Review

Your goal: write a report answering these primary questions, with enough high-level
overview for a supervisor to quickly understand the overarching key points and enough
specific detail in each section to be sent to the relevant engineers. It is a **team
improvement tool, not a monitoring tool** — something both groups enjoy reading and use
to make the company better.

1. **How much is the team using AI, and where does it go?** — adoption breadth and
   spread (how many people, how evenly), and allocation by repo / model / person-or-team
   at whatever grain the team's size supports, with cache health explaining where the
   bill comes from.
2. **What does the work look like, what does each kind cost, and is it paying off?** —
   recurring work-types sized by their share of the token bill, multi-agent fan-out and
   whether it earns its token cost, habits worth spreading (credited to the people who
   have them), code that actually landed (GitHub reach, where enriched).
3. **Which way is it trending?** — weekly volume AND token spend, deltas vs the last
   review, where the bill is concentrating, top-spend outlier sessions described by the
   work they were doing.
4. **What should change?** — ranked improvements, each with an estimated weekly token
   saving: cost levers (cache reuse, session hygiene, model right-sizing) and packaging
   moves (skills, subagents, AGENTS.md/CLAUDE.md edits) mined from repeated work,
   sticking points, and the waste the first three sections surfaced — each shipped as
   a ready-to-apply artifact in its section file. Changes attach to workflows,
   defaults, and tooling — never to individuals.

## Audience contract (enforce it everywhere)

Two readers, one shared-in-the-open report: the supervisor (no HypAware knowledge;
reads the brief) and the engineers (should recognize their own workflows in the
sections and find something worth changing).

- **No jargon.** Explain any term the report can't avoid (cache-read, subagent) in one
  plain line at first use, and say what a tool named as a fix does. Describe behavior
  literally — no metaphors or coined shorthand.
- **Specific time ranges.** Absolute dates ("07-09 → 07-14"), never "this week" or
  "final week".
- **Findings, not instructions.** State the pattern, its size, and what a change would
  return — never "ask X" / "talk to Y". Proposed changes name the artifact or default
  to alter, not a conversation to have.
- **Comparisons over absolutes.** Lead with shares, trends vs the last review, and
  spread across the team — raw token counts mean nothing alone.
- **Tokens, never dollars.** Capture is partial, so stop at token volume; say so once
  in the caveat, not in every section.

IMPORTANT: Don't assume which logs to read: **ask first.** Start by listing the data
sources and let the user choose which to query: **local logs** (this machine's own
recordings, `hyp query sql …`, no `--remote`) and **each remote HypAware server** (every
target from `hyp remote list`, plus any hypaware MCP server already available to you as
MCP tools (a `query_sql` / `graph_neighbors` tool in your toolset); the same server can
appear both ways, list it once). Present the options, ask which one (or more) to review,
then proceed against the chosen source.

## Token math (get this right; every breakdown reconciles to it)

Usage is in `attributes.usage` (NOT `raw_frame`): `input_tokens`, `output_tokens`,
`cache_read_tokens`, `cache_write_tokens` (+ `reasoning_tokens` for Codex). Usage rides
exactly one row per response (the last assistant part; non-carrier parts are null), so a
plain `SUM` over assistant rows is correct with no dedup (the one-carrier rule, LLP 0035);
`input_tokens` is net of cache, so it never double-counts. Report the four types
separately (cache-read is usually the bulk; output the scarce slice).

```sql
SELECT
  sum(CAST(JSON_EXTRACT(attributes,'$.usage.input_tokens')       AS BIGINT)) t_in,
  sum(CAST(JSON_EXTRACT(attributes,'$.usage.output_tokens')      AS BIGINT)) t_out,
  sum(CAST(JSON_EXTRACT(attributes,'$.usage.cache_write_tokens') AS BIGINT)) t_cw,
  sum(CAST(JSON_EXTRACT(attributes,'$.usage.cache_read_tokens')  AS BIGINT)) t_cr
FROM ai_gateway_messages
WHERE date BETWEEN '<start>' AND '<end>'
  AND role='assistant' AND JSON_EXTRACT(attributes,'$.usage') IS NOT NULL;
-- One carrier row per response (LLP 0035): a plain SUM is correct, no dedup.
-- Slice by adding gateway_id / model / repo_root / date to SELECT + GROUP BY.
-- Defensive equivalent: max(...) GROUP BY session_id, message_id -- session_id is the
-- uniform key; conversation_id is null for Claude and only separates Codex threads.
```

## Procedure

0. **Load query mechanics BEFORE the first query — skills, not memory.** After the user
   picks a source and before any `hyp query sql`, read the **hypaware-query** skill
   (invoke it or Read its SKILL.md), and the **hypaware-graph** skill if `hyp query
   status` lists `node`/`edge` datasets. Memory notes from past runs do NOT substitute —
   stale notes have cost real runs failed queries and server crashes (a phantom "100-row
   output cap"; message-table `cwd` scans that 504'd then OOM'd the prod server). Route
   by shape, per hypaware-query's "when the graph answers it cheaper" boundary:
   - **Graph first (`node`/`edge` — tiny, join-safe) for every entity/connection
     question:** which sessions used a repo/model/tool/file, skill and program rollups
     (graph-only facets — SQL reconstructions disagree with the projection), client mix,
     work-type clustering by shared-file `touched` edges, co-occurrence, and
     gateway→person attribution (`min/max(session_id)` per gateway from messages — an
     ID-only aggregate — then look those session_ids up in graph Session nodes'
     `props.cwd`, `props.client_name`).
   - **Messages (`ai_gateway_messages`) only for per-message measures:** token sums,
     distinct part/session counts, timestamps and ordering, `is_sidechain`/`agent_id`,
     `is_error`/stop-reasons, content sampling. Slice long windows into server-sized
     date ranges. **Never GROUP BY / DISTINCT / row-fetch wide content columns (`cwd`,
     `content_text`) on the messages table at scale** — that query shape kills servers.
     Capture stderr and check it even on success (truncation and server-cap notices
     land there).
   - **Content-heavy sampling fans out to `hypaware-analyst` workers** (the step-3
     theme/focus sampling and step-4 signal mining: retry loops, re-sent instructions,
     sticking-point samples): give each worker one slice + one question; they return
     compact summaries, never raw output, keeping the samples out of your context.
     Parallel workers against local logs; **strictly one at a time against a remote
     server** (concurrent remote queries 502 the prod proxy). Workers default to a
     small model — pass a model override for judgment-heavy distillation. The numeric
     spine (token sums, slices, trends) stays with you, not workers, so every section
     reconciles to one set of numbers.
   If a query fails, come back to this step; don't iterate on the failing SQL.

1. **Scope + coverage.** Window; distinct `gateway_id` (the unit; `user_id` is ~always
   null, so never measure reach by it) mapped to named people; usage coverage,
   `model`-column coverage (token-weighted), user/repo coverage; claude/codex mix;
   subagent provenance (`agent_id` / `is_sidechain` / `parent_thread_id`,
   transcript-enriched, may not survive ingest). Decide cost-capable vs volume-only and
   which parallelism dimensions are real vs proxied (the `Task`-call proxy). State N; if
   it's effectively one person / dogfood, say so. If usage is thin, fall back to
   behavioral proxies (turns, tool calls, length), labeled as estimates.
   **ALWAYS verify GitHub enrichment before deciding it's out of scope: probe, never
   assume.** Run the probe every run: `hyp query sql "SELECT node_type, projector,
   count(*) AS n, max(first_seen) AS newest FROM node GROUP BY node_type, projector"
   --remote <SRC>` (and check `edge` exists via `hyp query status`). If a `github.t0`
   projector with `PullRequest` / `Review` nodes is present, **GitHub reach is IN SCOPE
   and MUST be computed in step 3**: record the node counts and max `first_seen` per type
   as the graph's as-of date, and treat every reach figure as a floor. If the probe finds
   nothing, state **"checked - no GitHub enrichment present"** explicitly. Never write
   "not assessed" for reach — that phrasing means the probe was skipped.

2. **How much, where it goes, and which way it's moving.** Build the token spine and
   slice it by repo / model / person-or-team (grain per the audience contract; →
   `(unknown)` bucket) with shares. Show adoption as breadth and spread — how many
   people are active, median vs top usage, whether the volume is broad-based or
   carried by a few — rather than a leaderboard; note cache health
   (`cache_read/(cache_read+input)`) where it explains a slice's size (healthy context
   reuse vs where the bill comes from), attached to the slice, not as a per-person
   verdict. Weekly trend with WoW deltas vs the last review covering spend as well as
   volume (where the bill is concentrating, not just how much work happened);
   top-spend outlier sessions described by the work they were doing. This one spine
   feeds every later section — reconcile, don't re-derive.

3. **What the work is, and whether it pays off.** The team's focus: top models, tools
   (Bash dominance + top commands), repos, client, and 2–4 recurring work themes
   (sampled, redacted) — per person on a small team, by team/repo on a large one —
   distilled into one-line **focus labels** a reader can repeat. Cluster
   sessions into recurring **work-types** (shared-file overlap for code work, tool-set
   signature for no-file work; context graph if projected, else SQL), each sized as a
   share of the window's token bill — "what does this kind of work cost the team" is
   the question, and a work-type carrying heavy retry loops or over-specced models gets
   that fact stated right there, on the work-type.
   Parallelism as a payoff question: % of sessions that fan out to subagents (incl. the
   zero bucket), breadth/depth, true concurrency vs serial, main-loop-vs-subagent token
   split, fan-out vs tokens-to-resolution — say plainly whether the sophisticated
   pattern is earning its cost and who on the team has the habit worth spreading —
   credit them by name; this is the report's good news. When step 1 found `github.t0`
   enrichment, add the team's real *reach*: repos and PRs AI-assisted work landed in
   (`Session -at-> Commit <-references- PullRequest`) and whether it drew review
   (`… PullRequest <-on- Review <-submitted- Actor`), dated to the graph's freshness.
   Frame reach as the team's shipped-code footprint (with people credited on the wins),
   never as an output-per-person score. This is the "did the tokens become shipped
   code" evidence the messages cannot show — not optional when the graph supports it.

4. **What should change.** Reuse the spine and the step-3 work-type clusters — don't
   re-query what steps 1–3 already measured. Work three signals; each turns up
   candidate improvements (note frequency: sessions, distinct gateways; redact
   examples):
   - **Repeated work** → package it once (a skill or subagent): recurring work-types
     done successfully, parallelizable work done serially (low subagent use), recurring
     asks / multi-step workflows / re-sent instructions in sampled prompts +
     `system_text`.
   - **Sticking points** → the missing or too-weak instruction that would prevent them
     (an AGENTS.md/CLAUDE.md rule, or a skill), ranked by impact: failing tools
     (`is_error` by `tool_name`), retry loops (same tool + same first `tool_args` token
     ≥3×/session), refusals/truncations (stop-reason), abandoned costly sessions,
     repeatedly-violated conventions. Where GitHub-enriched, work that never landed or
     drew heavy review churn can corroborate a sticking point — a proxy, not proof.
   - **Inefficiency** → the cheaper setup: score the waste dimensions — cache-read
     ratio (usually the biggest lever, feature it), sessions kept open across days
     re-reading their full history, retry loops, abandoned costly sessions, model
     over-spec, context bloat (no `is_compact_summary`) — and name the setup change
     that captures each (right-size the model in AGENTS.md / a subagent, a
     context-hygiene rule, a skill that avoids the redo).
   Then **collect, dedup, prioritize**: drop anything an existing artifact already
   covers (a quick scan of the repo's `.claude/skills/`, subagents, and
   AGENTS.md/CLAUDE.md — the only repo read; every other signal is the logs), mark each
   survivor **new** vs **edit to an existing artifact**, attach evidence
   (frequency/impact + distinct gateways + token prize), and rank by it. Size the prize
   as two numbers kept distinct: **exposure (measured)** — tokens currently flowing
   through the issue — and **est. saving (assumption)** only where the counterfactual
   is clean (cache-read ratio, model right-size). Both are floors; capture is partial;
   never present a saving as if it were measured.

## Output - SAVE A SHORT MAIN FILE + ONE FILE PER SECTION

A **short bullet brief** is the main deliverable (~40 lines of content): a reader gets
the whole story from scannable bullets, and every detail lives in a linked section file.
Headings are standard business-report vocabulary — never AI-flavored coinages like "The
numbers", "What this shows", or "Where the leverage is".

- **Main brief:** `hypaware-reports/<YYYY-MM-DD>-usage-review.md` (create the dir if
  needed). Dated so reviews accumulate. Lay it out in exactly these blocks:
  1. **Title + scope** - an eyebrow line `<server/fleet> · <window>`, then
     `# Team AI Usage Review`.
  2. **Headline** - ONE short **bold** sentence a supervisor could repeat in a meeting:
     the trend, the biggest concentration, the top leverage point. Facts, not
     instructions.
  3. **`## Key metrics`** - grouped bullets, each a **bold topic line + 2-3 short
     sub-bullets** (topics ≈ Volume / Adoption / Trend / The work / Fan-out / Health):
     glanceable facts with bold numbers, no prose sentences. Each topic line ends with
     ` · [<section>](<dir>/<file>.md)` linking its detail section.
  4. **`## Key findings`** - 3-5 ranked findings as the same bold-topic + sub-bullets
     shape: each names the finding, the pattern and its driver, and the size, with the
     topic line linking its detail section like Key metrics. At least one finding is
     good news — a habit or pattern that's working and worth spreading, credited — so
     the report reads as a team retro, not an audit. A finding whose remedy is a
     proposed change states the fact and names the change number on the
     proposed-changes page — the fix itself is never written twice. This is data reporting, not consulting — sized facts, never
     instructions to the manager (audience contract) and never pitch-flavored headings
     ("Opportunities", "Recommendations").
  5. **`## Proposed changes`** - a **pointer, not the list**: 1-2 lines stating how
     many changes are proposed and the headline of the top one (with its prize), ending
     with a link to the proposed-changes page — e.g. `**5 proposed changes** — top:
     <one-line what + prize>. Full ranked list: [proposed changes](<dir>/proposed-changes.md)`.
     The ranked list itself lives ONLY on that page, never inlined on the brief.
     No tables on the brief.
  6. **`## Data limitations`** - 2-3 bullets: the caveats that most change how to read
     the report (tokens-never-dollars + partial capture; token prizes are floors;
     whether subagent identity survived ingest; any capture anomalies this window).
  7. **`## Supporting analysis`** - a one-line footer linking **every** section file
     written this run (not just the cited ones), so nothing is orphaned - e.g.
     `[scope & coverage](<dir>/scope-coverage.md) · [team usage](<dir>/team-usage.md) · [trends](<dir>/trends.md) · [focus & reach](<dir>/focus-and-reach.md) · [work-types](<dir>/work-types.md) · [parallelism payoff](<dir>/parallelism-payoff.md) · [proposed changes](<dir>/proposed-changes.md) · [change: <slug>](<dir>/change-<slug>.md) (one per proposed change) · [caveats](<dir>/caveats.md)`.
- **The proposed-changes page** (`<dir>/proposed-changes.md`) is the dedicated review
  page for what should change — a page a reader can review and act on without the rest
  of the report, held to the same audience contract (patterns and defaults, never
  individuals). It opens with a SHORT bold thrust line (the total prize and where the
  leverage concentrates), then a **numbered list**, one item per improvement,
  highest-leverage first (all survivors from step 4, not a top-N cut), each exactly:
  - the **what**: a short bold imperative naming ONE action (mechanics in parens
    after the bold), nothing else on the line. Never join two actions with ";" or
    "+" in the bold line — when a change pairs a skill move with a companion
    AGENTS.md rule, the bold names the primary action and the companion rides in a
    sub-bullet;
  - sub-bullet 1, the **why**: one short sentence with the token prize or headline
    number (est. savings labeled as estimates, per step 4);
  - sub-bullet 2, the **evidence**: one short line with the 1-2 strongest supporting
    numbers, ending with a link to the change's `change-<slug>.md` file.
  Never pack what+why+prize into the bold line. Change numbers on this page are the
  ones Key findings cite.
- **Every proposed change ships its artifact in its own section file**
  (`<dir>/change-<slug>.md`): it opens supervisor-readable — the claim, who/what
  drives it, exposure vs est. saving — and closes with the ready-to-apply artifact:
  AGENTS.md/CLAUDE.md edit → a real diff; new skill or subagent → the full proposed
  file (frontmatter + body) in a code block, ready to save; move of an existing
  artifact → concrete source → destination paths, flagging any machine-specific
  content to review (if the source file lives on another machine, say so — name the
  move, don't fake the file); tool/config change → the exact proposed text.
- **Chart the breakdowns.** Keep the allocation tables as the record (at the grain the
  audience contract picked — per-person for a small team, rollups + distribution for a
  large one), and pair each with a breakdown chart following the HTML renderer's
  authoring contract (`hypaware-report-to-html/authoring.md`; component snippets in
  `components.md` next to it): share of messages and tokens on the team-usage page,
  main-vs-subagent token split on the parallelism page, token share by work-type on
  the work-types page. Where a real team grouping exists (a user-supplied mapping, or
  cwd naming), add a by-team rollup; never invent teams the data doesn't show.
- **Section files are analysis, not inventory.** Each detail section is its own
  `<dir>/<file>.md`, held to the same standard as the main brief: it argues one claim,
  opens with a SHORT bold thrust line (a few clauses, not a paragraph — optionally
  followed by 2-4 bullets), and ties every number to what it means for the reader.
  Body lists use the same bold-topic + short-sub-bullets shape as the main brief;
  multi-sentence prose bullets are hard to scan and not allowed. A
  section file that is only a stat table has failed - fold it back into the main brief
  rather than shipping it as a page. Cut table narration and standing bookkeeping prose;
  compress source/window/method to a few lines.
- **No scope apologies (in any file).** Scope rules (what routes to which report) are
  authoring guidance, never report copy. Don't write "descriptive only" or routing
  disclaimers; state findings plainly.
- **Capture-health note:** if subagent provenance doesn't reach the server, the standing
  #1 caveat is "subagent identity must survive ingest"; run fan-out adoption off the
  sub-agent-invocation proxy (the tool calls that spawn subagents) and flag it.
