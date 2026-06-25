---
name: hypaware-ai-spend-report
description: AI Spend Review for a HypAware server — where tokens go (by user/repo/model/gateway), what work they go on (graph-clustered), and how to spend less (waste scorecard + cost levers). Deduped token volume, never dollars. Saves a dated report under hypaware-reports/; first asks which HypAware source to query (local logs or a remote server) via the hypaware-query skill.
---

# AI Spend Review

Where the team's tokens go, on what work, and how to spend less — read off one deduped token
spine. One story in three moves: **where it goes** (by user / repo / model / gateway, over
time), **on what work** (sessions clustered into recurring work-types, sized by tokens), and
**how to spend less** (a waste scorecard + ranked cost levers).

IMPORTANT: Don't assume which logs to read — **ask first.** Start by listing the data sources
and let the user choose which to query: **local logs** (this machine's own recordings —
`hyp query sql …`, no `--remote`) and **each remote HypAware server** (every target from
`hyp remote list`, plus any hypaware MCP server already available to you as MCP tools (a
`query_sql` / `graph_neighbors` tool in your toolset); the same server can appear both ways —
list it once). Present the options,
ask which one (or more) to run the review against, then proceed against the chosen source.

**Tokens, never dollars** — capture is partial, so stop at token volume and behavioral proxies.
Query mechanics (`--remote`, date-pruning the 30s timeout, the SQL dialect, sampling) live in
the **hypaware-query** skill; read it first.

## Token math (get this right — every breakdown reconciles to it)
Usage is in `attributes.usage` (NOT `raw_frame`): `input_tokens`, `output_tokens`,
`cache_read_tokens`, `cache_write_tokens` (+ `reasoning_tokens` for Codex). Dedup by message
and `max()` — a plain `SUM` overcounts ~3×. Report the four types separately (cache-read is
usually the bulk; output the scarce slice).

```sql
WITH msg AS (
  SELECT COALESCE(CAST(JSON_EXTRACT(raw_frame,'$.message_id') AS VARCHAR), message_id) mid,
    max(CAST(JSON_EXTRACT(attributes,'$.usage.input_tokens')       AS BIGINT)) inp,
    max(CAST(JSON_EXTRACT(attributes,'$.usage.output_tokens')      AS BIGINT)) outp,
    max(CAST(JSON_EXTRACT(attributes,'$.usage.cache_write_tokens') AS BIGINT)) cwrite,
    max(CAST(JSON_EXTRACT(attributes,'$.usage.cache_read_tokens')  AS BIGINT)) cread
  FROM ai_gateway_messages
  WHERE date BETWEEN '<start>' AND '<end>'
    AND role='assistant' AND JSON_EXTRACT(attributes,'$.usage') IS NOT NULL
  GROUP BY mid)
SELECT sum(inp) t_in, sum(outp) t_out, sum(cwrite) t_cw, sum(cread) t_cr FROM msg;
-- slice by adding max(gateway_id)/max(model)/max(repo_root)/max(date) inside, GROUP BY outside.
```

## Procedure
1. **Coverage + footprint.** Window; usage coverage, `model`-column coverage (token-weighted),
   user/repo coverage; distinct gateways, sessions, claude/codex mix. `user_id` is ~always null
   → attribute by `gateway_id` (≈ one machine/user) and always show an explicit **unattributed**
   row. State N; if it's a dogfood window, say so. If usage is thin, fall back to behavioral
   proxies (turns, tool calls, length), labeled as estimates.
2. **Where it goes + on what work.** Slice the spine by user / repo / model (→ `(unknown)`
   bucket) / gateway with shares, plus trends (by week, WoW deltas vs the last report) and
   top-spend outliers. Then cluster sessions into recurring **work-types** — shared-file overlap
   for code work, tool-set signature for no-file work (context graph if projected, else SQL) —
   and size each by deduped tokens.
3. **How to spend less.** Score the waste — cache-read ratio `cache_read/(cache_read+input)`
   (the biggest lever — feature it), retry loops, abandoned costly sessions, model over-spec,
   context bloat — and turn the top few into ranked cost levers, each with an estimated weekly
   token saving. Hand the expensive recurring work-types to **hypaware-ai-improvement-report** as packaging
   candidates (surface them; don't build them here).

## Output — SAVE A MARKDOWN FILE
- **Path:** `hypaware-reports/<YYYY-MM-DD>-spend-review.md` (create the dir if needed). Dated
  so reviews accumulate.
- **Bottom line (1 sentence):** total tokens this window, the trend vs the last report (▲/▼ %),
  and the single biggest driver.
- **Cost actions (ranked table):** one row per lever — **action** · **evidence** (tokens/share
  + cause) · **est. weekly saving** · **where it lands**. Highest-saving first.
- **Then the detail**, in these sections: **Coverage & footprint · Total spend (4 token types)
  · Allocation (user / repo / model / gateway) · Trends · Outliers · Spend by work-type · Waste
  scorecard · Leverage candidates (handoff to hypaware-ai-improvement-report) · Caveats**.
- **Formatting (human-readable):** open each section with its one-sentence takeaway, then the
  table; **bold** headline numbers; split the four token types (never collapse them); keep the
  bottom line + ranked table a ~1-minute read.
