# LLP 0521: A supervised port conflict retries once a minute

**Type:** Decision
**Status:** Accepted
**Systems:** Daemon, CLI
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-10-17
**Extends:** [LLP 0017](./0017-daemon-runtime.decision.md) (the service
manager relaunches the daemon whenever it exits; this paces the relaunch for
one failure class without touching the service definitions) and
[LLP 0383](./0383-status-reads-the-daemons-last-state-to-tell-a-crash-from-a-stop.decision.md)
(#the-signal-is-the-daemons-last-state: the boot-failure snapshot is now also
read while the failed process is still alive)
**Related:** [LLP 0114](./0114-gateway-default-listen-port-fixed.decision.md)
(a configured `listen` fails loudly instead of falling back),
[LLP 0309](./0309-kernel-auto-update.decision.md)
(#unstick-from-the-front: the pre-boot updater lane each relaunch passes
through), [LLP 0038](./0038-split-query-export-daemon-from-gateway.rfc.md) (the
gateway/processor split); hyparam/hypaware#137, hyparam/hypaware#1501

## Context {#context}

A gateway whose configured `listen` port is held by another process fails its
boot with `EADDRINUSE` and exits. launchd (`KeepAlive`, default 10s throttle)
and systemd (`Restart=always`, `RestartSec=5`) relaunch it at once, so a
conflict that lasts days becomes a boot every 5 to 10 seconds for days (#137
observed 161 daemon pids in 30 minutes). The processing child is not part of
this: its source-start failures are caught and served degraded, and its exits
are restarted by the gateway with a backoff that already caps at 30s.

The issue's triage (2026-10-06) settled the product choice: recover on its own
once the conflict clears, allow at most one new boot per 60s while it lasts,
let an explicit restart try at once, keep the failure visible in `hyp status`
and the logs, never claim health while waiting, and add no config knob and no
persisted attempt history.

## Decision {#decision}

### Pacing {#pacing}

When `hyp daemon run` is running under a service manager
(`detectSupervisor`) and its boot fails on an address in use, it holds the
failed process for `BIND_RETRY_INTERVAL_MS` (60s) and then exits 1 into the
manager's relaunch. Every other ending is unchanged: other boot failures exit
at once, and an unsupervised foreground run fails fast because nothing
relaunches it.

The wait happens after the failed boot's `stop` has run, so what waits is one
timer: no listener, no processing child, no pid file, no heartbeat. SIGTERM or
SIGINT ends the wait at once with exit 0, which is what `hyp daemon stop`
(bootout / `systemctl stop`) and `hyp daemon restart` (`kickstart -k` /
`systemctl restart`) deliver, so stop stays a stop and restart is an immediate
retry. One process per service means one retry at a time.

Retrying by exiting, rather than re-booting the kernel inside one long-lived
process, keeps every attempt a fresh process: the pre-boot updater lane
(LLP 0309) and its stuck-boot re-probe and rollback count see each one, and no
plugin state from a failed activation survives into the next.

### Owner probe {#owner-probe}

On that failure the gateway asks once who holds the port: `/proc/net/tcp{,6}`
plus `/proc/<pid>/fd` on Linux, `lsof -F pctn` on macOS, within a 1s budget
enforced on the whole probe (not only between reads) and a cap on fd entries
read. Only a listener that could refuse a bind on the failing address counts:
an IPv4 listener never refuses a specific IPv6 bind. It reports a pid and an
executable name, never a command line. A missing probe, a permission denial,
a race, a timeout, or candidate listeners held by more than one process reads
as "the owner is unknown", because naming the wrong process is worse than
naming none. The answer is appended to the boot-failure message,
so the persisted `boot_failed` warning, the `daemon.boot_failed` log line and
the service's stderr all carry it. The probe only reads: it never signals the
owner, never binds elsewhere, and never edits config.

### Status {#status}

While the failed process waits, the service probe reports a live pid whose own
snapshot is `degraded` with the boot-failure warning. `hyp status` raises
`daemon_boot_failed` (error, so `overall` is degraded) quoting the bounded
reason, with `hyp daemon restart` as the repair. Once the process exits, the
existing `daemon_exited_abnormally` reading applies until the relaunch.

## Alternatives {#alternatives}

- **Supervisor throttling** (`ThrottleInterval=60`, `RestartSec=60`): slows
  every relaunch, including the deliberate exit-75 config restart; reaches
  existing installs only after a reinstall; and changes the rendered service
  definitions.
- **In-process retry loop:** keeps one process alive across attempts, which
  bypasses the pre-boot updater lane and risks carrying a failed activation's
  state into the next boot.
- **Park after N failures:** rejected by the triage; a conflict that clears
  must recover without an operator.
