# LLP 0431: Frontier-scoped graph reads

**Type:** Spec
**Status:** Draft
**Systems:** Graph, Query, Usage-Policy
**Date:** 2026-09-24
**Related:** LLP 0064, LLP 0105, LLP 0213, LLP 0294, LLP 0388, LLP 0428

## Request

Replace LLP 0064's whole-graph neighbor loader and extend LLP 0428's query
cost limits to neighborhood reads. The central org graph has 131,255 unique
nodes and 406,875 unique edges: even a one-hop request for a PR's two commits
is refused before its seed or edge filter is applied. Compaction cannot fix
unique-row growth, and increasing the limit would retain the memory risk.

## Bounded frontiers

Resolve the seed through the existing node-id, natural-key, label tiers,
including type restriction and duplicate-id folding. Query edges only for the
current breadth-first frontier, in batches of at most 256 endpoint ids, with
direction and edge-type predicates in SQL. Retain visited ids and fetch node
display fields and edge evidence only for neighbors selected for output.
Every read uses the existing query registry and LLP 0105 visibility handling;
missing endpoints keep their existing placeholder and remain traversable by id.

Keep exact reachable counts within the budget, breadth-first output,
ambiguity reporting and the distinction between an empty graph and a missing
seed. Within-hop order follows the query source, not a new global sort. There
is no transaction spanning the reads; a changing graph remains eventually
consistent, as the previous separate node and edge reads were.

The 100,000 physical-result-row budget per dataset is cumulative across the
request, including duplicate rows, repeated endpoint reads and evidence
lookups. The extra LIMIT row detects overflow. Preserve the SQL engine's
128 MiB per-query heap-growth guard. Extend LLP 0428's shared traversal abort
signal to thirty seconds, allowing sequential frontier reads on cold or
unindexed storage more time within the same row and memory budgets.
Additionally cap cumulative materialized payload at 128 MiB (UTF-16 string
length, serialized JSON length and a fixed per-cell allowance). This is a
payload estimate, not an exact V8 heap limit; query intermediates retain the
engine's separate guard. Yield between queries and check wall-clock expiry
while processing rows, so late work cannot report success or begin another hop.
Exceeding a budget fails explicitly, never with an incomplete reachable count.

`--limit` remains an output cap, not a work cap. `totalNodes` now counts visited
ids including the seed, and `totalEdges` counts distinct examined edges;
neither claims the corpus size. Computing global totals would reintroduce
unnecessary whole-corpus work. The pure in-memory `traverse` helper continues
to describe the arrays supplied by its caller.

## Native suppression

Extend LLP 0294's row fallback for schema-aligned sources without a `cwd`
column and with declared content columns, including graph tables. The shared
visibility wrapper must retain native batches and replace content vectors
with constant nulls without decoding their values. Local tests of a persisted
131,255-node / 406,875-edge fixture exposed the old fallback's high allocation
cost even when the traversal itself retained only a few result rows.

If any content column is demanded, keep the entire predicate residual and
evaluate it after suppression. Do not forward source LIMIT/OFFSET or exact
counts. Preserve existing row selections, including position deletes, and
resolve lazy structural reads against their original batch. Mark suppressed
schema fields nullable. Count suppressed selected rows when content is demanded,
as the row path does. Sources mixing cwd and content suppression, or carrying
schema drift, retain the existing fallback. Visibility rules do not change.

## Cost and validation

No persistent index, runtime dependency or storage schema is introduced.
Unindexed backends may scan a table for each batch: WHERE reduces returned
allocations, not necessarily physical IO. The query engine owns predicate
pushdown and cooperative cancellation. A persisted adjacency index remains
a separate measured optimization, not a prerequisite for small queries.

Topology retention is bounded by the cumulative edge budget; labels and JSON
evidence scale with returned neighbors. Do not allocate a corpus adjacency
map or keep graph state across requests. The `graph.neighbors` span reports
query count, node/edge rows and estimated payload bytes, without logging labels
or evidence values. Existing SQL spans identify individual read failures.

Tests must cover a small neighborhood in a graph larger than the old cap,
real residual SQL filtering, frontier batching, cycles, dangling endpoints,
seed precedence and quoting, suppression, duplicate rows, exact truncation,
oversized neighborhoods, payload refusal and a late read. The hermetic graph
smoke must assert CLI output and the traversal's materialization counters.
Native suppression tests must compare row-path results for content predicates,
null predicates, aggregates, ranges and position deletes, and fail if a hidden
content vector is decoded. Validate the actual CLI against persisted tables
larger than the old cap, both with and without content suppression.
