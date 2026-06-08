# LLP 0015: Query, Datasets, and Collect

**Type:** Spec
**Status:** Active
**Systems:** Query
**Author:** Phil / Claude
**Date:** 2026-06-01
**Related:** LLP 0013, LLP 0016

> The intrinsic query surface and the `collect` on-ramp. Decomposed from
> `hypaware-design.md` (Query and Datasets, Collect Command).

## Query is intrinsic

Query and Iceberg storage are intrinsic services. Plugins register datasets;
core handles SQL, cache cursors, freshness, and output formatting.

```js
ctx.query.registerDataset({
  name: 'gascity_messages',
  plugin: '@hypaware/gascity',
  schema: GASCITY_SCHEMA,
  primaryTimestampColumn: 'event_time',
  discoverPartitions: discoverParts,
  refreshPartition,
  createDataSource,
})
```

A dataset contribution owns: name and schema, source discovery (where raw
partitions live), source-to-row materialization (`refreshPartition`), direct
parquet discovery where there's no JSONL stage, and dataset-specific canned
query helpers.

**Core does not hard-code dataset names.** `hypaware query` asks the registry;
`hypaware schema gascity_messages` works because the gascity source registered
its schema — not because core knows what gascity is.

## Collect: the ad-hoc on-ramp

`hypaware collect` registers an external JSONL file (or glob) the user already
has on disk as a queryable table **without writing a plugin**. It is a **core
command**, not a plugin contribution, because the collection lands in the
intrinsic cache and rides the same dataset registry, partition discovery, and
refresh machinery as any plugin-owned dataset. The only difference is who
registers the dataset entry — the user at the CLI, instead of a plugin at
activation.

```text
hypaware collect <file.jsonl> --name <name> [--replace] [--timestamp-column <field>]
hypaware collect --glob <pattern> --name <name> [...]
hypaware collect list
hypaware collect remove <name-or-table>
```

On `collect <add>` core: normalizes `--name` to a SQL-safe table name; persists
a collection entry under the recording root; registers a synthetic dataset (a
file → one partition; a glob → one partition per matched file, so one table can
span many files); runs a one-shot cache refresh; and prints the resolved table
name and a ready-to-run query.

### Collections are per-host state

Collections are stored under the recording root, **not in the v2 config file**.
They are per-host state (analogous to the lock file) — a collection points at
paths/globs only meaningful on the machine that ran `collect`. A team that wants
the same table everywhere should ship a plugin that registers the dataset, not a
synced collections list.

### Intentionally narrow

`collect` does not transform rows, infer schemas beyond the JSON shape, or own a
daemon lifecycle. The `--timestamp-column` hint is what lets `--from`/`--to`/
`--since` filtering work; without it the column is opaque. A workload that
outgrows `collect` (normalization, a live source, redaction, custom schema)
graduates to a source plugin that registers its own dataset — and nothing about
the query surface changes when it does.
