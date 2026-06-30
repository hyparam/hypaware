# LLP 0057: Bounded Query Execution — Implementation Plan

**Type:** Plan
**Status:** Accepted
**Systems:** Query, Cache
**Author:** Phil / Claude
**Date:** 2026-06-30
**Related:** LLP 0054, LLP 0055, LLP 0056

> Turns the bounded-execution spec ([LLP 0054](./0054-bounded-query-execution.spec.md))
> and its two decisions ([LLP 0055](./0055-stream-aggregates-via-scancolumn.decision.md),
> [LLP 0056](./0056-refuse-over-spill-or-truncate.decision.md)) into ordered work
> across the kernel and its two first-party upstream engines. Closes
> [hyparam/hypaware-server#9](https://github.com/hyparam/hypaware-server/issues/9).

## Scope and package map

The fix spans three first-party packages plus the server:

| Part | Package | Where |
|------|---------|-------|
| #1 signal threading | `hypaware` kernel + `squirreling` | `src/core/query/sql.js`; squirreling `executeSql` entry |
| #2 `scanColumn` | `icebird` + `hypaware` kernel + ai-gateway | icebird source; `src/core/query/union-source.js`; ai-gateway `dataset.js` (`withSchemaColumns`) |
| #3 budget + refuse | `squirreling` + `hypaware` kernel | squirreling `sort.js`/`aggregates.js`; `ExecuteSqlOptions` on the public `hypaware/core/query` surface |

`squirreling` (`github.com/hyparam/squirreling`) and `icebird`
(`github.com/hyparam/icebird`) are pinned exactly in the kernel `package.json`
(`0.12.24` / `0.8.11`). Engine-side parts land as **upstream PRs**, then a
**deliberate pinned-version bump** in the kernel (the kernel never carets these).

## Phases

### Phase 0 — Measure (size the budget)

Reproduce issue #9's crashers against representative `ai_gateway_messages`
volume and record peak heap per query class (`ORDER BY`, high-card `GROUP BY`,
`COUNT(DISTINCT content_text)`, `COUNT(DISTINCT session_id)`). Output: the
conservative default buffered-row / buffered-byte ceilings for
[LLP 0054](./0054-bounded-query-execution.spec.md) `#execution-budget`, and a
before/after target for Phase 2. (Deferred during doc authoring; do this first
when implementing.)

### Phase 1 — Thread the abort signal (the enabler)

- `src/core/query/sql.js`: construct an `AbortSignal` (linked to any
  caller-supplied `signal` + an optional deadline) and pass it into
  `squirrelExecuteSql({ tables, query, signal })`. Add `signal?` (and the
  deadline source) to `ExecuteSqlOptions` (`src/core/query/types.d.ts`).
- Confirm squirreling's `executeSql` accepts a `signal` option and propagates it
  to the operator `context.signal` the operators already check (`sort.js`,
  `aggregates.js`). If it does not yet, that propagation is a small upstream
  squirreling addition.
- Activates the previously dead abort checks; unlocks timeout/cancel/watchdog.
  Bounds nothing yet.
- `@ref` to add → [LLP 0054](./0054-bounded-query-execution.spec.md)
  `#signal-threading` at the `squirrelExecuteSql` call site.

### Phase 2 — Implement `scanColumn` (light the streaming aggregates)

Per [LLP 0055](./0055-stream-aggregates-via-scancolumn.decision.md), bottom-up so
each layer can be tested before the one above:

1. **icebird** (upstream PR): implement `scanColumn({ column, limit, offset, signal })
   -> AsyncIterable<ArrayLike<SqlPrimitive>>` reading a single column's row-group
   chunks; honor `signal`.
2. **kernel `union-source.js`**: forward `scanColumn` by concatenating
   per-partition column streams; do **not** push `limit`/`offset` per partition
   (non-distributive — [LLP 0015](./0015-query-and-datasets.spec.md)
   "Multi-partition union").
3. **ai-gateway `withSchemaColumns`** (`hypaware-core/plugins-workspace/ai-gateway/src/dataset.js`):
   forward `scanColumn`; null-fill a column a partition physically lacks.
4. Bump the pinned `icebird` version in the kernel `package.json`.
- `@ref` to add → [LLP 0055](./0055-stream-aggregates-via-scancolumn.decision.md)
  at the icebird source factory, `union-source.js`, and `withSchemaColumns`.

### Phase 3 — Execution budget + refuse (the bound)

- **squirreling** (upstream PR): enforce a per-run buffered-row / buffered-byte
  budget in the three blocking operators (`sort.js`, `aggregates.js` group +
  distinct slow paths); on exceed, abort via `context.signal` semantics and
  raise a distinct `QueryBudgetExceededError` carrying the limit + operator
  ([LLP 0056](./0056-refuse-over-spill-or-truncate.decision.md)).
- **kernel**: add the budget to `ExecuteSqlOptions` (public `hypaware/core/query`
  surface, `src/core/query/index.js` / `types.d.ts`); pass it into
  `squirrelExecuteSql`; default to the conservative ceiling from Phase 0; map /
  re-export the typed error so callers can catch it.
- Bump the pinned `squirreling` version in the kernel.
- `@ref` to add → [LLP 0056](./0056-refuse-over-spill-or-truncate.decision.md) at
  the operator budget-check sites; [LLP 0054](./0054-bounded-query-execution.spec.md)
  `#execution-budget` at the `ExecuteSqlOptions` addition.

### Phase 4 — Wire the callers

- **CLI** (`hyp query`): pass the host-default budget; print the refusal to
  stderr with a non-zero exit.
- **MCP `query_sql`** ([LLP 0034](./0034-mcp-host-intrinsic.decision.md)):
  inherits automatically (same `executeQuerySql`); confirm the refusal renders
  as a tool error, not a silent empty result.
- **HypAware Server**: pass its operator-configured budget through the existing
  `hypaware/core/query` path and map the refusal to a 4xx. Tracked in the server
  corpus — **HypAware Server LLP 0020** — not here. The server response-edge cap
  (HypAware Server LLP 0006 `#result-caps`) stays; the two caps compose.

### Phase 5 — Tests and smokes

- **Traditional tests** (`test/**`): budget enforcement (refuse at the ceiling),
  the typed-error shape, `scanColumn` correctness on icebird + the union +
  schema-drift null-fill, and signal-driven abort.
- **Smoke**: run a known issue-#9 crasher (`ORDER BY` over the full dataset;
  `COUNT(DISTINCT content_text)`) and assert a **clean refusal** (typed error,
  bounded heap) instead of an OOM / zero-byte socket — a candidate
  `bounded_query_refusal` acceptance smoke alongside the
  `installed_daemon_idle_soak` family.
