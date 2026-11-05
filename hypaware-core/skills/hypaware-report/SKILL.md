---
name: hypaware-report
description: Generate a full evidence-backed Markdown report on local or team AI usage or workflows, with analyst workers, period coverage, synthesis, recommendations, and review. For quick questions, single recommendations, or managing existing reports, use hypaware-query.
---

# HypAware report

Explain what improves the quality and value of the user's work. Deliver a
Markdown report grounded in recorded behavior and outcomes.

Read [report-contract.md](references/report-contract.md) for analysis, page format
and review.
Use [hypaware-query](../hypaware-query/SKILL.md) for querying and usage accounting,
keeping this report's agreed scope and budgets.
Read [analyst-task.md](references/analyst-task.md) when delegating. Use
[query report mechanics](../hypaware-query/reports.md) when saving or publishing.
Quick questions and single recommendations belong to
**hypaware-query**, without this full-report workflow.

## Scope

- Before analysis or delegation, establish recording scope (this machine or team),
  time period and focus. Reuse answers already given; ask for missing choices in
  one short exchange and wait. A general overview is a valid focus. Suggest the
  last 7 days including today when no period is given, but do not assume it.
- Once the period is selected, an omitted end date means now.
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
- For local scope, query without `--remote`. For team scope, discover configured
  targets with `hyp remote list --json` and resolve the intended target and
  organization before querying. Follow hypaware-query's remote guidance. Carry
  that scope through schema discovery, baseline queries and worker assignments;
  never silently substitute local data for team data. Inspect the selected
  source's schema; local cache status does not describe a remote. Do not change
  capture/privacy settings.
- Enumerate counts by day across the full range. Split failed enumerations down
  to a day as needed; distinguish failure from verified zero rows. A verified
  empty period needs no manufactured report or recommendations.
- Choose time buckets that help answer the question; weekly tables are optional.
  Use the preceding equal-length period as the comparison baseline unless the
  user specifies another. Query it within the same scope and budgets, only to
  establish the comparison; disclose unavailable or noncomparable evidence.
  Keep comparison boundaries consistent, label partial buckets, and compare
  per-active-day rates when exposure differs. Do not hide quiet days. Keep a
  compact ledger of coverage, query labels, evidence locators, figures, filters,
  and denominators outside the publish directory.

## Investigation

Before investigating, create a temporary `organization-context.md` following the
[organization context guidance](references/report-contract.md#understand-the-organization)
and share it with subagents. Update it as evidence changes.

Use an available relevant checkout to understand the project and validate
recommendations, following the [report contract](references/report-contract.md).
Share findings so workers do not repeat repository discovery. Checkout access
does not change the agreed recording scope.

Keep scope, synthesis and writing in this session; delegate bounded analysis:

**Claude:** Delegate slice reading to
the registered `hypaware-analyst` worker using the host's subagent tool, with
its plugin namespace if needed. Preserve its model and tool restrictions. If
the worker is unavailable, explain the missing dependency; a substitute worker
or single-agent report requires the user's choice.

**Codex:** Delegate slice reading to
separate workers through the host's delegation tool. Give each the
`hypaware-analyst` role and scoped assignment from the linked template. Codex
has no registered agent type by that name: use an available worker type and
inherit the model unless the user selects another. If delegation is unavailable,
explain that limitation; a single-agent report requires the user's choice.

**Other clients:** Delegate slice reading to
scoped workers when this client can run them, giving each the assignment from
the linked template. A client that cannot run a scoped worker runs each slice
itself under the same scope and budget; say so in the report's coverage notes.

Plan coverage before deep reads. Have workers survey every populated day using
aggregates and bounded samples, grouping up to 10 days or about 20,000 source
rows per assignment; this is a grouping bound, never a transcript-dump size.
Start with an informative slice, then dispatch independent assignments within
host concurrency limits. Cover ordinary and successful work as well as costly
or failing cases. Reserve budget for coverage gaps, cross-date synthesis, and
report review. Repair missing survey coverage before new deep investigations;
if coverage remains incomplete, label the report partial and scope its claims.

Default ceilings: 12 investigations, 40 SQL queries in this session, and 20 queries
per worker with a target of 5; a worker's tighter limits still apply. Count
failed queries and reassignments. A worker reports an error or insufficient
scope; narrow or reassign rather than repeating an unchanged
resource-refused query. Mark coverage only on usable returns. If the budget
cannot cover all slices, report omitted dates and known row counts explicitly.

Reconcile figures and test explanations across slices; a set
of daily summaries is insufficient for a multi-day period. Reuse worker results
and spend follow-up queries on contrasts, unresolved outcomes, and alternative
explanations that could change a recommendation. Check whether a proposed
change was already adopted. Compare prior reports only when selected by the
user, testing their claims against current-period evidence.

## Write and deliver

Draft in `./hypaware-report-<from>-to-<to>/` or the requested destination. Append
`-2`, `-3`, etc. if it exists; overwrite only when requested. Keep the ledger,
temporary organization context and raw query output outside this folder: it holds
only report pages. Use the linked report contract for page structure and the final
review.

Review the draft separately from writing it: use an independent reviewer when
available and permitted, otherwise self-review. The reviewer gets the pages and
contract, the current `organization-context.md`, and local verification findings;
check figures and locators against the ledger.
Resolve unsupported claims and contradictions, then recheck affected content.
Finish with the contract's [reader clarity pass](references/report-contract.md#final-reader-clarity-pass)
before delivery.

When review is complete, save the report using
[query report mechanics](../hypaware-query/reports.md), unless the user requested
another destination. If the CLI cannot accept the chosen pages, retain the
complete local folder and explain the limitation. Return the `report.md` path, scope, dates, and any
incomplete coverage or review. Publish only when requested, using that same
reference. Generation does not authorize applying proposals or changing settings.
