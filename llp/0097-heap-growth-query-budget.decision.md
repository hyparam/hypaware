# LLP 0097: Heap-Growth Guard Enforces the Execution Budget from the Kernel

**Type:** Decision
**Status:** Active
**Systems:** Query, Cache
**Author:** Phil / Claude
**Date:** 2026-07-10
**Related:** LLP 0054, LLP 0055, LLP 0056, LLP 0057

> How the kernel bounds query execution memory TODAY, with the pinned engine:
> a sampled process-heap-growth guard checked inline on the scan path, refusing
> per [LLP 0056](./0056-refuse-over-spill-or-truncate.decision.md). Realizes
> [LLP 0054](./0054-bounded-query-execution.spec.md) `#memory-invariant` and
> sizes the default ceiling `#execution-budget` deferred to measurement.

## Context

[LLP 0057](./0057-bounded-query-execution.plan.md) Phase 0 (measure) ran on
2026-07-10 against the production cache (202k-row / 931MB-on-disk
`ai_gateway_messages`, 5.4k-node / 12k-edge context graph), one fresh CLI
process per query, median of 3, peak RSS via `/usr/bin/time -l`:

| query class | wall | peak RSS |
|---|---|---|
| process floor (`LIMIT 1`) | 173ms | 172MB |
| `COUNT(*)` | 171ms | 179MB |
| `COUNT(DISTINCT session_id)` | 759ms | 510MB |
| `GROUP BY provider` / high-card `GROUP BY session_id` | ~780ms | 470-534MB |
| top-K `ORDER BY ... LIMIT 20` | 888ms | 444MB |
| full sort, narrow projection, no LIMIT | 987ms | 743MB |
| `COUNT(DISTINCT content_text)` | 1085ms | 685MB |
| `SELECT * ORDER BY` (no LIMIT, issue #9 class) | 18.3s | **6.1GB, died** |
| `hyp graph neighbors` depth 1-3 | ~170ms | 130-150MB |

Two facts changed the implementation picture since the 0054/0055 docs were
authored against squirreling 0.12.24:

- **The engine already streams.** squirreling 0.14.0 (pinned) streams scalar
  and `GROUP BY` aggregates through accumulators, sorts top-K when a `LIMIT`
  reaches the sort, threads an abort `signal`, and has the `scanColumn`
  column-stream fast path; icebird 0.8.13 (pinned) implements `scanColumn` at
  the leaf. The dormant pieces were all kernel wrappers, now lit
  ([LLP 0055](./0055-stream-aggregates-via-scancolumn.decision.md) `@ref`s in
  `src/core/cache/storage.js`, `src/core/query/union-source.js`, ai-gateway
  `dataset.js`).
- **The remaining crasher is retained buffering** in blocking operators with
  no bound: the engine-side buffered-row/byte accounting that
  [LLP 0054](./0054-bounded-query-execution.spec.md) `#execution-budget`
  specifies is an upstream squirreling change that has not landed.

Waiting for the engine accounting would leave the daemon OOM-killable in the
meantime. The kernel needed an enforcement mechanism that works with the
pinned engine, entirely from the `hypaware/core/query` surface.

## Options considered

1. **Sampled process-heap-growth guard in the kernel.** (Chosen.) Sample
   `process.memoryUsage().heapUsed` growth since query start; refuse when it
   exceeds the budget.
2. **Wait for engine-side buffered-row/byte accounting** (LLP 0054
   `#execution-budget` as specified). Rejected as the only line of defense:
   upstream latency leaves the crasher class live; the engine accounting
   remains the intended refinement and composes with this guard when it lands.
3. **Timer-only watchdog** (setInterval + abort signal). Rejected as
   insufficient alone, from evidence: a query whose reads resolve without real
   I/O holds the event loop for its entire run, so timer callbacks never fire.
   The measured issue-#9 crasher ran 8+ seconds to 4.8GB with a 50MB budget
   and **zero** watchdog samples.

## Decision

`executeQuerySql` enforces a **per-query heap-growth budget** with two
coordinated layers:

- **Inline guard (primary):** every table source is decorated so its row scans
  check sampled heap growth every 4096 rows, and its column streams check per
  chunk, from *inside* the loop that a blocking operator drives. Starvation-
  proof by construction.
- **Interval watchdog (secondary):** a 100ms `setInterval` covers execution
  phases that pull no further source rows (join amplification, output
  finalization) but do yield to the event loop.

Either tripping aborts the run through the threaded signal
([LLP 0054](./0054-bounded-query-execution.spec.md) `#signal-threading`) and
surfaces a typed `QueryExecutionBudgetError` (exported from
`hypaware/core/query`) carrying the limit and observed growth: a refusal, not
a truncation ([LLP 0056](./0056-refuse-over-spill-or-truncate.decision.md)).

**Growth, not absolute:** the budget bounds heap growth attributable to the
query (sampled minus at-start baseline), so a long-lived daemon's resident
baseline neither eats the budget nor causes blanket refusals.

**Default ceiling: 1GiB growth**, from the Phase 0 measurements: every
well-formed query in the measured set stays under ~500MB of growth (2x
headroom), while the crasher class blows past 4GB. Operators override with
`HYP_QUERY_MAX_HEAP_MB` (or the `maxHeapBytes` option on
`ExecuteSqlOptions`; `0` disables). With the default in place the measured
crasher refuses in 0.7-1.2s at ~1.4GB peak RSS instead of dying at 6GB.

## Consequences

- Every caller of `hypaware/core/query` (CLI, MCP `query_sql`, HypAware
  Server `POST /v1/query`) inherits the bound with no per-surface work
  ([LLP 0054](./0054-bounded-query-execution.spec.md) `#uniform-surface`).
  The server can pass its own `maxHeapBytes` and map the typed error to a
  4xx (HypAware Server LLP 0020 owns that wiring).
- Heap growth is process-global. Concurrent queries in one process share the
  observable, so a query can be refused partly on a neighbor's allocations;
  conservative and safe in the direction we care about (protect the process).
  Per-operator buffered-byte accounting (the LLP 0054 `#execution-budget`
  letter, upstream in squirreling) remains the precise refinement; when it
  lands, this guard stays as defense-in-depth.
- `heapUsed` includes not-yet-collected garbage, so a pathologically
  garbage-heavy but well-bounded query could trip early; measured headroom
  (2x over the worst legitimate query) and the scavenge-on-allocation
  behavior of young-generation garbage make this unlikely, and the refusal
  message names the override.
- Post-change measurements (same harness, same cache): every measured query
  got faster (up to -26% wall) and none regressed; the speed budget for this
  work ("within 10%") was met with margin.

The code site (`src/core/query/sql.js`) carries `@ref`s to this decision and
to [LLP 0054](./0054-bounded-query-execution.spec.md) `#signal-threading` /
[LLP 0056](./0056-refuse-over-spill-or-truncate.decision.md).
