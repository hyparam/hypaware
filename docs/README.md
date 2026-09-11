# HypAware documentation

HypAware collects AI sessions and telemetry into a local, queryable history.
You can keep it on your machine, export files, or share recordings with a team
server. Both `hyp` and `hypaware` run the same CLI.

## Start here

1. [Install and set up HypAware](CLI.md) on your own machine, or follow
   [team setup](TEAM_SETUP.md) to join an organization.
2. [Review recording and privacy controls](PRIVACY.md), including what can
   leave your machine.
3. [Search and query your history](QUERYING.md) after running `hyp status`
   to check capture.

## Guides by task

| I want to... | Guide |
| --- | --- |
| Install, reconfigure, update, or recover HypAware | [Setup and lifecycle](CLI.md) |
| Attach an AI client or import existing sessions | [Clients and history](CLIENTS.md) |
| Find a conversation, inspect tool calls, or summarize activity | [Querying and reports](QUERYING.md) |
| Change retention, configure exports, or enable plugins | [Configuration and storage](CONFIGURATION.md) |
| Keep a project private, pause recording, or delete local data | [Privacy controls](PRIVACY.md) |
| Connect a laptop to a team server | [Team setup](TEAM_SETUP.md) |
| Capture in CI, containers, or an unattended server | [Headless setup](HEADLESS.md) |
| Diagnose missing recordings, stale results, or failed exports | [Troubleshooting](TROUBLESHOOTING.md) |
| Look up exact command syntax and flags | [CLI reference](CLI_REFERENCE.md) |

## How the pieces fit

Clients and telemetry sources write to the **local query cache**. Queries read
that cache. **Sinks** export eligible data from it on a schedule: for example,
Parquet files on disk or recordings sent to an enrolled team server. Enabling
capture and enabling export are separate choices.

**Plugins** provide client integrations, sources, destinations, and optional
query tools. Command availability follows the active configuration. Run
`hyp --help` and `hyp plugin list` to see what your installation supports.

## Contributors and advanced reference

- [Plugin authoring](PLUGIN_AUTHORING.md): scaffold, validate, and implement a plugin.
- [Product telemetry](PRODUCT_TELEMETRY.md): opt-in controls, current draft
  implementation, and rollout limitations.
- [Acceptance procedures](ACCEPTANCE.md): manual release checks for real clients,
  installed services, and upgrades.
- [Repository guidance](../AGENTS.md): development checks and contribution rules.
- [Architecture and design decisions](../llp/0000-hypaware.explainer.md): the LLP
  subsystem map and design rationale.

These guides describe the code in this repository. For an older installed
release, use `hyp version` and `hyp COMMAND --help` to check its supported
syntax. Uppercase values such as `SESSION_ID` in examples are placeholders.
