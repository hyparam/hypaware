# LLP 0327: Central is not a start-now sink

**Type:** Decision
**Status:** Accepted
**Systems:** Sinks, Plugins, Usage-Policy
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-08-30
**Supersedes:** LLP 0324#disposition-seam (the central mapping's final clause
only, "every other eligible open dataset answers `starts-from-now`"; the seam
itself, the three answer semantics, and every other section of LLP 0324 stand)
**Related:** LLP 0305, LLP 0307, LLP 0324

> [LLP 0324](./0324-preview-asks-each-destination-which-datasets-it-forwards.decision.md)
> designed the disposition seam and, in the same sentence, prescribed
> central's answers, ending with "every other eligible open dataset answers
> `starts-from-now`". Applied to the sink
> [LLP 0307](./0307-durable-open-dataset-rollout-manifest.decision.md)
> actually built, that clause produces the exact under-disclosure
> [LLP 0324 #drift-pinned](./0324-preview-asks-each-destination-which-datasets-it-forwards.decision.md#drift-pinned)
> forbids: central baselines its cursors at sink creation, so a partition
> with no durable cursor is post-rollout and forwards in full, while
> `starts-from-now` would quote it as zero. This decision records what the
> implementation (PR #1096, merged as `5067cae7`) already does and why:
> central is not a start-now sink, an uncursored central partition forwards
> in full, and central answers `forwards` for every eligible open dataset.
> Nothing else in LLP 0324 changes.

## Context {#context}

Four settled facts, three of them inside LLP 0324 itself, cannot all be
honored by the mapping clause:

1. [LLP 0324 #disposition-seam](./0324-preview-asks-each-destination-which-datasets-it-forwards.decision.md#disposition-seam)
   prescribes central's mapping and ends "every other eligible open dataset
   answers `starts-from-now`".
2. [LLP 0324 #starts-from-now](./0324-preview-asks-each-destination-which-datasets-it-forwards.decision.md#starts-from-now)
   defines what that answer means: a partition with no durable watermark
   contributes zero pending rows at the consent prompt.
3. [LLP 0324 #drift-pinned](./0324-preview-asks-each-destination-which-datasets-it-forwards.decision.md#drift-pinned)
   forbids a disposition more restrictive than the export it describes: the
   prompt must never quote less egress than the export ships.
4. [LLP 0307 #rollout-instant](./0307-durable-open-dataset-rollout-manifest.decision.md#rollout-instant)
   writes central's rollout baselines while the sink instance is being
   created, and
   [LLP 0307 #future-partitions](./0307-durable-open-dataset-rollout-manifest.decision.md#future-partitions)
   admits any partition the manifest does not name at sequence zero, so its
   first rows forward.

Facts 2 and 4 make the states disjoint. For a central sink, "no durable
watermark" never means "history this sink will skip"; every partition that
existed at rollout already carries a baseline cursor, so an uncursored
partition is one that appeared afterwards, and LLP 0307 forwards its whole
backlog. Answering `starts-from-now` for such a dataset makes the preview
quote that backlog as zero while the next `exportBatch` ships it, which is
precisely what fact 3 forbids. The mapping clause and the rest of the same
document are in contradiction, and the contradiction was live, not
theoretical: review round 1 of PR #1096 observed the preview quoting 0 rows
over a post-rollout partition whose next export shipped 4.

LLP 0324 saw the boundary and stepped over it. Its own #context traces the
LLP 0307 ordering and concludes the preview usually reads durable baselines,
then #starts-from-now keeps the answer anyway as insurance for "any future
sink whose baseline is not written at creation". That insurance is right,
and this decision keeps it on the seam. What the mapping clause got wrong is
the sink it assigned the answer to: central is exactly the sink whose
baseline *is* written at creation, so central is the one sink that must not
give that answer.

LLP 0324 is Accepted and stays a record; per the corpus rules the clause is
not edited there. This document supersedes the clause, LLP 0324 carries a
scoped `Superseded-by:` note at #disposition-seam, and everything else in
LLP 0324 remains the design of record for the seam.

## Decision

### An uncursored central partition forwards in full {#uncursored-forwards}

For `@hypaware/central`, a partition with no durable watermark is a
post-rollout partition. Rollout state is established at sink creation
([LLP 0307 #rollout-instant](./0307-durable-open-dataset-rollout-manifest.decision.md#rollout-instant)),
every partition present then is baselined before the manifest commits, and a
key the manifest does not name is admitted at sequence zero and forwarded
([LLP 0307 #future-partitions](./0307-durable-open-dataset-rollout-manifest.decision.md#future-partitions)).
The state `starts-from-now` speaks about therefore means the opposite for
this sink: not "history that ships nothing" but "a backlog the next export
sends in full".

### Central answers `forwards` for every eligible open dataset {#central-answers-forwards}

Central's disposition mapping is: the four legacy signals answer `forwards`,
a dataset declaring `localOnlyContentColumns` answers `skips`, an open
dataset whose name a legacy ingest path reserves answers `skips`, and every
other eligible open dataset answers `forwards`. The last clause supersedes
[LLP 0324 #disposition-seam](./0324-preview-asks-each-destination-which-datasets-it-forwards.decision.md#disposition-seam)'s
`starts-from-now` prescription.

The cost is a bounded over-count in one state: a dataset eligible at sink
materialization is quoted incrementally from its durable baseline anyway, so
the answers only diverge on a partition created after rollout, where
`forwards` quotes the real backlog the export will ship. Over-disclosure is
the direction
[LLP 0324 #fail-open-loud](./0324-preview-asks-each-destination-which-datasets-it-forwards.decision.md#fail-open-loud)
already accepts for every degraded path; under-disclosure is the direction
[#drift-pinned](./0324-preview-asks-each-destination-which-datasets-it-forwards.decision.md#drift-pinned)
exists to prevent. Between a preview that may quote rows about to ship and
one that reads "nothing pending" over rows the next export sends, the seam's
own rules pick `forwards`.

Central answers from `datasetForwardingVerdict`, the same predicate its
export path enforces, rather than from a restated copy of these rules. A
second copy of a privacy verdict is a copy that can drift toward promising
less egress than occurs.

### `starts-from-now` stays on the seam, for the sink it fits {#seam-stands}

Everything else in LLP 0324 stands unchanged: the consultative seam shape,
preview-only scope (#preview-only), fail-open-loud degradation
(#fail-open-loud), `skips` semantics (#skips), the `starts-from-now`
counting rule (#starts-from-now), and the parity obligation (#drift-pinned).
The `starts-from-now` answer remains on the kernel contract for the sink
LLP 0324 built it for: one whose export really would ship nothing from an
uncursored partition because its baseline is not written at creation. The
published `DatasetDisposition` contract says so, and
`test/core/sink-seam-parity.test.js` pins both directions behaviorally:
central's export forwards only what its disposition admits, including the
post-rollout partition where a start-now answer would have under-disclosed,
and a disposition more restrictive than its export is caught, not trusted.

## Record {#record}

- The finding that forced the divergence was high severity and observed
  live in review round 1 of PR #1096: with central answering
  `starts-from-now`, the preview quoted 0 rows while the next `exportBatch`
  shipped 4, from a partition created after rollout.
- PR #1096's merged body (head `57b922c4`, merge `5067cae7`) is stale
  against its own head. It describes the pre-round-1 behavior, an eligible
  open dataset answering `starts-from-now` with the preview and export
  agreeing on zero, and quotes a scenario name, "a missing-watermark
  eligible open dataset's first export ships zero rows, and the preview says
  so", that the merged head replaced with "a partition created after rollout
  is quoted, not counted as a start-now zero". The merged code and tests
  implement this decision; the PR prose does not, and this note is the
  correction of record since a merged PR body is not usefully editable.

## Consequences

- No behavior changes. This document is the design record for code that is
  already on master: central's `datasetDisposition`
  (`hypaware-core/plugins-workspace/central/src/sink.js`), the parity
  scenarios in `test/core/sink-seam-parity.test.js`, and the
  `DatasetDisposition` doc comment in `hypaware-plugin-kernel-types.d.ts`
  carry `@ref`s here.
- A future sink author reading LLP 0324 alone could reintroduce the bug by
  copying the mapping sentence. The scoped `Superseded-by:` note at
  LLP 0324 #disposition-seam, this document, and the published contract's
  warning are the guards, and the parity test converts the mistake from a
  silent under-disclosure into a test failure for any sink it covers.
