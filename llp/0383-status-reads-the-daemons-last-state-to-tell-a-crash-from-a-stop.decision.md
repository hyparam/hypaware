# LLP 0383: `hyp status` tells a crashed daemon from a stopped one by the snapshot's terminal state

**Type:** Decision
**Status:** Accepted
**Systems:** Daemon, CLI
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-09-05
**Extends:** [LLP 0348](./0348-a-live-pid-is-not-a-live-daemon.decision.md)
(#stale-heartbeat-is-unresponsive settled what a *live* pid has to prove; this
settles the one question left on the other side of that gate, which is what an
exited daemon's leftover snapshot may be read for)
**Related:** [LLP 0017](./0017-daemon-runtime.decision.md)
(#the-service-status-query-never-raises: the probe budget this stays inside),
[LLP 0300](./0300-daemon-control-channel.decision.md) (the stop transport that
never reaches the service manager, which is why the live facts cannot tell the
two apart), [LLP 0164](./0164-status-names-recent-clients-from-gateway-entrypoints.decision.md)
(#status-reads-it-from-the-status-file: the file this reads);
hyparam/hypaware#1391, PR #1388
**Extended-by:** [LLP 0384](./0384-a-stopping-snapshot-that-stopped-ageing-is-a-stop-that-never-completed.decision.md)
(#stopping-is-a-claim-with-an-expiry: a terminal `stopping` snapshot older than
the heartbeat window is a stop that never finished, and raises as a crash does)

> `installed, loaded, not running` reported `overall: healthy`. It is the state
> a daemon leaves when it dies under a unit the service manager is still
> holding, so a machine capturing nothing called itself healthy. It is also,
> exactly, the state left by `hyp daemon stop`. Two review rounds on PR #1388
> rejected flagging the triple on its own for that reason. This settles which
> signal separates them.

## Context {#context}

**The three live facts are the same on both sides.** `hyp daemon stop` writes a
control-file request ([LLP 0300](./0300-daemon-control-channel.decision.md))
and never calls the service manager, so the unit or plist stays exactly as it
was. `loaded` is a bootstrap fact on both platforms and is independent of
active/inactive: `LoadState === 'loaded'` on Linux, a `launchctl print` that
exits 0 on macOS. An operator's deliberate stop and an abnormal exit therefore
both land on `installed: true, loaded: true, running: false`. Nothing the
collector already had could tell them apart, which is why
[LLP 0348](./0348-a-live-pid-is-not-a-live-daemon.decision.md) closed the
live-pid half of this and left this half open.

**The daemon already records how its run ended.** `shutdown()` persists
`state: 'stopped'` into `status.json` as its last write before the process
leaves, and it is reached from every orderly stop: the control file, SIGTERM
from `systemctl --user stop` or `launchctl bootout`, and Ctrl-C on a foreground
run. A process that is killed, that dies of OOM, or that faults cannot make
that write, so its snapshot is frozen wherever it was serving.

## Decision {#decision}

<a id="the-signal-is-the-daemons-last-state"></a>**The crash-versus-stopped
signal is the snapshot's terminal state, not a service-manager exit code.**
When the service is installed, the probe reports it loaded, no process is
running, and a snapshot exists whose `state` is one a *serving* daemon writes
(`starting`, `healthy`, `degraded`), `hyp status` raises
`daemon_exited_abnormally` at `error` severity, which degrades `overall`
through the existing severity rule. A snapshot ending in `stopped` (or
`stopping`, where a shutdown demonstrably ran) raises nothing.

The rejected alternative is the one the issue proposed: systemd's `Result` /
`ActiveState` and launchd's `LastExitStatus`. Three counts against it. It is
two per-platform signals for one question, each with its own parse and its own
absent-on-this-host case, where the state is one field already in hand. It
would widen the runtime probe, which [LLP 0017](./0017-daemon-runtime.decision.md#the-service-status-query-never-raises)
keeps to "installed, and loaded?" precisely so it always answers. And it is
wrong at the edges the state gets right: a SIGTERM stop can land a non-zero
`LastExitStatus` while the daemon shut down perfectly, and the restart exit
code the staged-restart path uses
([LLP 0017](./0017-daemon-runtime.decision.md#staged-restart-for-config-replacement))
is a deliberate non-zero exit by design.

<a id="a-record-not-a-claim"></a>**The leftover snapshot is read as a record of
how the run ended, never as a claim about now.** LLP 0348 states that a
snapshot left by an exited daemon "ages forever and is a record of what
happened, not a claim about now", and gates the heartbeat check on a live
process for that reason. Nothing here weakens that: the claim about now comes
entirely from the live probe (loaded, no process), and the file supplies only
the past tense, which does not age. For the same reason the reported
`daemon.state` is left transcribing the file rather than being overwritten with
a verdict, as the heartbeat check overwrites it for a live process.

<a id="named-forwards"></a>**The serving states are named forwards.** The
condition is `state` in a stated set, not `state !== 'stopped'`. A snapshot
written by an older build, or one whose `state` field a hostile file replaced
with anything at all ([LLP 0164](./0164-status-names-recent-clients-from-gateway-entrypoints.decision.md#status-reads-it-from-the-status-file)),
is not evidence of a crash, and neither is no snapshot at all: an install that
has never run has no exit to call abnormal. All three stay silent.

## Consequences {#consequences}

- A daemon that died under a loaded unit is visible from `hyp status` alone:
  `overall: degraded` and a named diagnostic whose repair is
  `hyp daemon restart`, which reaches the daemon here because the service
  manager is still holding the unit (unlike the unloaded case in issue #1387).
- `hyp daemon stop` is unaffected and still reports `healthy`.
- The check adds no I/O: it reads the `status.json` the collector already read
  and spawns nothing.
- Any future writer of `status.json` inherits an obligation: `state: 'stopped'`
  is now the record that a shutdown completed, so a writer that skipped that
  final write while exiting cleanly would report a crash that did not happen.
