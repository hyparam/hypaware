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
analysis and page requirements in one contract; let bounded experiments and
workflow decisions be usable recommendation artifacts alongside patches. Rank
by outcome improvement and evidence, not ease of producing a patch. A fixed
mix of recommendation types is not required.

Keep the analyst assignment in one template and publishing in a reference read
only when requested. Preserve host-specific worker selection, registered-dataset
and privacy boundaries, safe query shapes, period coverage disclosure, and
independent or explicit self-review. Preserve Markdown page names and linked
recommendation headings used by the hosted renderer. Publishing commands must
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
This request changes the local skill and its worker guidance, not server prompts.

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
