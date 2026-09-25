# HypAware documentation

HypAware collects AI sessions and telemetry into a local, queryable history.
You can keep it on your machine, export files, or sync recordings to
HypAware Cloud. Both `hyp` and `hypaware` run the same CLI.

## Quickstart

HypAware needs Node.js 22.12 or newer on macOS or Linux.

```sh
npm i -g hypaware
hyp setup
```

Setup's first question is how to collect. **Sync to the cloud** is the
default and opens a browser sign-in; choose **Local only** to keep everything
on this machine. Then check capture and look at what you already have:

```sh
hyp status
hyp query overview
hyp ask "From my HypAware history, where did my agents go off the rails recently?"
```

To switch a local-only machine to sync later, run `hyp remote login`.

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
| Diagnose missing recordings, stale results, or failed exports | [Troubleshooting](TROUBLESHOOTING.md) |
| Look up exact command syntax and flags | [CLI reference](CLI_REFERENCE.md) |

## How the pieces fit

Clients and telemetry sources write to the **local query cache**. Queries read
that cache. **Sinks** export eligible data from it on a schedule: for example,
Parquet files on disk or recordings sent to HypAware Cloud. Enabling
capture and enabling export are separate choices.

**Plugins** provide client integrations, sources, destinations, and optional
query tools. Command availability follows the active configuration. Run
`hyp --help` and `hyp plugin list` to see what your installation supports.

## Contributors and advanced reference

- [Plugin authoring](PLUGIN_AUTHORING.md): scaffold, validate, and implement a plugin.
- [Product telemetry](PRODUCT_TELEMETRY.md): the enrollment default, its
  controls, what is collected, and delivery limits.

These guides describe the code in this repository. For an older installed
release, use `hyp version` and `hyp COMMAND --help` to check its supported
syntax. Uppercase values such as `SESSION_ID` in examples are placeholders.
