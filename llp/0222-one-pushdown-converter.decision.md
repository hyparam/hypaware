# LLP 0222: One WHERE-to-parquet-filter converter, owned by icebird

**Type:** Decision
**Status:** Accepted
**Systems:** Query, Cache
**Author:** Phil / Claude
**Date:** 2026-08-13
**Related:** LLP 0098 (pushed the predicate down through `scanColumn`; this one settles *whose* converter does the pushing), LLP 0015

> The kernel keeps no WHERE-to-`ParquetQueryFilter` converter of its own.
> `src/core/query/parquet-pushdown.js` re-exports icebird's
> `whereToParquetFilter`. The cache tier and the archive tier convert
> predicates identically, because they run the same function - and that
> function agrees with SQL three-valued logic, because the whole stack was
> brought up to it first.

## Context {#context}

Two converters existed. `src/core/query/parquet-pushdown.js` (the cache tier,
via `parquet-source.js`) and `icebird/src/sql/whereFilter.js` (the archive
tier, via `icebergDataSource`) both began as ports of the Hyperparam app's
`lib/tools/parquetPushdownFilter.ts`. Same function names, same structure,
same De Morgan comments. They then drifted in *opposite* directions:

- **icebird went ahead on folding.** hypscope's sessions surface bounds its
  day windows with typed literals (`TIMESTAMP '2026-08-11T00:00:00Z'`), which
  squirreling parses as a `cast` node wrapping a string literal. icebird
  constant-folds that shape (`staticLiteral` / `foldCast`); the kernel's copy
  required a bare `literal` operand, and because AND is all-or-nothing the
  whole predicate declined, so every timestamp-bounded query scanned the
  cache tier unpruned. Measured on the production central server, org
  `hyperparam`, 2026-08-12: 11.4s bounded on `message_created_at` versus
  7.3s bounded on `date`, same rows, same projection. icebird also gated the
  boolean-position cast unwrap that let `WHERE CAST(a = 1 AS TEXT)` push a
  filter that drops rows.
- **The kernel went ahead on NULLs.** LLP 0098 lets a converted filter claim
  `appliedWhere`; the engine never re-filters a claimed predicate, so a
  filter that disagrees with SQL is a wrong answer, not a lost optimisation.
  Issues #728 and #734 (PRs #730, #743) fixed four NULL disagreements in the
  kernel's copy that icebird retained: leaking relational bounds, `$nor` as a
  two-valued complement of a negated OR, an unguarded `$nin`, and NULL
  literals answered with `IS NULL` semantics.

Adopting either copy as-was meant losing the other's fixes. Measured on a
24-predicate battery over a nullable column, evaluated through hyparquet's
`matchFilter` against SQL three-valued truth: the kernel's converter was
wrong on 0, `icebird@0.8.21` on 11.

## Decision {#decision}

**Fix the stack bottom-up, then re-export.** Three releases, in dependency
order, and the re-export lands only after all three:

1. **squirreling 0.15.3** made the *engine* three-valued: comparisons with a
   null operand are UNKNOWN rather than false, `NOT` keeps UNKNOWN as
   UNKNOWN instead of JS `!` flipping it to true, AND/OR use Kleene logic,
   and `IN` treats null members and null operands as UNKNOWN non-matches.
   This closed issue #734's "option 1" for real: a *declined* predicate now
   falls back to an engine that answers it correctly, so declining became a
   safe move rather than a differently-wrong one.
2. **icebird 0.8.22** made the *converter* target SQL truth rather than
   bug-compatibility with the old engine: De Morgan instead of `$nor` (which
   also restores row-group pruning under negation), negated comparisons push
   their flipped operator bare, `$ne`/`$nin` carry `$ne: null` guards, a
   `NOT IN` list holding NULL converts to hyparquet's never-match, NULL
   members of a plain IN list are dropped to keep statistics pruning
   decidable, and NULL-literal comparisons decline to the now-three-valued
   engine. The same battery: 0 wrong of 26.
3. **This repo** bumps all three pins and deletes its converter for the
   re-export.

### Floor: hyparquet 1.28.2 {#hyparquet-floor}

icebird's converter pushes bare relational bounds (`{ts: {$lte: v}}`), which
is only correct because hyparquet >= 1.28.2's `matchFilter` rejects null
cells in `$lt`/`$lte`/`$gt`/`$gte`. On 1.28.1 those coerce a null cell to 0
and the bound leaks NULL rows - the reason the kernel's copy carried
`$ne: null` guards. The root pin moves 1.28.1 to 1.28.2 with the same exact
pin, resolving to a single deduped copy shared with icebird.

### `coerceBigInt` is dropped, not ported {#no-bigint-coercion}

Integer literals stay plain numbers. `filterStrict: false` (what
`parquet-source.js` and icebird both pass) compares through `equals()`, so
`5 == 5n` holds against bigint-decoded INT64 columns, `$in`/`$nin` route
through the same `equals()` as of 1.28.1, and hyparquet's bloom hashing
rejects a bigint for INT32/FLOAT/DOUBLE - the coercion bought nothing on
INT64 and disabled bloom pruning everywhere else.

## Consequences {#consequences}

- Timestamp-bounded predicates prune the cache tier; the truthiness-cast
  bug is gone; bloom pruning is restored for non-INT64 numerics.
- The cache tier and archive tier answer the same predicate with the same
  rows. Issue #744 (the archive tier's NULL wrongness) is closed by the
  same bump that lands this.
- Issue #734 is closed outright: `NOT (col LIKE 'a%')` and every other
  negation of a declined subtree is now answered correctly by the engine.
- Future converter fixes land once, in icebird, and both tiers get them. The
  guardrail against silent regression is behavioral, not structural:
  `test/core/parquet-source.test.js` asserts SQL row sets end to end through
  real parquet scans (nullable TIMESTAMP fixture included), asserts
  `appliedWhere` so a fold regression cannot silently hand the work back to
  the engine, and measures bytes read so a pruning regression fails loudly.
- The unit shape assertions now document icebird's shapes: bare relational
  bounds, guards only on `$ne`/`$nin`, declines for NULL-literal
  comparisons.
