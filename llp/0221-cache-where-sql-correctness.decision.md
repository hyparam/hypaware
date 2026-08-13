# LLP 0221: The Cache Path Answers to the Kernel's WHERE Converter

**Type:** Decision
**Status:** Accepted
**Systems:** Query, Cache
**Author:** Phil / Claude
**Date:** 2026-08-13
**Related:** LLP 0098 (the applied-predicate contract this repairs an instance of), LLP 0015

> An `icebergDataSource` is wrapped before it reaches the engine. The rows it
> yields are judged by `src/core/query/parquet-pushdown.js`, this repo's
> converter; icebird's own converter keeps only the file and row-group pruning
> it is safe for, and never the answer.

## Context {#context}

Every intrinsic dataset (`ai_gateway_messages`, `traces`, `logs`) reaches
`hyp query sql` through `dataSourceForTable`
(`src/core/cache/iceberg/store.js`), which hands the user's `WHERE` AST to
icebird's `icebergDataSource`. That source converts the predicate with
`icebird/src/sql/whereFilter.js` and reports `appliedWhere: true` whenever the
conversion succeeds. Per LLP 0098 the engine never re-judges a claimed
predicate, so whatever that converter decides is the final answer.

On the pinned icebird 0.8.20 that converter is wrong three ways, all of them
about NULLs, and all three were fixed in this repo's own converter by #730 and
#743 (issues #728, #734):

| SQL | icebird pushes | cache path returned | SQL says |
| --- | --- | --- | --- |
| `ts = NULL` | `{ts: {$eq: null}}` | the NULL rows | none |
| `NOT (ts = NULL)` | `{ts: {$ne: null}}` | the non-NULL rows | none |
| `neg > -400` | `{neg: {$gt: -400}}` | the NULL rows too | non-NULL rows only |
| `NOT (ts > 300 OR ts > 400)` | `{$nor: [...]}` | the NULL rows too | non-NULL rows only |

A NULL-literal comparison converts to `IS NULL` semantics (three-valued logic
says no row is TRUE, NULL rows included, and `NOT UNKNOWN` is still UNKNOWN).
Relational operators push bare, and hyparquet evaluates `$gt`/`$lt` with raw
JavaScript comparison, which coerces a NULL column value to `0`, so NULL rows
sail past any negative bound. A negated OR becomes `$nor`, a two-valued
complement, so a row UNKNOWN for every disjunct reads as a match.

The result is a query engine that answers the same predicate differently
depending on which backend holds the rows: the parquet-file path has been
SQL-correct since #743, the cache path was not.

## Options considered {#options}

1. **Fix the converter upstream in icebird.** Correct at the source, and the
   right long-term home. Out of reach here: it needs an icebird release, and
   it is entangled with the separate open question of whether this repo should
   adopt icebird's converter wholesale (issue #721, LLP 0212 on
   `fix/one-pushdown-converter`). Not taken, not pre-empted.
2. **Pass a pre-built filter to `icebergDataSource`.** Rejected because the
   API has no such input: `icebergDataSource({tableUrl, metadataFileName,
   metadata, snapshotId, resolver, lister})` takes no filter, and its
   `scan({columns, where, limit, offset, signal})` / `scanColumn({column,
   where, limit, offset, signal})` take only the AST, which they convert
   themselves.
3. **Strip `where` from the scan hints** so icebird pushes nothing and the
   engine re-filters everything. Correctness-by-retreat: it trades active
   wrongness for the engine's own two-valued NULL handling (issue #734), and
   it costs the cache tier every file and row-group prune it has, which is
   what LLP 0098 exists to protect and what LLP 0212 measured at 11.4s versus
   7.3s on one production scan. Rejected.
4. **Wrap the source and apply the kernel's own filter to the rows**
   (chosen).

## Decision {#wrapper}

`withSqlCorrectWhere` (`src/core/query/iceberg-source.js`) wraps every
`icebergDataSource` the kernel builds, in `dataSourceForTable` and in the s3
query dataset. For a scan carrying a `where`:

- the predicate is converted with `whereToParquetFilter`
  (`src/core/query/parquet-pushdown.js`), the same function the parquet-file
  path uses, so the two backends answer the same question by running the same
  code;
- every emitted row is matched against that filter with hyparquet's own
  `matchFilter` at `filterStrict: false`, the same evaluator and the same
  strictness the parquet read applies, so the wrapper and the pushdown agree
  by construction rather than by a second implementation;
