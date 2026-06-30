# LLP 0059: Bounded Query Execution: Executable Plan

**Type:** plan
**Status:** Accepted
**Systems:** Query, Cache
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-06-30
**Related:** LLP 0054, LLP 0057, LLP 0058

> The executable task breakdown for the bounded-query-execution change set: the
> ordered, independently-mergeable tasks that realize the kernel `/v1/query` OOM fix
> across the kernel query plane and its two first-party upstream engines.
> `@ref LLP 0058 [implements]` — implements the technical design (signal threading,
> `scanColumn` down the source stack, and the execution budget with refusal).
> `@ref LLP 0054 [implements]` — satisfies the bounded-execution spec and its
> `#memory-invariant`, `#signal-threading`, `#streaming-first`, `#execution-budget`,
> and `#refusal` requirements uniformly across every caller of `hypaware/core/query`.
> `@ref LLP 0057` — extends the human prose plan with a neutral `## Tasks` block; it does
> not supersede or restate 0057's phasing, three-package scope map, or upstream-PR-then-pinned-bump discipline.

## Overview {#overview}

This is the neutral executable plan that drives implementation of the bounded-query-execution
package. It carries the task list the prose plan ([LLP 0057](./0057-bounded-query-execution.plan.md))
deliberately left to a neutral plan, and it implements the buildable design
([LLP 0058](./0058-bounded-query-execution.design.md)) without restating it. Read 0058 for the
HOW (the code-site annotation map, the `sql.js:115` OOM site, the dormant `scanColumn` and dead
`context.signal` paths); this plan only sequences the work.

The design's three coordinated mechanisms map onto the tasks below:

1. **Signal threading** (the enabler): T1.
2. **`scanColumn` down the source stack** (per [LLP 0055](./0055-stream-aggregates-via-scancolumn.decision.md)):
   T2 (icebird leaf), T3 (core union), T4 (ai-gateway schema wrapper), and T5 (the streaming
   aggregate path lit end-to-end over the real stack).
3. **Execution budget with refusal** (per [LLP 0056](./0056-refuse-over-spill-or-truncate.decision.md)):
   T6 (squirreling operator enforcement plus the typed error) and T7 (the public `ExecuteSqlOptions`
   budget plus the kernel wiring).

T8 wires the CLI and MCP callers plus telemetry; T9 is the end-to-end gate that proves the spec's
`#memory-invariant` holds across both the streaming and the budget mechanisms.

**Dependency shape.** Five roots are branch-disjoint and parallelizable: T1 (signal), T2/T3/T4 (the
three `scanColumn` forwarding layers, each unit-testable with a fake or fixture child source), and
T6 (the squirreling upstream change). T5 fans in over the three hook layers; T7 fans in over the
signal enabler and the squirreling budget; T8 follows T7; T9 fans in over the streaming path, the
budget option, and the caller wiring. The two engine-side tasks (T2 icebird, T6 squirreling) each
land as an upstream PR followed by a deliberate pinned-version bump in the kernel `package.json`
(`icebird@0.8.11`, `squirreling@0.12.24` are pinned exactly, never carated).

## Tasks

