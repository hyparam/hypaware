# LLP 0029: Additive cache schema evolution (in place)

**Type:** Decision
**Status:** Active
**Systems:** Cache
**Author:** Phil / Claude
**Date:** 2026-06-16
**Related:** LLP 0013, LLP 0022, LLP 0015

> Adding a **nullable** column to a cached dataset (e.g. `agent_id` v5,
> `parent_thread_id`, `session_id` on `ai_gateway_messages`) evolves the
> cache table's schema **in place**: the new column is queryable after a plain
> append, old rows read it as `null`, new rows populate it — **no recreate, no
> backfill**. A full recreate stays necessary only for genuinely breaking
> changes (resolves issue #102).

## Context

Every captured row lands in the intrinsic Iceberg-backed cache
([LLP 0013](./0013-local-query-cache.decision.md)); `hyp query` reads it back
([LLP 0015](./0015-query-and-datasets.spec.md)). When a dataset's projector
adds a column, its `SCHEMA_VERSION` bumps (ai-gateway is at 5,
`hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js`). Before
this change, the new column did **not** appear in the existing cache: to see it
an operator had to recreate the cache table and re-run `hyp backfill`. For an
always-on recent-data store that is a data-loss-shaped operation for a
mechanically safe (additive) change.

The pieces to avoid it already existed:

- icebird reads data files that predate a column as `null` for that column —
  old data stays readable under a newer schema.
- `mergeFieldIdsFromTable` (`src/core/cache/iceberg/schema.js`) already
  reconciles the declared `ColumnSpec[]` with the table's current schema:
  existing columns keep their field id, new **nullable** columns get fresh ids
  beyond the current max, and every breaking shape (type change, dropped
  column, partition-column change, new **required** column, nullable→required
  tightening) throws.
- `store.js` `appendRowsToTable` **computed** that merged schema (for
  partition-spec validation) and then **discarded it**, appending under the
  table's old schema. The merged schema never reached storage, so the new
  column never appeared. That discard was the bug.

## The reachable icebird path {#reachable-path}

Issue #102 recorded the schema-evolution path as "not reachable from here yet"
(icebird#25). That is true of icebird's **top-level transaction API**:
`icebergTransaction`'s `tx` object exposes only `append`, `delete`, `setRef`,
`expireSnapshots` — no schema-update method (`icebird/src/types.d.ts`
`IcebergTransaction`). So you cannot stage `add-schema` + an append atomically
through the public `tx`.

But a reachable path **does** exist in icebird `0.8.10` without forking or
patching:

- icebird's `applyUpdates` (`icebird/src/write/commit.js`) fully implements the
  `add-schema` and `set-current-schema` table updates, including the spec
  sentinel `schema-id: -1` (assign next free id / resolve to the most recently
  added schema) and the v3 evolution guards (stable assigned ids, type
  promotion only, no new required field without a default).
- `fileCatalogCommit` and `loadTable` are **published**: the package `exports`
  map declares `"./src/*.js"`, so `icebird/src/write/commit.js` and
  `icebird/src/catalog/loadTable.js` are deep-importable public API, not
  internals. The cache **already** deep-imports icebird write internals this
  way — e.g. `retention.js` reaches `icebird/src/write/stage-position-delete.js`
  and `icebird/src/delete.js` for position-delete maintenance — and the
  top-level compaction path (`compactExportTable`) commits through icebird's
  public `icebergRewrite`.
- `fileCatalogCommit` applies `staged.updates` and never reads
  `staged.snapshot`, so a **metadata-only** commit (just `add-schema` +
  `set-current-schema`, no data files, no new snapshot) is well-formed.

So the schema evolution is committed as its own metadata-only commit, and the
subsequent ordinary `icebergAppend` reloads metadata, sees the new
`current-schema-id`, and writes the new columns under it.

(Spiked and verified end-to-end before committing: create one-column table,
append a row, evolve in place, append a second row populating the new column —
the first row reads `null`, the second reads the value, `current-schema-id`
advances 0→1.)

## Decision

`appendRowsToTable`, for an existing table with a declaration, now evolves the
table's current schema to the merged schema when (and only when) the merge adds
field ids the table doesn't have. The merged schema — `effectiveSchema`, the
one thing that has to flow into the write — is the single value the switch point
acts on.

### The single switch point {#in-place-evolution}

In `src/core/cache/iceberg/store.js`, immediately after `effectiveSchema` is
computed and the partition spec is validated:

```js
if (existingSchema) {
  await evolveSchemaInPlace({
    catalog, tableUrl: url, resolver, lister, existingSchema, effectiveSchema,
  })
}
```

`evolveSchemaInPlace` is a no-op unless `effectiveSchema` carries a field id
`existingSchema` lacks (the steady-state append pays only an id-set
comparison). When it isn't a no-op, it stages
`add-schema { …effectiveSchema, 'schema-id': -1 }` + `set-current-schema -1`
and commits them through `fileCatalogCommit`. The annotation
`// @ref LLP 0029#in-place-evolution` sits on this block; the helper carries
`// @ref LLP 0029#reachable-path`.

This is the **one** change that flips additive evolution on. Were icebird to
later expose a `tx.updateSchema(...)` (icebird#25), the helper's body would
collapse to that single staged call inside the existing append's transaction —
the call site and the `effectiveSchema`-flows-to-the-write contract are
unchanged.

## Additive vs breaking boundary

The boundary is drawn entirely by `mergeFieldIdsFromTable`, with icebird's
`applyUpdates` as a second guard behind it:

- **Additive (evolve in place):** a new **nullable** column, or a column that
  widened required→nullable. These survive the merge and evolve the table.
- **Breaking (still recreate):** a column **type change**, a **dropped**
  column, **any change to a partition column** (type/removal), a new
  **required** column (Iceberg cannot back-fill it), or a nullable→required
  **tightening**. `mergeFieldIdsFromTable` throws for each before any commit, so
  the append rejects exactly as it did before this change — no half-evolved
  table.

The **partition-key move** is the canonical breaking change and is tracked
separately as issue #104: changing the partition axis is partition-spec drift,
which both the cache and the iceberg export **reject** in V1 rather than
evolve ([LLP 0022](./0022-iceberg-export-partitioning.spec.md#drift-rejection)).
Additive column evolution deliberately does **not** touch the partition spec —
new nullable columns are never partition fields here — so it composes with that
rejection rather than weakening it.

## Consequences

- Adding a nullable column to a cached dataset and restarting the daemon now
  surfaces the column on the next append with no operator action; `hyp backfill`
  works against the evolved schema (re-projected batches keep populating it).
- The cache table accumulates one extra schema in `metadata.schemas` per
  additive change (the prior schemas are retained, as Iceberg requires for
  reading old data files). This is metadata-only; data files are untouched.
- A breaking change still fails loudly at append time. The remaining recreate +
  backfill path is now reserved for the cases that genuinely need it.

## References

- Code: `src/core/cache/iceberg/store.js` (`appendRowsToTable`,
  `evolveSchemaInPlace`, `schemaAddsFields`),
  `src/core/cache/iceberg/schema.js` (`mergeFieldIdsFromTable` — the
  additive/breaking boundary).
- Tests: `test/core/cache-iceberg-schema-evolution.test.js` (in-place
  evolution, backfill, no-op, breaking rejection);
  `test/core/cache-iceberg-schema.test.js` (the existing-table append now
  asserts the new column is queryable).
- icebird `0.8.10`: `src/write/commit.js` (`fileCatalogCommit`, `applyUpdates`
  `add-schema`/`set-current-schema`), `src/catalog/loadTable.js`,
  `src/types.d.ts` (`IcebergTransaction` — no schema method, icebird#25),
  package `exports` (`"./src/*.js"` makes the deep imports public).
- [LLP 0013](./0013-local-query-cache.decision.md) — the cache this evolves.
- [LLP 0022](./0022-iceberg-export-partitioning.spec.md) — the shared icebird
  engine and partition-spec drift rejection.
- `src/core/cache/retention.js` — existing precedent for deep-importing
  icebird `src/` write internals via the published `"./src/*.js"` exports.
- Issue #102 (this work); issue #104 (partition-key move — the breaking case).
- icebird#25 — request to expose schema evolution from the transaction API.