- `appliedWhere` is true only for a predicate the wrapper actually converted
  and actually applied. When `whereToParquetFilter` declines (LIKE over a real
  pattern, a function, a cast of a literal, an identifier-vs-identifier
  comparison) the wrapper claims nothing and the engine judges the rows, which
  is exactly what the parquet-file path does for the same shapes.

### The predicate is still forwarded, as a pruning hint {#pruning-hint}

The `where` keeps going down to icebird even though its conversion no longer
decides anything. That is what preserves file pruning (`fileMightMatch`,
`partitionMightMatch`) and hyparquet's row-group, page and bloom skipping, so
the repair costs no reads.

It is sound because icebird's filter can only ever be a **superset** of SQL's
answer. Each leaf it emits sits between the leaf's TRUE rows and its
TRUE-or-UNKNOWN rows: on a row with no NULL in a referenced column its
conversion is exactly SQL's, and a NULL row is never SQL-FALSE, so a leaf's
filter contains every TRUE row and no FALSE row. That invariant is preserved
by `$and` and `$or` (monotone) and by `$nor`, whose complement can only drop
rows a child matched, and every child matches only rows the leaf is not FALSE
for. icebird's file pruners and hyparquet's statistics pruning are inclusive
projections of that same filter (hyparquet declines to skip on `$nor` at all,
and suppresses statistics skipping for any condition a NULL could satisfy), so
no row SQL selects is dropped before the wrapper's match runs.

### `LIMIT`/`OFFSET` move to the wrapper {#slice}

They are never forwarded alongside a `where`. icebird would cap the scan at
`offset + limit` rows matching ITS filter, and the wrapper then narrows
further, which under-returns. The wrapper applies the slice itself over rows
that really match and reports `appliedLimitOffset` for what it did. Early
termination survives: a consumer that stops reading returns the wrapper's
generator, which ends icebird's file walk.

`scanColumn` is narrower. A column stream carries one column, so the wrapper
owns the predicate only when it names that column and nothing else, and it
never touches `limit`/`offset` there (the engine withholds them from a
filtered `scanColumn` anyway, LLP 0098). A predicate over another column
leaves `appliedWhere: false`, the same honest decline the rest of the stack
makes.

## Consequences {#consequences}

- A predicate the kernel converter owns (`whereToParquetFilter` converts it,
  so the wrapper claims `appliedWhere`) returns the same rows over
  `ai_gateway_messages` as the same predicate does over a parquet file.
  `test/core/iceberg-source-parity.test.js` runs one corpus against both
  backends and against SQL's answer.
- No pruning is lost, so LLP 0098's filtered-aggregate fast path and the
  file-level pruning LLP 0212 measured both survive. What is added is a
  per-row `matchFilter` over rows that already passed icebird's filter, which
  is strictly less work than the engine-side re-filter option 3 would have
  forced.
- The remaining NULL gap is still tracked by issue #734: a predicate this
  repo's converter declines falls to squirreling's two-valued `WHERE`, which
  answers a negated UNKNOWN subtree (`NOT (col LIKE 'a%')` over a nullable
  column) with rows SQL excludes. On the parquet-file path, which has no
  pruning to fall back on, that two-valued answer is the whole story. On the
  cache path a declined predicate is still forwarded to icebird as a pruning
  hint (#pruning-hint), so it is filtered twice: once by icebird's own
  (possibly cast-folding) converter, then by the engine's two-valued `WHERE`
  over whatever survived. The pruning step can drop UNKNOWN rows the
  two-valued engine would otherwise have returned, so for a declined
  predicate the cache path may return FEWER rows than the parquet path, not
  the same rows and not more. What holds is weaker than parity: `SQL ⊆ cache
  ⊆ parquet`, bounded between SQL's own answer and the parquet path's,
  not equal to either in general. `test/core/iceberg-source-parity.test.js`
  pins a CAST/typed-literal case against that subset chain rather than
  asserting `cache === parquet` for this class.
- icebird's converter still runs, so a divergence in ITS constant folding
  (`foldCast`, which it documents as a mirror of squirreling's `CAST`
  evaluation) would now prune rows rather than decide them. That was already
  true before this change, where the same fold decided the answer outright;
  the wrapper strictly narrows its authority.
- Issue #721 is untouched. If icebird's converter is later adopted wholesale
  (LLP 0212), `whereToParquetFilter` becomes a re-export and this wrapper
  keeps doing the same thing with the same function, provided icebird has by
  then taken the NULL fixes. If icebird fixes its converter upstream instead,
  the wrapper becomes redundant and can be retired in one line.
