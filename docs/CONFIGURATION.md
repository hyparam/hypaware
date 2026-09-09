# Configure storage, exports, and plugins

[Documentation](README.md) / Configuration

Prefer `hyp setup` for routine changes. It composes the required plugins,
preserves centrally managed settings, and reports the actions it will take.

## Locate and validate configuration

The local file is `<HYP_HOME>/hypaware-config.json`; `HYP_HOME` defaults to
`~/.hyp`. Run `hyp status` to see the paths and effective setup.

```sh
hyp config validate
hyp plugin list
```

Configuration uses `version: 2`, an explicit `plugins` list, optional `sinks`,
and `query.cache` settings. Each plugin owns its own `config` block. Use
`hyp plugin info PLUGIN` to inspect an installed plugin's manifest.

On an enrolled machine, a separate central layer under `config-control/` is
authoritative. Local settings are additive and cannot override central locks.
`hyp status` identifies each layer and any rejected local entries. Joining
does not replace your local configuration; leaving removes central management.

## Make a repeatable setup

Preview an unattended local setup:

```sh
hyp setup --yes --source codex --client codex --export keep-local --retention-days 120 --dry-run
```

Remove `--dry-run` to apply it. On an existing installation, interactive
`hyp setup` is the usual reconfiguration path. An unattended replacement
requires `--force` and backs up the previous local file; supply the complete
set of choices, since it is a replacement rather than an incremental patch.

To apply a complete configuration file you have prepared:

```sh
hyp config validate --path ./hypaware-config.json
hyp setup --from-file ./hypaware-config.json --force
hyp status
```

For direct edits to the active file, validate afterward and restart the daemon
to load the change. Set a custom `HYP_HOME` consistently for the CLI and daemon;
changing it in one shell does not move existing recordings or a running service.

## Set local retention

The guided setup uses 120 days for local collection and 90 days for team
collection. Existing retention survives interactive reconfiguration.
`--retention-days` overrides the setup default. In a configuration file, the
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
older cache data; it does not delete exported files or server copies.

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

New guided setups default to local Parquet exports; interactive reconfiguration
preserves the existing export choice. An enrolled machine may also have a
centrally managed forwarding sink regardless of its local export choice.

To inspect destinations and send eligible data now:

```sh
hyp sync --dry-run
hyp sync
```

`hyp sync` prints its plan and asks for confirmation. It does not bypass
local-only or ignored-folder exclusions. A confirmed all-destination sync can
release an attended enrollment's first-sync hold early. See [privacy](PRIVACY.md)
and [headless setup](HEADLESS.md) for enrollment-specific behavior.

The generated Parquet sink instance is named `local`. Inspect cache
maintenance with:

```sh
hyp cache maintain ai_gateway_messages --dry-run
```

`hyp sink maintain` is a separate command, and it covers iceberg table-format
export sinks only. The Parquet sink the guided setup composes is a blob sink,
so that command does not accept it.

For custom destinations, keep writer and destination plugin settings in their
documented config blocks and run `hyp config validate` before restarting.
The [plugin authoring guide](PLUGIN_AUTHORING.md) explains the sink contracts.

## Know where data lives

All paths below are relative to `HYP_HOME`:

| Path | Purpose |
| --- | --- |
| `hypaware-config.json` | Local configuration |
| `hypaware/config-control/` | Central enrollment and managed configuration |
| `hypaware/cache/` | Local query cache |
| `hypaware/plugins/` | Per-plugin state |
| `hypaware/sinks/` | Export state and retry outboxes |
| `exports/` | Default local Parquet destination |
| `spool/claude-bodies/` | Transient Claude raw bodies |
| `hypaware/logs/` | Service stdout and stderr logs |
| `hypaware/processing/logs/daemon.log` | Processing daemon log |
| `hypaware/dev-telemetry/` | Local development diagnostics |

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
