# LLP 0591: The engine types timestamp literals; the kernel rewrite is retired

**Type:** Decision
**Status:** Accepted
**Systems:** Query
**Author:** Kenny Daniel
**Date:** 2026-11-08
**Supersedes:** LLP 0272#decision (where the literal is typed), LLP 0280
**Related:** LLP 0222, LLP 0272

> What LLP 0272 decided still holds: a string literal compared with a
> TIMESTAMP is read as a timestamp, and one that cannot be read is an error,
> never an empty result. What changes is who does it. squirreling now types the
> literal itself, and the sources that push filters refuse a bound that is still
> a raw string, so HypAware no longer rewrites the statement first.

## Context {#context}

LLP 0272 rewrote every bare string literal opposite a TIMESTAMP column into a
`CAST(... AS TIMESTAMP)` before squirreling or the pushdown saw it, because
neither typed it and the query returned zero rows (issue #860). LLP 0280
extended the rewrite through CTEs and derived tables by inferring the columns
their inner selects expose. Together that was about 770 lines of scope
resolution mirroring the engine's own.

The engine now covers the same ground:

- squirreling 0.17.1 and later types a string literal by the value it is
  compared against, per row, and refuses one that does not parse.
- When a source reports a column as a date, squirreling types the literal
  before pushdown. icebird 0.9.7 reports Iceberg column types, and the plain
  parquet source does too (PR #2936).
- A source that could still receive a raw string bound on a timestamp column
  (a union of drifted partitions, a wrapper that loses the schema) declines to
  push it and leaves it to the engine (`string-timestamp-bounds.js`).

## Decision {#decision}

Remove `coerceTimestampLiterals` and its module. `executeQuerySql` hands the
parsed statement to squirreling unchanged.

Before removing it, the same 30 queries ran against a 1.4 million row local
cache with and without the rewrite: every bound shape LLP 0272 lists
(comparisons, flipped operands, `BETWEEN`, `IN`, `NOT IN`, `OR`, `HAVING` on
`MAX`, `CASE`, CTEs, derived tables, subqueries, unions, joins, space and `T`
separators, `Z` and numeric offsets). Results were identical. Only the
refusal's wording differs.

## Consequences {#consequences}

- The refusal now comes from squirreling (`Cannot compare TIMESTAMP to string
  ...`) instead of `TimestampLiteralError`. Product telemetry still records it
  as `query_failed`, through the query verbs' fallback rather than a mapped
  code.
- A refusal now needs a row to compare against when the column's type only
  shows up at run time. A malformed bound on a CTE column over a scan that
  yields no rows returns an empty result instead of an error. The empty result
  is correct for that data, so this is not the silent wrong answer #860 was
  about.
- The rewrite's own tests (the AST shapes it emitted and its scope resolution)
  go with it. The end-to-end tests in
  `test/core/query-timestamp-literals.test.js` stay and pass unchanged, apart
  from the refusal tests matching the new error text and comments that
  described the rewrite.
