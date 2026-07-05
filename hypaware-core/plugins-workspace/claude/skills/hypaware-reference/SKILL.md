---
name: hypaware-reference
description: Explain what HypAware is, what it captures, how its data flows, which hyp command to run, config and paths, joining a fleet, and the activity graph. Use for product and CLI orientation - "what is HypAware", "what can it capture", "how do I detach codex", "how do I join a server", "where does my data go". For querying recorded data use hypaware-query; for analyses use the hypaware-ai-*-report skills.
---

# HypAware Reference

Orientation for questions about HypAware itself: what it is, what it captures,
how data moves, and which command does what. This is a conceptual map, not a
flag reference. For the exact flags and behavior on *this* install, run
`hyp --help` and `hyp <command> --help`; for "is it working right now?" run
`hyp status` (add `--json` for the stable machine shape). Those live sources
win over anything summarized here.

Do not answer data questions from this skill. It names no dataset columns, JSON
paths, or SQL - that all lives in the **hypaware-query** skill, which is the
single source of truth for the recorded data format.

## What HypAware is

A modular logs and telemetry collector with a plugin-kernel architecture. It
captures conversations and traffic from local AI clients (Claude Code, Codex),
raw Anthropic / OpenAI API traffic, and OpenTelemetry logs / traces / metrics
into a local query cache and optional Parquet exports.

It runs fully local by default, with no central server required. A host can
optionally join a fleet (`hyp join`) to forward its recordings to a central
HypAware server. HypAware is part of HypStack, an open-source stack for AI
observability.

## What it captures (sources)

Any subset of these can be enabled at `hyp init`:

- `claude` - Claude Code conversations
- `codex` - Codex conversations
- `raw-anthropic` - raw Anthropic API traffic
- `raw-openai` - raw OpenAI API traffic
- `otel` - OpenTelemetry logs / traces / metrics

A `.hypignore` file opts a directory subtree out of recording, but it only
gates the `claude` and `codex` pathways (they supply a working directory to
match against). It is a no-op for the `raw-anthropic` / `raw-openai` proxy and
OTEL sources. See the **hypaware-ignore** and **hypaware-unignore** skills for
managing it, or `hyp ignore --help`.

## How data flows (invariants)

- **Capture always lands in the local cache first.** Every source writes only
  to the intrinsic Iceberg-backed local query cache. Storage and query are
  intrinsic to the kernel, not plugin-provided.
- **Sinks are export targets, not the write path.** Configured sinks (for
  example local-fs Parquet) receive *scheduled exports out of* the cache.
  Sources never see sinks.
- **One source, one table.** Each dataset table has exactly one producer and is
  named after it.
- **Config is explicit.** The written config enumerates the chosen plugins;
  there is no implicit "use defaults" mode.

## CLI command map

The CLI is bound to both `hyp` and `hypaware`. Core commands:

- `hyp status` - health snapshot: config path, daemon state, active plugins,
  sources/sinks, attach state, retention, cache size, recent errors,
  diagnostics with repair lines. The entry point for any "is it working?"
  question.
- `hyp init` - interactive walkthrough (or `--yes` non-interactive) that picks
  sources, an export strategy, and a retention window, writes the config,
  installs the daemon, and attaches selected clients.
- `hyp query` - SQL over the local cache (and remote hosts via `--remote`).
  Use the **hypaware-query** skill for this.
- `hyp graph` - build and walk the activity graph: `project` materializes a
  node/edge graph from captured data, `compact` folds duplicate rows, and
  `neighbors <node>` walks out from a seed node. Contributed by the default-on
  `@hypaware/context-graph` plugin.
- `hyp attach` / `hyp detach` - wire a client (`claude`, `codex`) into the
  local gateway, or remove only HypAware-managed settings. Idempotent and
  reversible. `hyp unattach` is an alias of `detach`.
- `hyp ignore` / `hyp unignore` - write or remove a `.hypignore` for a folder.
- `hyp daemon` - lifecycle for the persistent user daemon: `install`, `start`,
  `status`, `restart`, `stop`, `uninstall` (launchd on macOS, systemd `--user`
  on Linux).
