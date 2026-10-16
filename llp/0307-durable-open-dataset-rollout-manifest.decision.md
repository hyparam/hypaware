# LLP 0307: Durable open-dataset rollout manifest

**Type:** Decision
**Status:** Accepted
**Systems:** Sinks, Cache, Plugins
**Author:** Phil / Codex
**Date:** 2026-08-24
**Related:** LLP 0014, LLP 0040, LLP 0305

> Extend LLP 0305's start-now migration with dataset-level rollout state. The
> central sink baselines partitions present when the sink instance starts,
> records that set durably, and starts partitions created later at sequence
> zero. A known partition whose progress is missing or invalid fails closed.

## Context

LLP 0305 used the absence of a partition watermark to identify a partition
that existed before open-dataset forwarding became available. That state is
ambiguous. The same absence also describes a cold machine's first partition, a
new source partition created after rollout, and an established partition whose
watermark file was deleted or became corrupt.

Treating all four cases as rollout history loses new rows. In particular,
Claude advertises a spool partition named `all`, while cache flush can commit
its rows into `source=unknown`. The sink driver can discover that new committed
partition during the same tick. A per-partition first-seen baseline then skips
the first fresh Claude batch. Treating every absent watermark as sequence zero
would avoid that loss but would replay pre-rollout history, contrary to the
explicit no-backfill requirement.

The missing fact is not another cursor value. It is whether the logical
dataset rollout has already happened and which partitions belonged to it.

## Decision

### Rollout happens when the sink instance is created {#rollout-instant}

For every eligible open dataset, `@hypaware/central` initializes rollout state
while the configured sink instance is being created, before scheduled exports
can begin. It discovers current partitions, flushes pending spools, and
rediscovers so a flush-time repartition such as `all` to `source=unknown` is
part of the same snapshot.

An empty dataset still gets an initialized manifest with no partition keys.
This is how a cold machine distinguishes "rollout completed before any rows"
from "first seen partition contains old history."

### Existing partitions baseline before the manifest commits {#existing-partitions}

Every materialized partition in the rollout snapshot gets a durable watermark
at its current sequence high-water and sends no rows. Existing watermark files
are preserved, including after a crash partway through initialization. Only
after every baseline write succeeds does the sink atomically write the dataset
manifest containing the stable logical partition keys.

The ordering is:

1. discover, flush pending spools, and rediscover;
2. write any missing partition baselines;
3. atomically commit the initialized dataset manifest.

A crash before step 3 retries without moving baselines already written. Rows
that arrived after those baselines remain above the cursor and forward once the
manifest commits.

### Future partitions start at zero {#future-partitions}

After the manifest exists, a partition key not in it is post-rollout. The sink
atomically writes sequence-zero progress first, then atomically adds the key to
the dataset manifest, then performs the ordinary incremental export. Its first
rows therefore forward.

A crash between the zero watermark and manifest update is safe: retry observes
the zero watermark, preserves it, and finishes admitting the key. A crash after
manifest update is safe because the progress write happened first.

Dataset rollout initialization and manifest updates are serialized within the
sink instance. Partition exports retain their separate serialization, so
overlapping scheduled ticks cannot admit or export the same new partition
twice.

### Missing progress for a known partition fails closed {#missing-progress}

Once the manifest names a partition, a missing, unreadable, or malformed
watermark is an integrity failure. The sink neither replays from zero nor
rebaselines at the current high-water. It leaves the partition retryable and
reports the local state error for operator repair.

The shared watermark store intentionally returns `null` for all three invalid
states because its default recovery policy is at-least-once replay. The
dataset manifest supplies the central open-dataset policy with the context to
interpret that `null` differently without changing legacy signals or other
sinks.

### The manifest is local per sink instance {#durable-manifest}

Each record lives beside that sink instance's watermarks:

```text
<plugin-state>/sink-instances/<instance>/open-dataset-rollouts/<dataset>.json
{ "v": 1, "partitions": ["source=unknown"],
  "initializedAt": "<iso>", "updatedAt": "<iso>" }
```

Writes use atomic temp-file plus rename. A malformed manifest throws and blocks
initialization. Deleting the complete sink-instance state loses both the
manifest and its watermarks; on restart the sink safely treats current rows as
rollout history and baselines them again. This can withhold rows captured while
state was absent, but it does not duplicate historical data. Recovering those
rows automatically would require a server-side per-gateway high-water or
another durable authority and is outside this patch.

### Reserved legacy names require an explicit matching signal {#reserved-names}

The dataset names `logs`, `traces`, `metrics`, and `proxy` are reserved wire
paths. A registered dataset may use one only when its explicit `sourceSignal`
matches the same legacy name. The dataset-name default is never enough to claim
a reserved route, and an explicit different signal is rejected before ingest.

## Consequences

- Existing Claude OTEL history is not backfilled when this release is adopted.
- A cold machine's first Claude OTEL partition forwards from its first row.
- A later source partition forwards from its first row rather than being
  mistaken for rollout history.
- Lost or corrupt established progress becomes visible as a retryable local
  state failure instead of silently skipping pending rows.
- Rollout initialization scans each existing open-dataset partition once.
- Complete local sink-state deletion remains a conservative data-loss case,
  not a duplicate-replay case.

## Alternatives considered

- **Keep per-partition missing-watermark baselines.** Rejected because a new
  partition and an old partition have the same local state, causing the first
  rows of cold or dynamically partitioned datasets to be skipped.
- **Start every missing watermark at zero.** Rejected because an upgrade would
  replay the historical Claude OTEL rows the rollout explicitly excludes.
- **Infer rollout from watermark files alone.** Rejected because missing and
  corrupt progress are deliberately collapsed by the shared store, and file
  presence cannot record an empty dataset rollout.
- **Use only an in-memory first-seen set.** Rejected because daemon restart
  would restore the ambiguity and could either replay history or skip new rows.
