[← All documentation](README.md)

---

# Configure storage, exports, and plugins

Prefer `hyp setup` for routine changes. It composes the required plugins,
preserves centrally managed settings, and reports the actions it will take.

## Contents

- [Locate and validate configuration](#locate-and-validate-configuration)
- [Make a repeatable setup](#make-a-repeatable-setup)
- [Set local retention](#set-local-retention)
- [Choose an export destination](#choose-an-export-destination)
- [Maintain the query cache](#maintain-the-query-cache)
- [Know where data lives](#know-where-data-lives)
- [Manage optional plugins](#manage-optional-plugins)

## Locate and validate configuration

The local file is `<HYP_HOME>/hypaware-config.json`; `HYP_HOME` defaults to
`~/.hyp`. Run `hyp status --verbose` to see the paths and effective setup.

```sh
hyp config validate
hyp plugin list
```

Configuration uses `version: 2`, an explicit `plugins` list, optional `sinks`,
and `query.cache` settings. The top-level `auto_update` setting defaults to
`true` for supervised global installations; see [automatic updates](CLI.md#update-hypaware).
To disable automatic updates, set `"auto_update": false` and restart the daemon.
Organization policy may control this setting. Each plugin owns its own `config` block. Use
`hyp plugin info PLUGIN` to inspect an installed plugin's manifest.

On an enrolled machine, a separate central layer under `config-control/` is
authoritative. Local settings are additive and cannot override central locks.
`hyp status --verbose` identifies each layer and any rejected local entries.
Joining does not replace your local configuration; leaving removes central
management.

## Make a repeatable setup

For a fresh installation, use the [unattended setup example](CLI.md#install-hypaware).
On an existing installation, interactive `hyp setup` is the usual reconfiguration
path. An unattended replacement
requires `--force` and backs up the previous local file; supply the complete
set of choices, since it is a replacement rather than an incremental patch.

To apply a complete configuration file you have prepared:

```sh
hyp config validate ./hypaware-config.json
hyp setup --from-file ./hypaware-config.json --force
hyp status
```

For direct edits to the active file, validate afterward and restart the daemon
to load the change. Set a custom `HYP_HOME` consistently for the CLI and daemon;
changing it in one shell does not move existing recordings or a running service.

## Set local retention

First-time guided setup uses 120 days for local collection and 90 days for team
collection. Unattended setup defaults to 90 days, including local-only installs.
Existing retention survives interactive reconfiguration. `--retention-days`
overrides the setup default. In a configuration file, the
following is a fragment to merge into the existing `query` block:

```json
{
  "cache": {
    "retention": {
      "default_days": 120,
      "datasets": { "logs": 30 }
    }
  }
}
```

This retains local logs for 30 days and other datasets for 120 days. A value
of `0` means no age limit. Shortening retention allows maintenance to remove
older cache data; it does not delete exported files or copies in HypAware Cloud.

Retention also supplies the fallback history-recovery window when an adapter
has no explicit `backfill.window_days`. See [clients and history](CLIENTS.md).

## Choose an export destination

Capture always writes to the local cache first. A sink is a scheduled export
from that cache, not a prerequisite for querying it.

| Setup choice | Result |
| --- | --- |
| `--export keep-local` | Keep the local query cache without composing a local export sink. |
| `--export local-parquet` | Also write Parquet files under `<HYP_HOME>/exports` every five minutes. |
| `--export configure-later` | Defer local export configuration. |

These `--export` flags select unattended setup; they are not extra choices
inside the guided walkthrough. New guided setups default to local Parquet
exports; interactive reconfiguration preserves the existing export choice. An enrolled machine may also have a
centrally managed sync sink regardless of its local export choice.

For previewing destinations and sending recordings now, see
[Cloud sync](TEAM_SETUP.md#send-recordings-now).

The generated Parquet sink instance is named `local`.

Cache maintenance is separate from export: it acts on the local query cache,
not on that sink. Inspect it with:

```sh
hyp cache maintain ai_gateway_messages --dry-run
```

`hyp sink maintain` is a separate command, and it covers iceberg table-format
export sinks only. The Parquet sink the guided setup composes is a blob sink,
so that command does not accept it.

For custom destinations, keep writer and destination plugin settings in their
documented config blocks and run `hyp config validate` before restarting.
The [plugin authoring guide](PLUGIN_AUTHORING.md) explains the sink contracts.

## Maintain the query cache

The cache is Iceberg storage backed by Parquet files. Local queries use this
cache; optional Parquet exports are an additional copy for external use.

Use `hyp cache refresh DATASET` when a query reports stale cached data, and
`hyp cache maintain DATASET --dry-run` to inspect maintenance before applying
it. Cache refresh does not import client transcripts; use
[history imports](CLIENTS.md#bring-in-existing-history) for that. Cache
maintenance does not delete exported copies.

## Know where data lives

All paths below are relative to `HYP_HOME`:

| Path | Purpose |
| --- | --- |
| `hypaware-config.json` | Local configuration |
| `hypaware/config-control/` | Central enrollment and managed configuration |
| `hypaware/cache/` | Local query cache |
| `hypaware/plugins/` | Per-plugin state |
| `hypaware/sinks/` | Export progress and retained failure diagnostics |
| `exports/` | Default local Parquet destination |
| `spool/claude-bodies/` | Transient Claude raw bodies |
| `hypaware/logs/daemon.log` | Main structured daemon log |
| `hypaware/logs/daemon.out.log` | Service stdout log |
| `hypaware/logs/daemon.err.log` | Service stderr log |
| `hypaware/session-ignores/` | Persistent session exclusions for supported recorders |
| `hypaware/product-telemetry/` | Product telemetry policy and pending batches |
| `hypaware/tls/` | Local proxy certificate authority and certificates |
| `hypaware/processing/logs/daemon.log` | Processing daemon log |
| `hypaware/dev-telemetry/` | Local development diagnostics |

<!-- @ref LLP 0471#diagnostic-history: prune owned diagnostic evidence without acknowledging cache payload -->
Each destination's `hypaware/sinks/<instance>/outbox/` holds failure diagnostics,
not rows waiting to be uploaded. HypAware writes the new record atomically,
then retains up to 100 recognized records per destination after successful cleanup.
It protects the new record and the newest failure dated no later than cleanup,
then fills the remaining places with the newest history.
An unsuccessful write prunes nothing.
Cleanup preserves unfamiliar files, symlinks and other destinations' records.
It does not delete cache rows, advance export progress or clear an export warning.

If filesystem access prevents cleanup, history can temporarily exceed 100.
The daemon logs a separate cleanup failure and retries on its existing cache
maintenance schedule, rather than rescanning old history on each export failure.
With automatic cache maintenance disabled, no cleanup timer runs: a new sink
handle after restart can retry cleanup when it next publishes a failure.
Check directory permissions and the [diagnostic logs](TROUBLESHOOTING.md#find-diagnostic-logs).
`hyp sink maintain` maintains export tables; it is not a command for pruning
these diagnostics.

## Manage optional plugins

```sh
hyp plugin list --json
hyp plugin info @hypaware/codex
hyp plugin outdated
```

Bundled does not always mean active. The effective configuration determines
which plugins load and which commands appear. If a command is missing, the CLI
names its owning plugin and prints a repair instruction.

Third-party plugins can be installed from supported local, npm, or git sources
with `hyp plugin install`. Review the source, revision, manifest, and requested
permissions before approving remote code. Use the
[plugin command reference](CLI_REFERENCE.md#manage-plugins) for install, update,
and removal syntax. Updating a plugin is separate from `hyp update`, which
updates the HypAware package.
