---
name: hypaware-reference
description: Explain what HypAware is, what it captures, how its data flows, config and paths, joining a fleet, and what is local-only versus opt-in. Use for product orientation - "what is HypAware", "what can it capture", "how do I detach codex", "how do I join a server", "where does my data go". For querying recorded data use hypaware-query; for graph questions hypaware-graph; for team token analysis hypaware-ai-usage-report.
---

# HypAware Reference

What HypAware is, what it captures, where its data goes, and what is local-only
versus opt-in. Data-format questions - dataset columns, JSON paths, SQL - belong
to the **hypaware-query** skill, which owns that ground entirely.

## What HypAware is

A modular logs and telemetry collector with a plugin-kernel architecture, part
of HypStack, an open-source stack for AI observability. It captures the sources
below into a local Iceberg-backed query cache that everything else reads from.
What stays on the machine and what can leave is drawn under "What is opt-in".

## What it captures (sources)

`hyp init` picks any subset of `claude`, `codex`, `raw-anthropic`, `raw-openai`,
and `otel`. For what is actually recording here, read it rather than infer it:
`hyp status` marks each client configured/attached, and on a fleet-managed
host also splits them into what the fleet forwards and what stays local, so a
local addition is never invisible. `hyp policy list` enumerates folder
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

- `<HYP_HOME>/hypaware-config.json` - active config, rewritten by `hyp init`
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

- **Enrolling with a central server** turns on the `@hypaware/central` sink,
  which forwards cache partitions to it. `hyp remote login` (attended, and what
  the install wizard wraps) and `hyp join <url> <token>` (unattended / MDM)
  reach the same enrolled state.
- **Bundled plugins that are off by default**, several of which send content
  off-machine: the `s3` sink and the `completion-*` / `embedder-*` enrichment
  plugins. `hyp plugin list` shows what is active here.

Third-party plugins install from npm or git (`hyp plugin install`); there is no
curated HypAware registry.

## Hand-offs

- Query or inspect recorded data - use the **hypaware-query** skill.
- Team token usage, cost, and improvement analysis - use the
  **hypaware-ai-usage-report** skill.
- Review captured history before it first syncs to an org server - use the
  **hypaware-privacy** skill.
- Opt a folder out of recording - `hyp ignore <path>` writes a committable
  `.hypignore`; `hyp policy set <path> ignore` marks it machine-local instead,
  with no repo breadcrumb. To pause only this conversation, `/hypaware-ignore`.
- "Is it working?" or diagnose a problem - `hyp status` (add `--json` for the
  stable shape).

## Guardrails

- Treat `hyp --help`, `hyp <command> --help`, and `hyp status --json` as the
  authoritative source for exact commands, flags, and state on this install.
  Use this skill for orientation and conceptual answers only.
- Never invent flags or promise a capability you cannot confirm on this
  install. When unsure, run the relevant `--help` before answering.
