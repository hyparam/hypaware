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

## Intrinsic, not plugin-provided

**Storage and query are intrinsic.** Every plugin can assume Iceberg-backed
storage with a SQL surface in front of it, and every plugin that registers a
dataset gets the same query and formatting behavior for free. The local query
cache ([LLP 0013](./0013-local-query-cache.decision.md)) is not a plugin and
never appears in `plugins[]`.

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
