# LLP 0013: Local Query Cache

**Type:** Decision
**Status:** Active
**Systems:** Cache
**Author:** Phil / Claude
**Date:** 2026-06-01
**Related:** LLP 0012, LLP 0014, LLP 0015

> The always-on intrinsic store. Decomposed from `hypaware-design.md`
> (Local Query Cache).

## Intrinsic, not a sink

The cache is the always-on intrinsic store for captured data. It is **not a
plugin** and **not configurable as a destination**. Its location is
HypAware-managed (under `~/.hyp/hypaware/` by default; an admin can relocate the
root, but the layout inside is fixed) and its on-disk format is an
implementation detail. If you want data in a layout, location, or format you
control, you configure a **sink** ([LLP 0014](./0014-sinks.spec.md)) — the cache
is how you *don't*.

## Write path and query

Every row a source produces is written into the cache; sources never see sinks
([LLP 0012](./0012-sources.spec.md)). `hypaware query` runs against the cache
([LLP 0015](./0015-query-and-datasets.spec.md)).

## Retention is the central tradeoff

Retention is **configurable per dataset**. Rows older than the window are
**deleted permanently** — if the data wasn't exported to a sink before then,
it's gone. The cache is recent-data-only by design, and this is the tradeoff to
surface to users.

```json
{ "query": { "cache": { "retention": { "default_days": 30, "datasets": { "logs": 7 } } } } }
```

Default retention is 30 days. A deployment with no export sink relies entirely
on this window. A deployment that pairs the cache with a **queryable sink**
(local-fs+parquet, or S3+iceberg) gets recent queries served locally and
historical queries reaching into the sink, transparently
([LLP 0014](./0014-sinks.spec.md#queryable-sinks)).

## Open question

**Cache eviction vs. export coupling** — should the cache wait to evict a
partition until all configured sinks have acked their export, or evict purely on
retention? Retention-only is simpler; ack-coupled protects against data loss
when a sink is slow. Unresolved; see [LLP 0000](./0000-hypaware.explainer.md).
A reserved `wait_for_sink_ack` retention knob was once parsed (but never wired);
it has been removed from the config surface until this question is decided, so
the option will reappear only alongside a real implementation.
