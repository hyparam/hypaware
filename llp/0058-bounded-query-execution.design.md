# LLP 0058: Bounded Query Execution — technical design

**Type:** design
**Status:** Accepted
**Systems:** Query, Cache
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-06-30
**Related:** LLP 0054, LLP 0055, LLP 0056, LLP 0057

> Buildable design for bounded query execution: how the kernel query plane keeps a
> single SELECT from accumulating unbounded intermediate state and OOM-killing the
> daemon for every caller.
> `@ref LLP 0054#memory-invariant [implements]` — realizes the budget-bounded peak-memory
> invariant uniformly across every caller of the `hypaware/core/query` surface.
> `@ref LLP 0054#signal-threading [implements]` — the kernel constructs and forwards the
> `AbortSignal` the engine already reads but never receives.
> `@ref LLP 0054#streaming-first [implements]` — lights squirreling's dormant `scanColumn`
> aggregate path by implementing the column hook down the source stack.
> `@ref LLP 0054#execution-budget [implements]` — adds the execution budget to the public
> `ExecuteSqlOptions`, distinct from the existing display controls.
> `@ref LLP 0054#refusal [implements]` — over-budget operators raise one typed refusal error.
> `@ref LLP 0055 [constrained-by]` — the streaming mechanism is `scanColumn` down the source
> stack, not an operator rewrite; a missing column hook falls back to the bounded buffer.
> `@ref LLP 0056 [constrained-by]` — at the budget ceiling V1 refuses with a typed error; no
> spill, no truncation.

## Problem: where the scan buffers and OOMs today {#problem}

