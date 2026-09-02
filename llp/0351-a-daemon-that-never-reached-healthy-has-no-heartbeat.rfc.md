# LLP 0351: A daemon that never reached `healthy` has no heartbeat to be late for

**Type:** RFC
**Status:** Draft
**Systems:** Daemon, CLI
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-09-02
**Related:** [LLP 0348](./0348-a-live-pid-is-not-a-live-daemon.decision.md)
(#heartbeat-is-derived, #stale-heartbeat-is-unresponsive: the check this asks
to widen), [LLP 0017](./0017-daemon-runtime.decision.md) (the boot-time
aggregate `state` is computed from), [LLP 0164](./0164-status-names-recent-clients-from-gateway-entrypoints.decision.md)
(#status-reads-it-from-the-status-file: the file this reads);
hyparam/hypaware#1183, hyparam/hypaware#1003, PR #1181

> LLP 0348 made `hyp status` stop repeating a wedged daemon's recorded
> `healthy`, by reading the heartbeat the status file already carries. The
> check has a stated domain: a snapshot that never reached `healthy` yields no
> heartbeat, "a daemon still booting has no heartbeat to be late for". That
> sentence is honest about a transient state and wrong about a permanent one.
> A daemon that wedges inside `bootKernel`, or that boots `degraded` and then
> stops ticking, is the same fault in the same shape, and it is exempt from the
> check forever. Closing that gap is not a patch: every remedy available inside
> the current design was foreclosed by 0348 itself. This document states the
> gap, the measurements, and the option space. It decides nothing.

## Context {#context}

`daemonHeartbeatAgeMs` (`src/core/daemon/status.js`) derives the moment of the
daemon's last status write as `healthyAt + uptimeMs`, and returns `null` when
`healthyAt` is missing or unusable. `healthyAt` is set in exactly one place
(`src/core/daemon/runtime.js`), after the source snapshots are collected and
only when the boot aggregate lands `healthy`:

- a boot where any configured source failed to start writes `state: 'degraded'`
  and never sets `healthyAt`
- a boot that never returns from `bootKernel` leaves `state: 'starting'`, with
  no `healthyAt` and no `uptimeMs`

In both shapes the process is alive, it owns its pid, and its listeners are
bound exactly as in the #1003 brownout. The heartbeat derivation returns
`null`, so the collector raises nothing.

## Evidence {#evidence}

Measured against `master` at 81d6fe7c, with a live pid and a snapshot six hours
stale (the same three shapes recorded in #1183 at PR #1181's head 2f2a54d6,
re-run here and unchanged):

| snapshot | `overall` | `daemon.state` | heartbeat diagnostic |
| --- | --- | --- | --- |
| boot-degraded (`state: 'degraded'`, no `healthyAt`) | `healthy` | `degraded` | none |
| stuck in `bootKernel` (`state: 'starting'`) | `healthy` | `starting` | none |
| control (`state: 'healthy'`, heartbeat six hours old) | `degraded` | `degraded` | `daemon_heartbeat_stale` (error) |

The third row is the check working where it applies. The first two are the gap:
`overall` stays `healthy` for a daemon that has been unable to serve for six
hours, and no diagnostic names the condition.

Two things bound how bad this is, and they are why #1183 classified it
non-blocking rather than a regression. It is **not a regression**: `master`
before PR #1181 reported `overall: healthy` for all three rows, so the change
strictly narrowed the blindness. And it is **not fully silent**: the transcribed
`daemon.state` still reads `degraded` or `starting`, so an operator reading the
whole report has a thread to pull. Only `overall` and the diagnostics list,
which are what a monitor keys off, stay quiet.

The population is also narrower than it looks. Both the gateway and the Claude
OTEL listener fall back to an ephemeral bind on `EADDRINUSE` when the port is
defaulted, so the ordinary port-collision route does not reach the
boot-degraded shape.

## Why this is not a patch {#why-not-a-patch}

Neither remedy that fits inside a review round is available without a
decision. One is foreclosed by settled design; the other is on record nowhere,
which is its own reason to put it on record before taking it.

**Recording a boot-time heartbeat means minting a `DaemonStatus` field.**
LLP 0348#heartbeat-is-derived settled the opposite: the heartbeat costs one
arithmetic expression over two fields that were already there, and adds nothing
to the status file's schema. A new field is a change to that decision, and to
the file every other reader and every older build shares.

**Treating `startedAt` as a heartbeat gives a settled field a second meaning.**
`startedAt` is written once, at process start, and never refreshed
(`src/core/daemon/runtime.js`). Reading it as a heartbeat would give every
daemon a permanently ageing one, so the derivation would have to be conditional
on the state, which is a second meaning for the field rather than a reuse of
it. No document forbids that read: LLP 0017 settles the boot aggregate `state`
is computed from and names neither `startedAt` nor `healthyAt`. What the read
costs is the field's single meaning, and that is a judgement this document is
asking for rather than one already on record.

A third framing is worth stating so it is not mistaken for a way out: 0348's
exclusion is not a bug in that document. It is accurate for the state it names.
The gap is that the state it names is not the only state that produces a
missing `healthyAt`, and the other one is not transient.

## Options {#options}

Stated, not chosen. Each is a change to what LLP 0348 settled and would land as
a Decision extending it.

<a id="option-boot-phase-bound"></a>**A. A boot-phase staleness bound derived
from `startedAt`.** For a live pid whose snapshot has no usable heartbeat,
treat `startedAt` as the start of a bounded boot window: past some multiple of
it, a daemon that has not reached `healthy` is stuck rather than starting.
Costs nothing in the status file and no new field. It needs a second window
constant and a defensible number for it, and it has to answer what a
legitimately slow boot looks like (a first-run plugin install, a cold cache
open) so the check does not shout at a machine that is merely working. It also
gives `startedAt` a read it did not have, which is the second-meaning question
above in a smaller form.

<a id="option-persist-from-starting"></a>**B. Persist a heartbeat from the
`starting` state onward.** Have the daemon refresh the pair (or an equivalent)
on a schedule that begins before the boot aggregate is computed, so every live
daemon has a heartbeat whatever its state. This is the shape that actually
matches the fault: the question the check asks is "is this loop running", and
that question is answerable from the moment there is a loop. It is also the
larger change: it touches the writer, not just the reader, and it either mints
the field 0348 declined to mint or redefines `uptimeMs` for a daemon that has
no `healthyAt` to measure from. It has a compatibility edge too, since a
snapshot written by an older build would still read as heartbeat-less and must
not be reported as stuck.

<a id="option-hold"></a>**C. Hold, and say so.** Leave the check's domain as
0348 drew it, and record the exclusion as deliberate rather than as an
oversight, on the grounds that the transcribed `daemon.state` already reads
`degraded` or `starting` in these shapes. The cost is that `overall` (the field
a monitor watches) stays `healthy` for a permanently stuck daemon, which is the
same class of lie #1003 was filed about, only rarer.

<a id="option-file-mtime"></a>**D. Read the status file's own mtime.** The
snapshot is rewritten by `persist()` at the end of every tick whatever the
`state`, so the file's modification time advances for a daemon that is ticking
`degraded` and freezes for one that has stopped ticking, with no field minted
and no second meaning given to `startedAt`. Reading a file's age for staleness
is already the established move elsewhere in the tree (the self-update lock,
the credentials lock, the cache's orphan grace). Its costs: the age lives
outside the snapshot, so it is a property of this machine's filesystem rather
than of the record, and it is lost the moment the file is copied; it adds a
`stat` to a collector LLP 0348#consequences describes as adding no I/O beyond
the status-file read it already performs; and for the `bootKernel` shape it
inherits option A's question exactly, because the only write is the one at
process start, so the mtime and `startedAt` are the same instant.

## What this does not cover {#not-covered}

**The text-plane transcription.** The second residual in #1183, that
`hyp daemon status` printed `daemon: healthy` with a climbing `uptime_ms` while
`hyp status` said `degraded`, needed no new decision: it is the existing
LLP 0348 derivation applied on a surface that was still transcribing. Fixed in
the PR that carries this document.

**`recent_error_count`.** Tracked as #1182 and settled by LLP 0349. Not
duplicated here.

**Why a daemon wedges.** #280. This document is about what the tool says while
it is wedged.
