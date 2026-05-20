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

## Troubleshooting

`hyp status` is the entry point for any "is HypAware working?" question.
It prints the active config path, daemon install/run state, active
plugins, source and sink rows, per-client attach state, retention
window, cache size, and a recent-error count. Pass `--json` for the
stable machine-readable shape that smokes and support tools rely on:

```sh
hyp status
hyp status --json
```

When something is wrong, `hyp status` surfaces a `diagnostics:` section
with one row per finding. Each row carries a `kind` (a stable
machine-readable identifier) and one or more `repair:` lines you can
run directly. The common Phase 8 conditions:

| kind                                  | meaning                                                                            | repair                                                                  |
|---------------------------------------|------------------------------------------------------------------------------------|-------------------------------------------------------------------------|
| `config_missing`                      | no `~/.hyp/hypaware-config.json` was found                                         | `hyp init` or `hyp init --from-file <config.json>`                       |
| `config_invalid`                      | the loaded config failed schema / cross-plugin validation                          | `hyp init --from-file <config.json>`                                     |
| `client_without_gateway`              | a client plugin (Claude / Codex) is enabled but `@hypaware/ai-gateway` is not      | re-run `hyp init`, then `hyp attach --client <name>`                     |
| `gateway_missing_anthropic_upstream`  | `@hypaware/claude` enabled but no Anthropic upstream is registered on the gateway  | re-run `hyp init` and pick the Anthropic upstream                        |
| `gateway_missing_openai_upstream`     | `@hypaware/codex` enabled but no OpenAI upstream is registered                     | re-run `hyp init` and pick the OpenAI upstream                           |
| `sink_missing_encoder`                | a local-fs sink is configured but no encoder plugin is enabled                     | re-run `hyp init` and pick "local Parquet export"                        |
| `client_attach_missing`               | a client plugin is enabled but its settings file shows no HypAware marker          | `hyp attach --client claude` or `hyp attach --client codex`              |
| `daemon_binary_missing`               | the daemon installer references a binary that no longer exists on disk             | `hyp daemon install`                                                     |
| `daemon_loaded_no_pid`                | the daemon service file is installed but launchd / systemd is not loading it       | `hyp daemon restart`                                                     |
| `recent_errors`                       | the local telemetry directory has recent error log entries                         | inspect `~/.hyp/hypaware/dev-telemetry`, then `hyp daemon restart`       |

Useful follow-on commands when a diagnostic fires:

- `hyp daemon restart` — bounce the persistent daemon
- `hyp daemon install` — re-install the launchd / systemd unit
- `hyp attach --client claude` / `hyp attach --client codex` — wire a
  selected client into the local gateway
- `hyp init --from-file <path>` — rebuild the config from a known-good
  file without re-running the interactive picker

