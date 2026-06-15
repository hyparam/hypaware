# LLP 0026: Context-graph basic query

**Type:** Decision
**Status:** Active
**Systems:** Graph
**Author:** Phil / Claude
**Date:** 2026-06-15
**Related:** LLP 0015, LLP 0023

> `hyp graph neighbors <node>` walks the activity graph that
> [LLP 0023](./0023-context-graph-projection.decision.md) projects — out to N hops
> from a seed node, over the registered `node`/`edge` datasets. It is the **read
> counterpart** to that projection: projection writes the graph, this reads it.
> The two are deliberately separate capabilities.

## Query reads the published surface

The query path reads **only the registered `node`/`edge` datasets**, through the
same query registry any consumer uses ([LLP 0015](./0015-query-and-datasets.spec.md))
— never `project.js`'s in-process state. That boundary is the whole point: it keeps
querying and projecting **independently replaceable**. A third party can ship an
alternate query command, or an alternate projector, against the same published
tables without reaching into the other. Couple the reader to projection internals
and "bring your own query engine" silently becomes false.

(Design home: cgproto's LLP 0003 §query-and-projection-are-separable, where this
separability and its boundary invariant are argued in full. This LLP records the
hypaware-local implementation.)

That surface can carry **pre-compaction duplicate rows** — the same
content-addressed id committed twice by concurrent projections or a partial
failure. [`hyp graph compact`](./0023-context-graph-projection.decision.md#graph-compaction)
folds them, but a *read* must not depend on it having run first. So the reader
folds node/edge rows by graph identity (`node_id`; `(src_id, edge_type, dst_id)`
for edges) before traversing — two physical copies of one node resolve as a
single seed rather than a false "ambiguous", and a doubled edge is walked once.
Genuine ambiguity (distinct ids sharing a `natural_key`/`label`, e.g. two `File`s
with the same basename) is preserved.

## Thin in-memory traversal

`graph neighbors` loads `node` and `edge` once through the query surface, builds
forward and reverse adjacency in memory, and breadth-first walks to `--depth`.
Loading the whole graph per invocation is a deliberate **basic-tier** choice: at
activity-graph scale the topology is small, and a thin BFS over it is correct and
fast enough. It is explicitly *not* the fast path — a persisted adjacency index
(sorted edge table or CSR) the engine loads warm and page-cache-bounded is the
documented next step (cgproto LLP 0003 §serving-traversal), deferred until a
benchmark justifies it. The query *interface* is stable across that change, so the
upgrade is backing-only.

The traversal core (`traverse` in [`query.js`](../hypaware-core/plugins-workspace/context-graph/src/query.js))
is a **pure function over in-memory node/edge arrays** — no IO — so the interesting
logic (depth, direction, filters, seed resolution) is unit-tested directly, the way
`mergeRow` is. The IO wrapper is thin glue.

## Seed resolution

The graph's ids are content-addressed digests
([LLP 0023 §content-addressed-ids](./0023-context-graph-projection.decision.md#content-addressed-ids)),
which nobody types. So a seed token resolves in tiers: exact `node_id`, else exact
`natural_key`, else `label` — each optionally narrowed by `--type`. Zero matches is
a not-found; multiple is an **ambiguity error that lists the candidates** rather
than silently picking one (a bare File basename legitimately matches several paths
— the fix is to pass the full key, and the error says so).

## Direction and filters

The T0 graph is **Session-rooted** (all four edge types point Session → resource),
so direction is load-bearing: `--direction out` from a Session reaches its
apps/models/tools/files; `--direction in` from a File or Tool reaches the Sessions
that touched it; depth-2 `both` from a resource is **co-occurrence** (file →
sessions → other files). `--edge-type` restricts which relations are walked.

## Honest limits

`--limit` caps the returned neighbor list in BFS order and the result **flags
truncation** with the true reachable total — it never silently drops. And because
the basic tier loads the whole graph into memory, a graph large enough to strain
that is a signal to build the persisted index above, not to raise the cap quietly;
the command surfaces that rather than hiding it.
