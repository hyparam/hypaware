# LLP 0219: The kernel keeps its own pushdown converter, and folds typed literals

**Type:** Decision
**Status:** Accepted
**Systems:** Query, Cache
**Author:** Phil / Claude
**Date:** 2026-08-13
**Related:** LLP 0098 (pushed the predicate down through `scanColumn`; this one settles *whose* converter does the pushing), LLP 0015

> The kernel keeps `src/core/query/parquet-pushdown.js` as a real converter
> rather than re-exporting icebird's. It adopts the one thing icebird's copy
> had and ours lacked, constant-folding of typed literals, and keeps the
> three-valued NULL semantics icebird's copy does not have.

## Context {#context}

Two converters exist. `src/core/query/parquet-pushdown.js` (the cache tier,
via `parquet-source.js`) and `icebird/src/sql/whereFilter.js` (the archive
tier, via `icebergDataSource`) both began as ports of the Hyperparam app's
`lib/tools/parquetPushdownFilter.ts`. Same function names, same structure,
same De Morgan comments. The two then drifted in *opposite* directions, and
the drift is the whole of this decision.

**Where icebird went ahead.** hypscope's sessions surface bounds its day
windows on `message_created_at` with typed literals
(`TIMESTAMP '2026-08-11T00:00:00Z'`), which squirreling parses as a `cast`
node wrapping a string literal. icebird constant-folds that shape
(`staticLiteral` / `foldCast`). Our copy required a bare `literal` operand,
so `extractColumnAndValue` returned nothing, and because AND is
all-or-nothing the *entire* predicate converted to `undefined`. Every
timestamp-bounded query pushed nothing down to the cache tier. Measured on
the production central server, org `hyperparam`, 2026-08-12: one grouped
sessions-list scan, identical projection and rows, took **11.4s** bounded on
`message_created_at` against **7.3s** bounded on `date`.

icebird also gates the boolean-position cast unwrap. Our copy unwrapped
**any** cast, so `WHERE CAST(a = 1 AS TEXT)` pushed down as `a = 1`; the
engine evaluates that cast to the string `'false'`, which is truthy, so the
pushdown dropped rows the query selects.

**Where the kernel went ahead.** LLP 0098 lets a converted filter claim
`appliedWhere`, and the engine never re-filters a claimed predicate. A filter
that disagrees with SQL is therefore a wrong answer, not a lost optimisation.
Issues #728 and #734 found that the shared ancestor disagrees with SQL on
NULLs in four ways, all of which the kernel's copy has since fixed and
icebird's copy retains:

1. bare relational operators leak NULL rows (hyparquet compares with raw JS
   operators, which coerce NULL to `0`),
2. `$nor` for a negated `OR` is a two-valued complement, so a row that is
   UNKNOWN for every disjunct matches,
3. `$nin` carries no NULL guard, and an all-NULL `IN` list is not a
   never-match,
4. a comparison against a NULL literal converts to `$eq: null`, answering it
   with `IS NULL` semantics.

Measured on a 24-predicate battery over a nullable column, evaluated through
hyparquet's own `matchFilter` and compared against SQL three-valued truth:
the kernel's converter is wrong on **0**, `icebird@0.8.21` on **11**.

icebird 0.8.21 (published 2026-08-13) closed items 4 and the `foldCast`
object case, and added NULL guards. It did not adopt De Morgan, and its guard
targets agreement with squirreling's *engine*, which is itself two-valued,
rather than agreement with SQL. That is a coherent goal, and it is not this
repo's: #743 deliberately diverges from the engine to be SQL-correct.

## Decision {#decision}

**The kernel keeps its converter, and ports the fold.** `staticLiteral`,
`foldCast` and `castTimestamp` come across from icebird, along with the
`TRUTHINESS_PRESERVING_CASTS` gate on the boolean-position cast unwrap. The
NULL handling stays as #730 and #743 left it.

A folded bound is guarded exactly like a plain one: `at >= TIMESTAMP '...'`
converts to `{at: {$ne: null, $gte: <Date>}}`. Folding decides *whether* a
bound pushes down; it does not change what NULL means. This is the property
that made the fold unlandable while the guards were missing, and landable
now that they are not.

### `coerceBigInt` stays, for now {#bigint-coercion}

Dropping it (so integer literals stay plain numbers) would restore bloom
pruning on INT32, FLOAT and DOUBLE columns, since hyparquet's
`hashParquetValue` rejects a bigint for those. That is a real win and it is
separable from this one: it changes the filter shape for every integer
predicate in the repo. Left as follow-up rather than bundled here.

## Consequences {#consequences}

- Timestamp-bounded predicates prune the cache tier. Worth ~4s of the ~9s
  sessions-list batch-0 scan measured above; the rest of that scan is a
  separate matter (there is no partition-level pruning: `sql.js` calls
  `discoverPartitions` with no WHERE, so every raw query still opens all 752
  cache files before any filter runs).
- The truthiness-cast pushdown bug is gone.
- The two tiers still disagree on NULLs, because the archive tier runs
  icebird's converter. That gap is filed as **#744** and is not closed here.
  Closing it means porting the four items above upstream, at which point the
  kernel's copy could genuinely become a re-export.
- The timestamp fixture is nullable and carries a NULL row, and the day-bound
  test asserts `appliedWhere` rather than only the row set. Without that
  assertion an upstream regression that stopped folding typed literals would
  keep the suite green and silently give back the scan time.
