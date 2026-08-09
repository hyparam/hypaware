# LLP 0017: Daemon Runtime and Installers

**Type:** Decision
**Status:** Active
**Systems:** Daemon
**Author:** Phil / Claude
**Date:** 2026-06-01
**Related:** LLP 0002, LLP 0011, LLP 0012, LLP 0014, LLP 0025
**Extended-by:** LLP 0181 (the fixed labels installed here live in a per-uid namespace, so a temp `HOME` does not sandbox them: `runServiceCommand` refuses to spawn `launchctl` / `systemctl` under the test runner)

> The primary daemon and how it is installed. Decomposed from the V1 finishing
> plan (`finish-v1` Phases 3–4, now tombstoned) and `hypaware-design.md`.

## The primary daemon

V1 introduces a primary daemon that boots the kernel and runs the steady state:

- boot the kernel and activate the configured plugin set
- **start all configured sources** ([LLP 0012](./0012-sources.spec.md)) and keep
  them running
- run the **sink export loop**: tick each configured sink on its cron schedule
  ([LLP 0014](./0014-sinks.spec.md))
- watch config and reload sources in place on change (same-shape reload, see
  [LLP 0004](./0004-activation-and-paths.spec.md#same-shape-reload)): this
  path covers **same-shape** changes only; config *replacement* takes the
  [staged restart](#staged-restart-for-config-replacement) below
- report health for `hypaware status` ([LLP 0009](./0009-cli-registry.spec.md#core-rendered-status))

The source registry and sink driver exist independently; the daemon is the
long-lived host that drives them together.

The boot health event the daemon writes to `daemon.log` is derived from the
**same aggregate** that `status.json` reports: a clean boot logs
`daemon.healthy`; a boot where any configured source failed to start logs
`daemon.degraded` (matching `state: "degraded"`), never `daemon.healthy`. The
event lists only the sources that actually came up; a source that failed is
surfaced separately (`failed_sources`) and is never reported as active. This
keeps monitoring keyed off `daemon.healthy` from reading a false positive on a
degraded boot.

## Staged restart for config replacement

When the operative config is **replaced wholesale**: remote config apply
([LLP 0025](./0025-remote-config-join-flow.spec.md#apply-semantics-staged-restart)),
or any change to the plugin set or installed plugin code, the daemon does
**not** reload in place. It persists the new config and **exits; the service
manager relaunches it** onto the new config.

Process restart is the only correct model here, not a simplification target:
install-on-config can upgrade a plugin that is already loaded, and Node's ESM
module cache cannot be invalidated, an in-process re-activate would run stale
code against the new config, defeating the artifact hash verification that
just passed. Restarting the process guarantees executed code = pinned artifact.

Consequences:

- The launchd / systemd user units **must be configured to relaunch on exit**
  (`KeepAlive` / `Restart=always`). This is now a requirement of the
  installers, not a nicety.
- A foreground (non-service) daemon cannot relaunch itself: it exits with a
  distinct restart exit code, **75** (`EX_TEMPFAIL`,
  `DAEMON_RESTART_EXIT_CODE`), and the invoker (smoke harness, dev shell)
  loops on that code.
- Same-shape reload ([LLP 0004](./0004-activation-and-paths.spec.md#same-shape-reload))
  remains the path for in-place source config changes; there are exactly two
  paths, distinguished by whether the plugin set / plugin code changed.

## Install: global package, then service manager

When daemon install is requested from `npx hypaware`, **install a persistent
global package first, then point the service manager at the stable global
binary**, never at an ephemeral npx path:

- **macOS**: a launchd user LaunchAgent
- **Linux**: a systemd user service

This is the decision recorded in [LLP 0002](./0002-v1-scope.decision.md#daemon-install).
Pointing the service at the stable global binary is what makes the installed
daemon survive across npx cache eviction and package updates.

### Reinstall waits for launchd release

`launchctl bootout` is **asynchronous**: launchd may still be tearing the
service down after the command returns. Reinstalling over a still-loaded agent
can bootstrap into a half-removed state and fail with
`Bootstrap failed: 5: Input/output error`. The macOS installer therefore, after
booting out an already-loaded agent, **polls `launchctl print` until launchd has
released the label** before writing the new plist and bootstrapping, and
**retries the transient EIO (`error 5`) a bounded number of times**. A genuine
load/config error (any non-EIO failure) is *not* retried: it surfaces
immediately as a `LaunchAgentError`. This makes "reinstall over a live agent"
reliable without masking real failures.

<a id="status-queries-never-raise"></a>
## The service status query never raises

`serviceDaemonStatus` answers "is the service installed, and is it loaded?" and
it **always answers**. Two rules make that true:

1. **No unit file on disk means no runtime probe.** Installedness is a file
   check under the caller's `homeDir`; when it comes back false there is
   nothing for the service manager to report on, so `launchctl` / `systemctl`
   is not spawned at all.
2. **An unusable service manager reports "not loaded", not an error.** A host
   with no `systemctl` on `PATH` (a container, a minimal image, WSL without
   systemd) or no user bus observably has nothing loaded. The probe failure is
   logged (`daemon.status.runtime_unavailable`, with `error_kind`) and the
   query returns `loaded: false`.

The reason is caller shape, not tidiness: every caller of this query branches
on `installed` inside a best-effort teardown or lifecycle path. `hyp leave` is
the sharp case - its contract is best-effort and idempotent
([LLP 0063](./0063-login-auto-provision-forward-sink.decision.md#prerequisites)),
so a *status* call that throws aborts the run between the config-layer teardown
and the attach reversal, leaving a half-disconnected machine. Raising here buys
nothing: a status query has no failure a caller could act on that
`loaded: false` does not already express.

Reporting is not the same as suppressing. Operations that *change* state
(install, start, restart, uninstall) still surface their failures as
`ServiceOpError` subclasses; only the query degrades.

## Attach is idempotent and reversible

Client attach/detach (Claude Code, Codex) performed during install must be
**idempotent and reversible**: re-running attach is a no-op, and detach fully
restores prior client settings. This is a V1 acceptance criterion
([LLP 0002](./0002-v1-scope.decision.md#v1-acceptance-criteria-summary)).
