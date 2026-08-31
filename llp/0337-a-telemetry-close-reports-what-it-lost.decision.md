# LLP 0337: A telemetry close reports what it lost, including the loss it only learns of afterwards

**Type:** Decision
**Status:** Accepted
**Systems:** Observability
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-08-31
**Extends:** [LLP 0335](./0335-a-telemetry-failure-is-said-once-never-thrown.decision.md)
(#close-failures named two boundaries its report could not reach, a close that
hangs and a close that swallows its own error, and #never-throws named a third
thing outside all its seams, a component that fails on a resource it owns.
This decision closes all three for the exporters this repo ships, which is
what makes 0335's report reachable in-tree at all)
**Related:** LLP 0021 (#shutdown-and-flush: the budget this spends and the
exporter strategy it leaves otherwise unchanged), LLP 0329 (#stderr-mirror:
the guarantee the whole series exists to keep), hyparam/hypaware#1130,
hyparam/hypaware#1137

> LLP 0335 landed a report for a telemetry component that fails to flush or
> close, and recorded in the same breath that neither exporter in this tree
> could produce it: `JsonlWriter.close` resolved from `stream.end`'s callback
> without reading the error that callback is handed, so a disk that took none
> of the buffered records reported a clean shutdown. The report was real and
> the loss was real and they could not meet. This decision makes them meet, in
> the one direction the series allows: the writer says what it lost, the
> shutdown seam turns that into one line, and nothing on the path throws.

## The writer owns the failures its own stream reports {#writer-owns-its-stream}

`JsonlWriter` opens an `fs.WriteStream` and, until now, listened to nothing on
it. Two consequences, and the second is the worse one:

- A write that fails after `stream.write` returned reports itself on the
  stream's `'error'` event, a tick after the `try`/`catch` in `exportBatch` is
  gone. LLP 0335#never-throws named this as outside every seam it has, and it
  is: an unlistened `'error'` event ends the process. The guard exists to stop
  a broken exporter from killing the caller, and the exporter this repo ships
  could kill it by a route no seam covers.
- Nothing held that failure anywhere, so the flush and close that followed had
  nothing to report even if they had wanted to.

`ensureOpen` now attaches an `'error'` listener that keeps the first failure
the stream reports. Keeping the first rather than the last is deliberate: the
first is the cause, and the ones after it are usually the same broken
descriptor saying so again.

This does not widen the guard's promise: a component that breaks on its own
resources is still outside the seams in LLP 0335#never-throws, and an exporter
we did not write can still end the process that way. What changes is that the
one such component in this tree no longer does.

## A close that lost its records rejects {#close-rejects}

`close` now rejects with whatever the stream failed on, and `flush` rejects if
the stream has already failed. `shutdownExporters` turns that rejection into
exactly the one line LLP 0335#close-failures specified, under the same
per-source, per-index, per-operation bound. The buffered-record loss in
hyparam/hypaware#1130 item 2 is a diagnosis now instead of a silence.

Two mechanical choices this rests on:

- **Settled on the stream's `'close'` event, not on `end`'s callback.** The
  two carry different halves of the failure: the callback is handed the write
  error, the `'error'` event arrives with the close error, and only the
  listener above sees both. `'close'` is emitted after either outcome, so one
  wait covers both. A stream that already failed, or was already destroyed,
  has emitted its `'close'` before the call and is settled from the held error
  directly, because waiting for a second one would wait forever.
- **The flush's drain wait rejects on error too.** A stream that fails while
  draining never drains, so a wait on `'drain'` alone would hang the flush
  rather than report it, which is the failure mode #budget-report is about.

What this changes for a caller: `forceFlush` and `shutdown` on a JSONL
exporter can now reject where they previously always resolved. Nothing on the
shutdown path propagates it. `shutdownExporters` already absorbs both a throw
and a rejection per exporter, `installObservability`'s shutdown absorbs what a
provider does, and a healthy close still resolves and still writes nothing to
stderr. The rejection is a channel to the report, not a new failure mode for
the process. The alternative, keeping the swallow and reporting from inside
the writer, was rejected because it invents a second diagnostic channel beside
`reportTelemetryFailure` and loses the bound the report already keeps.

## A close that outruns the budget is named, not abandoned {#budget-report}

`installObservability`'s shutdown races each provider's flush and close
against a budget (5s under dev telemetry, 500ms otherwise). The timeout arm
resolves rather than rejecting, so a provider that never settles simply lost
the race and the process moved on: a hung close and a clean one were the same
observation, which is the silence LLP 0335#close-failures ended for a close
that rejects and left standing for one that hangs.

The race now resolves the timeout arm with a sentinel, and a step that comes
back with it reports through `reportTelemetryFailure` under
`<channel>_provider#<operation>`, with `outcome: 'timed_out'` so the line says
the budget ran out rather than that something threw. The report itself is
guarded, like every other one on this path: a shutdown that rejected here
would skip the teardown after it.

This is not an alarm on a merely slow close, which was the argument against
raising it at all. When the budget expires the shutdown moves on regardless,
so whatever that provider still buffered is lost either way; the line is a
true statement about a real loss, not a prediction. It costs nothing on a
default install, where no exporter is configured and no provider exists to
close (LLP 0021#exporter-selection), and one line per provider per operation
on an install where a close really does hang.

The residue, named so nobody reads the guarantee wider than it is: **a close
that hangs on nothing at all is still silent.** The budget's timer is
`unref`'d, so if the pending close holds no handle open the event loop empties
and the process exits before the timer can fire. Nothing can run after that,
so this is not a report that was withheld; it is a report with nowhere to run.
A real hang waits on something (an unresponsive collector, a descriptor that
never closes), which keeps the loop alive, which is the case the line covers.

The `meter.readers` teardown beside it keeps the silent `safe()` wrapper
deliberately (hyparam/hypaware#1137 item 2): both return paths in
`installMeterProvider` return `readers: []`, so the loop is unreachable and a
report added there could not be run, let alone tested. The boundary this sets
is the one LLP 0335#meter-seam sets for the meter emit: the day a real
`MetricReader` lands, its close goes through the same step as every provider
above it.

## Consequences {#consequences}

- A JSONL exporter that cannot write to disk costs its telemetry, one stderr
  line at close, and nothing else. It no longer ends the process, and it no
  longer reports a clean shutdown over records that were never written.
- LLP 0335's settled-failure report is reachable from an in-tree exporter, so
  the contract can be exercised end to end rather than only against a fake.
- A hung provider close is diagnosable whenever a hung close is diagnosable at
  all, and the shutdown still never waits longer than its budget.
- `reportTelemetryFailure` grows one optional field, `outcome`, defaulting to
  `threw`; every existing line is byte-identical to what LLP 0335#one-line
  settled.
- Healthy operation is unchanged and still byte-silent on stderr: a clean
  close resolves, writes its file, and says nothing.
- `test/core/containment-refusal-stderr.test.js` pins each clause: the failed
  close diagnosed once and named as the exporter that lost the records, the
  healthy close silent with its records on disk, the asynchronous write
  failure that no longer ends the process (in a subprocess, because the
  assertion is that the process is still there), the hung close named when the
  budget runs out, and the shutdown that finishes inside it staying silent.

## References {#references}

- [LLP 0335](./0335-a-telemetry-failure-is-said-once-never-thrown.decision.md):
  the contract this extends. #close-failures for the report and the two
  boundaries it named, #one-line for the bound and the line's shape,
  #never-throws for the seams and the resource-owned failure outside them.
- [LLP 0329](./0329-a-containment-refusal-reaches-stderr.decision.md): the
  containment mirror whose guarantee every guard in this series protects.
- [LLP 0021](./0021-observability.spec.md): #shutdown-and-flush, the reverse
  order and the budget this spends, and #exporter-selection, which is why a
  default install has no provider to close.
- hyparam/hypaware#1130: item 2, the buffered-record loss, closed here for the
  in-tree exporters.
- hyparam/hypaware#1137: the triage that carried the deferred findings from
  PR #1134 forward, items 1, 2 and 3.
