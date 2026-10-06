# HypAware

HypAware records every session from your AI clients (Claude Code,
Codex, Cursor, OpenCode, and more) into one queryable history on your
machine. Then it helps you find what went wrong, what keeps repeating, and
what to fix.

- **Collect.** A lightweight background daemon captures sessions from the
  clients you already use. No changes to how you work.
- **Store.** Sessions land in a local cache of open table files, linked as a
  graph of sessions, repos, files, tools, and skills. No data warehouse.
- **Analyze.** Query everything with SQL or search, or have your client
  answer a question in plain English.
- **Act.** HypAware turns patterns in your history into concrete fixes, like a
  skill worth adding, with the sessions that prove it.

## Install

Requires Node.js 22.12 or newer, on macOS or Linux.

```sh
npm install -g hypaware
hyp setup
```

You can also ask your AI agent to install HypAware using these same two
commands. Without a terminal, `hyp setup` prints a guide so the agent can
walk you through the choices and run unattended setup. You complete any
browser sign-ins yourself. Agents using a terminal can read the guide with
`hyp setup --guide`.

On a terminal, setup first asks how to collect. **Sync to the cloud** is the default: press
Enter and a browser sign-in enrolls this machine, so your history follows you
across machines. Choose **Local only** to keep recordings on this machine.
Then it asks which clients to capture, installs the background daemon, and
starts recording. It ends with a first look at your history: tokens per
model, activity per day, which repos you worked in, and which tools got
called. Both `hyp` and `hypaware` run the same CLI.

## What you can do with it

See the summary any time:

```sh
hyp query overview
```

Have your client answer a question about your history. `hyp ask` opens one of
the clients HypAware is recording, such as Claude Code or Codex, on the
question:

```sh
hyp ask "which sessions touched the auth module"
hyp ask            # suggest a skill based on your recent sessions
```

Or ask from inside any session. Install the HypAware skills and your client
looks up past sessions itself whenever a question calls for it:

```sh
hyp client skills install
```

Search and query directly, without an AI client:

```sh
hyp query grep "connection refused"
hyp query sql "select count(*) from ai_gateway_messages"
```

See [queries](./docs/QUERYING.md) for more.

## Reports

Reports review your AI work over a period: token usage, recurring tasks, tool
failures, and opportunities to improve. Your agent investigates recorded sessions
and proposes specific fixes with evidence:

```sh
hyp report generate "Cover last week and focus on repeated debugging work"
```

Read the report locally or publish it to make it appear in your team's
[HypAware Cloud dashboard](https://app.hypaware.ai/).
See [reports](./docs/REPORTS.md) for generation and publishing.

## Supported clients

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

First-time browser enrollment provides a review period when its hold is saved.
Setup then asks `Upload now? [Y/n]`: pressing Enter chooses Yes and uploads
immediately, so answer **n** to keep the review period. Check the deadline with
`hyp status`. See the
[first-sync review](./docs/TEAM_SETUP.md#review-before-the-first-upload)
before sharing recordings.

One person can sign in and sync on their own. To put more than one person in
an organization, [contact us](https://hypaware.ai/contact?utm_medium=readme)
and we'll set it up; there is no self-serve invite yet. See the
[team setup guide](./docs/TEAM_SETUP.md).

## Privacy controls

Recordings stay local until you configure Cloud sync or another export
destination. You control what is recorded, per folder:

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

This shows the daemon, your clients, and anything that needs attention. See
[troubleshooting](./docs/TROUBLESHOOTING.md).

## Uninstall

```sh
hyp leave                  # only if you signed in to HypAware Cloud
hyp daemon uninstall       # stop the daemon and detach every client
npm uninstall -g hypaware
rm -rf ~/.hyp              # delete all local recordings
```

Your clients' settings are restored on the way out. Copies already sent to
HypAware Cloud or exported to files are not affected.

## Documentation

Start at the [documentation index](./docs/README.md) for setup, clients,
queries and reports, Cloud and teams, privacy, configuration, and troubleshooting.
The [CLI reference](./docs/CLI_REFERENCE.md) lists complete command syntax and flags.
