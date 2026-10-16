# LLP 0241: A Scan's Rows Carry the Column List the Scan Advertised

**Type:** Decision
**Status:** Accepted
**Systems:** Query, Cache
**Author:** Phil / Claude
**Date:** 2026-08-15
**Related:** LLP 0015, LLP 0029, LLP 0032, LLP 0055, LLP 0098

> Extends [LLP 0015](./0015-query-and-datasets.spec.md) "Multi-partition
> union": that section settled which *hints* a union may forward. This one
> settles what *shape* the rows it yields must have.

## Context

Issue #788 reported that over a union whose partitions have drifted schemas,
`SELECT *, git_remote FROM ai_gateway_messages` came back with `gateway_id`
holding `git_remote`'s value. The query succeeded, so the caller had no
signal that a column's value came from a different column.

It reproduces, and not only over a union. Staging an `ai_gateway_messages`
cache with one icebird partition whose schema never had `git_remote` (the
normal post-v7 state, LLP 0032) and a second that has it:

```
=== lone (ONE partition, no union involved) ===
  SELECT *, gateway_id AS trailing FROM t
    {"id":1,"gateway_id":"gw-narrow","date":"2026-05-26","schema_version":"gw-narrow"}
  SELECT *, 1 AS lit FROM t
    THREW TypeError: asyncRow.cells[k] is not a function

=== drifted (one partition with git_remote, one without) ===
  SELECT *, git_remote AS gr FROM t
    {"id":1,"gateway_id":"gw-narrow","date":"2026-05-26"}
    {"id":2,...,"git_remote":"git@...","schema_version":"git@..."}
  SELECT *, gateway_id AS trailing FROM t
    {"id":1,"gateway_id":"gw-narrow","date":"2026-05-26","git_remote":"gw-narrow"}
    {"id":2,...,"git_remote":"git@...","schema_version":"gw-wide"}
```

Two things to note. The value lands under whichever **declared** column sits
at the star's physical width, so it is not always `gateway_id`: on the lone
partition it is `schema_version`, and on the narrow half of the drifted union
it is `git_remote`. And the same misalignment surfaces as a hard `TypeError`
when the trailing item is a literal, so this is not purely a wrong-value bug.

<a id="mechanism"></a>

### The mechanism, isolated

The defect is not in icebird, not in the parquet reader, and not in the
`withSchemaColumns` wrapper's column declaration. A hand-rolled
`AsyncDataSource` with no HypAware and no icebird in the picture reproduces it
exactly:

```js
// declares [a, b, c, d]; yields rows whose `columns` is only [a, b]
SELECT * FROM t      -> [{"a":1,"b":2}]
SELECT *, b FROM t   -> [{"a":1,"b":2,"c":2}]   // b's value, named c
```

Squirreling derives a query's output column names **once**, from the scan's
advertised list (`executeScan` returns `columns: plan.hints.columns ??
table.columns`, and `selectColumnNames` expands the star over that). It then
fills them per row by walking that **row's own** `columns` array and
advancing a shared index. A row narrower than the advertised list under-runs
the index, so every output name after the star slides onto a neighbour.

The engine never passes a `columns` hint for a star query (measured: `SELECT
*` and `SELECT *, b` both arrive as `scan({ columns: undefined })`), so the
advertised list for any star is the source's full `columns`, and a drifted
partition's row is always short. Nothing above the source can repair this:
the output name list is already fixed and already promised to the caller in
`QueryResults.columns` before the first row is read.

## Decision

<a id="alignment"></a>

### Rows carry the advertised list

**A scan must yield rows whose `columns` equals the column list the scan
advertises**, that is `options.columns ?? source.columns`. A column the
partition does not physically carry gets a padded cell rather than a missing
slot. This is not a new promise to the caller: it is the schema the engine
already reported. Only the row objects disagreed with it.

Core ships `alignRowColumns` (one row) and `alignRows` (a stream) from
`hypaware/core/query` next to `unionSources`, and applies them at the two
places a HypAware row can be narrower than what its source advertises:

- **`unionSources.scan`**, because the union advertises the union of its
  partitions' columns while each partition yields only its own. This covers
  the parquet-backed unions too, where `parquetDataSource` derives a row's
  `columns` from `Object.keys(data[0])`.
- **`withSchemaColumns.scan`** in the AI-gateway dataset, because the wrapper
  advertises the dataset's declared schema over partitions that predate part
  of it (LLP 0032), and the single-partition path returns the wrapper with no
  union underneath.

A row that already matches is returned untouched, so the ordinary case (a
partition holding every declared column) pays one length check per row.

### The padded cell reads `undefined`, and this decides nothing new

