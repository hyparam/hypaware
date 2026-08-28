# LLP 0317: A daemon install that returns success has a running daemon

**Type:** Decision
**Status:** Accepted
**Systems:** Daemon
**Generated-by:** neutral
**Date:** 2026-08-26
**Related:** LLP 0017 (#install-global-package-then-service-manager: the installers this tightens, #reinstall-waits-for-launchd-release: the other half of the same reinstall race), LLP 0181 (the adapter seam this is tested through), LLP 0206 (uninstall's cascade, the symmetric case)

> Extends [LLP 0017 #install-global-package-then-service-manager](./0017-daemon-runtime.decision.md#install-global-package-then-service-manager).
> Registering the service with the service manager is not the same as having a
> daemon. Both installers now force the spawn and prove a pid before they
> return, so "install succeeded" and "the daemon is up" are the same statement.

## Context {#context}

LLP 0017 made reinstall-over-a-live-agent reliable on macOS: bootout, poll until
launchd releases the label, write the plist, bootstrap, retry the transient EIO.
It stopped there, on the assumption that `RunAtLoad` in the plist finishes the
job.

It does not always. When the same label is bootstrapped seconds after booting out
an instance that just exited, launchd can register the job and leave the initial
`RunAtLoad` spawn pended indefinitely. `launchctl print` shows the service, so
every "is it loaded" probe says yes, while `state = not running`, `runs = 0`,
`pended nondemand spawn = speculative`. `KeepAlive` does not rescue it: it
applies to a process that has run and exited, and this one never ran.

The installer neither forced the spawn nor checked for a pid, so `hyp daemon
install` printed success over a machine with no daemon (#1036). That is worse
than an ordinary silent failure, because attach is already in place: every
proxy-attached client (Codex, OpenClaw, Claude Code) keeps pointing at
127.0.0.1:18521 and sees connection refused on every request, with no error
anywhere naming HypAware. The walkthrough and join lanes hid it because they
chain a restart after install; bare `hyp daemon install`, the command the upgrade
docs tell you to run, is the exposed path.

systemd is not immune to the general shape either. `systemctl --user restart`
exits 0 on a `Type=simple` unit as soon as systemd accepts the job, which is not
a promise that a process is running.

## Decision {#decision}

<a id="install-means-running"></a>**D1: an install returns only once the service
is observably running.** "Loaded" is not the success condition; a pid is. Both
installers poll the service manager's own status query for a running process
after they start it, and raise their platform `ServiceOpError` subclass when none
appears within a bounded wait. An install that cannot produce a running daemon
fails, loudly, at the moment the user can still act on it.

<a id="kickstart-then-verify"></a>**D2: macOS kickstarts the label it just
bootstrapped, unconditionally.** `launchctl kickstart <target>` is the only thing
that clears a pended speculative spawn, and it is a no-op when `RunAtLoad`
already fired, so there is nothing to gain from probing first and a race to lose.
It is `kickstart` and never `kickstart -k`: the job may already be running, and
`-k` would kill the process the install just started, dropping every in-flight
proxied stream (the failure LLP 0181 was written about). The kickstart's own exit
code is not the gate. D1's pid check is; a kickstart that reports an error over a
job that is demonstrably running is not a failed install, and its stderr is
carried on the error only when no pid ever appeared.

<a id="one-retried-start"></a>**D3: systemd spends exactly one retried `start`.**
When `restart` leaves no MainPID, the unit gets a single `start` (a no-op on an
already-active unit) and one more bounded poll before the install fails. One
retry, not a loop: a unit that will not come up on two explicit starts is a
broken unit, and `Restart=always` already owns recovery for anything transient.

<a id="dormant-stays-dormant"></a>**D4: `RunAtLoad: false` is honored.** The flag
is the caller asking the installer not to start the job, so macOS skips D1 and D2
entirely for it: no forced spawn, and no pid demanded. It is not a claim that the
job stays dormant - `KeepAlive` (this installer's default) keeps a loaded job
running whatever `RunAtLoad` says, and that stays launchd's call, not the
installer's. What D4 rules out is the installer overriding the one thing the flag
asks of it.

## Consequences {#consequences}

- `hyp daemon install` is slower to fail and no slower to succeed: the pid is
  normally there on the first poll.
- A daemon that crashes on boot now fails the install instead of reporting
  success. That is the intended trade. The user is told at install time rather
  than discovering it through a coding agent that stopped working.
- Any test that drives either installer through its adapter seam must model the
  service as *running* after a successful start, not merely loaded. A fake whose
  status probe always answers "not loaded" now describes a failed install, which
  is what it always physically described.
