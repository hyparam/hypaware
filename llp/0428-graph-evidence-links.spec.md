# LLP 0428: Action and claim evidence links

**Type:** Spec
**Status:** Active
**Systems:** Graph, Plugins
**Date:** 2026-09-21
**Related:** LLP 0023, LLP 0028, LLP 0064, LLP 0075, LLP 0076
**Extended-by:** LLP 0431 (query cost scoped to traversed neighborhoods)

## Literal actions

Extend the activity connector to recognize complete, literal, awaited
`tools.exec_command` and `tools.apply_patch` expressions in recorded `exec`
wrappers. Never evaluate recorded code. Reject the entire input if any syntax
is unsupported, including conditionals, computed values and quoted examples.
The grammar accepts only direct awaits, optionally inside `text`, with scalar
literal object arguments or a literal string. Bound input to 65,536 characters,
32 calls, 32 object fields, 32 file operands and 4,096 characters per path.
Decode once per row. A rule may expose `toRows` for bounded fan-out; existing
single-row contracts remain supported.

These are inferred calls, not proof of execution or success. Stamp
`props.inferred_call=true` on derived rows and mark the exemplar in
`source_keys.inferred_call`. Neighbor results carry the edge locator and props,
and text output names inferred calls. Actual tool-call rows use the
existing direct path. No new capture event or normalized message is invented.
Shell file derivation accepts concrete operands in a small read-command grammar;
patch derivation accepts explicit patch file headers. Relative paths require a
recorded absolute working directory. Skill reads recognize `.agents/skills`,
`.codex/skills/.system` and versioned plugin-cache roots, and retain the weaker
`dispatch_shell_read` signal. General shell interpretation is out of scope.

## Claim evidence

Every activity exemplar carries original `session_id`, `message_id`, `part_id`
when present. It remains an exemplar, not full merged lineage. Prefer a precise
observed-call exemplar over an inferred one, then use deterministic ordering.

T1 must supply an exact evidence quote of at most 2,000 characters matching one
unique source part. Reject absent, unmatched or ambiguous evidence. Store only
that part's configured message and tiebreak keys, not the entire session.
T2 receives the quote and dereferences its part, with bounded queries and excerpt
size. Committed props retain the quote. A graph enrichment row points first to
its actual `enrichment_committed` row using item, anchor and commit-time keys;
that row's existing source dataset and keys then name the original evidence.
The first hop also locates legacy committed rows, but final dereferencing
refuses their broad or incomplete keys. Re-extraction supplies precise evidence;
refresh prefers a quoted committed exemplar over a legacy unquoted one.

## Visibility

Keep LLP 0105 suppression of graph and enrichment content for restricted
callers. A precise exemplar is not complete visibility lineage for a merged
label or a model-generated claim. Evidence dereferencing must apply the same
caller visibility at every hop, with no implicit local-only override. A hidden
intermediate row stops dereferencing. Making mixed-source labels shareable
requires a separate lineage design; this change does not authorize it.

## Refresh

Default projection remains append-only and skips existing identities.
`graph project --refresh` explicitly re-derives matching rows owned by the same
projector. Reuse the graph maintenance generation swap and refuse concurrent
changes or unreadable partitions. No source recording is changed. Unrelated
projectors and identities remain intact. A failed partial refresh is retryable;
there is no cross-dataset atomicity. Refresh does not retract obsolete identities
or upgrade old enrichment evidence; new T1 extraction needs an explicit backfill.
No automatic version-triggered mutation is introduced. Identities shared with
a different projector are preserved; an ambiguous replacement is refused.

## Query cost

The basic neighbor reader retains its existing semantics below a cap of
100,000 physical rows per graph dataset, with a 128 MiB heap-growth budget per
query and a shared five-second cancellation signal. It explicitly refuses a
read over the row cap. Evidence lookups allow at most two provenance hops and
require exactly one matching row at each hop.
This bounds materialization and traversal, not physical storage scans: predicate
pushdown and cancellation remain the query engine's responsibility. It is not a
persisted adjacency index or a prompt hook. Projection and enrichment remain
offline corpus operations. No retrieval-quality gain is claimed without an
equal-budget comparison.

> **Extended-by: [LLP 0431 §bounded-frontiers](./0431-frontier-scoped-graph-reads.spec.md#bounded-frontiers).**
> The cancellation signal is no longer one shared value. The frontier-scoped
> neighbor traversal arms a thirty-second abort signal and wall-clock deadline,
> so sequential frontier reads on cold or unindexed storage get more time inside
> the same row and payload budgets. Evidence lookups keep the five-second signal.


T1 refuses sessions over 10,000 parts or 2,000,000 transcript characters before
submission, without advancing their watermark. It accepts at most 128 candidates
and searches the bounded source for each exact quote. T2 caps clusters at 16
prospects and batches their locators into one query, avoiding repeated source
scans. It reads at most 641 rows (the last detects overflow), accepts at most
40 legacy keys per prospect, and renders at most 8,000 source characters plus
the bounded proposed quotes. These caps do not bound the existing corpus-wide
session selector, pending-prospect reads, dedup sets, or clustering backlog.

Wrapper extraction retains only the current row's decoded calls. Its temporary
memory is bounded by the input and fan-out caps. Graph refresh streams each
partition and reuses the 10,000-row rewrite batches; its replacement index,
like existing projection state, still grows with the offline graph. No new
busy loop or unbounded persistent cache is introduced.