- id: T1  branch: task/bounded-query-execution/T1  deps: []            -- Kernel signal threading (`@ref LLP 0054#signal-threading [implements]`): in `src/core/query/sql.js` construct an `AbortSignal` (linked to any caller-supplied `signal` and an optional deadline) and forward it into the engine at `squirrelExecuteSql({ tables, query: trimmed, signal })` (sql.js:115, which currently omits it); add `signal?` and the deadline source to `ExecuteSqlOptions` (`src/core/query/types.d.ts`). squirreling@0.12.24 already threads `signal` through `context.signal` to the operators (`sort.js:136`, `aggregates.js:210`), so no engine change is needed here. Enabler only; bounds nothing on its own. Tests in `test/**`: a caller-aborted signal tears down a running query mid-scan.
- id: T2  branch: task/bounded-query-execution/T2  deps: []            -- icebird `scanColumn` (upstream `github.com/hyparam/icebird` PR, then a deliberate pinned bump from `icebird@0.8.11` in kernel `package.json`; `@ref LLP 0055 [implements]` at the source factory): implement `scanColumn({ column, limit, offset, signal })` returning `AsyncIterable<ArrayLike<SqlPrimitive>>` over a single column's row-group chunks and honor `signal` (the column scan honors `@ref LLP 0054#signal-threading`). Upstream icebird test for single-column read correctness; the kernel-side pinned bump is the consumption point.
- id: T3  branch: task/bounded-query-execution/T3  deps: []            -- Core union `scanColumn` forward (`@ref LLP 0055 [implements]`) in `src/core/query/union-source.js`: forward `scanColumn` by concatenating per-partition column streams, NOT pushing `limit`/`offset` per partition (not distributive across a concatenation, matching the existing row `scan` strip at union-source.js:47; the engine re-applies them over the merged stream, `@ref LLP 0015#multi-partition-union`); `emptySource` yields an empty column stream. Unit-tested with a fake child source exposing `scanColumn` (concatenation order, limit/offset re-application over the merged stream, empty source).
- id: T4  branch: task/bounded-query-execution/T4  deps: []            -- ai-gateway `withSchemaColumns` `scanColumn` forward (`@ref LLP 0055 [implements]`) in `hypaware-core/plugins-workspace/ai-gateway/src/dataset.js:167`: forward `scanColumn` to the wrapped source; a partition whose physical schema lacks the requested column yields nulls rather than throwing (the same additive schema-drift rule its row `scan` already applies, `@ref LLP 0032#capture`). Unit-tested: a present column streams through; an absent column null-fills; never throws on drift.
- id: T5  branch: task/bounded-query-execution/T5  deps: [T2, T3, T4]  -- Streaming aggregates light up end-to-end (per LLP 0055): with `scanColumn` present down the real ai-gateway source stack (icebird leaf via T2, core union via T3, schema wrapper via T4), `tryColumnScanAggregate` stops bailing at the `!table?.scanColumn` guard (squirreling `aggregates.js:267`), so `COUNT`/`MIN`/`MAX`/`SUM`/`AVG` hold a single accumulator (O(1) rows) and `COUNT(DISTINCT low-card)` holds an O(cardinality) key set with zero row buffering. Kernel integration tests in `test/**` proving the column-scan path is taken and peak memory is O(cardinality)/O(1) (not O(rows)) for `COUNT(DISTINCT session_id)` and the scalar aggregates over a multi-partition fixture.
- id: T6  branch: task/bounded-query-execution/T6  deps: []            -- Squirreling budget enforcement plus typed refusal (upstream `github.com/hyparam/squirreling` PR, then a deliberate pinned bump from `squirreling@0.12.24`; `@ref LLP 0056 [implements]` at the budget-check sites): in the three blocking operators (`sort.js` push loop; `aggregates.js` scalar slow-path `group` and the high-card hash/distinct paths) track running buffered-row and buffered-byte counts and, when either would exceed the per-run ceiling, abort via the `context.signal` semantics and raise a distinct `QueryBudgetExceededError`-class value carrying the limit hit and the operator that hit it, returning no rows (a refusal, not a truncation; a partial `COUNT(DISTINCT)`/`GROUP BY` undercounts and an `ORDER BY` prefix is correct only after full buffering). Upstream squirreling tests for the threshold and the error shape.
- id: T7  branch: task/bounded-query-execution/T7  deps: [T1, T6]      -- Kernel execution budget option plus typed-error re-export (`@ref LLP 0054#execution-budget [implements]`): add the execution budget (a buffered-row ceiling and an estimated buffered-byte ceiling, whichever trips first) to `ExecuteSqlOptions` (`src/core/query/types.d.ts`, exported through `src/core/query/index.js`), distinct from the display-only `ContextControls` (`maxCell`/`maxBytes`); `sql.js` passes the budget into `squirrelExecuteSql` (over the threaded signal from T1) and defaults it to a conservative safe-low ceiling (concrete tuned numbers come from the LLP 0057 Phase 0 measurement, deferred); map/re-export `QueryBudgetExceededError` (from the T6 pinned bump) so callers can catch it. Tests in `test/**`: refuse at the ceiling and assert the typed-error shape against a small fixture with a deliberately low budget.
- id: T8  branch: task/bounded-query-execution/T8  deps: [T7]          -- Wire the CLI and MCP callers plus budget/refusal telemetry (`@ref LLP 0054#uniform-surface`): `hyp query` (`src/core/query/verb.js`, `format.js`) passes the host-default budget and prints the refusal to stderr with a non-zero exit; the `query_sql` MCP tool (the `querySqlVerb` operation, same `executeQuerySql` per LLP 0034) inherits automatically, so confirm the refusal renders as a tool error rather than a silent empty result; around the `query.execute_sql` span in `sql.js` emit structured signals (`component: 'query'`, `operation`, `error_kind: 'budget_exceeded'`, the refusing operator, buffered-row/byte high-water from the typed error). Server-side wiring (mapping the refusal to a 4xx, passing the operator-configured budget) is tracked in server LLP 0020, not here. Tests in `test/**`: CLI exit code plus stderr message; MCP tool-error rendering.
- id: T9  branch: task/bounded-query-execution/T9  deps: [T5, T7, T8]  -- End-to-end memory-invariant gate (`@ref LLP 0054#memory-invariant`): a `bounded_query_refusal` acceptance smoke (alongside the `installed_daemon_idle_soak` family, with stable `smoke_name`/`smoke_step`/`DEV_RUN_ID`) drives a known issue-#9 crasher (`ORDER BY` over the full `ai_gateway_messages` dataset; `COUNT(DISTINCT content_text)`) and asserts a clean typed refusal with bounded heap instead of an OOM or a zero-byte socket, plus a now-streaming `COUNT(DISTINCT session_id)` that completes within bounded memory, asserting the internal path via the T8 budget/refusal telemetry (`error_kind: 'budget_exceeded'`, the high-water marks), not only the process exit code. Register the flow in the smoke index.

