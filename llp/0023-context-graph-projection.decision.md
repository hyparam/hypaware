# LLP 0023: Context-graph T0 projection

**Type:** Decision
**Status:** Active
**Systems:** Graph
**Author:** Phil / Claude
**Date:** 2026-06-12
**Revised:** 2026-06-15
**Related:** LLP 0005, LLP 0006, LLP 0013, LLP 0015, LLP 0016, LLP 0021

> `@hypaware/context-graph` materializes a node/edge **activity graph** from any
> source that contributes a projection contract. The first is `ai_gateway_messages`
> (which sessions ran in which app, against which model, using which tools,
> touching which files), contributed by the `@hypaware/ai-gateway-graph` connector.
> The projection is **T0**: purely deterministic, exact-key, no models, no
> inference — the cheapest layer of graph that is still useful, and a stable
> substrate for smarter layers later.

## T0 contract

A projection contract is a hand-authored list of rules: each a read-only SELECT
over a source dataset plus a `toRow` mapper that emits one node or edge (or
`null` to skip). The read half is genuinely SQL — each SELECT documents the
structural fact it extracts — while the mapping half is plain code because the
interesting parts (file-path resolution out of `tool_args`, key normalization)
don't fit a declarative form yet. A generic declarative-contract → SQL compiler
is a deliberate **later slice**: a handful of rules per source don't justify the
abstraction, and the explicit list keeps the projected shape reviewable.

