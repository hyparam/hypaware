# LLP 0056: Refuse Over Spill or Truncate When a Query Exceeds Its Budget

**Type:** Decision
**Status:** Draft
**Systems:** Query
**Author:** Phil / Claude
**Date:** 2026-06-30
**Related:** LLP 0054, LLP 0057

> The policy for what a blocking operator does when it would exceed the
> execution budget. Implements the `#refusal` requirement of
> [LLP 0054](./0054-bounded-query-execution.spec.md).

## Context

After streaming removes the aggregate crashers
([LLP 0055](./0055-stream-aggregates-via-scancolumn.decision.md)), three operators
still **must** buffer to produce a correct answer over an unbounded input:

- `ORDER BY` — needs the whole input before it can emit the first sorted row;
- high-cardinality `GROUP BY` — its hash table grows with the number of groups;
- `COUNT(DISTINCT content_text)` — its distinct set grows with the number of
  distinct (large) values.

The execution budget ([LLP 0054](./0054-bounded-query-execution.spec.md)
`#execution-budget`) caps how much these may buffer. The open question is what
happens at the cap. Three behaviours are possible.

## Options considered

1. **Refuse** — abort mid-stream (via the threaded signal,
   [LLP 0054](./0054-bounded-query-execution.spec.md) `#signal-threading`) and
   return a distinct, typed error naming the limit hit. Correct, cheap, and
   never returns a wrong answer. The query simply does not run to completion.
2. **Spill to disk** — external-merge `ORDER BY` / on-disk hash for `GROUP BY` /
   `DISTINCT`. Correct **and** completes, at the cost of temp-file lifecycle,
   disk IO, and real operator complexity in squirreling.
3. **Truncate** — return a partial result with a `truncated` flag. For
   aggregates this is **a wrong answer, not a correct prefix**: a partial
   `COUNT(DISTINCT …)` or `GROUP BY` undercounts silently. For `ORDER BY` a
   sorted prefix could in principle be correct, but only *after* the full input
   has been buffered and sorted — which is exactly the memory we are trying not
   to spend — so it does not actually bound anything.

## Decision

**V1 refuses.** When a blocking operator's buffer would exceed the execution
budget, the run aborts mid-stream and surfaces a distinct, typed error (a
`QueryBudgetExceededError`-class value carrying which limit was hit and the
operator that hit it). It returns **no rows**.

This refusal is deliberately distinct from HypAware Server LLP 0006
`#result-caps`' `truncated: true`. That is a **correct, complete-up-to-N**
result trimmed at the response edge after the engine finished; this is a
**refusal to produce a result at all** because finishing would exhaust memory.
Surfacing them as the same thing would tell a user "showing first N rows" when
in fact the query never ran. Callers render the refusal as actionable guidance —
"query exceeded its execution budget; add a `WHERE`/`date` filter or aggregate":
HypAware Server maps it to a 4xx; the local CLI prints it to stderr with a
non-zero exit.

**Spill to disk is the named deferred follow-up**, not a V1 feature. It would
upgrade individual operators from *refuse* to *complete* without changing the
success-path wire contract, so it can land later behind the same budget knob.

**Truncate is rejected** for budget-exceed: it is correct for no aggregate and
illusory for `ORDER BY`.

## Consequences

- A well-formed but too-large query gets a **fast, honest error** in place of an
  OOM that kills the daemon for every caller (issue #9). This is the behaviour
  that makes the [LLP 0054](./0054-bounded-query-execution.spec.md)
  `#memory-invariant` actually hold for the operators streaming cannot help.
- Some queries that *would* have completed (given unbounded memory) now refuse;
  the user's recourse is a filter, an aggregate, or — for bulk extraction —
  reading the Iceberg archive directly, the same escape hatch HypAware Server
  LLP 0006 already points bulk consumers at.
- The typed error is part of the `hypaware/core/query` contract
  ([LLP 0054](./0054-bounded-query-execution.spec.md) `#uniform-surface`), so CLI,
  MCP, and server callers all distinguish refusal from truncation without
  per-surface logic.
- A later spill-to-disk follow-up can relax specific operators to complete
  without breaking callers written against the refusal contract.

The buffering operators (squirreling `sort.js` / `aggregates.js`) carry an
`@ref` to this decision at the budget-check site when implemented.
