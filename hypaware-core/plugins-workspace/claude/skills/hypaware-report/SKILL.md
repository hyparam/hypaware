---
name: hypaware-report
description: Investigate local HypAware recordings with analyst workers and produce an evidence-backed Markdown report with actionable recommendations. Use for AI usage or workflow reviews over a reporting period.
---

# Local HypAware report

Explain what improves the quality and value of the user's work. Deliver a
Markdown report grounded in recorded behavior and outcomes. Generation needs
neither server credentials nor publishing; applying recommendations is separate.

Read [report-contract.md](references/report-contract.md) for the analytical and
output standards, and [querying.md](references/querying.md) before querying.
Read [analyst-task.md](references/analyst-task.md) when delegating. Read
[publishing.md](references/publishing.md) only when publishing is requested.

## Scope

- Resolve inclusive UTC dates; default to the previous calendar month. The
  range is at most 365 days and ends before today UTC. For an open period,
  resolve a closed range with the user rather than silently clipping it.
- Use local `hyp` queries without `--remote`. Inspect cache status and schema;
  do not assume server-only columns exist or change capture/privacy settings.
- Enumerate counts by day across the full range. Split failed enumerations down
  to a day as needed; distinguish failure from verified zero rows. A verified
  empty period needs no manufactured report or recommendations.
- Use fixed Monday-to-Sunday weeks clipped to the period. Label partial weeks
  and compare per-active-day rates when exposure differs; do not merge quiet
  weeks. Keep a compact ledger of coverage, query labels, evidence locators,
  figures, filters, and denominators outside the publish directory.

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
or failing cases. Reserve budget for cross-date synthesis and report review.

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

When the review is complete, move the folder into HypAware's reports store,
unless the user asked for another destination:

```sh
hyp report save ./hypaware-report-<from>-to-<to>
```

It admits only a folder holding `report.md` and supported pages, copies it to
`$HYP_HOME/reports/<name>` (suffixing a taken name), and removes the draft. If
it refuses a stray file, remove that file and run it again; do not write under
the user's home directory yourself. Its receipt prints the saved path and the
publish command for this report.

Return the saved `report.md` path, scope, dates, and any incomplete coverage or
review. Do not apply proposals, change settings, or publish unless the user
requests it.
