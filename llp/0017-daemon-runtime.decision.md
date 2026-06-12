# LLP 0017: Daemon Runtime and Installers

**Type:** Decision
**Status:** Active
**Systems:** Daemon
**Author:** Phil / Claude
**Date:** 2026-06-01
**Related:** LLP 0002, LLP 0011, LLP 0012, LLP 0014, LLP 0023

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
  [LLP 0004](./0004-activation-and-paths.spec.md#same-shape-reload)) — this
  path covers **same-shape** changes only; config *replacement* takes the
  [staged restart](#staged-restart-for-config-replacement) below
- report health for `hypaware status` ([LLP 0009](./0009-cli-registry.spec.md#core-rendered-status))

The source registry and sink driver exist independently; the daemon is the
long-lived host that drives them together.

## Staged restart for config replacement

When the operative config is **replaced wholesale** — remote config apply
([LLP 0023](./0023-remote-config-join-flow.spec.md#apply-semantics-staged-restart)),
or any change to the plugin set or installed plugin code — the daemon does
**not** reload in place. It persists the new config and **exits; the service
manager relaunches it** onto the new config.

Process restart is the only correct model here, not a simplification target:
install-on-config can upgrade a plugin that is already loaded, and Node's ESM
module cache cannot be invalidated — an in-process re-activate would run stale
code against the new config, defeating the artifact hash verification that
just passed. Restarting the process guarantees executed code = pinned artifact.

Consequences:

- The launchd / systemd user units **must be configured to relaunch on exit**
  (`KeepAlive` / `Restart=always`). This is now a requirement of the
  installers, not a nicety.
- A foreground (non-service) daemon cannot relaunch itself: it exits with a
  distinct restart exit code and the invoker (smoke harness, dev shell) loops.
- Same-shape reload ([LLP 0004](./0004-activation-and-paths.spec.md#same-shape-reload))
  remains the path for in-place source config changes; there are exactly two
  paths, distinguished by whether the plugin set / plugin code changed.

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
