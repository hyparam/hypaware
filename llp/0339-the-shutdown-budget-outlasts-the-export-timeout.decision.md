# LLP 0339: The shutdown budget outlasts the export timeout it races

**Type:** Decision
**Status:** Accepted
**Systems:** Observability
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-08-31
**Extends:** [LLP 0337](./0337-a-telemetry-close-reports-what-it-lost.decision.md)
(#budget-report named the mismatch this settles as a boundary: a non-dev
shutdown budget of 500ms against an OTLP export timeout of 1000ms, reported
but not decided), [LLP 0021](./0021-observability.spec.md) (#shutdown-and-flush
recorded the 500ms number this replaces; the dev budget and the flush order
are unchanged)
**Extended-by:** [LLP 0342](./0342-the-telemetry-channels-close-at-once.decision.md)
(the "about 3.75s if every provider's close hangs" #budget-derived accepts is
now one budget: the channels close concurrently, so the ceiling is
`SHUTDOWN_BUDGET_MS`, not three of them. The budget itself and its derivation
are unchanged, and the coupling #alternatives left live now has a trip wire
against the daemon stop window)
**Related:** LLP 0329 (#stderr-mirror: the healthy-operation silence this
restores for slow-but-answering collectors), hyparam/hypaware#1143,
hyparam/hypaware#1141

> LLP 0337 made a shutdown that abandons an in-flight export say so, and named
> in the same section that the abandonment itself was a standing decision
> nobody had made: the budget doing the abandoning was half the exporter's own
> per-request timeout. The framing on record was a latency trade, records
> bought back at up to a second of exit latency per invocation. Measured, the
> trade dissolves: the exporter's own abort timer was already the effective
> bound on exit latency, so the low budget was not buying speed, it was only
> converting confirmations into disconnects. This decision derives the budget
> from the timeout so the mismatch cannot be reintroduced by drift.

## What the low budget actually cost, measured {#measured}

The facts, measured on the shipped CLI against a local collector
(hyparam/hypaware#1143), because the trade as framed did not survive contact
with them:

- **Export bodies were never the loss.** Every OTLP exporter posts each
  record at emit time, so the bytes reach the collector's socket within
  milliseconds, long before any budget matters. Against a collector that
  delays its response 700ms, `hyp status` delivered 69 of 69 bodies inside
  40ms even when the process exited at the old budget.
- **The loss is the confirmation, and it is real.** A collector that binds
  processing to the request context and cancels on client disconnect (the
  reference OTel collector's shape) drops a fully received batch when the
  client hangs up before the response. A minimal client that installs, emits
  one record, shuts down, and calls `process.exit` (the exact shape of
  `bin/hypaware.js`) against a 700ms canceling collector: at the 500ms budget
  the record was received and then dropped on disconnect; with the budget
  above the export timeout it was delivered. The cost of the difference was
  209ms of exit latency, paid only in that exact case.
- **Whether the old budget lost anything was an accident of channel order.**
  Shutdown closes metrics, then logs, then traces, each under its own budget.
  A pending post on an early channel times out and donates its wait to the
  fetches of later channels, so `hyp status`, which posts on all three,
  lost nothing at 700ms and warned anyway. A run whose pending post sits on
  the last-closed channel got no donation and lost the record. A guarantee
  that depends on which channel a record happened to land on is not one.
- **The budget was not bounding exit latency; the abort timer was.** Every
  OTLP post carries its own `AbortController` at `OTLP_EXPORT_TIMEOUT_MS`,
  and that timer keeps running across the serial channel closes. Measured
  wall times for `hyp status` before and after this change, same machine,
  same harness: no OTLP configured 201ms / 203ms, unreachable collector
  232ms / 224ms, fast collector 257ms / 255ms, 700ms collector 949ms / 948ms,
  collector that never answers 1246ms / 1246ms. Identical within noise in
  every scenario: the up-to-a-second-per-invocation cost the trade was framed
  around does not exist on this path.
- **The WARN the old budget emitted was noise on healthy operation.** At
  700ms the budget expired, the line said "buffered records may be lost", and
  in the common case nothing was: 347 stderr bytes per invocation against a
  merely slow collector, every run, teaching the operator the line means
  nothing. After this change the same scenarios write 0 stderr bytes, and the
  line fires only when a close hangs past a budget the exporter's own timeout
  could not settle, which is a loss every time.

## The budget is derived, not adjacent {#budget-derived}

The non-dev shutdown budget is `OTLP_EXPORT_TIMEOUT_MS` plus a fixed margin
(250ms), computed from the constant, not written beside it. The constant
itself moves to one exported definition in `otlp_exporters.js`, next to the
abort timer that enforces it; it was previously three identical private
copies in `tracer.js`, `logger.js`, and `meter.js`, which is exactly the
arrangement under which one number drifts away from another. The mismatch
this settles was that drift, already happened.

Above the timeout, the budget's meaning changes from "how long a slow
collector gets" to what it should have been all along: a backstop against a
close that hangs on something with no timer of its own. Every OTLP fetch
settles within the export timeout, delivered, failed, or aborted, so the only
close that can now meet the budget is a genuine hang, and LLP 0337's line
fires on it exactly as before. The margin covers the settle after an abort
fires, the rejection reaching `Promise.allSettled` and the provider's
shutdown resolving, so an export the exporter itself gave up on never
produces a budget report.

The dev budget stays at 5s (LLP 0021#shutdown-and-flush): it exists for disk
flushes a smoke will read back, not for network confirmations, and nothing
here touches it.

What this deliberately gives up: the ceiling on a *genuinely hung* close
rises from three 500ms budgets to three derived ones, about 3.75s if every
provider's close hangs on a live handle at once. That case requires a broken
provider, was already paying 1.5s for nothing recoverable, and now buys a
diagnosis line per channel while it waits.

## Alternatives refused {#alternatives}

- **Raise the number as a second independent constant.** Restores the records
  today and re-arms the drift that caused this: the next person to tune
  either constant reopens the mismatch silently. Deriving one from the other
  makes the relationship a fact of the code rather than a coincidence of two
  numbers.
- **Drain in `bin/hypaware.js` before `process.exit`.** Equivalent behavior,
  wrong owner: the invariant "an in-flight export settles before the process
  goes away" belongs to the shutdown that owns the exporters, not to every
  caller. The budget already applies only when a provider exists, so a
  default install pays nothing either way (LLP 0021#exporter-selection), and
  a future second caller of `installObservability` would inherit the loss.
- **Accept the warned loss as steady state.** Defensible only while the loss
  is assumed cheap and the latency assumed expensive; measurement inverted
  both. It also leaves a WARN that fires on healthy operation, which is the
  inverse of the LLP 0329 discipline: stderr lines mean something because
  healthy operation never writes one.

## Consequences {#consequences}

- A configured OTLP install with a collector answering inside the export
  timeout delivers and confirms every export at exit, silently, at the
  latency it was already paying.
- The `timed_out` line from LLP 0337#budget-report now only fires on a close
  the exporter's own timeout could not settle: a real hang, a real loss.
- Exit latency bounds are unchanged in practice and derived on paper:
  the exporter's abort timer bounds the OTLP path, the budget bounds a hung
  close, and the second is above the first by construction.
- `test/core/observability-shutdown-budget.test.js` pins all three faces
  against a real HTTP listener: the 700ms confirmation settled before
  shutdown resolves with zero stderr, the never-answering collector settled
  by the exporter's own abort inside the budget with zero stderr, and the
  hung provider close still cut at the budget and still reported.
