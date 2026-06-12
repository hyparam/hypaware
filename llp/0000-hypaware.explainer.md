# LLP 0000: HypAware

**Type:** Explainer
**Status:** Active
**Systems:** Core
**Role:** Root
**Author:** Phil / Claude
**Date:** 2026-06-01
**Related:** LLP 0001, LLP 0002

> Root orientation document for HypAware. Decomposed from `hypaware-design.md`
> (Mission, Design Summary). Subsystem detail lives in the LLPs linked below.

## Mission

HypAware is a modular logs and telemetry collector that stores data in the most
efficient way possible and surfaces it for efficient LLM-native querying.

## Architecture at a glance

HypAware is split into three pieces:

- **Core kernel** — the host runtime. Owns the mechanics that should be
  identical for every plugin: plugin discovery/manifest/dependency/activation
  lifecycle, the versioned capability registry, config parsing and validation,
  the CLI command registry, source lifecycle, the sink registry and export
  driver, the query/dataset registry and SQL surface, the intrinsic
  Iceberg-backed cache, result formatting, and managed state directories.
- **Server package** — the enterprise companion that receives logs forwarded
  from HypAware instances across an org, composes them into files, and uploads
  them to a sink. Full server design is out of tree for now (TK).
- **Plugins** — every piece of domain behavior. A plugin's category is
  expressed by what it `requires`, `provides`, and `contributes`, not by a
  privileged variant. See [plugin categories](#plugin-categories).

**Storage and query are intrinsic, not plugin-provided.** Every plugin can
assume Iceberg-backed storage with a SQL surface in front of it, and every
plugin that registers a dataset gets query and formatting for free.

## Plugin categories

- **Source plugins** — produce normalized rows and own a daemon lifecycle
  (proxy listener, OTLP receiver, gascity subscriber). See [LLP 0012](./0012-sources.spec.md).
- **Sink plugins** — *export targets*, not the write path. Captured data always
  lands in the intrinsic [local query cache](./0013-local-query-cache.decision.md);
  sinks receive scheduled exports out of it. See [LLP 0014](./0014-sinks.spec.md).
- **Client adapter plugins** — wire an external tool (Claude Code, Codex) to a
  HypAware capability such as [the AI gateway](./0016-ai-gateway.decision.md).
- **Composition plugins** — init presets, skill scaffolds; small surface, no
  daemon.

## Subsystem map

| Area | LLP | Type |
|------|-----|------|
| V1 scope & cutover decisions | [0002](./0002-v1-scope.decision.md) | Decision |
| Core vs plugin surface | [0003](./0003-core-vs-plugin-surface.spec.md) | Spec |
| Activation, paths, state dirs | [0004](./0004-activation-and-paths.spec.md) | Spec |
| Plugin manifest | [0005](./0005-plugin-manifest.spec.md) | Spec |
| Dependencies & capabilities | [0006](./0006-dependencies-and-capabilities.spec.md) | Spec |
| Plugin install & lock file | [0007](./0007-plugin-install-and-locking.decision.md) | Decision |
| Plugin runtime dependencies | [0008](./0008-plugin-runtime-dependencies.decision.md) | Decision |
| CLI registry & bridge | [0009](./0009-cli-registry.spec.md) | Spec |
| Config model v2 | [0010](./0010-config-model.spec.md) | Spec |
| Setup & first-run wizard | [0011](./0011-setup-and-onboarding.decision.md) | Decision |
| Sources model | [0012](./0012-sources.spec.md) | Spec |
| Local query cache | [0013](./0013-local-query-cache.decision.md) | Decision |
| Sinks driver & scheduling | [0014](./0014-sinks.spec.md) | Spec |
| Query, datasets & collect | [0015](./0015-query-and-datasets.spec.md) | Spec |
| AI gateway as a plugin | [0016](./0016-ai-gateway.decision.md) | Decision |
| Daemon runtime & installers | [0017](./0017-daemon-runtime.decision.md) | Decision |
| Observability & self-instrumentation | [0021](./0021-observability.spec.md) | Spec |
| Iceberg export partitioning | [0022](./0022-iceberg-export-partitioning.spec.md) | Spec |
| Context-graph T0 projection | [0023](./0023-context-graph-projection.decision.md) | Decision |
| Remote config & join flow | [0025](./0025-remote-config-join-flow.spec.md) | Spec |

## Where to start

- New to the codebase: read this, then [LLP 0002](./0002-v1-scope.decision.md)
  for what actually shipped in V1 (it diverges from the broader design in a few
  deliberate ways).
- Working on a subsystem: read the LLP tagged with its `Systems` value before
  changing code, and add `@ref LLP NNNN#anchor` annotations for non-obvious
  decisions you implement.
- The aspirational target architecture (separate plugin repos, post-V1 sinks)
  lives in the tombstoned design doc; the active LLPs above describe current
  guidance.

## Cross-cutting invariants

- **One source, one table.** Each dataset table has exactly one producer plugin
  and is named after it (`ai_gateway_messages`, `gascity_messages`, `logs`).
  See [LLP 0016](./0016-ai-gateway.decision.md#naming-rule).
- **Sources never see sinks.** Sources write only to the cache; the export
  pipeline reads the cache and pushes to sinks.
- **Config is explicit.** The written config enumerates chosen plugins in
  `plugins[]`; there is no implicit "use defaults" mode. See [LLP 0010](./0010-config-model.spec.md).
- **The kernel never runs `npm install`** on a user's machine; plugins ship
  pre-bundled JS. See [LLP 0008](./0008-plugin-runtime-dependencies.decision.md).
