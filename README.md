# HypAware

Modular logs and telemetry collector. Plugin-kernel architecture.

HypAware captures conversations and traffic from local AI clients (Claude
Code, Codex), raw Anthropic / OpenAI API traffic, and OpenTelemetry
logs / traces / metrics into a local query cache and optional Parquet
exports. Everything runs on the local machine — no central server is
required for V1.

## Quickstart

```sh
npx hypaware
```

On a TTY this launches the interactive walkthrough:

1. Pick the **sources** to capture. Any subset of:
   - Claude Code conversations (`claude`)
   - Codex conversations (`codex`)
   - Raw Anthropic API traffic (`raw-anthropic`)
   - Raw OpenAI API traffic (`raw-openai`)
   - OTEL logs / traces / metrics (`otel`)
2. Pick an **export** strategy: keep the local query cache only, write
   Parquet files under `<HYP_HOME>/exports`, or configure later.
3. Pick a **retention window** (default `30` days).
4. HypAware composes a minimal config with only the bundled plugins it
   needs, writes it to `<HYP_HOME>/hypaware-config.json`, installs the
   persistent daemon (launchd on macOS, systemd `--user` on Linux),
   attaches the selected clients, and starts capturing.
5. The walkthrough finishes by printing the config path, daemon status,
   per-client attach results, and a first `hyp query` command to run.

For unattended installs (CI, scripted bootstraps, dotfiles) use the
non-interactive flags:

```sh
hyp init --yes \
  --source claude --source otel \
  --client claude \
  --export local-parquet \
  --retention-days 30
```

Other init flags:

| Flag                       | Meaning                                                 |
|----------------------------|---------------------------------------------------------|
| `--yes` / `-y`             | Accept defaults; do not prompt                          |
| `--no-daemon`              | Skip daemon install and restart                         |
| `--dry-run`                | Render the config + planned actions, write nothing      |
| `--client claude\|codex`   | Attach a client (repeatable)                            |
| `--source <id>`            | Add a capture source (repeatable)                       |
| `--export <choice>`        | `keep-local`, `local-parquet`, or `configure-later`     |
| `--retention-days <N>`     | Override the default 30-day retention window            |
| `--from-file <config.json>`| Skip the picker and load a known-good config            |
| `--bin <path>`             | Override the binary path the daemon installer uses      |

## Where things live

| Path                                           | Contents                                                 |
|------------------------------------------------|----------------------------------------------------------|
| `<HYP_HOME>/hypaware-config.json`              | Active config (rewritten by `hyp init`)                   |
| `<HYP_HOME>/hypaware/`                         | Kernel state root                                         |
| `<HYP_HOME>/hypaware/plugins/<name>/`          | Per-plugin state                                          |
| `<HYP_HOME>/hypaware/cache/`                   | Local query cache (Iceberg-backed)                        |
| `<HYP_HOME>/hypaware/sinks/<name>/outbox/`     | Failed export rows awaiting retry                         |
| `<HYP_HOME>/hypaware/dev-telemetry/`           | Daemon self-telemetry (logs, traces, metrics)             |
| `<HYP_HOME>/hypaware/logs/daemon.{out,err}.log`| Daemon stdout / stderr (launchd / systemd)                |
| `<HYP_HOME>/exports/`                          | Local Parquet exports (when the local-fs sink is enabled) |

`HYP_HOME` defaults to `~/.hyp`. Override it by exporting `HYP_HOME=...`
before invoking the CLI or the daemon.

## Querying captured data

```sh
hyp query sql "select count(*) from ai_gateway_messages"
hyp query sql "select count(*) from traces"
hyp query sql "select count(*) from logs"
```

Use `hyp query schema <dataset>` to see the columns available on each
dataset, and `hyp query status` to inspect cache freshness per dataset.

## Attaching and detaching AI clients

Attach a single client (idempotent — running twice is a no-op):

```sh
hyp attach --client claude
hyp attach --client codex
```

Detach (removes only HypAware-managed settings):

```sh
hyp detach --client claude
hyp detach --client codex
```

Both commands support `--dry-run` and `--json` for inspection and
scripting. Claude writes only HypAware-related keys to
`~/.claude/settings.json`; Codex writes a `hypaware` provider entry to
`~/.codex/config.toml`. Unrelated keys in either file are preserved.

## Daemon lifecycle

