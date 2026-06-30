# LLP 0054: Bounded Query Execution

**Type:** Spec
**Status:** Draft
**Systems:** Query, Cache
**Author:** Phil / Claude
**Date:** 2026-06-30
**Related:** LLP 0015, LLP 0034, LLP 0055, LLP 0056, LLP 0057, LLP 0038

> The execution-side memory contract for the intrinsic SQL surface: no single
> query may grow intermediate state without bound. Extends [LLP 0015](./0015-query-and-datasets.spec.md).
> Captures the kernel-side fix for HypAware Server issue
> [hyparam/hypaware-server#9](https://github.com/hyparam/hypaware-server/issues/9)
> (unbounded sort/hash queries OOM-crash the daemon).

## Summary

The intrinsic query surface ([LLP 0015](./0015-query-and-datasets.spec.md)) runs
SQL over a streaming `AsyncDataSource` per dataset, but three blocking operators
— `ORDER BY`, `GROUP BY`, and `COUNT(DISTINCT …)` — buffer the **whole scanned
input** before producing a row, and `collect()` then re-materializes the result.
Peak memory therefore scales with the **scanned/intermediate row volume**, not
the (already-capped) result size. Over the ~495k-row `ai_gateway_messages`
dataset a single such query exhausts the heap and the process is OOM-killed
mid-request — taking the whole daemon down for every caller.

This spec makes peak execution memory a function of a **declared per-query
budget**, not of the scanned row count. It does so through three coordinated
requirements: thread an abort signal so operators can stop mid-stream
(`#signal-threading`); take a streaming path for the aggregates that can avoid
buffering entirely ([LLP 0055](./0055-stream-aggregates-via-scancolumn.decision.md));
and enforce a memory/row budget on the operators that must buffer, refusing
rather than crashing when it is exceeded
([LLP 0056](./0056-refuse-over-spill-or-truncate.decision.md)).

The bound is exposed through the kernel's **public** `hypaware/core/query`
surface, so every caller of that surface inherits it — the local `hyp query`
CLI, the `query_sql` MCP tool ([LLP 0034](./0034-mcp-host-intrinsic.decision.md)),
and HypAware Server's `POST /v1/query`. This is the reusable budget primitive
that HypAware Server LLP 0006 `#result-caps` named as a follow-up ("the kernel's
context-budget machinery is CLI-output-shaped and not exposed through the public
import surface").

## Motivation

The crash is driven by intermediate buffering, not result size:

- `ORDER BY` collects the entire input into one array before sorting.
- `GROUP BY` retains **every source row** in per-group arrays (it keeps rows, not
  key+accumulator).
- `COUNT(DISTINCT …)` falls to a slow path that buffers all rows into a single
  group, because the streaming fast path requires a source method
  (`scanColumn`) that no dataset source implements
  ([LLP 0055](./0055-stream-aggregates-via-scancolumn.decision.md)).
- The result is then re-materialized a second time by `collect()`.

No layer bounds this. `scope.limit` is **not** a row cap — on a multi-partition
union it is stripped per [LLP 0015](./0015-query-and-datasets.spec.md) ("Multi-partition
union"), and the ai-gateway scope builder reads only date fields. The operators
already check `context.signal`, but the kernel never constructs or passes a
signal, so that abort path is dead code. HypAware Server's response-edge caps
(LLP 0006 `#result-caps`) run **after** materialization, so they bound the
returned payload but cannot prevent the blowup.

This exposure is not server-only: the same operators back the local `hyp query`
CLI and the `query_sql` MCP tool. The fix belongs where the buffering lives — the
kernel query plane — not behind any one caller.

This spec **bounds the common case**. It is defense-in-depth with the
separately-owned process-isolation track ([LLP 0038](./0038-split-query-export-daemon-from-gateway.todo.md)):
bounding keeps well-formed-but-large queries from OOMing in the first place;
isolation contains the pathological query that escapes any bound. Neither
replaces the other.

## Requirements

### <a id="memory-invariant"></a>Peak execution memory is budget-bounded

A single `executeQuerySql` call MUST NOT accumulate unbounded intermediate
state. Peak in-flight memory MUST be a function of the query's declared
execution budget (`#execution-budget`) and the dataset schema width, **not** of
the number of rows scanned. This invariant holds uniformly across every caller
of the `hypaware/core/query` surface: the `hyp query` CLI, the `query_sql` MCP
tool ([LLP 0034](./0034-mcp-host-intrinsic.decision.md)), and HypAware Server's
`POST /v1/query`.

### <a id="execution-budget"></a>The execution budget is a public option, distinct from output controls

`ExecuteSqlOptions` (the public `hypaware/core/query` surface, `src/core/query/index.js`)
gains an optional execution budget bounding, across all blocking operators in a
single run:

- a **buffered-row ceiling** (count of rows held by sort/group/distinct buffers), and
- an **estimated buffered-byte ceiling** (cumulative size of buffered cell
  values), whichever trips first.

This budget bounds the **intermediate buffer during execution**. It is a
distinct concept from the existing `ContextControls` (`maxCell` / `maxBytes`),
which bound **display/output bytes after materialization** for the CLI. A query
can be cheap to display yet ruinous to execute (`COUNT(DISTINCT content_text)`
returns one number); the execution budget is what bounds the latter. The two
caps compose and neither subsumes the other.

The budget is operator-configurable with **conservative defaults**, and the
kernel ships a default ceiling so an un-configured `hyp query` is bounded out of
the box. (Concrete default values are TBD pending the measurement deferred in
[LLP 0057](./0057-bounded-query-execution.plan.md); this spec fixes the knob and
its semantics, not the number.)

### <a id="signal-threading"></a>Execution threads an abort signal

`executeQuerySql` MUST construct an `AbortSignal` (linked to any caller-supplied
`signal` and to a deadline if configured) and forward it into the engine
(`squirrelExecuteSql({ tables, query, signal, … })`). This activates the
operators' existing `context.signal` checks, which are otherwise unreachable.
Signal threading is the **enabling mechanism** for both budget refusal
(`#refusal`) and ordinary cancellation/timeout/watchdog-abort; it bounds nothing
on its own. The code site (`src/core/query/sql.js`, at the `squirrelExecuteSql`
call) carries an `@ref` to this section when implemented.

### <a id="streaming-first"></a>Streaming-eligible aggregates must not buffer

Scalar aggregates (`COUNT`, `MIN`, `MAX`, `SUM`, `AVG`) and low-cardinality
`COUNT(DISTINCT …)` MUST take the streaming column-scan path rather than the
row-buffering slow path, per [LLP 0055](./0055-stream-aggregates-via-scancolumn.decision.md).
These never reach the execution budget because they hold O(1) rows (a single
accumulator, or a distinct-key set whose size is the cardinality, not the row
count). This is the highest-leverage requirement for the aggregate crashers;
the budget (`#refusal`) is the backstop for what streaming cannot make cheap.

### <a id="refusal"></a>Over-budget queries refuse, they do not truncate

When a blocking operator's buffer would exceed the execution budget, the run
MUST abort mid-stream (via `#signal-threading`) and surface a **distinct, typed
error** carrying the limit that was hit. Per
[LLP 0056](./0056-refuse-over-spill-or-truncate.decision.md) this is a
**refusal** (no result), not a truncation: returning a partial `ORDER BY` prefix
or a partial `COUNT` would be a silent wrong answer. The error is distinct from
HypAware Server LLP 0006 `#result-caps`' `truncated: true`, which trims an
already-correct, already-materialized result at the response edge. Callers
render the refusal as actionable guidance ("query exceeded its execution budget
— add a `WHERE`/`date` filter or aggregate"): HypAware Server maps it to a 4xx;
the CLI prints the same message to stderr with a non-zero exit.

### <a id="uniform-surface"></a>One bound, every surface

Because query is intrinsic ([LLP 0015](./0015-query-and-datasets.spec.md)) and
MCP hosting is intrinsic ([LLP 0034](./0034-mcp-host-intrinsic.decision.md)), the
`query_sql` MCP tool and the remote-attach path run the **same**
`executeQuerySql` / `collect()` code. The budget and refusal therefore apply to
CLI, MCP, and server callers from the single kernel implementation — no
per-surface re-derivation. HypAware Server passes its operator-configured budget
through the existing `hypaware/core/query` import path (it already depends on
exactly that path per HypAware Server LLP 0002 `#kernel-compatibility`); this
adds options to `ExecuteSqlOptions`, not a new import surface or a shim.

## Open questions

- **Default budget values.** The conservative defaults (buffered-row and
  buffered-byte ceilings) need a measurement pass against real
  `ai_gateway_messages` volume on a representative box — deferred to
  [LLP 0057](./0057-bounded-query-execution.plan.md). Until measured, ship a
  safe-low default and let operators raise it.
- **Spill-to-disk.** A future external-merge / spilling path would let large
  `ORDER BY` / `GROUP BY` **complete** instead of refusing; named as a deferred
  follow-up in [LLP 0056](./0056-refuse-over-spill-or-truncate.decision.md), not
  in scope here.
- **Per-call budget override on the MCP/remote surface.** Whether `query_sql`
  callers may request a higher budget (subject to an operator ceiling) or only
  inherit the host default.

## References

- [LLP 0015](./0015-query-and-datasets.spec.md) — Query, Datasets, and Collect
  (the surface this extends; `#query-is-intrinsic`, "Multi-partition union").
- [LLP 0034](./0034-mcp-host-intrinsic.decision.md) — MCP hosting is intrinsic
  (`query_sql` runs the same execution path).
- [LLP 0055](./0055-stream-aggregates-via-scancolumn.decision.md) — stream
  aggregates via `scanColumn` rather than buffering rows.
- [LLP 0056](./0056-refuse-over-spill-or-truncate.decision.md) — refuse over
  spill/truncate on budget exceed.
- [LLP 0057](./0057-bounded-query-execution.plan.md) — implementation plan.
- [LLP 0038](./0038-split-query-export-daemon-from-gateway.todo.md) — process
  isolation (defense-in-depth sibling).
- HypAware Server LLP 0006 `#result-caps` — the response-edge cap and its V1
  note naming this kernel budget primitive as the follow-up.
- HypAware Server LLP 0002 `#kernel-compatibility` / `#host-shim` — the server's
  public-import-path contract and named-kernel-extension pattern.
- GitHub issue [hyparam/hypaware-server#9](https://github.com/hyparam/hypaware-server/issues/9).
- Engines: [squirreling](https://github.com/hyparam/squirreling) (operators +
  the `scanColumn` interface), [icebird](https://github.com/hyparam/icebird)
  (the Iceberg `AsyncDataSource`).
