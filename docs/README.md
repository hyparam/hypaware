# HypAware documentation

HypAware records sessions from your AI clients locally so you can search and
query them on your machine. You can sync your recordings to HypAware Cloud so
your team can search and query them.

## Quickstart

HypAware needs Node.js 22.12 or newer on macOS or Linux.

```sh
npm i -g hypaware
hyp setup
```

Select **Sync to the cloud** to store your recordings on HypAware Cloud or
choose **Local only** to keep everything on your machine. Then have your agent
inspect your logs:

```sh
hyp ask "From my HypAware history, where did my agents go off the rails recently?"
```

To **Sync to the cloud** later, run `hyp remote login`.

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
| Connect a machine to HypAware Cloud | [Team setup](TEAM_SETUP.md) |
| Capture in CI, containers, or an unattended server | [Headless setup](HEADLESS.md) |
| Diagnose missing recordings, stale results, failed exports, or a memory refusal | [Troubleshooting](TROUBLESHOOTING.md) |
| Look up exact command syntax and flags | [CLI reference](CLI_REFERENCE.md) |

## How the pieces fit

HypAware stores captured sessions in a **local query cache**. Local searches
and queries read that cache. If you enable Cloud sync, eligible recordings are
also sent to HypAware Cloud so your team can search and query them.

**Plugins** provide client integrations and optional query tools. Run
`hyp plugin list` to see plugins and their status.

## Contributors and advanced reference

- [Plugin authoring](PLUGIN_AUTHORING.md): scaffold, validate, and implement a plugin.
- [Product telemetry](PRODUCT_TELEMETRY.md): the enrollment default, its
  controls, what is collected, and delivery limits.

Use `hyp --help` to list commands, or `hyp <command> --help` for help with a
specific command.
