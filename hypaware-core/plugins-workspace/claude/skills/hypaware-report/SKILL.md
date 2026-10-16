---
name: hypaware-report
description: Generate a full evidence-backed Markdown report on local AI usage or workflows, with analyst workers, period coverage, synthesis, recommendations, and review. For quick questions, single recommendations, or managing existing reports, use hypaware-query.
---

# Local HypAware report

Explain what improves the quality and value of the user's work. Deliver a
Markdown report grounded in recorded behavior and outcomes. Generation needs
neither server credentials nor publishing; applying recommendations is separate.

Read [report-contract.md](references/report-contract.md) for the analytical and
output standards, and [querying.md](references/querying.md) before querying.
Read [analyst-task.md](references/analyst-task.md) when delegating. Use
[query report mechanics](../hypaware-query/reports.md) when writing pages,
saving, or publishing. Quick questions and single recommendations belong to
**hypaware-query**, without this full-report workflow.

## Scope

- Resolve the user's question and scope interactively. If neither the request
  nor this conversation establishes a focus, ask what the report should focus
  on and wait before starting analysis or delegation. A requested general
  overview is a valid focus. Ask when ambiguity would materially change the
  investigation; reuse established answers rather than asking again.
- Default to the last 7 days including today. An omitted end date means now.
  "Last week" means the last 7 days including today. Use calendar week or month
  boundaries only when specifically requested, never merely because a report
  covers about a week or month. If wording leaves the intended period unclear
  (for example, "last month" could mean a rolling month or a calendar month),
  ask before choosing dates. Honor clearly specified date ranges. State the
  resolved absolute dates and timezone (UTC by default).
- Include today's available recordings and label today as partial, with the
  query time and cache freshness. Do not require a closed period or impose a
  365-day cutoff. For large ranges, keep queries bounded and agree a narrower
  question with the user if the budget cannot support useful coverage.
- Use local `hyp` queries without `--remote`. Inspect cache status and schema;
  do not assume server-only columns exist or change capture/privacy settings.
- Enumerate counts by day across the full range. Split failed enumerations down
  to a day as needed; distinguish failure from verified zero rows. A verified
  empty period needs no manufactured report or recommendations.
- Choose time buckets that help answer the question; weekly tables are optional.
  Keep comparison boundaries consistent, label partial buckets, and compare
  per-active-day rates when exposure differs. Do not hide quiet days. Keep a
  compact ledger of coverage, query labels, evidence locators, figures, filters,
  and denominators outside the publish directory.

## Investigation

The coordinator owns scope, synthesis, and writing; delegate slice reading to
the registered `hypaware-analyst` worker using the host's subagent tool, with
its plugin namespace if needed. Preserve its model and tool restrictions. If
the worker is unavailable, explain the missing dependency; a substitute worker
or single-agent report requires the user's choice.

Plan coverage before deep reads. Have workers survey every populated day using
aggregates and bounded samples, grouping up to 10 days or about 20,000 source
rows per assignment; this is a grouping bound, never a transcript-dump size.
Start with an informative slice, then dispatch independent assignments within
host concurrency limits. Cover ordinary and successful work as well as costly
or failing cases. Reserve budget for coverage gaps, cross-date synthesis, and
report review. Repair missing survey coverage before new deep investigations;
if coverage remains incomplete, label the report partial and scope its claims.

Default ceilings: 12 investigations, 40 coordinator SQL queries, and 20 queries
per worker with a target of 5; a worker's tighter limits still apply. Count
failed queries and reassignments. A worker reports an error or insufficient
scope; the coordinator narrows or reassigns rather than repeating an unchanged
resource-refused query. Mark coverage only on usable returns. If the budget
cannot cover all slices, report omitted dates and known row counts explicitly.

The coordinator reconciles figures and tests explanations across slices; a set
of daily summaries is insufficient for a multi-day period. Reuse worker results
and spend follow-up queries on contrasts, unresolved outcomes, and alternative
explanations that could change a recommendation. Check whether a proposed
change was already adopted. Compare prior reports only when selected by the
user, testing their claims against current-period evidence.

## Write and deliver

Draft in `./hypaware-report-<from>-to-<to>/` or the requested destination. Append
`-2`, `-3`, etc. if it exists; overwrite only when requested. Keep the ledger
and raw query output outside this folder: it holds only report pages. Use the
linked report contract for page structure and the final review.

Review the draft separately from writing it: use an independent reviewer when
available and permitted, otherwise self-review. The reviewer gets the pages and
contract; the coordinator checks figures and locators against the ledger.
Resolve unsupported claims and contradictions, then recheck affected content.

When review is complete, save the report using
[query report mechanics](../hypaware-query/reports.md), unless the user requested
another destination. Return the saved `report.md` path, scope, dates, and any
incomplete coverage or review. Publish only when requested, using that same
reference. Generation does not authorize applying proposals or changing settings.
