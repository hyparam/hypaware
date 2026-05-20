# HypAware

Modular logs and telemetry collector. Plugin-kernel architecture.

This is a fresh-start kernel cutover from the `collectivus` project. The
`collectivus/` directory in this repo is the *behavior reference* — it
will be removed once V1 lands and parity smokes pass.

## Status

Pre-V1. See:

- [`hypaware-design.md`](./hypaware-design.md) — architecture and decisions
- [`hypaware-implementation-plan.md`](./hypaware-implementation-plan.md) — phase-by-phase plan
- [`collectivus-plugin-kernel-types.d.ts`](./collectivus-plugin-kernel-types.d.ts) — draft public interfaces

## Layout (target)

```
src/
  core/                 # the kernel
    observability/      # tracer, logger, meter, attrs, span helpers
    manifest.js
    dep_graph.js
    registry/           # capabilities, commands, datasets, sources, sinks
    runtime/            # paths, activation, loader
    cache/              # intrinsic Iceberg-backed cache
    cli/                # dispatch
    config/             # v2 schema, validator
    plugin_install/     # resolver, fetch, lock, update_check
    sinks/              # cron driver + encoder utility
hypaware-core/
  smoke/                # `hyp smoke <name>` flows
hypaware-core/plugins-workspace/
  otel/                 # @hypaware/otel
  ai-gateway/           # @hypaware/ai-gateway
  local-fs/             # @hypaware/local-fs
  format-parquet/
  format-jsonl/
  claude/               # @hypaware/claude
  codex/                # @hypaware/codex
  central/              # @hypaware/central
  gascity/              # @hypaware/gascity (in-workspace until extracted)
bin/
  hyp.js                # CLI entrypoint
collectivus/            # REFERENCE ONLY — donor behavior, do not import
```