- Per the repo's log-driven-development rule, emit structured budget/refusal
  signals (`component: query`, `operation`, `error_kind: budget_exceeded`,
  buffered-row/byte high-water) so a smoke asserts the *internal* path, not only
  the exit code.

## `@ref` map (annotations to add when the code lands)

| Code site | LLP anchor | relation |
|-----------|-----------|----------|
| `src/core/query/sql.js` (`squirrelExecuteSql` call) | LLP 0054 `#signal-threading` | implements |
| `src/core/query/types.d.ts` / `index.js` (`ExecuteSqlOptions` budget) | LLP 0054 `#execution-budget` | implements |
| `src/core/query/union-source.js` (`scanColumn` forward) | LLP 0055 | implements |
| ai-gateway `dataset.js` (`withSchemaColumns` `scanColumn`) | LLP 0055 | implements |
| icebird source factory (`scanColumn`) | LLP 0055 | implements |
| squirreling `sort.js` / `aggregates.js` (budget check) | LLP 0056 | implements |

## Test ownership

- `scanColumn` correctness + union concatenation + schema-drift null-fill →
  traditional tests in the kernel; column-read correctness also covered by an
  icebird upstream test.
- Budget refuse threshold + typed error → traditional kernel tests against a
  small fixture with a low budget.
- End-to-end "crasher refuses, daemon survives" → the `bounded_query_refusal`
  smoke.

## References

- [LLP 0054](./0054-bounded-query-execution.spec.md),
  [LLP 0055](./0055-stream-aggregates-via-scancolumn.decision.md),
  [LLP 0056](./0056-refuse-over-spill-or-truncate.decision.md).
- [LLP 0015](./0015-query-and-datasets.spec.md),
  [LLP 0034](./0034-mcp-host-intrinsic.decision.md).
- HypAware Server LLP 0006 `#result-caps`, LLP 0002 `#kernel-compatibility`,
  LLP 0020 (server-side wiring + the named-kernel-extension decision).
- GitHub issue [hyparam/hypaware-server#9](https://github.com/hyparam/hypaware-server/issues/9).
