# LLP 0014: Sinks

**Type:** Spec
**Status:** Active
**Systems:** Sinks
**Author:** Phil / Claude
**Date:** 2026-06-01
**Related:** LLP 0010, LLP 0013, LLP 0025

> Export targets and the export driver. Decomposed from `hypaware-design.md`
> (Sinks).

## Sinks are export targets, not the write path

Sinks receive data **out of the cache** ([LLP 0013](./0013-local-query-cache.decision.md))
on a configurable schedule and ship it somewhere durable. The two are decoupled:
sources write to the cache only; the export pipeline reads the cache and pushes
to sinks. The cache is the recent-query story; sinks are the long-term-storage
and downstream-integration story.

## Two sink shapes

"Destination" is two different kinds of thing:

1. **Blob destinations** — local filesystems and object stores
   (`@hypaware/local-fs`, `@hypaware/s3`, future `@hypaware/gcs`). Accept "put
   these bytes at this path." Format is separable.
2. **Request destinations** — endpoints with their own wire protocol
   (`@hypaware/webhook`, `@hypaware/central`). Accept "send this structured
   payload via my protocol." Format is bound to the destination.

## Bytes flow down, semantics flow up

For blob destinations, format is factored into **writer plugins**:

```text
Blob destinations     provide: hypaware.blob-store     @hypaware/local-fs, @hypaware/s3
Encoders (per-batch)  require: hypaware.blob-store      @hypaware/format-parquet, @hypaware/format-jsonl
                      provide: hypaware.encoder
Table formats         require: blob-store + encoder     @hypaware/format-iceberg
                      provide: hypaware.table-format
Request destinations  (no separable format)             @hypaware/webhook, @hypaware/central
```

The Parquet writer doesn't know whether it writes to local disk or S3; the S3
plugin doesn't know whether it holds Parquet, JSONL, or an Iceberg manifest.
Iceberg-on-S3 and Parquet-on-S3 share one S3 plugin. Adding GCS later is one
plugin and every existing writer works.

## Export layout is the writer's, not the cache's

A table-format writer lays data out for the **archive's** job, which is not the
cache's job. The `@hypaware/format-iceberg` writer partitions exported tables by
a writer-owned **day grain** and sorts each partition by the dataset's lookup
key — deliberately *not* inheriting the cache's `cachePartitioning`, which is
tuned for recent-query lookups and would impose an unbounded per-conversation
file count on an archive. See [LLP 0022](./0022-iceberg-export-partitioning.spec.md).

## Export contract

A sink implements an export contract — not a per-row writer:

```ts
interface Sink {
  exportBatch(batch: ExportBatch, opts: ExportOptions): Promise<ExportResult>
  flush?(): Promise<void>
  close(): Promise<void>
}
```

`exportBatch` is called on the configured schedule with a batch of ready cache
partitions; the sink writes them and acks.

## Forward sink backpressure

`@hypaware/central` is a request sink: `exportBatch` POSTs each partition's rows
to the server in bounded chunks. The server rate-limits per gateway, so a chunk
can come back `429`/`503` carrying a `Retry-After`. The sink treats this as
**backpressure, not failure**:

- It **retries the same chunk in place** — byte-identical body and
  `X-Hyp-Batch-Id` — so the re-send is idempotent (the server dedupes the
  already-delivered prefix; server LLP 0001).
- It honors a **positive** `Retry-After`. An absent, garbage, or **non-positive**
  value (a legal `Retry-After: 0` and a past HTTP-date both parse to `0`) carries
  no useful pacing and falls back to the linear ladder (`30→60→120→300s`). Taking
  a zero verbatim would retry with no delay and spin the loop; the ladder
  guarantees every wait advances so the inline budget can bound it. The same rule
  governs the config pull loop ([LLP 0025](./0025-remote-config-join-flow.spec.md#config-pull-loop)).
- The inline wait per chunk is **bounded** (~5 min). Past the budget the chunk
  throws and the export driver respools the partition (`ExportResult.retryPartitions`)
  on the next scheduled tick — cheap, because the server has already deduped what
  landed.
- The wait is **abortable**: `close()` aborts an in-flight pause so daemon
  shutdown is never wedged by a parked chunk.

The wire contract for these statuses lives in `@hypaware/central`'s `proto.md`
("Response 429 / 503").

## Config: two shapes

Blob sinks compose a `writer` + `destination`; request sinks are one-piece
(`plugin`). Both carry `schedule`. See [LLP 0010](./0010-config-model.spec.md#sinks-block).

```json
{ "sinks": {
    "archive":  { "writer": "@hypaware/format-iceberg", "destination": "@hypaware/s3",
                  "config": { "bucket": "acme-hyp-archive", "schedule": "0 * * * *" } },
    "forward":  { "plugin": "@hypaware/central",
                  "config": { "endpoint": "https://hypaware.acme.internal", "schedule": "*/5 * * * *" } } } }
```

`schedule` is a standard **5-field cron expression** — chosen over a friendly
DSL because cron expresses "02:00 UTC nightly" naturally and the kernel parses
one grammar. The kernel validates writer/destination compatibility at
config-load time: `format-parquet` + `@hypaware/webhook` is rejected with an
explicit message (writer requires `hypaware.blob-store`; webhook provides
`hypaware.http-endpoint`) — so the failure is configuration, not runtime.

## Queryable sinks

Sinks declare what they support via the `supports` list in their manifest
(renamed from `capabilities` to avoid clashing with the global registry).
Recognized tag at V1: **`queryable`**. Queryability of a blob sink is a property
of the resolved writer/destination pair — Parquet-on-local-fs is queryable,
JSONL-on-local-fs is not. A queryable sink adds a read API; `hypaware query`
scans its data in place and queries transparently span cache + sink. If no
queryable sink is configured, queries run against the cache and retention bounds
the horizon.

**Default install.** The walkthrough installs `@hypaware/local-fs` +
`@hypaware/format-parquet` together when the user picks "export to a local
directory," so the common case still feels like one decision; the two-package
shape only surfaces for non-default pairings.
