# LLP 0015: Query, Datasets, and Collect

**Type:** Spec
**Status:** Active
**Systems:** Query
**Author:** Phil / Claude
**Date:** 2026-06-01
**Related:** LLP 0013, LLP 0016

> The intrinsic query surface and the `collect` on-ramp. Decomposed from
> `hypaware-design.md` (Query and Datasets, Collect Command).

> **Extended by [LLP 0034](./0034-mcp-host-intrinsic.decision.md).** Because the
> SQL/dataset surface is intrinsic, the kernel projects it as a `query_sql` MCP
> tool (and dataset schemas as MCP resources) on every host with a registered
> dataset: no plugin work. Remote SQL ([LLP 0033](./0033-remote-query-attach.spec.md))
> calls that tool over MCP and renders with the same formatters.

> **Extended by [LLP 0054](./0054-bounded-query-execution.spec.md).** The
> intrinsic execution path is memory-bounded: a per-query execution budget plus
> a threaded abort signal cap peak intermediate memory, so no single query can
> OOM the host by buffering an unbounded scan
> ([hyparam/hypaware-server#9](https://github.com/hyparam/hypaware-server/issues/9)).

> **Extended by [LLP 0266](./0266-native-prepared-batches-through-query-sources.decision.md).**
> Compatible partition unions now concatenate native prepared batches, remap
> per-table field ids, and keep LIMIT/OFFSET on the merged stream. Drifted
> schemas retain the row-padding behavior specified below.

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
its schema, not because core knows what gascity is.

## Multi-partition union

A dataset whose `createDataSource` spans several committed partitions returns a
single union `AsyncDataSource` that concatenates the per-partition scans. Core
ships the canonical pair, `unionSources` and `emptySource`, from
`hypaware/core/query`; every plugin imports them rather than re-implementing the
concatenation (otel, ai-gateway, s3, context-graph, context-graph-enrich).

The union reports `appliedWhere: false` and `appliedLimitOffset: false`, so the
SQL engine re-applies both over the merged stream. **`limit`/`offset` are
stripped** from the sub-scans: they are not distributive across a
concatenation. A sub-source that honors limit/offset pushdown (an Iceberg
partition) would otherwise drop its first `offset` rows per partition, and the
engine would skip the offset again on the joined stream, silently losing rows
from paginated multi-partition queries. Five drifted copies of this helper, two
of which had un-stripped the hints, produced exactly that pagination bug before
the helper was centralized.

`where` is forwarded to a sub-source as a pushdown optimization **only when that
partition advertises every column the predicate references**. A heterogeneous
union (partitions with additive schema drift) can otherwise push a filter on a
column a given partition physically lacks, and a parquet-backed source throws
`parquet filter columns not found` rather than reading it as null; when a
partition can't satisfy the predicate the union drops `where` for it and lets
the engine filter. `columns` is always forwarded, which adds no failure the
merged stream did not already have, but an absent column does **not** read as
null: it reads as `undefined`. The union pads every row out to the column list
the scan advertised
([LLP 0241 §alignment](./0241-scan-rows-carry-advertised-columns.decision.md#alignment)),
so a column a partition physically lacks is still a real cell on the row, and
that cell resolves to `undefined`. The value is outside `SqlPrimitive` and
`JSON.stringify` drops it, so a padded column renders as an absent key even
though the row object owns it, and `Object.keys(row).length` over a star counts
the **advertised** columns rather than the physical ones. Every **row**-path
read agrees on that value: reading the row's pre-materialized `resolved` map
(`collect()`'s fast path), invoking the cell directly, and evaluating the column
above the scan in a `WHERE`, an expression or function over it, `ORDER BY`,
`GROUP BY`, `DISTINCT`, or an aggregate. The `scanColumn` column-stream path is
**not** part of that agreement and is not what padding changed: the union
forwards each partition's chunks unchanged, and a wrapper above it normalizes
the holes if it wants them uniform (LLP 0032's `withSchemaColumns` maps them to
`null`). LLP 0241 deliberately left that `null`/`undefined` split between the
two paths unsettled. `SELECT *` renders identically to the unpadded star,
because the key it now owns is one `JSON.stringify` drops. The column is
addressable at all only because the union advertises the superset of partition
columns; when no partition has it, planning fails unless a wrapper advertises
the declared schema on top of the union (LLP 0032's `withSchemaColumns`), which
keeps such a column addressable; the exact value a read of it then yields
depends on the read path and is not settled here. Pinned by
[`test/core/union-source.test.js`](../test/core/union-source.test.js).

> **Corrected (#731, PR #740).** This section previously stated that projecting
> an absent column "reads as null, never throws". That was never true of the
> code when it was written; the paragraph above records the measured contract.
> No runtime behaviour changed.

> **Corrected again (#820).** PR #740 was cut before, and merged after,
> [LLP 0241](./0241-scan-rows-carry-advertised-columns.decision.md), so the text
> it landed described a tree that no longer existed: an unresolved drifted cell,
> `undefined` only via `collect()`'s pre-materialized fast path, and a
> `ColumnNotFoundError` from anything that evaluated the column or merely sat
> beside it as a non-identifier sibling. 0241's padding removed that seam, and
> the semantic conflict turned `master` red. The paragraph above records the
> contract as measured on the current tree. No runtime behaviour changed in this
> correction either.

> **Extended-by: [LLP 0241 §alignment](./0241-scan-rows-carry-advertised-columns.decision.md#alignment).**
> The hints above say what a union may forward; LLP 0241 adds what shape the
> rows it yields must have. A partition narrower than the union's advertised
> column list makes a star expansion slide a later output name onto its
> neighbour's value, so the union pads each row back out to the list the scan
> advertised.

## Collect: the ad-hoc on-ramp

`hypaware collect` registers an external JSONL file (or glob) the user already
has on disk as a queryable table **without writing a plugin**. It is a **core
command**, not a plugin contribution, because the collection lands in the
intrinsic cache and rides the same dataset registry, partition discovery, and
refresh machinery as any plugin-owned dataset. The only difference is who
registers the dataset entry: the user at the CLI, instead of a plugin at
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
They are per-host state (analogous to the lock file): a collection points at
paths/globs only meaningful on the machine that ran `collect`. A team that wants
the same table everywhere should ship a plugin that registers the dataset, not a
synced collections list.

### Intentionally narrow

`collect` does not transform rows, infer schemas beyond the JSON shape, or own a
daemon lifecycle. The `--timestamp-column` hint is what lets `--from`/`--to`/
`--since` filtering work; without it the column is opaque. A workload that
outgrows `collect` (normalization, a live source, redaction, custom schema)
graduates to a source plugin that registers its own dataset, and nothing about
the query surface changes when it does.