The kernel entry point `executeQuerySql` ([`src/core/query/sql.js`](../src/core/query/sql.js))
builds one squirreling `AsyncDataSource` per referenced dataset and then, at
`sql.js:115-116`, calls `squirrelExecuteSql({ tables, query: trimmed })` with **no
`signal`** and immediately `collect(results)`, which re-materializes the result into a
plain array. The three blocking operators in the pinned engine (`squirreling@0.12.24`)
buffer the **whole scanned input** before they can emit a row: `executeSort`
(`node_modules/squirreling/src/execute/sort.js`, `rows.push(row)` for every child row
before the sort), the scalar-aggregate slow path (`src/execute/aggregates.js`
`executeScalarAggregate`, which collects every source row into one `group` array), and
high-cardinality `GROUP BY` (`executeHashAggregate`). Over the ~495k-row
`ai_gateway_messages` dataset a single such query exhausts the heap and the process is
OOM-killed mid-request, taking the daemon down for every caller (HypAware Server issue
[#9](https://github.com/hyparam/hypaware-server/issues/9)). The abort machinery already
exists but is unreachable from the kernel: those operators check `context.signal?.aborted`
(`sort.js:136`, `aggregates.js:210`), squirreling's `executeSql({ tables, query, functions,
signal })` already threads a `signal` into the operator `context` (`execute.js:29` /
`execute.js:52`), and even the leaf parquet scan honors it at the row-group boundary
([`src/core/query/parquet-source.js:69`](../src/core/query/parquet-source.js),
`if (hints.signal?.aborted) throw abortError()`); but the kernel call site supplies no
signal, so the whole abort path is dead code. The streaming aggregate fast path is dormant
for the same shape of reason: `tryColumnScanAggregate` (`aggregates.js:256`) bails to the
buffering slow path when `!table?.scanColumn` (`aggregates.js:267`), and no kernel data
source implements the optional `scanColumn` hook (`AsyncDataSource.scanColumn?`,
squirreling `src/types.d.ts:82`): `unionSources` and `emptySource`
([`src/core/query/union-source.js`](../src/core/query/union-source.js)), `parquetDataSource`
([`src/core/query/parquet-source.js`](../src/core/query/parquet-source.js)), and the
ai-gateway `withSchemaColumns` wrapper
([`hypaware-core/plugins-workspace/ai-gateway/src/dataset.js:167`](../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js))
each expose only `{ columns, numRows, scan }`. The only bound that exists today,
`ContextControls` (`maxCell` / `maxBytes`, [`src/core/query/types.d.ts:18`](../src/core/query/types.d.ts)),
trims **display** bytes after `collect()` returns ([`format.js`](../src/core/query/format.js),
wired in [`verb.js`](../src/core/query/verb.js)), so it bounds the printed payload but never
the execution buffers; and `scope.limit` (defaulted to `1_000_000` at `sql.js:33`) is not a
row cap because `unionSources` strips `limit`/`offset` from its sub-scans (`union-source.js:47`).

## Design overview {#overview}

Three coordinated mechanisms plug into the existing kernel query plane. None adds a new
import surface: the budget rides on `ExecuteSqlOptions`, the public `hypaware/core/query`
surface every caller already depends on.

1. **Signal threading** ([§signal](#signal)) makes the engine's existing abort checks
   reachable. It is the enabling mechanism; it bounds nothing on its own.
2. **`scanColumn` down the source stack** ([§scancolumn](#scancolumn), constrained by
   [LLP 0055](./0055-stream-aggregates-via-scancolumn.decision.md)) lights the streaming
   aggregate path so the common crashers (`COUNT`, `MIN`, `MAX`, `SUM`, `AVG`, low-card
   `COUNT(DISTINCT …)`) hold O(1) or O(cardinality) state and never buffer the scan.
3. **An execution budget with refusal** ([§budget](#budget), constrained by
   [LLP 0056](./0056-refuse-over-spill-or-truncate.decision.md)) caps what must still buffer
   (`ORDER BY`, high-card `GROUP BY`, `COUNT(DISTINCT content_text)`) and aborts over the
   ceiling with a distinct typed error instead of crashing.

The split is deliberate and follows the two decisions: streaming removes the common
aggregate crashers, the budget backstops whatever still buffers, and the threaded signal is
the single abort primitive both reuse
(`@ref LLP 0054#memory-invariant`). Each piece lands where the buffering lives, the kernel
query plane plus its two first-party upstream engines, so every surface
([§callers](#callers)) inherits the bound from one implementation.

## Signal threading: construct and forward the AbortSignal {#signal}

`executeQuerySql` constructs an `AbortSignal` (linked to any caller-supplied `signal` and to
an optional deadline) and forwards it into the engine at the call site that currently omits
it, `squirrelExecuteSql({ tables, query: trimmed, signal })` (`sql.js:115`). `signal?` and the
optional deadline source are added to `ExecuteSqlOptions`
([`src/core/query/types.d.ts`](../src/core/query/types.d.ts)).

The engine side needs no change for signal plumbing: `squirreling@0.12.24` (pinned in
`package.json`) already accepts `signal` on `executeSql` and threads it through `context.signal`
to the operators that read it, so supplying the signal at the kernel call site is the whole
fix for this piece. This is the **enabler** for both budget refusal ([§budget](#budget)) and
ordinary cancellation, deadline/timeout, and watchdog abort; on its own it lets a long query be
torn down cleanly but bounds nothing.

`@ref` to add when the code lands: `@ref LLP 0054#signal-threading [implements]` at the
`squirrelExecuteSql` call site in `sql.js`.

## Streaming aggregates: `scanColumn` down the source stack {#scancolumn}

Per [LLP 0055](./0055-stream-aggregates-via-scancolumn.decision.md), implement the streaming
column hook end-to-end so the engine's existing fast path (`tryColumnScanAggregate` →
`scanColumnAggregate`, `aggregates.js`) lights up. The hook matches squirreling's already-typed
contract `scanColumn({ column, limit, offset, signal }) -> AsyncIterable<ArrayLike<SqlPrimitive>>`
(`ScanColumnOptions`, squirreling `src/types.d.ts:114`). It is added bottom-up so each layer is
testable before the one above:

- **icebird Iceberg source** (upstream `github.com/hyparam/icebird`, then a deliberate pinned
  bump from `icebird@0.8.11`): read a single column's values via row-group column chunks, yield
  them as an async iterable, and honor `signal` (`@ref LLP 0054#signal-threading`).
- **core `unionSources`** ([`src/core/query/union-source.js`](../src/core/query/union-source.js)):
  forward `scanColumn` by **concatenating per-partition column streams**, applying the same
  non-distributive discipline the existing row `scan` already applies. `limit`/`offset` are not
  pushed per partition (the union already strips them at `union-source.js:47` because they are
  not distributive across a concatenation, `@ref LLP 0015#multi-partition-union`); the engine
  re-applies them over the merged column stream. `emptySource` yields an empty column stream.
- **ai-gateway `withSchemaColumns`** ([`dataset.js:167`](../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js)):
  forward `scanColumn`; a partition whose physical schema lacks the requested column yields nulls
  rather than throwing, the same additive schema-drift rule its row `scan` already applies
  (`@ref LLP 0032#capture`).

With the hook present, `tryColumnScanAggregate` stops bailing at the `!table?.scanColumn` guard:
`COUNT` / `MIN` / `MAX` / `SUM` / `AVG` hold a single accumulator (O(1) rows) and
`COUNT(DISTINCT low-card)` holds a distinct-key set whose size is the column's cardinality, not the
row count, so neither reaches the execution budget. A source that cannot stream a given column
simply omits `scanColumn` for it; the engine then falls back to the buffering path, which is now
bounded by the budget ([§budget](#budget)). The two are complementary, exactly as the decision
frames them.

`@ref` to add when the code lands: `@ref LLP 0055 [implements]` at the icebird source factory,
`union-source.js`, and `withSchemaColumns`.

## Execution budget and refusal {#budget}

Per [LLP 0056](./0056-refuse-over-spill-or-truncate.decision.md), the operators that must buffer
to be correct (`ORDER BY`, high-card `GROUP BY`, `COUNT(DISTINCT content_text)`) gain a per-run
budget and refuse over it rather than spilling or truncating.

- **Public option.** `ExecuteSqlOptions`
  ([`src/core/query/types.d.ts`](../src/core/query/types.d.ts), exported through
  [`index.js`](../src/core/query/index.js)) gains an execution budget with a **buffered-row
  ceiling** (rows held by the sort/group/distinct buffers) and an **estimated buffered-byte
  ceiling** (cumulative size of buffered cell values), whichever trips first
  (`@ref LLP 0054#execution-budget`). This is distinct from `ContextControls` (`maxCell` /
  `maxBytes`), which bound display bytes after materialization; a query can be cheap to display
  yet ruinous to execute (`COUNT(DISTINCT content_text)` returns one number), so the two caps
  compose and neither subsumes the other. The kernel ships a conservative default ceiling so an
  un-configured `hyp query` is bounded out of the box. The concrete default numbers are deferred
  to the [LLP 0057](./0057-bounded-query-execution.plan.md) Phase 0 measurement; this design fixes
  the knob and its semantics, not the value.
- **Operator enforcement** (upstream `squirreling` PR, then a pinned bump). Inside the three
  blocking operators (`sort.js` push loop; `aggregates.js` scalar slow-path `group` and the
  high-card hash/distinct paths) track the running buffered-row and buffered-byte counts; when
  either would exceed the ceiling, the operator aborts via the threaded signal semantics and
  raises a distinct typed `QueryBudgetExceededError`-class value carrying the limit that was hit
  and the operator that hit it. It returns **no rows**. This is a refusal, not a truncation: a
  partial `COUNT(DISTINCT …)` or `GROUP BY` undercounts silently, and a sorted prefix would only
  be correct after the full input was already buffered, the exact memory the budget exists to
  avoid (`@ref LLP 0056 [constrained-by]`).
- **Kernel wiring.** `executeQuerySql` passes the budget into `squirrelExecuteSql`, defaults it to
  the conservative ceiling, and re-exports/maps the typed error so callers can catch it. The error
  is part of the `hypaware/core/query` contract (`@ref LLP 0054#uniform-surface`) and is
  deliberately distinct from HypAware Server LLP 0006 `#result-caps`' `truncated: true`, which trims
  an already-correct materialized result at the response edge.

`@ref` to add when the code lands: `@ref LLP 0056 [implements]` at the operator budget-check sites;
`@ref LLP 0054#execution-budget [implements]` at the `ExecuteSqlOptions` addition.

## One bound, every surface {#callers}

Because SQL query is intrinsic ([LLP 0015](./0015-query-and-datasets.spec.md)) and MCP hosting is
intrinsic ([LLP 0034](./0034-mcp-host-intrinsic.decision.md)), the local `hyp query` CLI, the
`query_sql` MCP tool (the `querySqlVerb` in [`src/core/query/verb.js`](../src/core/query/verb.js),
whose `operation` calls the same `executeQuerySql`), and HypAware Server's `POST /v1/query` all run
the **same** kernel path and inherit the budget and refusal from one implementation, with no
per-surface re-derivation (`@ref LLP 0054#uniform-surface`). They differ only in how they render the
refusal: the CLI prints the typed error to stderr with a non-zero exit; the MCP tool renders it as a
tool error rather than a silent empty result; HypAware Server maps it to a 4xx and keeps its
response-edge cap (server LLP 0006), the two caps composing. The server-side wiring (passing its
operator-configured budget through the existing import path, mapping the refusal) is tracked in the
server corpus (server LLP 0020), not here.

## Telemetry {#telemetry}

Log-driven (CLAUDE.md): around the call site and the refusing operators emit structured
budget/refusal signals reusing the existing `query.execute_sql` span (`sql.js`): `component: 'query'`,
`operation`, `error_kind: 'budget_exceeded'`, the operator that refused, and the buffered-row /
buffered-byte high-water marks. A smoke then asserts the internal path (a clean typed refusal with a
bounded heap), not only the process exit code.

## Test plan {#tests}

Test ownership at the design level (the [LLP 0057](./0057-bounded-query-execution.plan.md) plan
sequences these):

- **Traditional tests** (`test/**`): `scanColumn` correctness on icebird, union concatenation, and
  the ai-gateway schema-drift null-fill; budget refuse threshold and typed-error shape against a small
  fixture with a deliberately low budget; signal-driven abort.
- **Smoke**: drive a known issue-#9 crasher (`ORDER BY` over the full dataset;
  `COUNT(DISTINCT content_text)`) and assert a clean refusal (typed error, bounded heap) instead of an
  OOM or a zero-byte socket, a candidate `bounded_query_refusal` acceptance smoke alongside the
  `installed_daemon_idle_soak` family.

## Relationship to the existing plan {#plan}

[LLP 0057](./0057-bounded-query-execution.plan.md) is the existing **prose** implementation plan for
this package: it carries the phase ordering, the three-package scope map (`hypaware` kernel +
`squirreling` + `icebird`), and the upstream-PR-then-pinned-bump discipline (`squirreling@0.12.24`,
`icebird@0.8.11` are pinned exactly, never carated). This design is the technical HOW that plan
executes against. A neutral executable plan (with `## Tasks`) will extend LLP 0057 to drive
implementation; this design does not restate 0057's phasing and does not own the task list.

## Out of scope (V1) {#out-of-scope}

Carried from the spec and the two decisions:

- **Spill-to-disk.** The named deferred follow-up in
  [LLP 0056](./0056-refuse-over-spill-or-truncate.decision.md) that would let a large `ORDER BY` /
  `GROUP BY` **complete** instead of refuse; it can land later behind the same budget knob without
  changing the success-path wire contract.
- **Concrete default budget numbers.** Deferred to the LLP 0057 Phase 0 measurement pass.
- **Per-call budget override on the MCP/remote surface.** An open question in
  [LLP 0054](./0054-bounded-query-execution.spec.md); this design fixes only the host-default budget.
- **Process isolation.** [LLP 0038](./0038-split-query-export-daemon-from-gateway.todo.md) is the
  defense-in-depth sibling that contains the pathological query escaping any bound; bounding and
  isolation are complementary, neither replaces the other.

## Annotation map (for the implementing change set) {#annotation-map}

| Code site | Annotation |
|-----------|------------|
| `src/core/query/sql.js` (`squirrelExecuteSql` call) | `@ref LLP 0054#signal-threading [implements]` |
| `src/core/query/types.d.ts` / `index.js` (`ExecuteSqlOptions` budget) | `@ref LLP 0054#execution-budget [implements]` |
| `src/core/query/union-source.js` (`scanColumn` forward) | `@ref LLP 0055 [implements]` |
| ai-gateway `dataset.js` (`withSchemaColumns` `scanColumn`) | `@ref LLP 0055 [implements]` |
| icebird source factory (`scanColumn`) | `@ref LLP 0055 [implements]` |
| squirreling `sort.js` / `aggregates.js` (budget check) | `@ref LLP 0056 [implements]` |

## References

- [LLP 0054](./0054-bounded-query-execution.spec.md) — Bounded Query Execution (the spec this
  design covers).
- [LLP 0055](./0055-stream-aggregates-via-scancolumn.decision.md) — stream aggregates via
  `scanColumn`.
- [LLP 0056](./0056-refuse-over-spill-or-truncate.decision.md) — refuse over spill/truncate.
- [LLP 0057](./0057-bounded-query-execution.plan.md) — the prose implementation plan.
- [LLP 0015](./0015-query-and-datasets.spec.md), [LLP 0034](./0034-mcp-host-intrinsic.decision.md),
  [LLP 0032](./0032-github-llm-graph-bridge.decision.md), [LLP 0038](./0038-split-query-export-daemon-from-gateway.todo.md).
- GitHub issue [hyparam/hypaware-server#9](https://github.com/hyparam/hypaware-server/issues/9).
- Engines: [squirreling](https://github.com/hyparam/squirreling) (operators + the `scanColumn`
  interface), [icebird](https://github.com/hyparam/icebird) (the Iceberg `AsyncDataSource`).
