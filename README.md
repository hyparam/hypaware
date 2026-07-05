# HypAware

Modular logs and telemetry collector. Plugin-kernel architecture.

HypAware captures conversations and traffic from local AI clients (Claude
Code, Codex), raw Anthropic / OpenAI API traffic, and OpenTelemetry
logs / traces / metrics into a local query cache and optional Parquet
exports. It runs fully local by default, no central server required, and a
host can optionally join a fleet (`hyp join`) to forward its recordings to a
central server.

> Part of **[HypStack](https://hypstack.ai/)**, an open-source stack for AI observability.

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

## Joining a centrally-managed fleet (`hyp join`)

`hyp join` enrolls a host in a fleet so its recordings are forwarded to a
central sink:

```sh
hyp join <url> [token]
hyp join <url> --token-file <path>     # read the token from a file (recommended for MDM)
echo "<token>" | hyp join <url>        # or from stdin
hyp join <url> <token> --no-daemon     # write the seed only, skip daemon install
```

It writes a central-enrollment config (mode `0600`) to a dedicated layer under
`config-control/`, never to your local `hypaware-config.json`, so joining
augments an existing install rather than replacing it, then installs and starts
the daemon (unless `--no-daemon` is passed).

The policy token is a multi-use fleet-wide credential. Prefer `--token-file`
or stdin over a positional argument, which would otherwise land in shell
history and process listings. Other flags: `--bin <path>` overrides the binary
the daemon installer records, and `--no-daemon` writes the seed without
installing or restarting the daemon.

## Files and directories

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

## Building and querying the activity graph

Alongside the row datasets, HypAware can project captured activity into a
node/edge **activity graph**: which sessions ran in which app, against which
model, using which tools, touching which files. The projection is
deterministic (exact-key matching, no models), and the `context-graph` plugins
are active by default.

Projection is a manual, cheap-to-rerun step. Build or refresh the graph from
what has been captured, then walk it from a seed node:

```sh
hyp graph project                       # project captured data into the node/edge graph
hyp graph compact                       # merge duplicate rows (optional housekeeping)
hyp graph neighbors <node> --depth 2    # walk out from a seed node
```

`hyp graph neighbors` takes a `node_id`, natural key, or label as the seed,
plus `--depth`, `--direction out|in|both`, `--type <node_type>`, `--edge-type
<type>` (repeatable), and `--limit`. The graph is also plain data: the `node`
and `edge` datasets are queryable through `hyp query sql` like any other
dataset.

Claude Code and Codex additionally get a `hypaware-graph` skill (and a
`graph_neighbors` tool) so an assistant can project and walk the graph on your
behalf.

## Attaching and detaching AI clients

Attach a single client (idempotent — running twice is a no-op):

```sh
hyp attach claude
hyp attach codex
# Equivalent flag form:
hyp attach --client claude
hyp attach --client codex
```

Detach (removes only HypAware-managed settings):

```sh
hyp detach claude
hyp detach codex
# Equivalent aliases:
hyp detach --client claude
hyp detach --client codex
hyp unattach claude
hyp unattach codex
```

Both commands support `--dry-run` and `--json` for inspection and
scripting. Claude writes only HypAware-related keys to
`~/.claude/settings.json`; Codex writes a `hypaware` provider entry to
`~/.codex/config.toml`. Unrelated keys in either file are preserved.

## Opting a folder out of recording (`.hypignore`)

A `.hypignore` file declares a data-usage policy for a directory subtree. It
currently carries exactly one class, `ignore`: AI gateway exchanges (Claude /
Codex) whose working directory is at or under a directory containing a
`.hypignore` are never written to the local cache. The live LLM call is
untouched; only persistence is suppressed.

Resolution is gitignore-style: from an exchange's `cwd`, HypAware walks up the
directory tree, and any `.hypignore` found on the way governs. Dropping one
file at a repo root covers the whole repo, but the file works anywhere in the
ancestor chain, including outside a git repo.

Manage it with the CLI (idempotent; hand-authoring the dotfile is optional):

```sh
hyp ignore              # write a .hypignore at the repo root (or cwd if not in a repo)
hyp ignore <path>       # ignore a specific directory subtree
hyp ignore --check      # report whether cwd is ignored, which file governs, and
                        # how many already-cached rows from the scope remain
hyp unignore            # remove the governing .hypignore, re-enabling recording
```

`hyp ignore` writes a self-documenting file (a comment header plus the `ignore`
token); an empty or comment-only `.hypignore` also means `ignore`. Pass
`--json` to `hyp ignore` for a machine-readable result.

Two things to know:

- **Prospective only.** A `.hypignore` gates future recording and backfills.
  Rows already captured before the file existed are left in place; `hyp ignore
  --check` surfaces that residual count.
- **Folder matching needs a `cwd`.** Only the Claude and Codex pathways supply
  one, so `.hypignore` is a no-op for the `raw-anthropic` / `raw-openai`
  proxy and OTEL sources.

To pause recording for just the current Claude session (in-memory, reversible,
not committed) use the `/hypaware-ignore` and `/hypaware-unignore` skills
instead.

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
npm run typecheck         # if a typecheck script is present
npm pack --dry-run        # verify the published file set
```

Re-run the smoke battery and confirm every one is green:

```sh
hyp smoke package_bin_boot
hyp smoke cli_bundled_plugins_activated
hyp smoke daemon_foreground_start_stop
hyp smoke daemon_install_render
hyp smoke walkthrough_picker_to_first_query
hyp smoke client_attach_idempotent
hyp smoke gateway_claude_capture
hyp smoke gateway_codex_capture
hyp smoke hypignore_capture_drop
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
    central/            # @hypaware/central (bundled, opt-in via `hyp join`)
    gascity/            # @hypaware/gascity (bundled, opt-in)
bin/
  hypaware.js           # CLI entrypoint (bound to both `hypaware` and `hyp`)
```

## Project documents

Design rationale lives in numbered **LLP documents** under [`llp/`](./llp/)
(Linked Literate Programming). Start here:

- [`llp/0000-hypaware.explainer.md`](./llp/0000-hypaware.explainer.md) — root overview and subsystem map
- [`llp/0002-v1-scope.decision.md`](./llp/0002-v1-scope.decision.md) — what actually shipped in V1
- [`llp/0001-adopting-llp.plan.md`](./llp/0001-adopting-llp.plan.md) — how this docs system was set up

The former monolithic docs (`hypaware-design.md`, `finish-v1.md`,
`hypaware-implementation-plan.md`) were decomposed into the LLP corpus and are
preserved under [`llp/tombstones/`](./llp/tombstones/).

- [`docs/PLUGIN_AUTHORING.md`](./docs/PLUGIN_AUTHORING.md) — how to write a plugin (`hyp plugin new` / `hyp plugin doctor`)
- [`hypaware-plugin-kernel-types.d.ts`](./hypaware-plugin-kernel-types.d.ts) — public plugin interfaces
