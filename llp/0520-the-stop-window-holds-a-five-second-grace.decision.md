# LLP 0520: The stop window holds a five-second gateway grace

**Type:** Decision
**Status:** Accepted
**Systems:** Daemon, Sources, Observability
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-10-17
**Extends:** [LLP 0343](./0343-the-telemetry-channels-close-at-once.decision.md)
(#stop-window named `DAEMON_STOP_TIMEOUT_MS` at 5s and pinned the telemetry
ceiling against it; this raises it and pins the gateway's forced exit against
it too. The #alternatives refusal to raise it is superseded for this reason
only.)
**Related:** LLP 0038 (#lifecycle-and-operator-behavior: an open stream cannot
strand a stop), hyparam/hypaware#610

## Context {#context}

A proxied SSE stream never ends on its own, so the gateway's stop bounds how
long an in-flight response may keep streaming before it is cut, and the turns
it cuts are recorded as finished captures (#610). Phil settled the bound on
the issue (2026-10-06): a five-second network grace, measured once from the
first stop request, and recordings are not discarded to get a shorter return.
The five seconds bound network drainage, not every plugin's storage work.

The surrounding limits were sized for a 2s grace: the gateway forced its exit
at 4s, and `hyp daemon stop` waited 5s. A 5s grace does not fit either.

## Decision {#decision}

### Grace {#grace}

`STOP_GRACE_MS` in the ai-gateway proxy is 5s. It starts once, when the first
`stop()` runs; a second stop waits on the same drain.

### The window {#window}

The three limits nest, and each is checked against the next:

- The proxy's grace is 5s.
- The gateway's forced exit, `STOP_DEADLINE_MS`, is 8s: the grace plus 3s for
  the cut turns' finalizers and the processing child's writes. It is the only
  thing that guarantees a stuck child dies, so it still fires.
- `DAEMON_STOP_TIMEOUT_MS` is 10s: the forced exit plus the telemetry ceiling
  (`SHUTDOWN_BUDGET_MS`, 1.25s) that runs after it on the way out, with the
  rest left for the requester to observe the exit.

Tests pin the grace below the deadline with 3s to spare, and the deadline plus
the telemetry ceiling inside the window. The LLP 0343 half-the-window check on
the telemetry ceiling stays.

## Why raising the window is right here {#why}

LLP 0343#alternatives refused a larger window because it only bought slack for
waiting three times on one hung close. Here the wait is a deliberate one the
issue asked for: a turn streaming at stop time gets its five seconds and is
recorded. A shorter window would report a healthy stop as timed out, or the
forced exit would cut streams before they finalize, which is the loss #610 is
about.

## Consequences {#consequences}

- A stop with a stream open returns after about 5s plus settlement instead of
  2s. A stop with nothing streaming is unchanged.
- A stop that truly hangs is reported after 10s instead of 5s, and the macOS
  stop's unload poll, which spends the same window, waits 10s too.
- The processing-child restart watcher shares `STOP_DEADLINE_MS`, so a wedged
  child is replaced after 8s rather than 4s.
- Both service managers' own kill timers (systemd's default `TimeoutStopSec`
  of 90s, launchd's default exit timeout of 20s) sit outside the window.

## Validation {#validation}

- `test/plugins/ai-gateway-proxy-stop-drain.test.js`: the grace is 5s and
  stays 3s inside the forced exit.
- `test/core/observability-shutdown-budget.test.js`: the forced exit plus the
  telemetry ceiling fit the stop window.
- The `daemon_foreground_start_stop` and `gateway_claude_capture` smokes.
