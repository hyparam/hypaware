# LLP 0014: Sinks

**Type:** Spec
**Status:** Active
**Systems:** Sinks
**Author:** Phil / Claude
**Date:** 2026-06-01
**Related:** LLP 0010, LLP 0013

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
