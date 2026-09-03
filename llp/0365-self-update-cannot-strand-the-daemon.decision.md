# LLP 0365: A self-update cannot leave the daemon stale, dead, or on a version that will not start

**Type:** Decision
**Status:** Draft
**Systems:** Daemon, CLI
**Author:** Phil / Claude
**Date:** 2026-09-02
**Related:** LLP 0309 (the auto-update decision this extends: #mechanism, #cadence, #unstick-from-the-front, #cli-surface), LLP 0017 (#staged-restart-for-config-replacement: the exit-and-relaunch this bounds), LLP 0348 (#stale-heartbeat-is-unresponsive: how a wedged daemon reads from outside), hyparam/hypaware#610, hyparam/hypaware#1206
**Extends:** LLP 0309

> LLP 0309 settled that the daemon updates itself through `npm install -g`
> and a staged restart, and accepted two residual risks: a release whose
> entrypoint cannot run, and no rollback. Two field reports and one
> reproduction on a developer laptop showed a third failure it did not
> name, and showed that the accepted ones are reachable by ordinary
> customers. This document settles the additional guarantees: the disk is
> the verdict on an install, the running version is tracked separately from
> the installed one, a new version is proven to run before anything
> restarts onto it, the automatic lanes never exit for a relaunch nobody
> will perform, a restart exit is bounded, and a version that keeps failing
> to boot is rolled back and held.

## What went wrong {#evidence}

Observed on a global install under mise, 2026-09-01 and 2026-09-02, and
reproduced under the daemon's launchd environment:

- The `npm` on the daemon's PATH is a wrapper that runs the real npm and
  then `mise reshim`. `mise` is not on the service manager's PATH, so the
  command exits 127 with the new version already on disk. The updater
  trusted the exit code, recorded `apply_failed: npm_install_failed`, and
  never restarted. The daemon ran 1.28.0 for two days while the root held
  1.30.0.
- Every later probe compared the registry against the *disk* version, so
  the next day it cleared the error and reported nothing. `hyp update` said
  "up to date". The stale daemon had no path back except a reboot.
- The same end state is reached on plain node by a hand-typed
  `npm install -g hypaware` (the natural repair when auto-update is
  degraded), which every customer has.

Two more shapes were found in review rather than the field:

- A restart shutdown that never finishes (hyparam/hypaware#610: a client
  stream holding the gateway's `server.close()` open) is a daemon whose
  listeners are closed and whose process is alive. Clients are refused and
  the service manager relaunches nothing.
- `hyp daemon run --foreground` in a terminal or under a supervisor the
  updater does not know about: an applied update exits with the restart
  code into nothing.

<a id="disk-is-the-verdict"></a>
## The installed version decides `applied`, never npm's exit code

After `npm install -g`, the updater reads the version back off the global
root. Equal to the target: applied, whatever npm returned (a non-zero exit
is logged with npm's stderr tail as `self_update.npm_exit_ignored`, never
swallowed). Not equal: failed, with the exit code deciding only *which*
failure (`npm_install_failed` with the stderr tail, or
`version_not_installed` for an npm that returned 0 and changed nothing).
The check already existed for the second direction; this makes it total.

npm's stderr tail is recorded on `last_apply.detail` and in the failure
log line. A `npm_install_failed` with no detail was unanswerable from the
customer's files, and the most common plain-node cause (a root-owned
prefix, `EACCES`) is one line of npm's own output.

<a id="running-version-is-tracked"></a>
## The running version is tracked separately from the installed one

The daemon records the version it loaded at boot (`running_version` in
the updater's state file, written beside the cached `auto_update` flag).
The pass compares the registry against the disk to decide whether to
*install*, and the disk against the running version to decide whether to
*restart*. A root newer than the running daemon is an update whose install
is already done and whose restart is owed: the daemon lane exits for it,
and `hyp update` restarts through the service manager for it.

`hyp status` names the state: "1.30.0 is installed but the daemon is still
running 1.28.0; run 'hyp daemon restart'". The recorded running version is
believed only while the pid that wrote it is alive.

Fields are added to the updater's own state file, which no other subsystem
reads. No `DaemonStatus` field is minted (LLP 0348#heartbeat-is-derived
rejects that), and no config key.

<a id="preflight-then-hand-over"></a>
## A new version must run before anything restarts onto it

After the install lands, the updater runs the installed entrypoint
(`node <root>/bin/hypaware.js --version`, with the node the service unit
relaunches with) and requires it to print the target version. A failure
here is the residual risk LLP 0309 accepted, "a release broken so early
that the entrypoint itself cannot run", and it is caught while the old
daemon is still serving. The version it replaced is reinstalled on the
spot, the failed one is recorded as `held_version`, and nothing restarts.
A held version is never installed again; the hold clears when the registry
offers something newer, and is dropped from the state file at the same
time so it cannot re-engage if `latest` ever moves back to it.

The hold is recorded whether or not the reinstall of the previous version
succeeded, because the failed reinstall is the worse case: the root is
left holding the version that cannot start, the registry and the disk
then agree, and the only difference left on the machine is a daemon
correctly running older code, which is exactly the shape
#running-version-is-tracked acts on. A held version on the root suppresses
that restart, so the daemon keeps serving the code it already loaded and
the failure stays a status notice rather than a hand-over into a crash
loop.

<a id="restart-needs-a-supervisor"></a>
## The automatic lanes never exit for a relaunch nobody will perform

The daemon lane and the pre-boot lane apply only when a service manager
will relaunch the process: launchd (`XPC_SERVICE_NAME` equal to the
daemon's own label; presence alone is not enough, since macOS sets it in
terminals and GUI apps too) or systemd (`INVOCATION_ID`). Unsupervised, the
pass probes and records but installs nothing: installing without a
restart is the stale-daemon state above, and a restart exit is a dead
daemon. `hyp update` is exempt, because it restarts through the service
manager itself or says that it cannot.

The rollback of #rollback-after-failed-boots is gated the same way and for
the same reason: it is an apply that ends in a restart exit. Run
unsupervised (`hyp daemon run --foreground` in a terminal, which is what
the CLI suggests when a daemon will not start) it would downgrade the
operator's global install and then exit with nothing to relaunch it.

<a id="restart-exit-is-bounded"></a>
## A restart exit is bounded

When a supervised daemon shuts down for a restart, an unref'd timer forces
`process.exit` with the restart code after `RESTART_EXIT_DEADLINE_MS`
(two minutes, longer than the stop window of LLP 0343 and any single npm
budget). It exists for the case where shutdown never completes: the daemon
has stopped listening, clients are being refused, and the only thing
standing between them and a relaunch is a process that will not exit.
Unsupervised daemons get no forced exit, for the same reason they get no
automatic apply.

The clock starts *after* the in-flight reconcile pass settles, not at the
top of shutdown. Shutdown waits on that pass on purpose (LLP 0041): the
pass spawns `hyp backfill`, which is a multi-minute import by design, and
abandoning it orphans the child and loses the marker write. A deadline
that spanned the settle would cut exactly that short on a first run over
a large history, trading the wedge this bounds for a corruption the
existing shutdown order exists to prevent. Everything the wedge is about
(a client stream holding a source's `server.close()` open) happens after
the settle and is inside the deadline.

<a id="rollback-after-failed-boots"></a>
## Repeated failed boots on an installed version roll it back

This reverses LLP 0309#unstick-from-the-front's "no rollback", narrowly.
The pre-boot lane counts consecutive boots that never reached the kernel
(`boot_failures`, reset to 0 by any daemon whose kernel came up) while the
global root holds the version this updater last installed. At two, it
reinstalls the version that install replaced, holds the failed one, and
exits for the relaunch. One failed boot is counted and not acted on: the
first relaunch after a power loss finds the same frozen status file.

Only an update this updater applied is undone, and only while the root
still holds it. A hand-installed version that will not boot is the
operator's; a stuck boot on any other version says nothing about an
update. And only a version that has never booted here: `last_apply` does
not expire, so without that guard two failed boots from a bad config edit
months later would downgrade a version that has been serving the whole
time and then hold it. The daemon that came up on it already recorded
`running_version`, and that is the evidence the update is not what is
stopping the boot. The "next release fixes it" path of LLP 0309 is untouched: a held
version is skipped, the eager hourly probe keeps running, and a newer
release installs as before.

The machinery is one counter and one held version in a state file the
updater already owns, plus a second `npm install -g` through the same
apply function. That is the "too much machinery" LLP 0309 rejected, and it
is accepted here because the alternative was measured: a crash-looping
daemon refuses every attached client until a human notices.

## What this does not do {#non-goals}

- It does not make `npm install -g` succeed on a root-owned prefix. That
  install fails with `EACCES`, now with the reason in `last_apply.detail`
  and `hyp status`; the daemon stays on the old version and keeps serving.
- It does not make a *failed* rollback loud for long. The daemon is kept
  off the broken root, and `last_apply` and the log keep the diagnosis,
  but the `apply_failed` notice on `hyp status` is cleared by the next
  successful probe, the same way every other apply error already is. That
  clearing is LLP 0309's behavior and is left alone here.
- It does not drain client streams on shutdown (hyparam/hypaware#610).
  The forced exit bounds the damage; the drain is still the right fix.
- It does not change the probe cadence or the DarkWake starvation of
  hyparam/hypaware#1206.
