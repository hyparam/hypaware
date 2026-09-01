# LLP 0348: A live pid is not a live daemon: `hyp status` reads the heartbeat, not the recorded state

**Type:** Decision
**Status:** Accepted
**Systems:** Daemon, CLI
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-09-01
**Extends:** [LLP 0017](./0017-daemon-runtime.decision.md)
(the boot-time health aggregate it settled is unchanged; this adds the
read-side question boot health cannot answer, which is whether the daemon is
still running its loop now)
**Extended-by:** LLP 0349 (#not-settled: `recent_error_count` now counts the errors the install actually recorded, in the daemon log and the sink outboxes, over a stated 24-hour window)
**Related:** LLP 0164 (#status-reads-it-from-the-status-file: the file this
reads and why `hyp status` reads no kernel), LLP 0228
(#status-file-is-the-surface: the same file as a standing operator surface),
LLP 0257 (#status-and-health: the sibling staleness judgement, on capture
rather than on the daemon)

> During a reproduced brownout (issue #1003) both local listeners, the Codex
> gateway and the Claude OTEL listener, accepted TCP connections and returned
> zero HTTP bytes before the client gave up, while `hyp status --json` said
> `overall: healthy`, `daemon.state: healthy`. For an observability product
> that is the worst available failure: the tool lied about itself at the one
> moment its answer mattered. This document settles what `hyp status` has to
> prove before it may repeat the word `healthy`.

## Context {#context}

**The status file proves a start, not a service.** LLP 0017 settled the boot
health aggregate: a clean boot writes `state: "healthy"` into `status.json`,
a boot with a failed source writes `degraded`. That aggregate is computed once,
at boot. `hyp status` then reported `daemon.state` by transcribing whatever
that file said, gated only on the pid being alive. Both halves were true during
the brownout: the process had started cleanly and still owned its pid.

**A wedged daemon keeps its listeners bound, and they keep accepting.** The
observed fault is an event loop that cannot run (in #1003, central sink
pressure with as many as eight overlapping failed export intervals). Nothing
about that closes a listening socket. The kernel completes the TCP handshake
out of the accept backlog with no help from the process, so a client connects
in microseconds and then waits for bytes no handler will ever write. Every
cheap liveness signal, the pid, the bound port, the successful connect, reads
as healthy in exactly this state.

**The daemon already emits a heartbeat, and nothing was reading it.** The tick
loop persists `status.json` at the end of every tick, recomputing `uptimeMs`
from `healthyAt` immediately before each write. A loop that cannot serve
cannot tick either, so the file stops advancing at precisely the moment the
daemon stops working. The runtime knew this hazard: the comment on
`SOURCE_STATUS_TIMEOUT_MS` spells out that a hang on the tick path freezes
every field in `status.json` "while the daemon goes on reporting itself
healthy". It bounded the one hang it could see and left the staleness itself
unread.

## Decision {#decision}

<a id="stale-heartbeat-is-unresponsive"></a>**A live process with a stale
heartbeat is reported `degraded`, whatever its snapshot claims.** The state
`hyp status` reports is this collector's verdict, not a transcription of the
file. When the process is alive and its last snapshot write is older than the
window below, the reported `daemon.state` becomes `degraded` and a
`daemon_heartbeat_stale` diagnostic is raised at `error` severity, which
degrades `overall` through the existing severity rule.

`degraded` rather than a new state word: the existing vocabulary already means
"running, and something an operator has to know about", which is exactly this,
and a new `DaemonState` member would have to be understood by every consumer
of the file that this change does not otherwise touch.

The check is asked only of a running process. A snapshot left behind by a
daemon that exited ages forever and is a record of what happened, not a claim
about now, the same distinction LLP 0164#not-liveness-gated draws for
last-seen entrypoints.

<a id="heartbeat-is-derived"></a>**The heartbeat is derived from the snapshot,
not recorded as a new field.** `healthyAt + uptimeMs` is the moment of the last
`persist()`, because `persist()` sets `uptimeMs = now - healthyAt` immediately
before it writes. Reading the heartbeat therefore costs one arithmetic
expression over two fields that have always been there, and adds nothing to
`DaemonStatus`. A snapshot from an older build, or one that never reached
`healthy`, yields no heartbeat and is left alone: a daemon still booting has
no heartbeat to be late for.

<a id="no-listener-probe"></a>**`hyp status` does not open a socket to the
listeners.** Issue #1003 proposed a bounded local readiness probe against the
gateway and OTEL ports. It is rejected here, for now, on three grounds. It
would put network I/O and a timeout budget inside a command that is a report;
a legitimately busy listener would make the command intermittently report
`unhealthy`, which is a worse failure than the one being fixed; and it tests a
symptom, where the heartbeat tests the cause. A loop that runs serves its
listeners, and a loop that does not serve them cannot tick. If a fault ever
appears where the loop runs and a listener is dead anyway (a server closed out
from under the source, say), that is a different defect and it earns its own
probe then.

<a id="the-window"></a>**The window is five missed ticks.** The tick interval
is fixed at 60s outside the test harnesses, so `DAEMON_HEARTBEAT_STALE_MS` is
five minutes. It is several ticks wide deliberately: one slow tick is ordinary,
because the sink export runs inside it, and a status command that flickered to
`degraded` whenever an export ran long would be worse than the bug. It is not
tighter for a second reason, that the daemon's timers do not fire while the
machine is asleep, so a host that has just woken reads as stale until its next
tick lands. That window is bounded by one tick and self-clearing, and the
diagnostic states the observed age rather than a diagnosis, so the reader can
see a five-minute gap for what it is.

## What this does not settle {#not-settled}

**`recent_error_count` still counts only dev telemetry.** Issue #1003 also
reports that the central sink's export failures (1,016 `429
gateway_pending_high_water`, 849 `fetch failed`, and more) never reached
`recent_error_count`. They cannot: that counter walks `dev-telemetry/`, which
only exists under `HYP_DEV_TELEMETRY=1`, so on a production install the number
is structurally zero and says nothing. Making it mean something is a separate
decision about which failures count and over what window, and the daemon log
under `<stateRoot>/logs/daemon.log` is the production-side record it would have
to read. Untouched here. Settled by [LLP 0349](./0349-recent-error-count-reads-the-records-production-keeps.decision.md).

**The sink and OOM mechanism is #280.** Why the daemon wedged is not this
document's subject. That it must not claim to be healthy while wedged is.

## Consequences {#consequences}

- A wedged daemon is now visible from `hyp status` alone, in both planes:
  `daemon.state: degraded`, `overall: degraded`, and a named diagnostic whose
  repair is `hyp daemon restart`.
- A healthy daemon is unaffected: the check adds no I/O beyond the
  `status.json` read the collector already performs, and raises nothing while
  the tick advances.
- Any future writer of `status.json` inherits an obligation it did not have
  before: `healthyAt` and `uptimeMs` are now read as a heartbeat, so a writer
  that stops refreshing them while continuing to serve would report a fault
  that is not there.
