# HypAware documentation

HypAware records sessions from your AI clients locally so you can search and
query them on your host. A host is any machine the collector runs on: a laptop, a build box, a remote agent's box. You can sync your recordings to HypAware Cloud so
your team can search and query them.

## Quickstart

Requires Node.js 22.12 or newer on macOS or Linux.

```sh
npm i -g hypaware
hyp setup
```

Select **Sync to the cloud** to sync your recordings to HypAware Cloud, or
choose **Local only** to keep recordings on your host. Then ask your agent
about your recordings:

```sh
hyp ask "From my HypAware history, where did my agents go off the rails recently?"
```

Use `hyp --help` to list commands, or `hyp <command> --help` for help with a
specific command. To query your recordings from an MCP client instead, see
[Connect an MCP client](MCP.md).

## Documentation by category

| Category | Topics | Commands |
| --- | --- | --- |
| [Setup](CLI.md) | Installation, updates, background service, and uninstall | `setup`, `status`, `update`, `version`, `daemon` |
| [Integrations](INTEGRATIONS.md) | Every supported agent and tool, its status, and how to set it up, including CI and headless hosts | `attach`, `codex-cloud`, `github`, `ollama` |
| [Clients and history](CLIENTS.md) | Choosing clients, capture, history imports, detaching, and skills | `client`, `attach`, `detach`, `backfill` |
| [Queries](QUERYING.md) | Explore recordings with your agent, search, SQL, graph and vector tools, and MCP | `ask`, `query`, `graph`, `vector`, `enrichment`, `mcp` |
| [MCP](MCP.md) | Connect an MCP client to your recordings, locally with `hyp mcp serve` or remotely with an agent token | `mcp` |
| [MCP reference](MCP_REFERENCE.md) | The MCP tools and prompts HypAware defines, with their CLI equivalents; tools only HypAware Cloud registers are not listed | `mcp` |
| [Reports](REPORTS.md) | Generate, review, and publish reports | `report` |
| [Cloud and teams](TEAM_SETUP.md) | Enrollment, sync, and remote access | `remote`, `join`, `leave`, `sync` |
| [Privacy controls](PRIVACY.md) | What is recorded, sharing controls, session exclusions, deletion, and product telemetry | `privacy`, `session`, `telemetry` |
| [Configuration and storage](CONFIGURATION.md) | Configuration files, retention, cache, exports, and plugins | `config`, `cache`, `sink`, `plugin` |
| [Troubleshooting](TROUBLESHOOTING.md) | Diagnose missing recordings, sync failures, and installation problems | Diagnostic commands |
| [CLI reference](CLI_REFERENCE.md) | Complete command syntax, flags, exit behavior, and aliases | All commands |

For contributors, see [plugin authoring](PLUGIN_AUTHORING.md).
