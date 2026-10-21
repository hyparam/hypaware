# Integrations

HypAware records sessions from the AI agents your team runs and connects to the
tools around them. `hyp setup` detects the agents installed on a host and offers
to record them; `hyp attach <client>` adds one later. Each integration's page
covers what is recorded, how to set it up, and its limits.

Setup also installs HypAware's skills in each recorded agent that has a skills
directory, so the agent can query its own history. See
[clients and history](CLIENTS.md) for attaching, history imports, and detaching
in general.

## Status

| Status | Meaning |
| --- | --- |
| Supported | Built and maintained by the HypAware team and offered in `hyp setup`. |
| Beta | Built by the HypAware team and usable today, but it depends on an interface that may change. Behavior can change between releases. |
| Community | Built and maintained outside the HypAware team, usually as a [plugin](PLUGIN_AUTHORING.md). No community integrations are listed yet. |

**Runs on** is where the agent or tool itself runs. HypAware runs on a host you
control: install it next to an agent on a server or CI runner, and for cloud
agents the collection route depends on the provider. Codex Cloud uses your
existing local login; the tested Claude Code Cloud recipe runs the
collector inside the cloud environment.

## Coding agents

| Integration | Status | Runs on | How HypAware records it | Backfill | Setup id |
| --- | --- | --- | --- | --- | --- |
| [Claude Code](integrations/claude-code.md) | Supported | Your machine, a server, or CI | Claude Code's OpenTelemetry events, plus transcript recovery every five minutes | Yes | `claude` |
| [Claude Desktop](integrations/claude-desktop.md) | Supported, macOS | Your machine | Claude Code sessions run in the desktop app, imported from local transcripts every five minutes | Yes | `claude-desktop` |
| [Codex](integrations/codex.md) | Supported | Your machine, a server, or CI | Codex CLI and desktop session files, imported every minute; gateway capture is optional | Yes | `codex` |
| [VS Code (GitHub Copilot)](integrations/copilot.md) | Beta | Your machine | Completed Local and Agent Host chat/model/tool spans from VS Code's native databases, imported every minute; local single-folder workspaces only | Within native retention | `copilot` |
| [Cursor](integrations/cursor.md) | Supported | Your machine | Cursor hooks, then a read-only read of Cursor's own session store, for the editor and CLI; no token usage | Yes | `cursor` |
| [OpenCode](integrations/opencode.md) | Supported | Your machine | A managed OpenCode plugin sends live session snapshots, for the CLI and desktop app | Yes | `opencode` |
| [Pi](integrations/pi.md) | Supported | Your machine | A managed Pi extension sends completed entries, plus session recovery every five minutes | Yes | `pi` |
| [Factory Droid](integrations/droid.md) | Supported | Your machine, a server, or CI | Native hooks signal local transcript changes, plus recovery every five minutes; no billed token usage or cost | Yes | `droid` |

## Cloud agents

For Anthropic-managed sessions, see the
[Claude Code Cloud recipe](integrations/claude-code-cloud.md), tested with
HypAware 1.42.0. It includes setup, session startup, and upload after replies.

| Integration | Status | Runs on | How HypAware records it | Backfill | Setup id |
| --- | --- | --- | --- | --- | --- |
| [Codex Cloud](integrations/codex-cloud.md) | Beta | OpenAI's cloud | Hosted Codex coding chats, checked every five minutes through your local Codex login | Yes | `codex-cloud` |
| [ChatGPT Work](integrations/codex-cloud.md#choose-during-setup) | Beta | OpenAI's cloud | Work web and mobile chats through the same collector; only under **Customize** | Yes | `chatgpt-work` |

## Agent harnesses

| Integration | Status | Runs on | How HypAware records it | Backfill | Setup id |
| --- | --- | --- | --- | --- | --- |
| [OpenClaw](integrations/openclaw.md) | Supported | Your machine or a server | Anthropic and OpenAI model calls through the local gateway, plus a transcript sweep every five minutes | Yes | `openclaw` |
| [Hermes Agent](integrations/hermes.md) | Supported | Your machine or a server | Hermes's local state database, read-only, polled every 60 seconds | Yes | `hermes` |
| [LangGraph](integrations/langgraph.md) | Beta | Your machine, a server, or CI | JavaScript or Python callbacks write a bounded local queue; the daemon collects completed events, including after an outage; only under **Customize** | No checkpoint import; queued-event recovery | `langgraph` |

## Software factories and CI

| Integration | Status | Runs on | How HypAware records it | Backfill | Setup id |
| --- | --- | --- | --- | --- | --- |
| [CI and headless deployment](integrations/ci-and-headless.md) | Supported | CI runners, containers, and servers | The collector runs without a browser or service manager on factory hosts, containers, and CI runners such as GitHub Actions, and records the agents the job runs | No | `hyp join --no-daemon` |

## Local models

| Integration | Status | Runs on | How HypAware records it | Backfill | Setup id |
| --- | --- | --- | --- | --- | --- |
| [Ollama](integrations/ollama.md) | Supported | Your machine | Native chat and generate requests from the Ollama CLI and Python SDK, routed through a local capture host; only under **Customize** | No | `ollama` |

## Data sources

| Integration | Status | Runs on | How HypAware records it | Backfill | Setup id |
| --- | --- | --- | --- | --- | --- |
| [GitHub](integrations/github.md) | Supported | GitHub's cloud | Issue, pull request, commit, file, review, and comment metadata, polled into the activity graph | Yes | `hyp github login` |
| [OpenTelemetry](integrations/opentelemetry.md) | Supported | Your machine | Logs, traces, and metrics from any OTLP/JSON exporter, stored as raw rows, not sessions | No | `otel` |

## Query and export

| Integration | Status | Runs on | What it does | Setup |
| --- | --- | --- | --- | --- |
| [MCP clients](MCP.md) | Supported | Your machine | `hyp mcp serve` gives any MCP client your recorded history over stdio | `hyp mcp serve` |
| [Exports](CONFIGURATION.md#choose-an-export-destination) | Supported | Your machine | Scheduled Parquet exports under `<HYP_HOME>/exports`, or a custom sink such as Amazon S3 | `--export local-parquet` |

## Request an integration

To ask for an agent or tool that is not listed here, open an issue at
[hyparam/hypaware](https://github.com/hyparam/hypaware/issues). To build one
yourself, see [plugin authoring](PLUGIN_AUTHORING.md).
