# LLP 0212: One WHERE-to-parquet-filter converter, owned by icebird

**Type:** Decision
**Status:** Accepted
**Systems:** Query, Cache
**Author:** Phil / Claude
**Date:** 2026-08-12
**Related:** LLP 0098 (pushed the predicate down through `scanColumn`; this one settles *whose* converter does the pushing), LLP 0015

> The kernel keeps no WHERE-to-`ParquetQueryFilter` converter of its own.
> `src/core/query/parquet-pushdown.js` re-exports icebird's
> `whereToParquetFilter`. The cache tier and the archive tier now convert
> predicates identically, because they run the same function.

## Context {#context}

Two converters existed. `src/core/query/parquet-pushdown.js` (the cache tier,
via `parquet-source.js`) and `icebird/src/sql/whereFilter.js` (the archive
tier, via `icebergDataSource`) both began as ports of the Hyperparam app's
`lib/tools/parquetPushdownFilter.ts`. Same function names, same structure,
same De Morgan comments. icebird's copy kept moving; ours did not.

The drift was invisible until it was measured. hypscope's sessions surface
bounds its day windows on `message_created_at` with typed literals
(`TIMESTAMP '2026-08-11T00:00:00Z'`), which squirreling parses as a `cast`
node wrapping a string literal. icebird constant-folds that shape
(`staticLiteral` / `foldCast`). Our copy required a bare `literal` operand,
so `extractColumnAndValue` returned nothing, and because AND is
all-or-nothing (`if (!left || !right) return undefined`) the *entire*
predicate converted to `undefined`. Every timestamp-bounded query pushed
nothing down to the cache tier.

Measured on the production central server, org `hyperparam`, 2026-08-12: one
grouped sessions-list scan, identical projection and rows, took **11.4s**
bounded on `message_created_at` against **7.3s** bounded on `date`. The
685 MB / 752-file cache tier was read without row-group pruning in the first
case and with it in the second.

The same audit found a second divergence, this one a correctness bug rather
than a cost. Our `convertExpr` unwrapped **any** cast at boolean position:

```js
if (node.type === 'cast') return convertExpr(node.expr, negate)
```

So `WHERE CAST(a = 1 AS TEXT)` pushed down as `a = 1`. The engine evaluates
that cast to the string `'false'`, which is truthy, so the pushdown dropped
rows the query selects, and because a converted filter sets `appliedWhere`
the engine does not re-filter to catch it. icebird gates the unwrap to casts
that preserve truthiness (boolean and numeric targets) and falls back to the
engine otherwise.

## Decision {#decision}

**icebird owns the converter.** `parquet-pushdown.js` becomes a re-export of
`whereToParquetFilter` from `icebird/src/sql/whereFilter.js`; the public
`hypaware/core/query` surface is unchanged, so no consumer moves.

icebird is already a direct dependency, and deep-importing `icebird/src/*.js`
is the established pattern in this repo (`src/core/cache/retention.js`,
`src/core/cache/iceberg/stream_append.js`, a dozen sites). icebird's exports
map publishes `./src/*.js` with matching `types/`, so the swap costs no
type fidelity.

### `coerceBigInt` is dropped, not ported {#no-bigint-coercion}

The one thing our copy had that icebird's lacks was `coerceBigInt`, which
turned every integer literal into a `bigint` so it would compare equal to a
bigint-decoded INT64 column. Nothing needed it, and it was costing us:

- `filterStrict: false` (what `parquet-source.js` and icebird both pass)
  compares through `equals()`, which falls back to `==`, and `5n == 5`. The
  relational operators compare mixed bigint/number natively.
- hyparquet's bloom hashing (`hashParquetValue`) **rejects** a bigint for
  INT32, FLOAT and DOUBLE columns and returns `undefined`, which disables
  bloom pruning. The coercion was buying nothing on INT64 and silently
  turning off a pruning path on every other numeric column.

### Floor: hyparquet >= 1.28.1 {#hyparquet-floor}

`$in` / `$nin` are the one place the bigint/number distinction is load
bearing. hyparquet 1.27.x matched them with `Array.prototype.includes`, which
is SameValueZero: a number-valued `$in` against an INT64 column matches no
rows. 1.28.1 routes them through `matchesIn` -> `equals(value, target,
strict)`, which handles the mixed case. This repo pins 1.28.1. A consumer
that forces the kernel onto 1.27.x would get wrong results, not slow ones.

## Consequences {#consequences}

- Timestamp-bounded predicates prune the cache tier. Worth ~4s of the ~9s
  sessions-list batch-0 scan measured above; the rest of that scan is a
  separate matter (there is no partition-level pruning: `sql.js` calls
  `discoverPartitions` with no WHERE, so every raw query still opens all 752
  cache files before any filter runs).
- The truthiness-cast pushdown bug is gone.
- Bloom pruning is restored for INT32/FLOAT/DOUBLE equality.
- 188 lines of converter deleted against 33 of re-export and rationale. Future
  converter fixes land once, in icebird, and both tiers get them.
- Tests now assert plain numbers where they asserted bigints, and cover the
  two shapes the drift produced: a folded `TIMESTAMP` literal (unit and
  end-to-end through a real parquet scan, since a mis-folded literal would
  drop rows rather than merely lose pruning) and the truthiness-cast guard.
