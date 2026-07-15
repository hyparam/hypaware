---
name: hypaware-ai-usage-report
description: Team AI Usage Review for a HypAware server, written for whoever supervises the team (eng manager, lead, CTO — no HypAware knowledge assumed): who's using AI and how much, what work it goes on and whether it pays off, which way it's trending, where tokens are wasted, and the levers to improve — the former adoption profile and spend review merged onto one token spine. Token volume, never dollars. Saves a dated report under hypaware-reports/; first asks which HypAware source to query (local logs or a remote server) via the hypaware-query skill. Supersedes hypaware-ai-adoption-report and hypaware-ai-spend-report — run this instead of either.
---

# Team AI Usage Review

One report, one window, one token spine, answering the four questions a supervisor
actually has:

1. **Who is using AI, how much, and on what?** — per-person utilization, and allocation by
   person / repo / model.
2. **What does the work look like, and is the sophistication paying off?** — each person's
   focus, recurring work-types sized by tokens, multi-agent fan-out and whether it earns
   its cost, code that actually landed (GitHub reach, where enriched).
3. **Which way is it trending?** — weekly volume/output, deltas vs the last review.
4. **Where is it wasted, and what can I do about it this week?** — waste scorecard +
   ranked levers, each with an estimated weekly token saving.

The old adoption-profile and spend-review reports each told half of this and repeated the
other half; this report replaces both. Don't run those skills alongside it.

## Audience contract (this is the point of the merge — enforce it everywhere)

The reader is **the person supervising the team** — an engineering manager, team lead,
CTO, or ops owner. Assume they have never seen a HypAware table, don't know the schema
vocabulary, and are reading to make decisions about their team, not to audit queries.
Concretely:

- **People, not infrastructure.** A `gateway_id` is ≈ one person's machine: attribute it
  to a named person (via session `cwd`) and say the person. "phil's laptop", never
  "gateway a3f9". Keep an explicit **unattributed** row when attribution fails.
- **Every number carries a judgment and a "so what".** Not "cache-read ratio 99.5%" but
  what that means for them (context reuse is healthy / this is where the bill comes from).
  Terms the report can't avoid (cache-read, subagent, output tokens) get a one-line
  plain-language gloss the first time they appear — once, then use them freely.
