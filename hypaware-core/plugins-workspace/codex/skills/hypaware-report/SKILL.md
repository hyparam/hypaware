---
name: hypaware-report
description: Delegate to the host's available worker type to investigate local HypAware logs and produce a Markdown report using the server report workflow. Use for a local AI usage or workflow report over a reporting period.
---

# Local HypAware report

Run the server's analytical workflow against this machine's HypAware recordings.
Deliver Markdown files only. This is a portable adaptation of generation, not
an invocation of the hosted report service or a guarantee of identical findings.
No server checkout, server credentials, HTML renderer, or publishing is required.

The invoking agent is the coordinator: enumerate activity, dispatch named
`hypaware-analyst` workers, investigate cross-slice findings, synthesize their
evidence, and write the report. Reading and classifying slice content belongs
to the workers. Launch separate subagents through the host's delegation tool,
giving each the hypaware-analyst role and the complete scoped prompt in
[analyst-task.md](references/analyst-task.md). This adapter installs skills,
not a named Codex agent configuration: do not assume a registered
`hypaware-analyst` agent type exists. Use the host's available worker type and
inherit its model unless the user specified another.

Check that delegation is available before starting the investigation. If it
is unavailable, explain the missing capability rather than silently doing all
the reading in the coordinator. A single-agent report requires the user's
choice.

Read [querying.md](references/querying.md) before querying. Read
[report-contract.md](references/report-contract.md) before investigating and
again when writing and reviewing. Both travel with this skill.

## Scope and inventory

1. Resolve the requested period to inclusive absolute dates. Default to the
   previous calendar month in UTC. Accept a day, month, or explicit range of at
   most 365 days. The last day must be before today UTC. If the requested period
   is still open, explain the boundary and ask for a closed range; never silently
   clip it. Record the local dataset and exact dates in the report.
2. Use local `hyp` queries, without `--remote`. Inspect cache status and schema.
   Do not assume `org`, `gateway_id`, or `received_at` exist locally. Do not
   change capture, privacy, or tool configuration to make a report possible.
3. Enumerate row counts by `date` over the full period. A local slice is one
   recorded day; the server uses `(date, gateway_id)`. If an enumeration fails,
   split its date range and retry smaller ranges, stopping at a single day.
   Track failed days separately from verified zero-row days. If all enumeration
   succeeds and there are no rows, report the empty range and stop without
   manufacturing a report or recommendations.
4. Compute Monday-through-Sunday week buckets clipped to the period, inclusive
   ends, once. Keep these boundaries throughout; label partial buckets with
   their day counts. Never merge quiet weeks or compare a day with a week as
   equivalent amounts.

## Investigation

Keep a small working ledger of slices examined, queries, results, observations,
and figures with their filters and denominators. Assign query labels (`q1`,
`q2`, etc.) so recommendations can name their basis. These are working notes,
not another report page. Do not retain unbounded raw transcript dumps.

Plan coverage before deep reads. Examine every inventoried slice, giving the
largest slices more attention and sweeping the rest in groups of up to 10 days
or about 20,000 rows of source activity. This is a grouping bound, not permission
to dump those rows. Use aggregates and bounded samples.

Launch one `hypaware-analyst` on the heaviest slice first. Use its answer to
refine the questions for the remaining workers, then dispatch independent
assignments together within the host's concurrency limits. Do not serialize
every worker behind the previous answer. Reserve enough assignments for the
coverage sweeps before spending the rest on deep reads. Give each worker only
its assigned slices and question, schema, token rules, and fixed week buckets,
not the whole report inventory, house style, or other workers' transcripts.
Use [analyst-task.md](references/analyst-task.md) as the dispatch prompt.
Each reader returns:

- `summary`: 2 or 3 sentences about the scope.
- `observations`: evidence-backed statements with counts, shares, dates, and IDs.
- `figures`: label, value, and basis (rows, dates, filters, denominator).
- Query labels and recorded turn locators supporting its findings.

Keep cross-date analysis with the coordinator. A collection of daily summaries
is insufficient: run at least one cross-date investigation when the period has
multiple recorded days. Reuse reader figures instead of querying them again.
Mark slices examined only when a worker returns a usable scoped summary.
Failed, interrupted, or out-of-scope assignments remain uncovered. Resolve
worker errors in the coordinator, then narrow or reassign within the budget.

