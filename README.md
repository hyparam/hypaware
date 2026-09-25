# HypAware

HypAware records every session from your AI coding agents (Claude Code,
Codex, Cursor, OpenCode, and more) into one queryable history on your
machine. Then it helps you find what went wrong, what keeps repeating, and
what to fix.

- **Collect.** A lightweight background daemon captures sessions from the
  agents you already use. No changes to how you work.
- **Store.** Sessions land in a local cache of open table files, linked as a
  graph of sessions, repos, files, tools, and skills. No data warehouse.
- **Analyze.** Query everything with SQL or search, or just ask a question
  in plain English.
- **Act.** HypAware turns patterns in your history into concrete fixes, like a
  skill worth adding, with the sessions that prove it.

## Install

Requires Node.js 22.12 or newer, on macOS or Linux.

```sh
npm install -g hypaware
hyp setup
```

Setup first asks how to collect. **Sync to the cloud** is the default: press
Enter and a browser sign-in enrolls this machine, so your history follows you
across machines. Choose **Local only** to keep everything on this machine.
Then it asks which agents to capture, installs the background daemon, and
starts recording. It ends with a first look at your history: tokens per
model, activity per day, which repos you worked in, and which tools got
called. Both `hyp` and `hypaware` run the same CLI.

## What you can do with it

See the summary any time:

```sh
hyp query overview
```

Ask a question about your own history:

```sh
hyp ask "which sessions touched the auth module"
hyp ask            # suggest a skill based on your recent sessions
```

Search and query directly:

```sh
hyp query grep "connection refused"
hyp query sql "select count(*) from ai_gateway_messages"
```

Your agents can do this too. `hyp client skills install` gives Claude or
Codex skills to look up what happened in past sessions on their own.

See [querying and reports](./docs/QUERYING.md) for more.

## Supported agents

Claude Code, Claude Desktop, Codex (CLI and Desktop), Cursor, OpenCode,
OpenClaw, Hermes Agent, Pi, and any tool that exports OpenTelemetry logs,
traces, or metrics.

Claude Code is captured through its built-in telemetry, so it still talks
directly to Anthropic and nothing sits in the path of your session. See
[clients and history](./docs/CLIENTS.md), including how to import sessions
you ran before installing.

## Use it with your team

Choosing **Sync to the cloud** in `hyp setup` signs the machine in. To sign
in a machine you set up as local only, run:

```sh
hyp remote login
```

Everyone's history then flows to HypAware Cloud, so you can analyze usage,
spend, and failure patterns across the whole team:

```sh
hyp query sql "select count(*) from ai_gateway_messages" --remote
```

Nothing leaves your machine right away. The first sync waits until the end of
the day you sign in, so you can review what will be sent and mark anything
private first.

One person can sign in and sync on their own. To put more than one person in
an organization, [contact us](https://hypaware.ai/contact) and we'll set it
up; there is no self-serve invite yet. See the
[team setup guide](./docs/TEAM_SETUP.md).

## Privacy

Everything stays local unless you sign in, either by choosing **Sync to the
cloud** in setup or with `hyp remote login`. You control what is recorded,
per folder:

```sh
hyp privacy ignore              # never record sessions in this repo
hyp privacy set . local-only    # record, but never send to HypAware Cloud
hyp session ignore              # stop recording the current session
hyp privacy purge --session ID  # delete what was already recorded
```

See [what HypAware records and how to control it](./docs/PRIVACY.md).

## Is it working?

```sh
hyp status
```

This shows the daemon, attached agents, and what was captured recently. See
[troubleshooting](./docs/TROUBLESHOOTING.md).

## Uninstall

```sh
hyp leave                  # only if you signed in to HypAware Cloud
hyp daemon uninstall       # stop the daemon and detach every agent
npm uninstall -g hypaware
rm -rf ~/.hyp              # delete all local recordings
```

Your agents' settings are restored on the way out. Copies already sent to
HypAware Cloud or exported to files are not affected.

## Documentation

- [Setup and lifecycle](./docs/CLI.md)
- [Clients and history](./docs/CLIENTS.md)
- [Querying and reports](./docs/QUERYING.md)
- [Configuration and storage](./docs/CONFIGURATION.md)
- [Privacy](./docs/PRIVACY.md)
- [Team setup](./docs/TEAM_SETUP.md) and [headless deploys](./docs/HEADLESS.md)
- [Troubleshooting](./docs/TROUBLESHOOTING.md)
- [CLI reference](./docs/CLI_REFERENCE.md)
- [Writing a plugin](./docs/PLUGIN_AUTHORING.md)