## Notes {#notes}

- **Engine-side discipline.** T2 and T6 are the only tasks that touch the pinned upstream engines.
  Each merges its upstream PR first, then the kernel consumes it via a deliberate pinned-version
  bump (never a caret). The bump is the kernel-side half of the same task, so the consuming kernel
  tasks (T5 over icebird, T7 over squirreling) see the new API at merge.
- **Budget defaults stay deferred.** T7 ships a conservative safe-low default so an un-configured
  `hyp query` is bounded out of the box. The concrete tuned buffered-row/buffered-byte numbers come
  from the [LLP 0057](./0057-bounded-query-execution.plan.md) Phase 0 measurement pass; this plan
  fixes the knob and its wiring, not the value. Operators may raise the ceiling until then.
- **Out of scope (V1).** Spill-to-disk (the named deferred follow-up in
  [LLP 0056](./0056-refuse-over-spill-or-truncate.decision.md)), per-call budget override on the
  MCP/remote surface (an open question in [LLP 0054](./0054-bounded-query-execution.spec.md)), and
  process isolation ([LLP 0038](./0038-split-query-export-daemon-from-gateway.todo.md), the
  defense-in-depth sibling). None is a task here.
- **Status.** This plan is `Accepted` to match the rest of the package
  ([LLP 0054](./0054-bounded-query-execution.spec.md)–[LLP 0058](./0058-bounded-query-execution.design.md));
  it flips to `Active` when the change set merges.

## References {#references}

- [LLP 0054](./0054-bounded-query-execution.spec.md) — the bounded-execution spec (requirements).
- [LLP 0055](./0055-stream-aggregates-via-scancolumn.decision.md) — stream aggregates via `scanColumn`.
- [LLP 0056](./0056-refuse-over-spill-or-truncate.decision.md) — refuse over spill/truncate.
- [LLP 0057](./0057-bounded-query-execution.plan.md) — the human prose plan this extends.
- [LLP 0058](./0058-bounded-query-execution.design.md) — the technical design this implements
  (the code-site annotation map).
- [LLP 0015](./0015-query-and-datasets.spec.md), [LLP 0034](./0034-mcp-host-intrinsic.decision.md),
  [LLP 0032](./0032-github-llm-graph-bridge.decision.md),
  [LLP 0038](./0038-split-query-export-daemon-from-gateway.todo.md).
- HypAware Server LLP 0006 `#result-caps`, LLP 0002 `#kernel-compatibility`, LLP 0020 (server-side wiring).
- GitHub issue [hyparam/hypaware-server#9](https://github.com/hyparam/hypaware-server/issues/9).
- Engines: [squirreling](https://github.com/hyparam/squirreling), [icebird](https://github.com/hyparam/icebird).
