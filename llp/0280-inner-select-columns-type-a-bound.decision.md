# LLP 0280: A CTE or derived table carries its columns' types to the bound

**Type:** Decision
**Status:** Accepted
**Systems:** Query
**Author:** Phil / Claude
**Date:** 2026-08-19
**Extends:** LLP 0272 (which typed a bound from a dataset schema and named the
relations the registry cannot name as an open residual)
**Related:** LLP 0222, LLP 0098

> A relation the registry cannot name still supplies its columns, when the
> inner select behind it can be read end to end. The column list a CTE or
> derived table exposes is carried out of its body, so a string bound written
> on it is typed exactly as the same bound on the base table is. An inner
> select that cannot be read completely supplies nothing at all.

## Context {#context}

LLP 0272 typed a bare string literal from the **dataset schema** of the
relation it is compared against, and closed issue #860 for the shape the issue
reported. It named two residuals under
[`#not-settled-derived`](0272-string-literals-typed-by-the-column.decision.md#not-settled-derived)
and issue #906 carried them forward.

The first residual is a real defect with the same signature as #860. Against
the four-row fixture in `test/core/query-timestamp-literals.test.js`, every one
of these returned **zero rows** and exited 0:

```
with c as (select * from ai_gateway_messages) select id from c where message_created_at >= '2026-08-18T21:00:00Z'
with c as (select id, message_created_at as ts from ai_gateway_messages) select id from c where ts >= '...'
select id from (select * from ai_gateway_messages) t where message_created_at >= '...'
select t.id from (select * from ai_gateway_messages) t where t.message_created_at >= '...'
with c as (...), d as (select * from c) select id from d where message_created_at >= '...'
select id from (select * from m union all select * from m) t where message_created_at >= '...'
```

Each of them returns rows the moment the literal is written `TIMESTAMP '...'`,
which is the tell: the query plan is fine and only the literal's type is wrong.
`with` is the idiomatic way to write anything but the shortest `hyp query sql`,
so this is not a corner of the language.

LLP 0272 declined to close it because typing the bound needs the inner select's
output column *types*, "column inference the engine already owns and does not
export". That is true of full inference. It is not true of the question this
rewrite actually asks, which is narrower: **is this one name a TIMESTAMP, or
not?** A walk that answers "not" whenever it is unsure is sound, because
answering "not" is exactly what LLP 0272 already does for every relation it
cannot read, and it costs only the pruning.

## Decision {#decision}

### A relation supplies a column list, whatever kind of relation it is {#carry}

`src/core/query/timestamp-literals.js` resolves every relation a select binds
to the same shape, an ordered `{ name, isTimestamp }[]`:

- a **dataset** answers from its declared schema, as before;
- a **CTE** answers from the list its body was proved to expose, computed once
  where the CTE is bound and carried in the same map that already records the
  shadowing (so a CTE still shadows a dataset of its name, case-insensitively);
- a **derived table** is walked in place;
- anything else (a table function) answers with nothing.

Because the list is the only currency, everything LLP 0272 built on a dataset
schema now works over a CTE and a derived table unchanged: `agreed` for an
unqualified reference, `byRelation` for a qualified one, the outward walk for a
correlated one, and the type-carrying calls.

The carried type is the **inner expression's**, never the outer name's. A
column list is read from the inner select's own `SELECT` clause:

- `*` expands to the relations it covers, in FROM-then-JOIN order; `t.*`
  expands to the one relation `t` names.
- an aliased or bare-named column takes the alias as its output name, and its
  type from the expression under it.
- an expression is a TIMESTAMP only when it provably carries one: a column
  reference the inner relations declare TIMESTAMP, a `CAST(... AS TIMESTAMP)`,
  or a type-preserving call (the same `TYPE_PRESERVING_ARGS` table LLP 0272
  settled) every type-carrying argument of which is a TIMESTAMP. Everything
  else is not a TIMESTAMP.
- a set operation pairs its sides by position and keeps a type only when both
  sides have it.

So `with c as (select id, date as message_created_at from ai_gateway_messages)`
exposes a `message_created_at` that is a `STRING`, and a bound on it keeps its
string comparison. Typing that one from the dataset that shares the name would
compare a string cell to a `Date`, which is the silently-empty answer LLP 0272
exists to end, pointed the other way.

### The list is complete or it is nothing {#complete}

An inner select supplies its **whole** column list or none of it. If any
relation in its `FROM` cannot be read, or any output column cannot be given a
name (an unaliased expression), the walk returns nothing and the relation is
treated exactly as LLP 0272 treated every CTE: present in `bound`, absent from
`byRelation` and from `agreed`.

A partial list would be worse than no list. `agreed` is an intersection over
the relations in scope, so a name a partial list happened to omit could be
typed from an unrelated relation that declares it, which is a wrong coercion
and wrong rows. Refusing costs only the pruning, and that is the trade LLP 0272
already made.

A complete list is not a list of *distinct* names. A relation can expose one
name twice, because `*` expands every relation in the join and two of them may
declare the same column with different types. The occurrence a reference to
that name actually reaches is the engine's call, not this walk's (squirreling
flattens a CTE's duplicate last-wins and rejects the derived-table spelling of
the same reference outright), so a name is a TIMESTAMP only when **every**
occurrence of it is, both for the unqualified reference `agreed` answers and
for the qualified one `byRelation` answers. Reading the first occurrence, or
the union of the TIMESTAMP ones, types the bound against a column the engine
does not hand it: the bound then goes silently empty on matching data, and a
string bound that is not a timestamp at all is refused outright by
[LLP 0272 `#refuse-uncoercible`](0272-string-literals-typed-by-the-column.decision.md#refuse-uncoercible).
Both are the failure this document exists to avoid, so an ambiguous name is
simply not typed.

The boundary is therefore visible and testable rather than implicit:
`with c as (select * from other)` (unregistered), `select id, upper(date)`
(an output column with no name), and `from unnest(...)` (a table function) all
type nothing.

### The unqualified correlated reference is not this defect {#unqualified-correlated}

LLP 0272 named a second residual: `... where exists (select 1 from n where ts
>= '...')`, where `ts` belongs to the enclosing select rather than to `n`. It
is **not** a coercion defect, and it is not closed here because there is
nothing at this layer to close.

squirreling does not resolve an unqualified name into an enclosing select at
all. The query raises `Column "message_created_at" not found. Available
columns: id, weight` before any comparison is evaluated, and it raises
identically whether the literal is written bare or as `TIMESTAMP '...'`. There
is no silent empty result, and typing the literal could not change the answer;
it would only trade one error message for another. The rewrite therefore leaves
the shape alone, and `test/core/query-timestamp-literals.test.js` pins the
engine's rejection in both spellings so that a future squirreling that does
resolve the reference fails this repo's suite rather than passing it silently.

The machinery this document adds is what a fix would need if that day comes:
proving a name is *not* an inner relation's requires the inner relations' full
column lists, which is now exactly what `#complete` computes. What is missing
is only an engine that can evaluate the resolved reference.

## Consequences {#consequences}

- The six shapes in [#context](#context) return the rows they name, and agree
  row for row with their `TIMESTAMP '...'` spellings.
- `hyp query sql` gains row-group pruning on a bound written through a CTE,
  which it previously lost along with the rows.
- Nothing about LLP 0222 changes. The rewrite still emits the one `cast` node
  both evaluators already fold, and the converter still sees only AST shapes it
  handled before.
- The `TimestampScope` interface keeps its three members; what changed is the
  set of relations that can fill them. `InferredColumn` and `RelationRef` are
  new in `src/core/query/types.d.ts`.
- A recursive CTE is not special-cased, because squirreling does not parse one.

<a id="not-settled-inference"></a>

## Not settled here: real column inference {#not-settled-inference}

This is a *predicate*, not an inference engine: it answers "is this name a
TIMESTAMP" and nothing else. It does not compute the type of an arbitrary
expression, does not model `USING`/natural-join column merging, does not know
what a table function returns, and gives up on an output column that has no
name. Widening any of those is a separate design call, and it should be made
against evidence of a query that fails, the way this one was, rather than for
completeness.

Coercion for types other than `TIMESTAMP` remains where LLP 0272 left it
(`#not-settled` there): unopened, and needing its own document.