```sh
hyp daemon install      # launchd LaunchAgent (macOS) or systemd --user unit (Linux)
hyp daemon start        # ensure the service is started
hyp daemon status       # health snapshot
hyp daemon restart      # bounce after a config change
hyp daemon stop         # signal the running daemon to shut down
hyp daemon uninstall    # remove the service file (config + recordings are kept)
```

`hyp daemon install --dry-run --json` prints the rendered plist or unit
content and target paths without touching the filesystem — useful for
verifying what `hyp init` will install.

## V1 scope

V1 ships with:

- Bundled plugins (no external plugin install required for the default
  flow): `@hypaware/ai-gateway`, `@hypaware/claude`, `@hypaware/codex`,
  `@hypaware/otel`, `@hypaware/local-fs`, `@hypaware/format-parquet`,
  `@hypaware/format-jsonl`, plus Anthropic and OpenAI upstreams.
- Local capture for Claude Code, Codex, raw Anthropic API, raw OpenAI
  API, and OTEL logs / traces / metrics.
- Local query (`hyp query sql`) across captured AI gateway messages,
  logs, traces, and metrics.
- Local Parquet export through the `local-fs` sink and the
  `format-parquet` encoder.
- Claude Code attach and Codex attach (idempotent, reversible).
- Persistent macOS / Linux user daemon (`launchd` LaunchAgent or
  `systemd --user` unit).

## Out of scope for V1

- The central / enterprise sink.
- Gascity (multi-tenant aggregation).
- Extracting the kernel or bundled plugins into separate repos.
- Migrating an existing Collectivus install.
- An external first-party plugin registry. Only bundled plugins are
  required for the default V1 path.

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

## Release checklist

Run before tagging a new HypAware release:

```sh
npm test                  # if a test script is present
npm run lint              # if a lint script is present
npm run typecheck         # if a typecheck script is present
npm pack --dry-run        # verify the published file set
```

Re-run the V1 smoke battery and confirm every one is green:

```sh
hyp smoke package_bin_boot
hyp smoke cli_bundled_plugins_activated
hyp smoke daemon_foreground_start_stop
hyp smoke daemon_install_render
hyp smoke walkthrough_picker_to_first_query
hyp smoke client_attach_idempotent
hyp smoke gateway_claude_capture
hyp smoke gateway_codex_capture
hyp smoke otel_loopback_capture
hyp smoke local_parquet_export
hyp smoke status_diagnostics
```

Finally, exercise the manual gate end-to-end on at least one macOS host
and one Linux host:

```sh
npm pack
npx ./hypaware-*.tgz
hypaware status
hypaware daemon restart
hypaware query sql "select count(*) from ai_gateway_messages"
hypaware query sql "select count(*) from traces"
hypaware query sql "select count(*) from logs"
hypaware daemon uninstall
```

## Layout

```
src/
  core/                 # the kernel
    observability/      # tracer, logger, meter, attrs, span helpers
    manifest.js
    dep_graph.js
    registry/           # capabilities, commands, datasets, sources, sinks
    runtime/            # paths, activation, loader, daemon runtime
    cache/              # intrinsic Iceberg-backed cache
    cli/                # dispatch, walkthrough, core_commands
    config/             # v2 schema, validator
    daemon/             # platform installers (launchd / systemd) + lifecycle
    plugin_install/     # resolver, fetch, lock, update_check
    sinks/              # cron driver + encoder utility
hypaware-core/
  smoke/                # `hyp smoke <name>` flows
  plugins-workspace/
    ai-gateway/         # @hypaware/ai-gateway
    otel/               # @hypaware/otel
    local-fs/           # @hypaware/local-fs
    format-parquet/     # @hypaware/format-parquet
    format-jsonl/       # @hypaware/format-jsonl
    claude/             # @hypaware/claude
    codex/              # @hypaware/codex
    central/            # @hypaware/central (out of scope for V1)
    gascity/            # @hypaware/gascity (out of scope for V1)
bin/
  hypaware.js           # CLI entrypoint (bound to both `hypaware` and `hyp`)
```

## Project documents

- [`hypaware-design.md`](./hypaware-design.md) — architecture and decisions
- [`finish-v1.md`](./finish-v1.md) — the V1 plan of record
- [`hypaware-implementation-plan.md`](./hypaware-implementation-plan.md) — the longer-term phased plan
- [`collectivus-plugin-kernel-types.d.ts`](./collectivus-plugin-kernel-types.d.ts) — public plugin interfaces
