# LLP 0343: The telemetry channels close at once

**Type:** Decision
**Status:** Accepted
**Systems:** Observability
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-08-31
**Extends:** [LLP 0339](./0339-the-shutdown-budget-outlasts-the-export-timeout.decision.md)
(#budget-derived accepted a hung-close ceiling of three derived budgets as the
price of raising the budget above the export timeout; this removes the "three"
without touching the budget), [LLP 0021](./0021-observability.spec.md)
(#shutdown-and-flush recorded the reverse-order close this replaces with an
unordered one; the dev flush, the dev budget, and the flush-before-close order
*within* a channel are unchanged)
**Related:** LLP 0337 (#budget-report: the per-channel line that still fires,
now three at once rather than three in a row), LLP 0300 (#posix-keeps-signals:
the SIGTERM that starts the window this has to fit inside),
hyparam/hypaware#1153

> LLP 0339 raised the non-dev shutdown budget above the OTLP export timeout and
> recorded, as a deliberate cost, that a shutdown with every channel's close
> hung would now take about 3.75s. Measured on a real daemon that number turned
> out to be spending three quarters of the window `hyp daemon stop` waits in.
> The three budgets were never three waits for one reason: the channels close
> one after another. They share nothing. Closing them at once makes the ceiling
> one budget and leaves both constants alone.

## A hang costs one budget, not one per channel {#one-budget}

`shutdown()` closes metrics, logs, and traces concurrently, under one
`Promise.all`. Each channel keeps its own budget and its own dev
flush-then-close order; what goes away is the wait between them.

The ceiling on a shutdown where every provider's close hangs on something with
no timer of its own therefore falls from `3 * SHUTDOWN_BUDGET_MS` (about 3.75s
measured, 3757ms in the test that pins it) to `SHUTDOWN_BUDGET_MS` (1250ms).
The healthy and slow-collector paths are unchanged in wall time: they were
already bounded by the exporter's own abort timer, which runs from post time
and keeps running across channels either way (LLP 0339#measured).

Concurrency is safe here because the channels are disjoint, and specifically:

- Each provider owns its own exporter list, its own pending-post array, and
  its own global registration slot. No close reads or clears another's.
- Nothing on the close path emits telemetry, so no channel can need another
  still open. The timed-out report writes straight to `process.stderr`
  (LLP 0335#one-line), one `write` per line, so the lines interleave as whole
  lines or not at all.
- The one-line bound is a `Set` keyed by channel and operation, so three
  concurrent reports key distinctly and each still fires exactly once.
- Nothing is closed *earlier* than it was: a channel that used to be third now
  starts at the same moment as the first. The budget it gets is the same
  1250ms, and every pending OTLP post it might be waiting on already aborts
  within `OTLP_EXPORT_TIMEOUT_MS` of the post that made it, which is before the
  shutdown began.

This gives up the reverse-order close LLP 0021#shutdown-and-flush recorded.
Reverse install order is the right default when a later-installed component can
emit through an earlier one; none of these can. Keeping the order bought
nothing and cost the two waits.

## The stop window is a checked fact, not a coincidence {#stop-window}

`requestDaemonStop`'s 5s wait was an inline literal, and the telemetry ceiling
underneath it was derived from a different constant entirely. That is the same
two-adjacent-numbers arrangement LLP 0339#budget-derived removed from the
observability side, one level up: nothing connected them, and at 3.75s of 5s
they were only coincidentally compatible.

The 5s is now `DAEMON_STOP_TIMEOUT_MS`, the ceiling is now
`SHUTDOWN_BUDGET_MS`, and a test asserts telemetry may claim at most half the
window. Neither number changes. The assertion is the trip wire for the coupling
LLP 0339#alternatives left live: raising `OTLP_EXPORT_TIMEOUT_MS` raises the
ceiling with it, and past 2500ms it now fails a test instead of quietly eating
the stop window.

## Alternatives refused {#alternatives}

- **Raise `DAEMON_STOP_TIMEOUT_MS`.** Buys slack by making every real stop
  failure take longer to report. The hung-close case was slow because it waited
  three times for one thing, and the fix for waiting three times is to wait
  once, not to budget for three.
- **Derive `DAEMON_STOP_TIMEOUT_MS` from `SHUTDOWN_BUDGET_MS`.** The option
  hyparam/hypaware#1153 named. Refused because the telemetry close is a small
  part of what happens in that window (sources stop, sinks drain, the pid file
  clears), so a stop timeout derived from telemetry alone would claim a
  relationship that does not hold. The assertion above states exactly the part
  that does: telemetry stays a bounded fraction.
- **Lower `OTLP_EXPORT_TIMEOUT_MS` to make the healthy path faster.** Aimed at
  the wrong number. The ~1s a stop costs against a collector that never answers
  is the exporter's own abort, not the shutdown budget, and it is the same 1s
  whether the channels close in sequence or at once. Against a collector that
  answers, exit was already about 250ms (LLP 0339#measured). Tuning the export
  timeout is a separate decision with a separate cost (records abandoned
  earlier), and it now has the #stop-window trip wire attached.

## Consequences {#consequences}

- A shutdown where all three closes hang costs one budget, and `hyp daemon
  stop` sees the daemon gone with about 3.75s of its window unspent instead of
  1.23s.
- Every hung channel is still reported, one line each; only their order on
  stderr is now unspecified.
- `test/core/observability-shutdown-budget.test.js` pins both faces: three
  hangs settling inside two budgets with all three channels named, and the
  ceiling against `DAEMON_STOP_TIMEOUT_MS` with no wall clock at all.
