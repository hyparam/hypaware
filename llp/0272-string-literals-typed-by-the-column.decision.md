# LLP 0272: A string literal is typed by the column it is compared against

**Type:** Decision
**Status:** Accepted
**Systems:** Query
**Author:** Phil / Claude
**Date:** 2026-08-18
**Related:** LLP 0222 (settles *whose* converter turns a WHERE into a parquet
filter; this one settles what the WHERE holds by the time that converter sees
it), LLP 0015, LLP 0098

> Before a parsed statement reaches the engine or the pushdown converter, the
> kernel gives every bare string literal sitting opposite a `TIMESTAMP` column
> the type SQL says it has: the literal is rewritten into the same
> `CAST(... AS TIMESTAMP)` node a typed literal already parses to. A literal
> that cannot be read as a timestamp is an error, not an empty result.

## Context {#context}

Issue #860. On a cache holding 64,749 `claude_code` rows,
`where message_created_at >= '2026-08-18T21:00:00'` returned **zero rows**,
and so did every other bound at every other threshold, in both directions,
including `>= '2020-01-01T00:00:00'` (which every row satisfies) and
`<= '2030-01-01T00:00:00'` (likewise). `message_created_at is not null`
returned all 64,749. The query exited 0 and printed an empty table.

Neither half of the stack coerces:

- **The engine.** squirreling's `applyBinaryOp` compares two `Date`s by
  `getTime()` and otherwise falls through to JS relational operators. A `Date`
  against a string relationally converts the `Date` to a number and the string
  to `NaN`, so `<`/`<=`/`>`/`>=` are false for every row; `==` compares the
  JS date string (`Tue Aug 18 2026 ...`) against the ISO text, also false.
- **The converter.** icebird's `whereToParquetFilter` folds a *typed* literal
  (`TIMESTAMP '...'`, which squirreling parses as a cast over a string) into a
  `Date`, but passes a bare string literal through untouched. hyparquet then
  compares that string to the column's `Date` statistics, every row group
  prunes, and the scan claims `appliedWhere` (LLP 0098), so the engine never
  re-checks. Both paths agree on the same wrong answer.

This is not the defect family of issue #734. That one was three-valued logic:
a *declined* pushdown fell back to a two-valued `WHERE` and returned rows SQL
excludes. Here nothing declines and nothing is UNKNOWN; the comparison is
well-formed and simply typed wrong before either evaluator runs. #734 over-
returned; this under-returns to exactly zero.

### Why zero rows is worse than an error {#why-silent}

`docs/ACCEPTANCE.md` bounds six release-gate steps on `message_created_at`.
Run against this defect, `claude_otel_shape_check` step 6, whose whole job is
to prove captured rows landed with their columns filled, reports "no rows" on
a healthy capture path. The written procedure then reads as a capture failure,
and the reader debugs code that is fine. The defect cost real diagnosis time
during OTEL attach validation before the rows were found intact by re-querying
with `order by message_created_at desc limit n`.

## Decision {#decision}

**Type the literal at the shared read path, before anything evaluates it.**

`executeQuerySql` parses the statement, then calls
`coerceTimestampLiterals(statement, registry)`
(`src/core/query/timestamp-literals.js`) and hands the *rewritten statement*,
not the original text, to `squirrelExecuteSql`. Every surface that queries
(the `hyp query` verbs, the graph and overview commands, the MCP tools) funnels
through that one function, which is where LLP 0105 already put the visibility
filter and where LLP 0015 put IO attribution: one place, never re-implemented
per command.

The rewrite emits `{ type: 'cast', toType: 'TIMESTAMP', expr: <literal> }`,
which is byte-for-byte the node `TIMESTAMP '...'` already parses to. That
matters more than convenience: LLP 0222 requires the converter's fold and the
engine's `CAST` evaluation to stay in lockstep, and reusing the shape they
already agree on means this change adds no third opinion about what a
timestamp literal means.

### What is coerced, and what deliberately is not {#scope}

- The dataset **schema** decides, not the value's shape. Only a column a
  registered dataset declares `TIMESTAMP` takes the coercion. `date` is a
  `STRING` partition column that happens to hold `2026-08-18`; its comparisons
  were the one thing that always worked, and typing them would change what
  they mean.
- A column two in-scope tables type differently is left alone. A wrong
  coercion returns wrong rows, which is the failure this document exists to
  end; declining costs only the pruning.
- A CTE shadowing a dataset name does not borrow the dataset's schema, and a
  subquery is typed against its own `FROM`, never the enclosing one.
- Comparison operators (`=`, `==`, `!=`, `<>`, `<`, `<=`, `>`, `>=`) and `IN`
  lists, on either side of the operator. `BETWEEN` desugars to two comparisons
  at parse time and is covered by that. `LIKE` against a `TIMESTAMP` is not
  coerced: `CAST(<date> AS TEXT)` is a JS date string, so a pattern written
  against ISO text would not mean what it looks like, and there is no
  defensible reading to pick.
- The space-separated form (`'2026-08-18 21:00:00'`) is ordinary SQL, and
  neither squirreling's `toDate` nor icebird's mirror of it accepts the space.
  The rewrite normalizes the separator to `T` rather than refusing, so the fix
  does not trade one silent empty result for a new error on a form that reads
  as valid.

<a id="refuse-uncoercible"></a>

### An uncoercible literal is refused {#refuse-uncoercible}

`where message_created_at >= 'yesterday'` throws `TimestampLiteralError`
naming the column, the literal, and the accepted shapes. It does **not**
return zero rows.

This is the one place the fix makes a formerly-succeeding query fail, and it
is deliberate. PostgreSQL raises `invalid input syntax for type timestamp` on
the same query; more to the point, an empty result here is indistinguishable
from "nothing matched", which is precisely the confusion #860 is about. A
comparison that can never be satisfied for a reason the caller could fix
should say so. Coercing to `null` instead (what a bare `CAST` would do) would
reintroduce the silent empty result through the front door.

## Consequences {#consequences}

- `since`-style queries work as written, in both spellings, and a bare string
  bound now prunes row groups exactly as its typed twin does.
- `docs/ACCEPTANCE.md` keeps the trailing `Z`. The old text stripped it
  (`SINCE_SQL=${SINCE%Z}`) with a note that the zone-less form "compares
  cleanly", which was never true; worse, `new Date('...T21:00:00')` without a
  zone is *local* time, so on any non-UTC host the zone-less form silently
  shifts the window by the offset even once the coercion lands. Six steps and
  the note are corrected in the same change.
- `test/core/query-timestamp-literals.test.js` pins the row sets end to end
  through `executeQuerySql` over a real parquet partition, in both directions
  (rows inside the bound return; rows outside stay out; a bound far outside
  the data returns everything or nothing rather than zero either way), across
  every implicated operator, plus the NULL exclusions, the `STRING`-column
  non-coercion, and the refusal.
- Nothing about LLP 0222 changes. The converter is still icebird's, still the
  only one, and still sees exactly the AST shapes it already handled.

<a id="not-settled"></a>

## Not settled here: coercion for other types {#not-settled}

Only `TIMESTAMP` is coerced. A string literal against an `INT64` column
(`where id = '3'`) still compares as JS `==` does, and a string against
`BOOLEAN` or `DOUBLE` is likewise untouched. Those are not known to fail
silently the way the timestamp case does (JS `==` coerces numerics, so they
mostly answer correctly by accident), and widening the rewrite is a design
call about how much implicit coercion this engine should have. It needs its
own document, with its own evidence; this one fixes the case that returns
zero rows on matching data.
