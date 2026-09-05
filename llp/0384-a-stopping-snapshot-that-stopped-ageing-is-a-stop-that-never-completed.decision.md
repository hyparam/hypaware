# LLP 0384: a `stopping` snapshot that has stopped ageing is a stop that never completed

**Type:** Decision
**Status:** Accepted
**Systems:** Daemon, CLI
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-09-05
**Extends:** [LLP 0383](./0383-status-reads-the-daemons-last-state-to-tell-a-crash-from-a-stop.decision.md)
(#the-signal-is-the-daemons-last-state read a terminal `stopping` as a stop that
ran; this settles the case that reading leaves open, where the stop began and
was killed before it could finish)
**Related:** [LLP 0348](./0348-a-live-pid-is-not-a-live-daemon.decision.md)
(#heartbeat-is-derived: the last-write time this reads, and #the-window: the
window it borrows), [LLP 0017](./0017-daemon-runtime.decision.md)
(#the-service-status-query-never-raises: the probe budget this stays inside);
hyparam/hypaware#1409, PR #1405

> LLP 0383 excluded `stopping` from the crash signal because "a shutdown
> demonstrably ran". PR #1405 then moved the `stopping` write to the first
> statement of `shutdown()`, so it now marks a shutdown that *started*, and
> anything killed across the whole of shutdown freezes the snapshot there. A
> machine whose daemon died mid-stop and never came back reports
> `overall: healthy` forever. This settles what separates a stop in progress
> from a stop that never finished.

## Context {#context}

**The exclusion outlived the window it was sized for.** When LLP 0383 was
written, `stopping` was persisted late in `shutdown()`, so a snapshot ending
there really did mean a shutdown had run nearly to its end. PR #1405 moved the
write to the first statement, before `maintenanceInFlight`,
`reconcileScheduler.settle()` (a multi-minute `hyp backfill` import by design),
`stopAllSources`, and `closeAllSinks`, precisely so that a long stop could not
be misread as a crash. The same move widened the other side: a SIGKILL anywhere
in that window (systemd's default `TimeoutStopSec`, which the generated units do
not bound; an OOM kill; an operator's `kill -9` after `hyp daemon stop` reports
its timeout) leaves `stopping` on disk permanently, and the collector reads it
as a completed stop.

**A stop in progress is never what the collector is looking at.** The branch is
gated on `!daemon.running`, and the parts of shutdown that take minutes are all
spent with the process alive, so the multi-minute case that PR #1405 protects
cannot reach here at all. What can reach here is a dead process next to a
`stopping` snapshot, which is either the last fraction of a second of an orderly
stop (the snapshot read before the process probe, the `stopped` write landing
between the two) or a stop that will never write another byte. The live facts
are identical in both. The only thing that differs is how long the snapshot has
been sitting there.

## Decision {#decision}

<a id="stopping-is-a-claim-with-an-expiry"></a>**A terminal `stopping` snapshot
is believed only while it is still fresh.** `stopped` is a record of something
that finished and is true forever; `stopping` is a claim that something is
underway, and a claim about an ongoing action expires when nothing goes on. When
the service is installed, the probe reports it loaded, no process is running,
and the snapshot's `state` is `stopping` and older than the window below,
`hyp status` raises `daemon_exited_abnormally` at `error` severity, the same
diagnostic the serving states raise in LLP 0383. Nothing changes for a fresh
`stopping` snapshot: it raises nothing, exactly as 0383 settled.

The diagnostic keeps that name rather than gaining one of its own. The three
live facts are the same, the machine is capturing nothing either way, and
`hyp daemon restart` is the way back from both, so a second kind would be a
second name for one condition. Only the sentence differs, because "exited
without shutting down" is untrue here: a shutdown began. The message states
what was read (the recorded state, and how long ago it was written) and not a
cause, as LLP 0383's does, because a kill, an OOM, and a fault leave the same
snapshot.

<a id="the-window-is-the-heartbeat-window"></a>**The window is the heartbeat
window, and the age is the heartbeat age.** The check reuses
`DAEMON_HEARTBEAT_STALE_MS` and `daemonHeartbeatAgeMs`, which derives the moment
of the last write from `healthyAt + uptimeMs`
([LLP 0348](./0348-a-live-pid-is-not-a-live-daemon.decision.md#heartbeat-is-derived));
`persist()` recomputes `uptimeMs` before every write, including the `stopping`
ones, so the age of a terminal `stopping` snapshot is the age of the shutdown's
last sign of life. No new status field, no new constant, no new config key, and
no I/O the collector was not already doing.

The same width is right because it is the same question: LLP 0348 sized it as
how long the snapshot may go unwritten before `hyp status` stops believing the
`state` recorded in it, and `stopping` is a recorded state. It is also far wider
than the only legitimate way to observe a dead process beside a `stopping`
snapshot, which is the sub-second read-order race above, so it absorbs that race
and ordinary clock skew rather than turning them into an error on a machine that
is stopping normally.

<a id="an-underivable-age-stays-silent"></a>**An age that cannot be derived
raises nothing.** LLP 0383 names the serving states forwards so that a missing
snapshot, an older build's snapshot, or a `state` field a hostile file replaced
is not evidence of a crash. This is that rule in the time dimension: when
`daemonHeartbeatAgeMs` returns `null`, because `healthyAt` is absent (a daemon
killed while stopping before it ever reached `healthy`) or `uptimeMs` is missing
or unusable, the snapshot stays silent. An unreadable age is not a stale one.

## Consequences {#consequences}

- A daemon killed mid-shutdown under a loaded unit is visible from `hyp status`
  once its snapshot goes stale, instead of never. `overall` degrades through the
  existing severity rule and the repair is `hyp daemon restart`, which reaches
  the daemon because the service manager is still holding the unit.
- A machine probed during a live `hyp daemon stop` raises nothing *from this
  branch*. The process is alive for all of it, so the `!daemon.running` gate is
  false, and at the instant it is not alive the snapshot is seconds old. A stop
  that outlasts the window with the process still alive is a different reading
  and not this one: `shutdown()` clears the tick before it waits, so the
  heartbeat check ([LLP 0348](./0348-a-live-pid-is-not-a-live-daemon.decision.md#stale-heartbeat-is-unresponsive))
  sees a frozen snapshot beside a live pid and raises `daemon_heartbeat_stale`.
  That predates this decision, which neither widens nor narrows it.
- An operator who force-kills a wedged stop is now told the stop did not
  complete. That is the intended reading rather than an over-report: the unit is
  still loaded, nothing is capturing, and a stop that reached its end writes
  `stopped` and stays silent forever, as before.
- The obligation LLP 0383 left on future writers of `status.json` gains a second
  clause. `state: 'stopped'` is the record that a shutdown completed, and now a
  writer that exits cleanly while leaving `stopping` behind reports an
  incomplete stop once the window passes, rather than never being noticed.
