---
name: hypaware-reference
description: Explain what HypAware does, what it captures, how data flows, configuration and paths, connecting to HypAware Cloud, and local-only versus opt-in behavior. Use for product orientation and conceptual questions. Querying activity, quick recommendations, and report management belong to hypaware-query; capture audits and recording controls belong to hypaware-privacy.
user-invocable: false
---

# HypAware Reference

What HypAware is, what it captures, where its data goes, and what is local-only
versus opt-in. Data-format questions - dataset columns, JSON paths, SQL - belong
to the **hypaware-query** skill, which owns that ground entirely.

## What HypAware is

A modular logs and telemetry collector with a plugin-kernel architecture. It
captures the sources below into a local Iceberg-backed query cache that
everything else reads from.
What stays on the machine and what can leave is drawn under "What is opt-in".

## What it captures (sources)

`hyp setup` picks any subset of `claude`, `codex`, `raw-anthropic`, `raw-openai`,
and `otel`. For what is actually recording here, read it rather than infer it:
`hyp status` marks each client configured/attached, and on a centrally managed
host also splits them into what the org forwards and what stays local, so a
local addition is never invisible. `hyp privacy list` enumerates folder
markings.

The rule neither command states: folder scoping works only for `claude` and
`codex`, the sources that carry a working directory. `.hypignore` and `policy`
markings are a no-op for the raw proxies and OTEL.

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

## Config and paths

`HYP_HOME` defaults to `~/.hyp`; override by exporting it before invoking the
CLI or daemon.

- `<HYP_HOME>/hypaware-config.json` - active config, rewritten by `hyp setup`
- `<HYP_HOME>/hypaware/cache/` - local query cache (Iceberg-backed)
- `<HYP_HOME>/hypaware/sinks/<name>/outbox/` - failed export rows awaiting retry
- `<HYP_HOME>/hypaware/dev-telemetry/` - daemon self-telemetry
- `<HYP_HOME>/hypaware/logs/daemon.{out,err}.log` - daemon stdout / stderr
- `<HYP_HOME>/exports/` - local Parquet exports (when the local-fs sink is on)

Enrolling writes a separate central layer under `config-control/` (mode `0600`),
never into the local `hypaware-config.json`, so it augments an existing install
rather than replacing it.

## What is opt-in

A default install keeps everything on the machine. Two deliberate config
choices change that:

- **Enrolling with a sync server** (HypAware Cloud, unless
  `query.default_remote` or the `<name>` given to `hyp remote login <name>`
  points elsewhere, or the URL given to `hyp join`) turns on the
  `@hypaware/central` sink, which forwards cache partitions to it. `hyp remote login` (attended, and what the install wizard
  wraps) and `hyp join <url> <token>` (unattended / MDM) reach the same
  enrolled state.
- **Bundled plugins that are off by default**, several of which send content
  off-machine: the `s3` sink and the `completion-*` / `embedder-*` enrichment
  plugins. `hyp plugin list` shows what is active here.

Third-party plugins install from npm or git (`hyp plugin install`); there is no
curated HypAware registry.

## CLI and MCP

`hyp` is the CLI on this machine. `hyp mcp serve` exposes HypAware to an MCP
client over stdio, and a remote serves its own MCP endpoint; the tools a client
lists are the ones it can call. The skills name `hyp` commands and the MCP tools
for the same reads, so a client with only MCP can still follow them.

## Hand-offs

- Query recorded activity, get a quick recommendation, or save, upload, list,
  view, and act on reports or recommendations: **hypaware-query**.
- Generate a full report: **hypaware-report**.
- Audit captured content, change folder privacy, purge, or stop/resume recording
  this conversation: **hypaware-privacy**.

## Guardrails

- Treat `hyp --help`, `hyp <command> --help`, and `hyp status --json` as the
  authoritative source for exact commands, flags, and state on this install.
  Use this skill for orientation and conceptual answers only.
- Never invent flags or promise a capability you cannot confirm on this
  install. When unsure, run the relevant `--help` before answering.
