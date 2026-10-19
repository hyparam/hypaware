# LLP 0545: An unreachable service manager is marked on the status answer

**Type:** Decision
**Status:** Accepted
**Systems:** Daemon, CLI
**Author:** neutral
**Date:** 2026-10-19
**Extends:** LLP 0017 (#status-queries-never-raise: the degraded answer says it
is degraded)
**Related:** issue #1406, issue #1400, issue #1393, LLP 0317

## Why {#why}

[LLP 0017#status-queries-never-raise](./0017-daemon-runtime.decision.md#status-queries-never-raise)
has `serviceDaemonStatus` answer "not loaded" when `systemctl` or `launchctl`
cannot run, and says no caller could act on that failure any differently.
The setup finale is one that can. After a failed install it restarts the
daemon only when the probe returns a pid, so a running daemon picks up the
config the run just wrote (#1400). A degraded probe also returns no pid, so a
host with a unit on disk, no user bus and a live daemon had its restart
withheld with nothing to say the probe never ran. The run read the same as one
where no daemon was running.

## Decision {#unreachable}

`serviceDaemonStatus` still never raises, and on a probe failure still reports
`loaded: false`, because that is what the host observably has. The answer now
also carries `unreachable: true`. A probe failure is either shape the dead
manager takes:

- the manager cannot be spawned at all (the throw LLP 0017 already catches);
- it spawns and answers with a failure instead of a state. `systemctl --user
  show` exits 0 for a unit it does not know (`LoadState=not-found`), so any
  nonzero exit, "Failed to connect to bus" above all, is a failure.
  `launchctl print` exits 113 for a service not in its domain, so any other
  nonzero exit is a failure.

The field appears only on those paths. A probe that got an answer, including
systemd's `not-found` and launchd's 113, and a unit that is not installed,
return no `unreachable` field at all.

## The finale records why it withheld the restart {#withheld}

On the failed-install path, when the probe comes back `unreachable`, the
finale still does not restart: the restart would drive the same manager that
just failed to answer. It records
`summary.daemonRestart = { skipped: true, dryRun: false, ok: false, withheld:
'service_manager_unreachable' }`. Nothing is printed. The install failure line
above it is already that fault's one diagnosis, and a second line would
return the doubled output #1393 removed.

## Checks {#checks}

The degraded-probe tests in `test/core/daemon.test.js` assert `unreachable:
true` alongside `loaded: false` for a manager that cannot be spawned, a
systemctl that exits 1 on a missing bus, and a launchctl print that exits with
something other than 113, and assert no `unreachable` for systemd's
`not-found` and launchd's 113. A finale test injects a probe that returns
the degraded state under a durable-bin install failure, and asserts no
restart, the `withheld` record, and no restart line on stderr.