- **Plain literal language, everywhere.** Pipeline vocabulary (ingest, sidechain,
  provenance, projector, org-scoped, part) never appears in report copy — translate to
  what it means for the numbers ("the logs record which tokens belong to helper
  agents"). Coined names (a harness like "gastown") get a one-line gloss at first
  mention on EACH page that uses them. Headings state the literal fact, never a
  metaphor ("Message counts for 07-09 → 07-14 don't reflect real activity", not "The
  volume meter broke"). This bans report-coined shorthand too: "marathon sessions" was
  flagged by the user as vague (2026-07-14) — write the literal behavior, "sessions
  kept open across days re-read their entire history each morning" / "the 60 longest
  sessions". When a skill or tool is named as a fix, add one clause on what it
  literally does ("`/handoff` writes a short end-of-day note of where the work stands
  so the next day starts a fresh session"), never just its name. Time references are
  absolute dates ("07-09 → 07-14", "wk of 07-13"), never relatives like "final week"
  or "this week" that decay after the run date.
- **Equip the reader; never direct them.** The report's job is to surface what a
  supervisor needs to act — who is involved, the size of the effect, what would change
  it, and the expected result — stated as findings and sized options, NOT as
  instructions ("ask X about Y", "talk to kenny", "set an expectation", "sanction Z").
  The reader knows how to manage their team; telling them how reads as presumptuous and
  buries the information. Write "the 60 longest sessions are 32 phil / 24 kenny; a 25%
  context trim returns ~290M/wk", never "ask phil and kenny to trim their sessions".
  Deep tooling work (skills to build, harness changes) still routes to
  **hypaware-ai-improvement-report** as a plain cross-link — surface it, don't spec it
  here.
- **Comparisons over absolutes.** A supervisor can't judge "69.5M output tokens" in a
  vacuum; they can judge shares, trends vs the last review, and spread across the team.
  Lead with those.
- **Tokens, never dollars.** Capture is partial, so stop at token volume and behavioral
  proxies; say so once in the caveat, not in every section.

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
     content sampling. Slice long windows into server-sized date ranges. **Never GROUP
     BY / DISTINCT / row-fetch wide content columns (`cwd`, `content_text`) on the
     messages table at scale** — that query shape kills servers. Capture stderr and
     check it even on success (truncation and server-cap notices land there).
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

2. **Who, how much, and which way it's moving.** One row per person: volume (messages,
   sessions, active days, first/last seen), tokens + cache-read ratio
   `cache_read/(cache_read+input)`. Slice the token spine by person / repo / model
   (→ `(unknown)` bucket) with shares; weekly trend with WoW deltas vs the last review;
   top-spend outlier sessions. This one spine feeds every later section — reconcile,
   don't re-derive.

3. **What the work is, and whether it pays off.** Per person: top models, tools (Bash
   dominance + top commands), repos, client, and 2–4 recurring work themes (sampled,
   redacted), distilled into a one-line **focus label** a supervisor can repeat. Cluster
   sessions into recurring **work-types** (shared-file overlap for code work, tool-set
   signature for no-file work; context graph if projected, else SQL), sized by tokens.
   Parallelism as a payoff question: % of sessions that fan out to subagents (incl. the
   zero bucket), breadth/depth, true concurrency vs serial, main-loop-vs-subagent token
   split, fan-out vs tokens-to-resolution — say plainly whether the sophisticated
   pattern is earning its cost and who on the team has the habit worth spreading. When
   step 1 found `github.t0` enrichment, add each person's real *reach*: repos and PRs
   their AI-assisted work landed in (`Session -at-> Commit <-references- PullRequest`)
   and whether it drew review (`… PullRequest <-on- Review <-submitted- Actor`), dated to
   the graph's freshness. This is the "did the tokens become shipped code" evidence a
   supervisor most wants and the messages cannot show — not optional when the graph
   supports it.

4. **Where to save, and the information to act.** Score the waste: cache-read ratio
   (the biggest lever, feature it), long-session concentration (sessions kept open
   across days), retry loops,
   abandoned costly sessions, model over-spec, context bloat. Turn the top few into
   **ranked levers, each with an estimated weekly token saving and the facts a
   supervisor needs to act on it** — who is involved, what behavior or default drives
   it, and what a stated change would return. Per the audience contract: findings and
   sized options, never instructions to the manager. Hand expensive recurring
   work-types to **hypaware-ai-improvement-report** as packaging candidates (surface
   them; don't build them here).

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
     sub-bullets** (topics ≈ Volume / Who / Trend / The work / Fan-out / Health):
     glanceable facts with bold numbers, no prose sentences. Each topic line ends with
     ` · [<section>](<dir>/<file>.md)` linking its detail section.
  4. **`## Key findings`** - 3-5 ranked findings as the same bold-topic + sub-bullets
     shape: each names the finding, who is involved, the driver, and the estimated
     weekly token effect where one exists, with the topic line linking its detail
     section like Key metrics. This is data reporting, not consulting — sized facts,
     never instructions to the manager (audience contract) and never pitch-flavored
     headings ("Opportunities", "Recommendations").
  5. **`## Data limitations`** - 2-3 bullets: the caveats that most change how to read
     the report (tokens-never-dollars + partial capture; whether subagent identity
     survived ingest; any capture anomalies this window).
  6. **`## Supporting analysis`** - a one-line footer linking **every** section file
     written this run (not just the cited ones), so nothing is orphaned - e.g.
     `[scope & coverage](<dir>/scope-coverage.md) · [team usage](<dir>/team-usage.md) · [trends](<dir>/trends.md) · [focus & reach](<dir>/focus-and-reach.md) · [work-types](<dir>/work-types.md) · [parallelism payoff](<dir>/parallelism-payoff.md) · [waste scorecard](<dir>/waste-scorecard.md) · [levers](<dir>/levers.md) · [caveats](<dir>/caveats.md)`.
- **Chart the who-breakdowns.** Keep the one-row-per-person tables as the record, and
  pair each with a breakdown chart following the HTML renderer's authoring contract
  (`hypaware-report-to-html/authoring.md`; component snippets in `components.md` next to
  it): share of messages and tokens by person on the team-usage page, main-vs-subagent
  token split on the parallelism page, waste levers as a ranked bar set. Where a real
  team grouping exists (a user-supplied mapping, or cwd naming), add a by-team rollup;
  never invent teams the data doesn't show.
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
  disclaimers; state findings plainly, and where a sibling report owns the action a plain
  cross-link is enough.
- **Capture-health note:** if subagent provenance doesn't reach the server, the standing
  #1 caveat is "subagent identity must survive ingest"; run fan-out adoption off the
  sub-agent-invocation proxy (the tool calls that spawn subagents) and flag it.
