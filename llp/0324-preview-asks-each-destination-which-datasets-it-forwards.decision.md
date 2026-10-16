# LLP 0324: The sync preview asks each destination which datasets it would forward

**Type:** Decision
**Status:** Accepted
**Systems:** Sinks, CLI, Usage-Policy
**Author:** Phil / Claude
**Generated-by:** neutral
**Date:** 2026-08-29
**Related:** LLP 0101 (#hold, the coupling this stays inside), LLP 0305 (#eligibility and #start-now, the sink-side rules this makes countable), LLP 0307 (#rollout-instant, the ordering that already narrows #start-now), LLP 0040 (#watermark-contract, the seam the preview reads), LLP 0105 (the local-only content invariant behind the over-count)

> Extends [LLP 0101](./0101-first-sync-review-window.decision.md#hold) and
> [LLP 0305](./0305-open-dataset-central-forwarding.decision.md#eligibility).
> `hyp sync`'s pending preview counts every registered dataset toward every
> destination, but `@hypaware/central` refuses datasets that declare
> `localOnlyContentColumns`, so a central line can quote rows that will never
> leave the machine. The fix is a consultative, preview-only seam: each sink
> may answer, per dataset, whether it forwards it, skips it, or starts it from
> now. The driver, the hold, and the export path do not change. This is a
> decision record: the seam is a cross-plugin contract change and is
> implemented by a follow-up, not by the change that lands this document.

## Context {#context}

`previewPendingRows` (`src/core/sinks/pending.js`) counts what each
destination would send by walking the export's own seam: the per-`(sink
instance, partition)` watermark plus `readRowsSince`. Its partition discovery
enumerates every dataset `query.listDatasets()` returns, with no eligibility
filter, and the same discovered set is counted for every handle.

`@hypaware/central` does not forward everything. `forwardingTarget`
(`hypaware-core/plugins-workspace/central/src/sink.js`) withholds any dataset
declaring `localOnlyContentColumns`, per
[LLP 0305 #eligibility](./0305-open-dataset-central-forwarding.decision.md#eligibility),
and withholds open datasets whose names a legacy ingest path has reserved. On
a machine with `@hypaware/context-graph` active, the preview's central line
therefore includes derived-table rows central will never send. That is
over-disclosure, the safe direction on a consent prompt, but it is materially
wrong on exactly the machines where the derived tables are large, and a
consent surface that overstates teaches the reader to discount it.

The naive fixes both fail:

- **Filter `localOnlyContentColumns` datasets out of the preview
  generically.** A `@hypaware/local-fs` destination *does* export those
  datasets, so the generic filter under-discloses a local destination, the
  one direction the preview must never err in. It would also re-implement
  central's rule in the kernel, the central-sink-allowlist coupling
  [LLP 0305 #eligibility](./0305-open-dataset-central-forwarding.decision.md#eligibility)
  explicitly rejected.
- **Teach the kernel which sinks leave the machine and filter for those.**
  [LLP 0101 #hold](./0101-first-sync-review-window.decision.md#hold) declined
  that registration concept for the export hold ("the driver cannot reliably
  know which sinks leave the machine"), and off-machine-ness is the wrong
  predicate anyway: what central skips is a property of the dataset contract,
  not of the transport.

There is a second over-count in the same direction. A newly eligible open
dataset with no durable watermark reads as "export from the beginning" at the
preview, while central's
[LLP 0305 #start-now](./0305-open-dataset-central-forwarding.decision.md#start-now)
baseline ships none of that history. Verifying this against master narrows
it considerably:
[LLP 0307 #rollout-instant](./0307-durable-open-dataset-rollout-manifest.decision.md#rollout-instant)
moved the baseline write into sink *creation* (`initializeOpenDatasetRollouts`
is awaited before the handle exists), and `hyp sync` materializes sinks in its
own process (`src/core/cli/dispatch.js`) before it previews. So whenever the
preview has a central handle at all, the baselines for datasets eligible at
materialization are already durable and the preview reads them. What remains
is an ordering coincidence, not a pinned contract: nothing forces sink
materialization to precede the preview, and nothing says a future sink with
start-now semantics will baseline at creation.

## Decision

### A consultative dataset-disposition seam on the sink contract {#disposition-seam}

The kernel `Sink` interface gains one optional method:

```ts
datasetDisposition?(dataset: DatasetRegistration):
  'forwards' | 'skips' | 'starts-from-now'
```

The sink answers from its own rules, against the same `DatasetRegistration`
the kernel already holds. The kernel treats the answer as opaque: it never
learns *why* a dataset is skipped, and the eligibility rule itself stays where
[LLP 0305 #eligibility](./0305-open-dataset-central-forwarding.decision.md#eligibility)
put it, declared on the dataset and enforced in the sink. Central's
implementation is the predicate it already has: the four legacy signals answer
`forwards`, a dataset declaring `localOnlyContentColumns` answers `skips`, an
open dataset whose name a legacy path reserves answers `skips`, and every
other eligible open dataset answers `starts-from-now`.

**Superseded-by:** [LLP 0327](./0327-central-is-not-a-start-now-sink.decision.md).
The mapping's final clause only, and it is the part that is replaced: an
eligible open dataset answers `forwards`, not `starts-from-now`. Central
writes its rollout baselines at sink creation
([LLP 0307 #rollout-instant](./0307-durable-open-dataset-rollout-manifest.decision.md#rollout-instant)),
so a partition with no durable watermark is post-rollout and its backlog
forwards in full
([LLP 0307 #future-partitions](./0307-durable-open-dataset-rollout-manifest.decision.md#future-partitions)),
save for one integrity state LLP 0327 names where it forwards nothing and
`forwards` merely over-quotes;
`starts-from-now` would make the prompt quote that backlog as zero while the
next export shipped it, the under-disclosure [#drift-pinned](#drift-pinned)
forbids. The seam itself, the other three answers in this mapping, and the
[#starts-from-now](#starts-from-now) semantics for a sink whose baseline is
not written at creation all stand.

### The seam is preview-only and never gates an export {#preview-only}

Only `previewPendingRows` consults the disposition. The driver keeps handing
every discovered partition to every sink, sink-side enforcement
(`forwardingTarget`) stays the authority on what actually ships, and the
first-sync hold stays driver-wide exactly as
[LLP 0101 #hold](./0101-first-sync-review-window.decision.md#hold) settled:
this seam carries no off-machine knowledge and cannot hold or release
anything. A consent surface reading evidence the export path does not act on
is the established pattern here: `hyp sync` already derives its "leaves this
machine" note from instance config without teaching the driver anything.

### Absence, error, and novelty all read as `forwards` {#fail-open-loud}

A sink without the method, a call that throws, and an answer the preview does
not recognize are all counted as `forwards`. The degraded direction is
over-disclosure, today's behavior: `@hypaware/local-fs` and `@hypaware/s3`
implement nothing and keep their exact counts.

### `skips` removes the dataset from that destination's count entirely {#skips}

A skipped dataset's partitions contribute to neither the pending tally nor the
withheld tally for that destination. The withheld line means "the export seam
drops these rows as it advances the cursor" (LLP 0070); a skipped dataset's
cursor never advances and its rows are not a policy outcome, so folding them
into `withheldRows` would overstate policy activity. Whether the plan should
additionally *name* the datasets that stay local is left to the implementing
change as rendering, not decided here.

### `starts-from-now` makes a missing watermark mean zero, not the beginning {#starts-from-now}

For a `starts-from-now` dataset, a partition with no durable watermark
contributes zero pending rows and does not force the destination's resume
range to `beginning`. A partition *with* a watermark counts incrementally,
unchanged. This pins the [LLP 0305 #start-now](./0305-open-dataset-central-forwarding.decision.md#start-now)
semantics into the preview instead of relying on the
[LLP 0307 #rollout-instant](./0307-durable-open-dataset-rollout-manifest.decision.md#rollout-instant)
ordering staying true, and it keeps the preview honest for any future sink
whose baseline is not written at creation. A zero produced this way is a
*counted* zero, the sink's real answer, so the false-zero guard (a degraded
count must never render as "nothing pending") does not apply to it.

### Drift toward under-disclosure is pinned by the parity test {#drift-pinned}

The one hazard this seam introduces is a sink whose disposition says `skips`
or `starts-from-now` while its export path ships the rows anyway: the preview
would then under-disclose, the failure class it exists to avoid. The
implementing change must extend `test/core/sink-seam-parity.test.js`, by name
per that file's own scope rule: every dataset central's `exportBatch`
actually forwards must be one its disposition admits, and a missing-watermark
eligible open dataset's first export must ship zero rows, matching
`starts-from-now`. That moves `writeHistoryBaseline` from the test's named
out-of-scope list into scope. The multi-destination rendering belongs in
`test/core/sync-pending-volume.test.js`: a central handle and a local-fs
handle over one `localOnlyContentColumns` dataset must quote different
numbers.

## Alternatives considered

- **Filter on `localOnlyContentColumns` in the kernel preview.**
  Under-discloses local destinations and duplicates central's rule in the
  kernel. Rejected above ([#context](#context)).
- **A declarative registration field instead of a method.** Central's rule
  needs the dataset registration and already exists as code; a declarative
  mirror is a second copy that can drift silently, and the parity test can
  only pin behavior, not data someone forgot to update.
- **A per-sink dataset allowlist in config.** Pushes a privacy-relevant
  judgement onto every operator and drifts from the sink's actual behavior by
  construction.
- **Accept the over-count.** It is safe but not small: the highest-stakes
  reading of the preview is the all-or-nothing first-sync release
  ([LLP 0101 #no-release](./0101-first-sync-review-window.decision.md#no-release)),
  and context-graph tables can dwarf the rows central will actually send.

## Consequences

- This is a cross-plugin contract change: `hypaware-plugin-kernel-types.d.ts`
  (the optional `Sink` method), `src/core/sinks/pending.js` (consulting it),
  `@hypaware/central` (answering it), and the two named tests. It is decided
  here and implemented by a follow-up change; nothing in the change that
  lands this document alters behavior.
- Until the follow-up lands, the preview keeps today's over-disclosure, which
  remains the safe direction.
- The budget question (how the preview spends its wall clock across
  destinations) is deliberately not part of this seam; it is settled
  separately in [LLP 0325](./0325-preview-budget-cumulative-per-destination-deadlines.decision.md).
