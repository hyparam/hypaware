# LLP 0386: A daemon that is serving dates its writes, whatever its boot verdict was

**Type:** Decision
**Status:** Accepted
**Systems:** Daemon, CLI
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-09-05
**Extends:** [LLP 0348](./0348-a-live-pid-is-not-a-live-daemon.decision.md)
(#heartbeat-is-derived: the derivation and the status file's schema are
unchanged; what changes is the writer, so that a daemon which boots `degraded`
fills the pair in and the derivation has something to read)
**Related:** [LLP 0351](./0351-a-daemon-that-never-reached-healthy-has-no-heartbeat.rfc.md)
(#option-persist-from-starting: the option space this chooses from, and the
half of the gap it leaves open), [LLP 0384](./0384-a-stopping-snapshot-that-stopped-ageing-is-a-stop-that-never-completed.decision.md)
(#an-underivable-age-stays-silent: the reading that inherited the silence and
named this as 0348's to settle), [LLP 0017](./0017-daemon-runtime.decision.md)
(the boot health aggregate, unchanged here);
hyparam/hypaware#1417, hyparam/hypaware#1409, PR #1414

> A daemon boots with one source unable to start, serves `degraded` for a week,
> and is then SIGKILLed mid-stop. Its snapshot freezes at `stopping`, and
> `hyp status` reports `overall: healthy` for as long as the machine stands
> there capturing nothing. The same daemon killed while serving is caught. The
> difference is not the fault: it is that a `degraded` boot never wrote down
> when it last wrote anything.

## Context {#context}

**One assignment, gated on the boot verdict.** `runDaemon` set `healthyAt` (and
the `healthyAtMs` that `persist()` recomputes `uptimeMs` from) in exactly one
place, immediately after the source snapshots were collected, and only when the
aggregate landed `state: 'healthy'`. A boot where any configured source failed
to start lands `degraded`, so it took neither: `healthyAt` stayed absent and
`uptimeMs` stayed at the `0` the first write recorded, for the whole run,
however long that run was and however well the tick loop ran.

**Two readers derive their answer from that pair, and both went quiet.**
LLP 0348#heartbeat-is-derived reads `healthyAt + uptimeMs` as the moment of the
last `persist()`, and returns null when `healthyAt` is absent. So for every
degraded-boot daemon: `daemon_heartbeat_stale` could not fire while it was
alive and wedged (LLP 0351's first evidence row), and LLP 0384's stalled-stop
reading of a terminal `stopping` snapshot could not fire after it was killed
mid-shutdown. The second is issue #1409's headline symptom surviving its own
fix for exactly this population, and it is silent in the worst way: `overall`
stays `healthy`, which is the field a monitor watches.

**The gap is in the writer, not in either reader.** LLP 0384
#an-underivable-age-stays-silent is right that an unreadable age is not a stale
one, and it named the widening as LLP 0348's to settle rather than its own.
LLP 0351 laid out the option space and decided nothing. What all of it comes
back to is that a pair which is read as "when did this daemon last write" was
being filled in only when the daemon's boot was clean, and those are different
questions.

## Decision {#decision}

<a id="serving-dates-the-write"></a>**The pair is dated when the daemon starts
serving, whatever the boot aggregate says.** `runDaemon` assigns it once,
unconditionally, at the same instant it did before: after the sources have been
started and the aggregate has been computed. A daemon whose boot landed
`degraded` therefore carries a `healthyAt` and an `uptimeMs` that advances with
every tick, exactly as a clean boot does, and every reader of the derivation
gets an answer for it.

That instant is the right one because it is when there is a loop to have a
heartbeat. Before it, `bootKernel` may still be running and the process has no
tick to be late for, which is the transient case LLP 0348 was right to exclude.
After it, the daemon is serving whatever it is called: the sources that did
start are bound and accepting, the tick loop runs, and `persist()` writes at the
end of every tick. Nothing about a failed sibling source stops any of that.

The boot verdict is untouched. `state` still reads `degraded` when a source
failed (LLP 0017), the `daemon.degraded` log event is still what boot emits, and
`hyp status` still reports what it reported. What changes is that the run is
dated, not what the run is called.

<a id="the-pair-keeps-its-name"></a>**`healthyAt` keeps its name and gains no
sibling.** The honest name for what it now records is "serving since", and
renaming it is still the wrong move. It is a field in the status file that
older builds wrote and other readers read, so a rename either mints the second
field LLP 0348#heartbeat-is-derived declined to mint, or leaves every existing
reader deriving null again for the population this decision is about. Nothing
reads the name as a health claim either: `state` carries the verdict, and both
`hyp status` and `hyp daemon status` report their own verdict over the file
rather than transcribing it (LLP 0348#stale-heartbeat-is-unresponsive). The
field's documented meaning is updated where it is defined, in `DaemonStatus`.

This is LLP 0351#option-persist-from-starting taken at the narrowest point that
answers the fault, and not its wider form: no new field, no second window
constant, no schedule that begins before the aggregate exists, and no second
meaning given to `startedAt` (0351#option-boot-phase-bound) or to the status
file's mtime (0351#option-file-mtime).

## What this does not settle {#not-settled}

**A boot that never returns from `bootKernel` still has no heartbeat.** That
daemon's snapshot is stuck at `starting`, it never reaches the assignment above,
and it is still exempt from both readers. It is LLP 0351's second evidence row
and it is a different question: there is no loop yet, so what would have to be
settled is how long a boot may legitimately take (a first-run plugin install, a
cold cache open) before not having finished is a fault. Untouched here.

**Compatibility with snapshots older builds wrote.** A `degraded` snapshot from
before this change still carries no `healthyAt`, still derives to null, and is
still read as an unreadable age rather than a stale one, exactly as
LLP 0384#an-underivable-age-stays-silent requires. This decision changes what
new runs write, and nothing about how a file that lacks the pair is read.

## Consequences {#consequences}

- A degraded-boot daemon that wedges is now visible from `hyp status` while it
  is alive (`daemon_heartbeat_stale`), and one killed mid-shutdown is visible
  once its snapshot passes the window (`daemon_exited_abnormally`). Both were
  structurally unreachable for it before.
- `hyp daemon status` prints a `healthyAt` line and a climbing `uptime_ms` for
  a degraded daemon, where it printed no `healthyAt` and a permanent `0`. That
  is the intended reading: the daemon has been up that long, and the line that
  says how it is doing is `daemon: degraded`, which is unchanged.
- The obligation LLP 0348#consequences left on future writers of `status.json`
  is now unconditional. A daemon that is serving must keep refreshing the pair
  whatever its own verdict on itself is, because a writer that stops refreshing
  while continuing to serve reports a fault that is not there, and one that
  never starts refreshing reports nothing at all.
