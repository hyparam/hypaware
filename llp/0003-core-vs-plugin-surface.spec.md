# LLP 0003: Core vs Plugin Surface

**Type:** Spec
**Status:** Active
**Systems:** Core, Plugins
**Author:** Phil / Claude
**Date:** 2026-06-01
**Related:** LLP 0005, LLP 0006

> What belongs in the kernel vs. a plugin. Decomposed from
> `hypaware-design.md` (Design Summary, Core vs Plugin Surface).

## Principle

Core is the host runtime. It owns the mechanics that should be **identical for
every plugin**, so plugins stay focused on their domain. If a behavior would be
copy-pasted into every plugin, it belongs in core.

## Core owns

- plugin discovery, manifest loading, dependency resolution, activation, lifecycle
- the versioned capability registry (`hypaware.ai-gateway`, `hypaware.blob-store`, …)
- config parsing, per-plugin section dispatch, cross-plugin validation
- the CLI command registry, dispatch, common flags, help assembly
- source lifecycle: start, stop, reload, status
- the sink registry and sink lifecycle
- the query dataset registry, SQL execution, read-only query enforcement
- the Iceberg-backed cache/storage implementation and freshness checks
- result formatting (table / json / jsonl / markdown)
- managed state directories, lock files, permission prompts
- the **config apply engine** — staging a replacement config: validate,
  install pinned plugins, persist last-known-good, swap, staged restart,
  rollback bookkeeping. Exposed to plugins as a narrow context facade; the
  document's *transport* (e.g. `@hypaware/central`'s pull loop) is plugin
  domain. See [LLP 0025](./0025-remote-config-join-flow.spec.md#apply-engine-is-kernel-surface).

## Intrinsic, not plugin-provided

**Storage and query are intrinsic.** Every plugin can assume Iceberg-backed
storage with a SQL surface in front of it, and every plugin that registers a
dataset gets the same query and formatting behavior for free. The local query
cache ([LLP 0013](./0013-local-query-cache.decision.md)) is not a plugin and
never appears in `plugins[]`.

"Query is intrinsic" means the **SQL/dataset surface** specifically: the
dataset registry, SQL execution, cursors, freshness, and formatting. Other
query modalities (e.g. vector similarity search) are **plugin capabilities**
that build on the intrinsic surface, not kernel surface — decided 2026-06-12
when scoping `@hypaware/vector-search`
([LLP 0024](./0024-vector-search-plugin.decision.md#plugin-not-kernel)).

**Partition-spec derivation is core surface.** The helpers that turn a dataset's
partitioning declaration into an Iceberg `PartitionSpec` and guard its stability
— `partitionSpecForDeclaration` and `validatePartitionSpecStability`, with the
declaration type — began life under `src/core/cache/iceberg/` but are pure
functions of `(declaration, schema)` consumed across the boundary: the dataset
registry validates declarations, the public plugin surface types them
(`DatasetRegistration.cachePartitioning`), the intrinsic cache derives its spec,
and the `@hypaware/format-iceberg` export derives its own
([LLP 0022](./0022-iceberg-export-partitioning.spec.md#shared-core-helpers)).
They are therefore promoted to a neutral core home re-exported from
`src/core/index.js`, not buried in the cache — the cache is one consumer, not the
owner.

"Query is intrinsic" means the **SQL/dataset surface** specifically: the
dataset registry, SQL execution, cursors, freshness, and formatting. Other
query modalities (e.g. vector similarity search) are **plugin capabilities**
that build on the intrinsic surface, not kernel surface — decided 2026-06-12
when scoping `@hypaware/vector-search`.

## Plugins own

Domain behavior only, expressed through what they `require`, `provide`, and
`contribute` (see [LLP 0005](./0005-plugin-manifest.spec.md)). A plugin's
category (source, sink, client adapter, composition) is emergent from its
manifest, not a privileged type.

## V1 reality

In V1 first-party plugins are bundled in `hypaware-core/plugins-workspace`
rather than installed from separate repos — a deliberate divergence recorded in
[LLP 0002](./0002-v1-scope.decision.md#plugin-packaging-divergence).
The core/plugin *boundary* is unchanged by where the plugin code physically
lives.
