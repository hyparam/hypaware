# LLP 0017: Daemon Runtime and Installers

**Type:** Decision
**Status:** Active
**Systems:** Daemon
**Author:** Phil / Claude
**Date:** 2026-06-01
**Related:** LLP 0002, LLP 0011, LLP 0012, LLP 0014

> The primary daemon and how it is installed. Decomposed from the V1 finishing
> plan (`finish-v1` Phases 3–4, now tombstoned) and `hypaware-design.md`.

## The primary daemon

V1 introduces a primary daemon that boots the kernel and runs the steady state:

- boot the kernel and activate the configured plugin set
- **start all configured sources** ([LLP 0012](./0012-sources.spec.md)) and keep
  them running
- run the **sink export loop** — tick each configured sink on its cron schedule
  ([LLP 0014](./0014-sinks.spec.md))
- watch config and reload sources in place on change (same-shape reload, see
  [LLP 0004](./0004-activation-and-paths.spec.md#same-shape-reload))
- report health for `hypaware status` ([LLP 0009](./0009-cli-registry.spec.md#core-rendered-status))

The source registry and sink driver exist independently; the daemon is the
long-lived host that drives them together.

## Install: global package, then service manager

When daemon install is requested from `npx hypaware`, **install a persistent
global package first, then point the service manager at the stable global
binary** — never at an ephemeral npx path:

- **macOS** — a launchd user LaunchAgent
- **Linux** — a systemd user service

This is the decision recorded in [LLP 0002](./0002-v1-scope.decision.md#daemon-install).
Pointing the service at the stable global binary is what makes the installed
daemon survive across npx cache eviction and package updates.

## Attach is idempotent and reversible

Client attach/detach (Claude Code, Codex) performed during install must be
**idempotent and reversible** — re-running attach is a no-op, and detach fully
restores prior client settings. This is a V1 acceptance criterion
([LLP 0002](./0002-v1-scope.decision.md#v1-acceptance-criteria-summary)).
