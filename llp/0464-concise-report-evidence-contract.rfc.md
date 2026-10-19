# LLP 0464: A concise report evidence contract

**Type:** RFC
**Status:** Draft
**Systems:** Reports, Plugins
**Date:** 2026-10-05
**Extends:** LLP 0196, LLP 0436
**Related:** LLP 0035, LLP 0390, LLP 0450

@ref LLP 0196#constraints-not-layout [extends]: preserve analytical invariants without prescribing sentence counts or investigation order
@ref LLP 0436#skill [extends]: retain delegated Markdown generation and optional publishing
@ref LLP 0035#one-carrier [constrained-by]: within-response carrier placement is distinct from identity across captures

## Problem

The restored local skill accumulated 579 lines across its entrypoint and three
references. Worker outputs, review, analytical questions, and publishing rules
repeat. The investigation menu favors visible errors, while exact word and
sentence counts make formatting compete with finding useful recommendations.

There is also a correctness boundary the old simplification missed: the
one-carrier rule concerns a captured response's parts. In the September 1 to
October 4 report, distinct native and OpenTelemetry messages plus historical
partial/final updates carried the same provider request. Summing carriers gave
262,398,752 output tokens; verified request identity gave 192,384,696. Selecting
only the CLI lane also dropped unmatched requests. This extends LLP 0196's
plain-SUM advice for datasets with overlapping captures, without changing
capture normalization or the meaning of net input.

## Requested guidance {#guidance}

Keep scope, coverage, delegation budgets, and delivery in the entrypoint. Keep
analysis in the report contract and shared page requirements under query; let bounded experiments and
workflow decisions be usable recommendation artifacts alongside patches. Rank
by outcome improvement and evidence, not ease of producing a patch. Recommendation count follows the
evidence and usefulness, with no fixed cap or required mix of types.

Keep the analyst assignment in one template and publishing in a reference read
only when requested. Preserve host-specific worker selection, registered-dataset
and privacy boundaries, safe query shapes, period coverage disclosure, and
independent or explicit self-review. Preserve Markdown page names and linked
recommendation headings used by the hosted renderer. Evidence pages accompany
substantive analysis; small reviews can keep it in the brief and proposals. Publishing commands must
match the installed CLI; a skill cannot supply an unavailable subcommand.

Before aggregating historical usage, verify provider/source identities and
stream semantics. For proven copies of a response, retain one final record's
counters together, including unmatched captures. Missing identities are not a
shared key. Do not prescribe a universal SQL dedup key for every provider or
mistake byte proxies for tokens. Reconcile workers on one accounting basis.
The report worker must not override this with an unconditional plain-SUM rule.

The original report skill was adapted from the separate HypAware Server's
report workflow on September 24. Those server prompts remain a maintainer
reference, not runtime dependencies or a promise of identical local behavior.
This request changes the local skills and worker guidance, not server prompts.

## Interactive scope and current evidence {#interactive-scope}

Local reporting answers the user's question interactively. Default to the last
7 days including today; an omitted end date means now. "Last week" means the
last seven days including today unless the user explicitly requests a calendar
week. Use calendar month or week boundaries only when specifically requested.
Ask before resolving unclear periods, such as "last month", instead of assuming
an entire calendar month. Honor clearly specified date ranges and state absolute
dates and timezone. Mark today partial and disclose
query time and cache freshness. Remove the closed-period and 365-day restrictions;
query budgets still bound work. Comparison buckets follow the question.
Before a new single-recommendation investigation, ask for a period if none was
stated or established in the conversation. Suggest the last seven days through
today, but wait for an answer. Ask for focus when absent, for both recommendations
and full reports; an explicit general overview is sufficient. Bundle missing
scope questions and reuse established answers. Already scoped findings and
implementation of existing recommendations require no new period question.
Single recommendations use narrow bounded reads and a chat answer by default;
they require neither a full report nor a page.

Adapt the server's latest-state, cross-section selection, and concrete-handoff
guidance (server LLPs 0530, 0544-0546, 0573, and 0583). Check later relevant
outcomes and material remedy assumptions before selecting an action. An unknown
fix can yield a targeted investigation with a completion test allowing no change.
Repair survey gaps before new deep investigations. Keep local query budgets,
optional supporting pages, and evidence-driven recommendation counts. Summary
bullets need not each carry a number; qualitative findings and unknown effects
must not become invented metrics. Server orchestration, mandatory page sets,
larger budgets, and closed-period scheduling do not become local requirements.

## Skill ownership {#ownership}

Query owns interactive investigation, quick recommendations, and report mechanics.
Its `reports.md` holds shared artifact formats, saving, upload, listing, retrieval,
and recommendation status/implementation guidance. Load it only for those tasks.
Report owns full-period generation, delegated analysis, synthesis and review;
it consults query's shared reference for artifacts and delivery. Investigation
depth alone does not promote a quick recommendation into the report workflow.
Reference explains the product and routes operational requests. Privacy retains
audits and owns direct recording controls without requiring an audit. Move the
existing controls there without changing capture behavior or authorization.
Preserve both hosts' discovery metadata and their existing host-specific rules.

## Conditional query guidance {#conditional-query}

Keep hazard warnings and required-reading triggers in query's entrypoint.
Move text-search details, remote rules, AI message accounting/identity, graph
procedures, and quick recommendation analysis to task-specific references.
Require the accounting reference before token measurements: overlapping captures
and stream updates can double-count responses; missing usage is unknown.
Keep bounded execution, error/coverage checks, and the captured-content boundary
visible to every query. Move recommendation-specific provenance guidance alongside
recommendation analysis. Both host copies retain the same routing and safeguards.

Implementing a published recommendation includes status tracking: retrieve and
check it, mark in_progress when work begins, and mark applied after the requested
implementation and required verification complete. Incomplete or failed work
stays in_progress. Landing is required when part of the requested scope; a local
completed change does not require an unsolicited merge. Inspect write receipts
and disclose failed status updates. Command details live in query's reports.md.

## Validation and cost {#validation}

Run existing host parity, skill-constraint, captured-content boundary, and
manifest checks; validate skill metadata and relative links. Use a bounded
synthetic report exercise to check recommendation quality, unsupported causality,
capture overlap, missing usage, and embedded instructions. Do not treat prose
checks alone as evidence that a report will be insightful.

CPU and memory: no runtime implementation, new dependency, or background state.
The skill is shorter and keeps query/delegation ceilings, bounded samples, and
wide-column restrictions. Identity checks use narrow projections; they are not
permission for unbounded raw dumps or parallel wide scans.