Contracts are **not** built into the graph plugin — each is contributed by the
source plugin that owns the data (see [§contract-contribution](#contract-contribution)).
The first contract is `ai_gateway_messages → graph`, carried by the
[`@hypaware/ai-gateway-graph`](../hypaware-core/plugins-workspace/ai-gateway-graph/src/graph_contract.js)
connector:

- T0 node types: `Session`, `App`, `Model`, `Tool`, `File`.
- T0 edge types: `via`, `used_model`, `used`, `touched` (all Session-rooted).

## Contract contribution

`@hypaware/context-graph` owns the **engine**, not the **sources**. A source's
contract lives with the source; the seam between them is a capability.

- The graph plugin provides **`hypaware.context-graph@1.0.0`**, whose value is
  `{ registerContract, kit }`. A source plugin (or a connector) calls
  `registerContract` during activation; contracts land in an in-plugin registry
  ([`contract-registry.js`](../hypaware-core/plugins-workspace/context-graph/src/contract-registry.js))
  that `hyp graph project` reads and the engine
  ([`project.js`](../hypaware-core/plugins-workspace/context-graph/src/project.js))
  iterates. Adding a source is contributing a contract — never editing the engine.
- The `kit` ([`contract-kit.js`](../hypaware-core/plugins-workspace/context-graph/src/contract-kit.js))
  is `{ nodeId, edgeId, makeRowBuilders }`. A contract's `toRow` builds rows with
  `makeRowBuilders({ sourceDataset, projector, projectorVersion })`, so the **id
  recipe and provenance columns stay owned by the graph plugin** (see
  [§content-addressed-ids](#content-addressed-ids)) — no source can fork the
  recipe and orphan committed rows. The source owns only its rules and its
  projector id/version.

**Ownership split.** Central (graph plugin): the engine, `node`/`edge` datasets,
dedup/compaction, the id recipe, the row-builder kit. Per source: the contract's
rules (SQL + `toRow`) and projector metadata. A contract maps *into* the fixed
core the graph plugin owns; it cannot fork it.

**Packaging — connector, not bundled into the source.** `@hypaware/ai-gateway-graph`
is a thin **connector**: it declares **plugin** dependencies on both
`@hypaware/ai-gateway` (the source it exists for) and `@hypaware/context-graph`,
**plus** a **capability** dependency on `hypaware.context-graph`, and registers the
contract in its `activate()`. Both kinds are needed and they do different jobs: the
capability dep is the interface contract (and what `requireCapability` checks), but
only a *plugin* dependency makes the resolver activate `@hypaware/context-graph`
first — capabilities are interchangeable, so a capability requirement does **not**
pin activation order ([LLP 0006](./0006-dependencies-and-capabilities.spec.md)).
Declare only the capability and the connector races ahead of the provider and its
`requireCapability` throws at boot. This is the same both-kinds pattern
`@hypaware/claude` uses for `@hypaware/ai-gateway`. The connector shape keeps the
two existing plugins mutually independent — neither `@hypaware/ai-gateway` (a
foundational capture plugin) nor `@hypaware/context-graph` depends on the other,
and the gateway still boots with no graph installed. Rule of thumb: a source
built *for* the graph may bundle its own contract and depend on the capability
directly; a foundational or pre-existing source gets a connector. (Why not bundle
the contract into `@hypaware/ai-gateway`? hypaware has no *optional* capability
deps — [LLP 0006](./0006-dependencies-and-capabilities.spec.md) — so a declared
`requires` would be hard, making the graph plugin mandatory for capture.)

**Cross-source convergence.** Because ids are content-addressed and `mergeRow`
is order-independent, two contracts that mint the same node (same `type` +
natural key — e.g. an `Actor` seen by two sources) merge structurally with no
extra machinery.

Design home: cgproto LLP 0006 §projection-contracts, where the contribution
point and the ownership split are argued in full; this LLP records the
hypaware-local implementation.

## Content-addressed ids

Node and edge ids are truncated sha256 digests of `(kind, type, natural key)`
— see [`ids.js`](../hypaware-core/plugins-workspace/context-graph/src/ids.js).
The same entity always hashes to the same id, which is what makes
re-projection **idempotent**: an already-committed row is skipped by the
pre-write dedup, and any duplicate that slips through collapses during
compaction because both copies share an id.

Hash-input segments are NUL-delimited (written as the `\0` escape so the
source file stays plain text). NUL cannot occur in the input strings, so no
two distinct key tuples can collide by embedding the delimiter. **Changing
the recipe (algorithm, truncation, delimiter) orphans every committed graph
row**; `test/plugins/context-graph-ids.test.js` pins known digests so that
change can only happen deliberately, with a migration. The recipe lives in one
place ([`ids.js`](../hypaware-core/plugins-workspace/context-graph/src/ids.js))
and reaches contract authors only through the kit's `makeRowBuilders`
([§contract-contribution](#contract-contribution)), so a source cannot
reimplement — and accidentally diverge from — it.

## Inline provenance

Every row carries its provenance inline: `source_dataset`, `source_keys`,
`projector`, `projector_version`. The fuller design has a separate provenance
table (one graph row ← many source rows); V1 collapses that to "the first
sighting's keys" because the only V1 consumer is debugging ("where did this
node come from?"), and a join table for that is overhead without a reader.
Revisit when a consumer needs complete lineage, not just an exemplar.

`projector_version` is **provenance, not a re-projection trigger**: it records
which generation of the projector first minted a row. Bumping it rewrites
nothing on its own — ids are content-addressed
([§content-addressed-ids](#content-addressed-ids)), so a re-run mints the same
ids and the pre-write dedup skips every already-committed row; the committed
rows keep their original version. Re-deriving a source after a projector logic
change is a deliberate operation (drop/re-project, or a compaction-style
migration), never a side effect of incrementing this number. A contract that
needs the *new* logic reflected in committed rows must remove the stale rows
first — there is no version-aware replace in the engine, and adding one would
have to define preference/cleanup rules across `(source_dataset, projector)`.

## On-demand projection

The projection runs only via `hyp graph project` (and compaction via
`hyp graph compact`). There is no snapshot/commit hook in the kernel to chain
from, and **eventual freshness is acceptable** for an activity graph — the
graph answers "what happened", not "what is happening". Registering the
command (not a source or sink) keeps the plugin out of the daemon loop
entirely; nothing here can block or OOM the daemon.

## Merge policy

Duplicate rows for the same id (same entity seen by multiple rules/runs) merge
by: earliest `first_seen` wins; `props` union with **per-key earliest-wins**
(value-level tie-break when timestamps are equal or unknown) — implemented in
`mergeRow` ([`project.js`](../hypaware-core/plugins-workspace/context-graph/src/project.js)).
The policy is order-independent because the contract SELECTs have no stable
ordering; the same inputs must produce the same merged row regardless of scan
order, or re-projection and compaction would disagree. Projection-time and
compaction-time merging share the same function for the same reason.

## Pre-write dedup

`graph project` reads the committed id set (`SELECT node_id FROM node`) and
filters before appending. Only a *missing dataset* is a benign failure there;
any other query/storage error aborts the projection, because treating an
unreadable cache as "empty id set" would append duplicates and report success.
Duplicates that slip past pre-write dedup (concurrent projections, partial
failures) are the compaction's job, below.

## Graph compaction

`hyp graph compact` owns **graph semantics only**: it merges duplicate ids
across committed `source=` partitions (each group folds into one row in the
earliest sighting's partition) and rewrites affected partitions into sorted
replacement tables. General file compaction — data-file counts, snapshot
expiry — stays the kernel cache-maintenance's job ([LLP 0013](./0013-local-query-cache.decision.md)).

The rewrite mirrors the kernel's generation swap (new `table-<seq>` dir,
cursor repoint, `.retired` marker for the grace-period sweep) with two safety
rules:

- **Positive cursor reads only.** A partition whose `cursor.json` cannot be
  positively read (`tryReadCursorSync` → null) or whose layout is not
  `source-table` is skipped and reported — a corrupt cursor must never be
  mistaken for the epoch-0 default when a generation is about to be retired.
- **Conditional swap, no lock.** Writers keep appending to the live table
  while compaction scans it. Before repointing, the cursor is re-read and
  compared to the one the scan started from; any change (rowCount bump,
  different tableDir) aborts the swap and removes the staged table — retiring
  the old generation at that point would lose rows appended during the
  rewrite window. Skipped partitions keep their duplicates until the next
  run; duplicates are benign (same id, mergeable), lost rows are not. Home
  partitions (which receive merged rows) are rewritten before partitions that
  only drop copies, and a duplicate's copies are only dropped once its merged
  row verifiably landed.

A partition-level maintenance lock would close the residual window between
re-read and cursor write; it is deliberately not taken in V1 because the
command is manual, reruns are cheap, and the failure mode of the conditional
swap is "duplicate persists", never data loss.

## Derived datasets

`node` and `edge` register as kernel datasets ([LLP 0015](./0015-query-and-datasets.spec.md))
backed directly by the cache's committed partitions — there is no live source;
`refreshPartition` is a no-op. Queries over multiple committed partitions go
through a union data source that concatenates per-partition scans; the union
reports `appliedLimitOffset: false` and therefore must not forward
limit/offset hints to its sub-sources, or offsets would be applied twice.
