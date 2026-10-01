# HypAware documentation

HypAware records sessions from your AI clients locally so you can search and
query them on your machine. You can sync your recordings to HypAware Cloud so
your team can search and query them.

## Quickstart

Requires Node.js 22.12 or newer on macOS or Linux.

```sh
npm i -g hypaware
hyp setup
```

Select **Sync to the cloud** to sync your recordings to HypAware Cloud, or
choose **Local only** to keep recordings on your machine. Then ask your agent
about your recordings:

```sh
hyp ask "From my HypAware history, where did my agents go off the rails recently?"
```

Use `hyp --help` to list commands, or `hyp <command> --help` for help with a
specific command.

## Documentation by category

| Category | Topics | Commands |
| --- | --- | --- |
| [Setup](CLI.md) | Installation, updates, background service, and uninstall | `setup`, `status`, `update`, `version`, `daemon` |
| [Clients and history](CLIENTS.md) | Supported clients, capture, history imports, GitHub activity, and skills | `client`, `attach`, `detach`, `backfill`, `github` |
| [Queries](QUERYING.md) | Explore recordings with your agent, search, SQL, graph and vector tools, and MCP | `ask`, `query`, `graph`, `vector`, `enrichment`, `mcp` |
| [Reports](REPORTS.md) | Generate, review, and publish reports | `report` |
| [Cloud and teams](TEAM_SETUP.md) | Enrollment, sync, remote access, CI, and headless deployment | `remote`, `join`, `leave`, `sync` |
| [Privacy](PRIVACY.md) | What is recorded, sharing controls, session exclusions, deletion, and product telemetry | `privacy`, `session`, `telemetry` |
| [Configuration and storage](CONFIGURATION.md) | Configuration files, retention, cache, exports, and plugins | `config`, `cache`, `sink`, `plugin` |
| [Troubleshooting](TROUBLESHOOTING.md) | Diagnose missing recordings, sync failures, and installation problems | Diagnostic commands |
| [CLI reference](CLI_REFERENCE.md) | Complete command syntax, flags, exit behavior, and aliases | All commands |

For contributors, see [plugin authoring](PLUGIN_AUTHORING.md).