Use the server defaults as ceilings unless the user sets another budget:
12 investigations delegated, 20 SQL queries per reader, 40 coordinator SQL
queries, and 4 recommendation pages. These are ceilings, not overrides of the
installed worker's own instructions: the shipped `hypaware-analyst` agent file
is the source of truth for its per-task query limit and stop-on-error
behavior, not this paragraph. Size its assignments accordingly, and use the
tighter applicable limit. Count failed queries and
reassignments too. Reserve time/context to write and review all pages. A
resource refusal means simplify or split the query, not repeat it unchanged.
If coverage cannot be completed within the budget, disclose the omitted dates
and their known row counts beside affected findings and in the delivery message.

Investigate the questions in the report contract that the record supports.
Compare earlier and later slices, follow failures through recovery, and check
whether a proposed fix was already adopted. Use only user-selected previous
reports for comparisons; measure their recommendations against current-period
data rather than treating old prose as new evidence.

## Write, review, deliver

Write into a new `hypaware-report-<from>-to-<to>/` directory, or the user's
requested destination. Do not overwrite an existing report without instruction.
Save section pages first, then the linked `report.md` brief. Follow the report
contract for content, evidence, and Markdown replacements for server visuals.

Review the complete draft as a separate pass. An independent reviewer, when
available and permitted, receives the pages and the report contract, not the
raw logs, and returns blocking findings, improvements, and a verdict without
editing or querying. Otherwise perform an explicit self-review. Check numbers
and evidence against the working ledger separately. Revise once to address
findings, then recheck changed figures, links, and recommendation artifacts.
Do not call unresolved contradictions or unsupported claims a completed review.

An optional readability pass may simplify sentences but must preserve numbers,
dates, claims, citations, links, and proposed file contents. The server's
readability pass is optional too.

Return the path to `report.md`, the period and local scope, and any incomplete
coverage or review. The output is a proposal: do not install recommended skills,
edit project instructions, change settings, or upload logs. Publishing is an
optional step only when the user requests it, as described below.

## Optional publishing

When the user asks to publish or share the report with their team, upload the
reviewed Markdown directory using the existing CLI. Do not run `hyp report
render` first. The server renders HTML and supplies its own assets.

Use the user's selected remote and the report's actual coverage period. For
example, a report covering August 2026 can be published with:

```sh
hyp report publish ./hypaware-report-2026-08-01-to-2026-08-31 --kind usage-review --period 2026-08 --remote <target>
```

For a custom range, use `YYYY-MM-DD-to-YYYY-MM-DD` as the period. If the team
or destination is unclear, resolve it with the user before uploading. Reuse
existing login credentials; if login is needed, direct the user to
`hyp remote login <target>`. Publishing requires the organization's publisher
role. Ordinary members do not pass `--org`; that flag is for an operator's
admin token.

Upload only the supported Markdown pages, with no working ledger, raw logs,
images, HTML, or assets. The server rejects raw HTML in prose; literal HTML
examples belong in fenced code blocks. Links may use http(s), mailto, page-local
fragments, or other pages in this report. Publishing the report does not
upload its underlying local log dataset.

On success, return the server's report identifier and the CLI receipt's
`hyp report get` command, including the selected `--remote`. Do not claim a
browser URL unless the server or an available tool provides one. On failure,
retain the local report and report the error. Do not silently change its
content, destination, or format, or loop on permission, quota, or rendering
errors. Local generation remains useful when publishing is unavailable.

## Maintenance provenance

Adapted from the **HypAware Server** repository (a separate codebase from this
one) on 2026-09-24: HypAware Server paths `src/reports/prompts.js`,
`agent-generator.js`, `tool-schemas.js`, and `time-skeleton.js` (that repository's
own tree, not this repository's `src/core/reports/`); HypAware Server LLPs 0139,
0143, 0166, 0189, 0190, 0326, 0329, 0333, and 0476 (that repository's `llp/`
numbering, not this repository's, where those numbers name unrelated documents).
These are maintainer references into the server codebase, not runtime
dependencies of this skill. Preserve the analysis and review contract when
updating; server HTML components and hosted evidence URLs do not apply.
