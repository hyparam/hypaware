# LLP 0240: What an icebird-backed read of an absent column actually yields

**Type:** Decision
**Status:** Accepted
**Systems:** Query, Cache
**Author:** Claude
**Date:** 2026-08-15
**Related:** LLP 0015 (#multi-partition-union: the union contract this
completes for the icebird backing), LLP 0032 (#capture: the additive v7
columns that create the drift), LLP 0098 (#wrapper-duties: the predicate gate
this extends from `scanColumn` to the row path), LLP 0055

> Extends [LLP 0015](./0015-query-and-datasets.spec.md). LLP 0015 settles what
> the union does with a column a partition physically lacks, in terms of the
> parquet-backed sources it was written against. It does not settle what the
> **icebird**-backed cache yields for such a read, and the flagship dataset
> `ai_gateway_messages` is icebird-backed. This decision records that, measured
> at the SQL surface rather than derived from the code, and closes a
> correctness hole the measurement exposed.

> **Amended by [LLP 0241 §alignment](./0241-scan-rows-carry-advertised-columns.decision.md#alignment),
> which landed first.** 0241 pads every scanned row out to the column list the
> scan advertised, which moves exactly one cell of the table below: under
> `SELECT *` the absent column's key now **exists** and holds `undefined`,
> where it was previously not on the row at all. The rendering is unchanged
> and no other row of the table moves; re-measured on the merged tree, and
> pinned by the same test file. 0241 also fixes the star-expansion defect the
> Consequences below deferred to issue #788.

## Context

`ai_gateway_messages` declares more columns than any given partition
physically has. Schema v7 added `git_remote` / `head_sha` / `repo_root` as
nullable (LLP 0032) with no partition-label bump, so every partition written
before the bump lacks them, and `withSchemaColumns` in the ai-gateway plugin
advertises the declared set on top of whatever the storage source reports so
that a SELECT naming one of them plans at all.

What such a read then *yields* had never been pinned. Only the raw `scan()`
rows and the `scanColumn()` chunks were tested; no test ran a full SELECT
through `executeSql` + `collect`, which is the pair `hyp query sql` uses. In
the absence of a test, five successive written descriptions of this mechanism
were each measured false during the review of #731 / PR #740, and the
maintainer descoped the icebird half rather than ship a sixth guess.

Everything below was obtained by running the query and recording the answer.

## Decision

### <a id="contract"></a>The contract

Over an icebird-backed partition that physically lacks a declared column,
**nothing throws**, and the value read depends on which path the engine takes:

| query shape | value | rendering |
| --- | --- | --- |
| `SELECT git_remote FROM t` | `null` | `{"git_remote":null}` |
| `SELECT git_remote AS gr FROM t` | `null` | `{"gr":null}` |
| `SELECT git_remote, 1 AS n FROM t` | `null` | `{"git_remote":null,"n":1}` |
| `SELECT id, git_remote FROM t` | `undefined` | `{"id":1}` (key dropped) |
| `SELECT git_remote FROM t WHERE date >= '...'` | `undefined` | `{}` |
| `SELECT * FROM t` | `undefined`, under a key that exists (LLP 0241) | `{"id":1,"date":"..."}` |

The discriminator is **the size of the scan's hint column set, not the shape
of the SELECT list.** Squirreling routes a scan whose hints name exactly one
column through `scanColumn` (`execute.js`, gated on
`plan.hints.columns?.length === 1`, with no aggregate required), and
`withSchemaColumns` normalizes the hole to `null` on exactly that path.
Anything that widens the hint set to two columns takes the row path instead
and reads `undefined`. A literal or expression sibling reads no column, so it
does **not** widen it; a `WHERE` on an unrelated column does, which is why
adding a date filter silently flips the same projection from `null` to
`undefined`.

On the row path the value is `undefined` rather than a throw because icebird
builds each row with squirreling's `asyncRow(obj, requestedColumns)` over the
**requested** column list: the cell exists as a thunk that resolves to
`obj[name]`, which is `undefined`, and the pre-materialized `resolved` map
that `collect()` reads simply has no entry for it. This is the whole
difference from a parquet-backed partition, whose `asyncRow` is built over
`Object.keys(data[0])`, the row's **physical** keys, so the cell does not
exist and anything evaluating it throws `ColumnNotFoundError`. Hence, on
icebird, `ORDER BY`, `GROUP BY`, `DISTINCT`, an expression, and an aggregate
over the absent column all answer (with `null`, or a count that skips it)
where the parquet union throws.

Consequently **`null` and `undefined` are both live readings of the same
absent cell, and neither is "the" value.** A consumer that must distinguish
"no value" from "column predates this partition" cannot do it from the read;
callers should treat both as absent, and no code should branch on which one it
got.

### <a id="where-gate"></a>The row path owes the same predicate gate as `scanColumn`

LLP 0098 (#wrapper-duties) already requires `withSchemaColumns` to strip a
predicate naming a declared-but-physically-absent column before it reaches the
source. Only `scanColumn` implemented it; `scan` forwarded `options` verbatim.
Measuring the contract exposed what that costs on icebird, which does not
throw where parquet does:

- icebird converts the predicate to a hyparquet filter over a column its
  schema never had,
- filters nothing away,
- and still reports `appliedWhere: true`,

so the engine trusts the stream and does not re-filter. On a cache with a
**single** partition lacking the column, `SELECT id FROM t WHERE git_remote =
'zzz'` returned every row, and so did `WHERE git_remote IS NOT NULL`. Two or
more partitions hid it, because `createDataSource` then wraps `unionSources`,
whose own per-partition gate (LLP 0015#multi-partition-union) fires first. The
exposed shape is therefore the ordinary one: a fresh install with one client.

`withSchemaColumns.scan` now applies the same gate as its `scanColumn`: when
the predicate names a column the wrapped source does not advertise, drop the
predicate along with `limit`/`offset` (only meaningful post-filter) and report
`appliedWhere: false` / `appliedLimitOffset: false`, handing the filter back
to the engine. A predicate the source can satisfy is still pushed and still
claimed, so the ordinary filtered read keeps its pushdown.

### <a id="pinned"></a>Pinned at the SQL surface

The contract is pinned by
[`test/core/ai-gateway-absent-column-sql.test.js`](../test/core/ai-gateway-absent-column-sql.test.js),
which runs `executeSql` + `collect` over a staged icebird cache in two shapes:
one partition lacking the column (no union in the way), and a drifted pair.
Every value is asserted exactly, as `null` versus `undefined` versus key
absence, never through a tolerant `?? null`. That form is deliberate: a
tolerant assertion is what let the mechanism be described wrongly five times
while the suite stayed green.

## Consequences

- Documentation of this contract belongs here, not in LLP 0015. LLP 0015 is
  Active and its union section is being corrected separately for the parquet
  backing (#731 / PR #740); this doc carries the icebird half and 0015 gains
  only a forward-ref.
- The `null`-versus-`undefined` split is a property of the engine's fast-path
  gate, not of the cache. If squirreling ever widens or narrows that gate, the
  values in the table above move, and the pinning tests are what will say so.
- `SELECT *, git_remote FROM t` over a drifted union was observed to
  mis-assign a value into a neighbouring declared column. That is a star
  expansion defect above this layer, is not part of this contract, and is left
  unaddressed here; the tests deliberately do not cover it. It is tracked as
  [hyparam/hypaware#788](https://github.com/hyparam/hypaware/issues/788), and
  is **now fixed** by [LLP 0241](./0241-scan-rows-carry-advertised-columns.decision.md),
  which landed on master first.
- The #where-gate and 0241's padding are not independent at the star. A star
  carries no `columns` hint, so its rows are only as wide as the partition
  physically is; the gate then hands the predicate back to the engine, which
  reads the absent column off `row.cells`. Measured with 0241's two alignment
  call sites reverted, `SELECT * FROM t WHERE git_remote IS NULL` raises
  `ColumnNotFoundError` from `filterRows` instead of answering. The padding is
  what makes the handed-back filter evaluable, so the two must ship together;
  the composition has its own pin in the test file.