- `hyp join` - enroll the host in a centrally-managed fleet.
- `hyp remote` - manage remote HypAware query targets (`add`, `login`, `list`).
- `hyp backfill` - import client history from registered backfill providers.
- `hyp sink` - manage sink instances (`force`, `maintain`).
- `hyp config` - inspect or validate the config.
- `hyp mcp` - serve this host's read verbs as an MCP server over stdio.
- `hyp smoke` - run a hermetic smoke flow.
- `hyp version` - print the version.

`logs`, `metrics`, and `traces` commands are contributed by the `@hypaware/otel`
plugin, so they appear only when it is enabled. Plugin-contributed commands
vary by install - trust `hyp --help` for the live inventory, and
`hyp <command> --help` for exact subcommands and flags.

## Config and paths

`HYP_HOME` defaults to `~/.hyp`; override by exporting it before invoking the
CLI or daemon.

- `<HYP_HOME>/hypaware-config.json` - active config, rewritten by `hyp init`
- `<HYP_HOME>/hypaware/cache/` - local query cache (Iceberg-backed)
- `<HYP_HOME>/hypaware/sinks/<name>/outbox/` - failed export rows awaiting retry
- `<HYP_HOME>/hypaware/dev-telemetry/` - daemon self-telemetry
- `<HYP_HOME>/hypaware/logs/daemon.{out,err}.log` - daemon stdout / stderr
- `<HYP_HOME>/exports/` - local Parquet exports (when the local-fs sink is on)

`hyp join` writes a separate central-enrollment layer under `config-control/`
(mode `0600`), never into the local `hypaware-config.json`, so joining augments
an existing install rather than replacing it.

## Availability

Available on every install (default flow, no extra config):

- Local capture for Claude Code, Codex, raw Anthropic API, raw OpenAI API, and
  OTEL logs / traces / metrics.
- Local query over captured messages, logs, traces, and metrics.
- The activity graph: `hyp graph project` builds a node/edge graph from captured
  data and `hyp graph neighbors` walks it (also queryable via `hyp query`).
- Local Parquet export.
- Claude Code and Codex attach (idempotent, reversible).
- A persistent macOS / Linux user daemon.

Opt-in (enabled by explicit config, not the default flow):

- **Central forwarding.** `hyp join <url> <token>` enrolls the host and turns on
  the `@hypaware/central` sink, which forwards cache partitions to a central
  HypAware server. It is fine to explain how to join a server; the receiving
  server is a separate deployment the user points the host at.
- **Additional bundled plugins** (for example an S3 sink and AI-enrichment
  plugins). Some are opt-in specifically because enabling them lets captured
  content leave the machine, so they must be a deliberate config choice. Trust
  `hyp --help` and the written config for the live set on this install.

Not provided by the CLI: there is no first-party plugin registry. Third-party
plugins can be installed from npm or git, but HypAware does not curate a
registry.

## Hand-offs

- Query or inspect recorded data - use the **hypaware-query** skill.
- Run an analysis (spend, adoption, security, improvement) - use the
  **hypaware-ai-spend-report**, **-adoption-report**, **-security-report**, or
  **-improvement-report** skills.
- Opt a folder out of recording - use **hypaware-ignore** /
  **hypaware-unignore**, or pause just the current session with the
  `/hypaware-ignore` and `/hypaware-unignore` skills.
- "Is it working?" or diagnose a problem - `hyp status` (with `--json` for the
  stable shape); its `diagnostics:` section carries `repair:` lines to run.

## Guardrails

- Treat `hyp --help`, `hyp <command> --help`, and `hyp status --json` as the
  authoritative source for exact commands, flags, and state on this install.
  Use the map above for orientation and conceptual answers only.
- Never invent flags or promise a capability you cannot confirm on this
  install. When unsure, run the relevant `--help` before answering.
- Do not name dataset columns, JSON paths, or SQL here. Defer every data-format
  detail to the **hypaware-query** skill.
