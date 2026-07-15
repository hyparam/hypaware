---
name: hypaware-ai-spend-report
description: "SUPERSEDED by hypaware-ai-usage-report (merged with the adoption profile, 2026-07-13) — invoke that skill instead unless the user explicitly asks for a standalone spend review. Original scope: AI Spend Review for a HypAware server: where tokens go (by user/repo/model/gateway), what work they go on (graph-clustered), and how to spend less (waste scorecard + cost levers). Token volume, never dollars. Saves a dated report under hypaware-reports/; first asks which HypAware source to query (local logs or a remote server) via the hypaware-query skill."
---

# AI Spend Review

Where the team's tokens go, on what work, and how to spend less, read off one token
spine. One story in three moves: **where it goes** (by user / repo / model / gateway, over
time), **on what work** (sessions clustered into recurring work-types, sized by tokens), and
**how to spend less** (a waste scorecard + ranked cost levers).

IMPORTANT: Don't assume which logs to read: **ask first.** Start by listing the data sources
and let the user choose which to query: **local logs** (this machine's own recordings,
`hyp query sql …`, no `--remote`) and **each remote HypAware server** (every target from
`hyp remote list`, plus any hypaware MCP server already available to you as MCP tools (a
`query_sql` / `graph_neighbors` tool in your toolset); the same server can appear both ways,
list it once). Present the options,
ask which one (or more) to run the review against, then proceed against the chosen source.

**Tokens, never dollars.** Capture is partial, so stop at token volume and behavioral proxies.
Query mechanics are step 0 of the procedure — a mandatory read, not a reference.

## Token math (get this right; every breakdown reconciles to it)
Usage is in `attributes.usage` (NOT `raw_frame`): `input_tokens`, `output_tokens`,
`cache_read_tokens`, `cache_write_tokens` (+ `reasoning_tokens` for Codex). Usage rides exactly
one row per response (the last assistant part; non-carrier parts are null), so a plain `SUM`
over assistant rows is correct with no dedup (the one-carrier rule, LLP 0035); `input_tokens`
is net of cache, so it never double-counts. Report the four types separately (cache-read is
usually the bulk; output the scarce slice).

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
0. **Load query mechanics BEFORE the first query — skills, not memory.** After the user picks a
   source and before any `hyp query sql`, read the **hypaware-query** skill (invoke it or Read
   its SKILL.md), and the **hypaware-graph** skill if `hyp query status` lists `node`/`edge`
   datasets. Memory notes from past runs do NOT substitute — stale notes have cost real runs
   failed queries and server crashes (a phantom "100-row output cap"; message-table `cwd` scans
   that 504'd then OOM'd the prod server). Route by shape, per hypaware-query's "when the graph
   answers it cheaper" boundary: entity/connection questions go to the graph's tiny `node`/`edge`
   tables — sessions per repo/model/tool/file, skill and program rollups (graph-only facets),
   client mix, work-type clustering by shared-file `touched` edges, and gateway→person
   attribution (`min/max(session_id)` per gateway from messages — an ID-only aggregate — then
   look those session_ids up in graph Session nodes' `props.cwd`). The **token spine stays on
   `ai_gateway_messages`**: token sums, counts, ordering — date-sliced to server-sized ranges,
   and **never GROUP BY / DISTINCT / row-fetch wide content columns (`cwd`, `content_text`) at
   scale** (that query shape kills servers). Capture stderr and check it even on success —
   truncation and server-cap notices land there. If a query fails, come back to this step; don't
   iterate on the failing SQL.
1. **Coverage + footprint.** Window; usage coverage, `model`-column coverage (token-weighted),
   user/repo coverage; distinct gateways, sessions, claude/codex mix. `user_id` is ~always null
   → attribute by `gateway_id` (≈ one machine/user) and always show an explicit **unattributed**
   row. State N; if it's a dogfood window, say so. If usage is thin, fall back to behavioral
   proxies (turns, tool calls, length), labeled as estimates.
2. **Where it goes + on what work.** Slice the spine by user / repo / model (→ `(unknown)`
   bucket) / gateway with shares, plus trends (by week, WoW deltas vs the last report) and
   top-spend outliers. Then cluster sessions into recurring **work-types**: shared-file overlap
   for code work, tool-set signature for no-file work (context graph if projected, else SQL),
   and size each by tokens.
3. **How to spend less.** Score the waste: cache-read ratio `cache_read/(cache_read+input)`
   (the biggest lever, feature it), retry loops, abandoned costly sessions, model over-spec,
   context bloat, and turn the top few into ranked cost levers, each with an estimated weekly
   token saving. Hand the expensive recurring work-types to **hypaware-ai-improvement-report** as packaging
   candidates (surface them; don't build them here).

## Output - SAVE A SHORT MAIN FILE + ONE FILE PER SECTION
A **progressively-disclosed one-pager** is the deliverable: a reader can stop after the thesis
sentence, glance the key-numbers table, skim the findings, or follow any link into a detail
**section**, and each section is its own markdown file. Build the one-pager top-to-bottom so each
layer is shorter and more glanceable than the one it summarizes.

- **Main one-pager:** `hypaware-reports/<YYYY-MM-DD>-spend-review.md` (create the dir if needed).
  Dated so reviews accumulate. Lay it out in exactly these blocks, separated by `---` rules:
  1. **Title + scope** - `# AI Spend Review`, then a `## <server/fleet> · <window>` subtitle.
  2. **Thesis** - ONE **bold** sentence: total tokens this window, the trend vs the last report
     (▲/▼ %), and the single biggest driver.
  3. **`### Key numbers`** - a small metric→readout table, ~4-6 rows, each one glanceable fact with
     no link (total tokens with the four types split, WoW trend, the top allocation who/what
     dominates, the biggest waste lever + est. weekly saving, usage coverage). This is the ONLY
     table on the one-pager.
  4. **`## What this shows`** - 3-5 numbered findings, highest-leverage first; each is a
     `### N. <headline>` followed by 2-3 plain-language sentences with **bold** numbers, then a
     single `[<section> →](<dir>/<file>.md)` link on its own line (where it goes, on what work, the
     biggest waste lever, the top cost action).
  5. **`## Caveat`** - tokens-never-dollars and partial capture, in plain language + a `[caveats →]`
     link.
  6. **`## Report details`** - a one-line footer linking **every** section file written this run
     (not just the cited ones), so nothing is orphaned - e.g.
     `[coverage](<dir>/coverage.md) · [total spend](<dir>/total-spend.md) · [allocation](<dir>/allocation.md) · [trends](<dir>/trends.md) · [outliers](<dir>/outliers.md) · [work-types](<dir>/work-types.md) · [waste scorecard](<dir>/waste-scorecard.md) · [leverage candidates](<dir>/leverage-candidates.md) · [caveats](<dir>/caveats.md)`.
- **Section files are analysis, not inventory.** Each detail section is its own `<dir>/<file>.md`, held to the same standard as the one-pager: it argues one claim, opens with that takeaway, and ties every number to what it means for the reader. A section file that is only a stat table has failed - fold it back into the one-pager rather than shipping it as a page. Cut table narration ("how to read the table") and standing bookkeeping prose; compress source/window/method to a few lines.
- **No scope apologies (in any file).** Scope rules (what routes to which report) are authoring guidance, never report copy. Don't write "descriptive only", "no recommendations here", or routing disclaimers in the one-pager or any section file; state findings plainly, and where a sibling report owns the action a plain cross-link is enough.