A padded cell resolves to `undefined` and the row's `resolved` map is left
alone, so a padded column is simply absent from it. That is deliberately the
**same** value the engine already read for a declared-but-absent column on
the row path (measured in issue #778), so this decision does not touch the
`null`/`undefined` split between the `scanColumn` and row paths, and no query
that already returned a value returns a different one. Whether that split
should be collapsed remains an open design question, not settled here.

It does change queries that did not return a value at all. A clause the
engine evaluates above the scan (a `WHERE` a partition could not accept, an
`ORDER BY`) reads the absent column off `row.cells`, and on a short row that
lookup missed and raised `ColumnNotFoundError`. On a padded row it reads
`undefined`, so those queries now answer instead of throwing. That is the
behaviour [LLP 0015](./0015-query-and-datasets.spec.md) already required of a
union ("projecting an absent column reads as null, never throws"); the throw
was the same short row surfacing on a different path. It is recorded below
rather than left implicit.

## Consequences

- `SELECT *` renders identically. A row object gains a key per declared
  column it lacks, but the value is `undefined`, which `JSON.stringify` drops
  exactly as it dropped the missing key. The verified rendering over the
  drifted fixture is unchanged before and after:
  `{"id":1,"gateway_id":"gw-narrow","date":"2026-05-26"}`.
- `Object.keys(row).length` for a star over a drifted partition now equals
  the declared column count rather than the physical one. A consumer that
  enumerated a result row's keys to discover which columns a partition
  physically held loses that signal. It was never a sound signal: the two
  halves of a drifted union answered it differently for the same query, and
  `QueryResults.columns` already reported the declared list.
- `SELECT *, <literal>` over a drifted partition stops throwing
  `TypeError: asyncRow.cells[k] is not a function`.
- A query whose `WHERE` or `ORDER BY` names a column some partition lacks
  stops throwing `ColumnNotFoundError` and answers. Measured on the drifted
  two-partition fixture, before to after:
  `SELECT * FROM t WHERE git_remote IS NULL` threw, now returns the narrow
  row; `WHERE git_remote = 'zzz'` threw, now returns no rows; `ORDER BY
  git_remote` (either direction) threw, now returns both rows. So the fix is
  wider than the star expansion that motivated it, and the key-count growth
  above is not the only change overall. The answers are the ones the hinted
  form of each query already gave on both trees (`SELECT id FROM t WHERE
  git_remote IS NULL` and friends carry a `columns` hint, so they never went
  short and never threw), which is the reference these were checked against.
- A star over a partition whose physical column order differs from the
  advertised list now renders its keys in the advertised order. Measured at
  the core union over partitions declaring `[a, b]` and `[b, a]`, `SELECT *`
  returned `{"b":4,"a":3}` for the second partition before and `{"a":3,"b":4}`
  now. The values are unchanged, and the new order is the one
  `QueryResults.columns` already reported, so this settles a disagreement
  rather than creating one. Carrying the advertised list means carrying its
  order, not just its membership.
- The padding is a per-row rebuild, and it is not free on a drifted
  partition. Measured over 20k rows of a 3-of-57 partition, `SELECT *` went
  from ~25ms to ~150ms; over a partition holding every declared column it is
  unchanged (~550ms both ways), because such rows match by content and the
  per-stream memo then costs one reference compare. The multi-partition
  AI-gateway path rebuilds a narrow row twice, once to the union's physical
  column list and again to the wrapper's declared list, and **neither pass is
  removable**. The wrapper cannot defer to the union: the union aligns to the
  union of what its partitions **physically** hold, while the wrapper
  advertises the **declared** schema, a strict superset whenever a column is
  absent from every partition (the normal post-bump state, LLP 0032).
  Removing only the wrapper's pass puts the reported defect straight back on
  the multi-partition path, `SELECT *, <literal>` crash included. The union
  cannot defer to the wrapper either: `unionSources` is a core export with no
  wrapper above it in otel, gascity, s3 and the context-graph datasets, so
  skipping there would need a flag threaded down from the wrapper. And that
  coupling would buy nothing measurable: the union rebuild spans the handful
  of columns a partition physically holds while the wrapper rebuild spans all
  57, so dropping the union pass measured ~178ms against ~173ms with it,
  inside the run-to-run noise. Accepted: the cost buys row objects that agree
  with the schema the engine already promised, and it scales with the
  declared width the caller asked for.
- The duty is on the **source**, not the engine. HypAware does not own
  squirreling, and an engine that fixed this by re-deriving output names per
  row would have to abandon the single static `columns` a result set
  promises. Aligning at the source is the smaller and locally verifiable
  change.
- Pinned by `test/core/star-expansion-drifted-union.test.js`, which asserts
  the occupant of each named cell with exact equality: a row of the right
  shape carrying the wrong values cannot pass.
