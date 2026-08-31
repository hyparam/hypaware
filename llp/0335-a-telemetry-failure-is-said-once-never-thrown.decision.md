# LLP 0335: A telemetry failure is said once on stderr, never thrown into the caller

**Type:** Decision
**Status:** Accepted
**Systems:** Observability
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-08-31
**Extends:** [LLP 0329](./0329-a-containment-refusal-reaches-stderr.decision.md)
(#stderr-mirror: the mirror's guarantee forced a guard around everything the
mirror shares a path with, and the guard's own diagnostic is a fifth
unconditional stderr write that 0329's per-call-site opt-in does not predict)
**Related:** LLP 0021 (#shutdown-and-flush and the exporter strategy this
leaves unchanged), hyparam/hypaware#1122, hyparam/hypaware#1125,
hyparam/hypaware#1130

> LLP 0329 rests its guarantee on the mirror sitting beside the OTel emit,
> and hyparam/hypaware#1122 showed nothing enforced the word "beside": one
> synchronously throwing exporter threw out of `Logger.emit` and skipped the
> mirror below it, silencing all four containment guards at once. The fix
> (PR #1125) is a contract, not a patch: telemetry export never throws or
> rejects into its caller, and a component the guard had to silence is
> diagnosed by one line on `process.stderr`, bounded per broken component per
> provider instance. That diagnostic line is unconditional, which 0329 alone
> would tell a reader cannot happen. This decision records the contract the
> code already keeps, so the corpus predicts the tree again.

## Export never throws or rejects into the caller {#never-throws}

Everything an emit path hands to a telemetry component is guarded at the
seam where control leaves our code:

- `exportGuarded` (`src/core/observability/runtime.js`) wraps every
  exporter's `exportBatch` on all three channels, per exporter, so a broken
  one cannot take down the caller or the healthy exporters queued behind it.
- `guardTelemetryResult` covers the other half of the same seam: an
  asynchronous exporter does not throw, it rejects, and on Node's default
  policy an unhandled rejection ends the process one tick after the mirror
  wrote its line. A returned thenable therefore gets the same treatment as a
  synchronous throw.
- `getLogger`'s emit guard (`src/core/observability/logger.js`) is the second
  seam, for a globally installed logger provider that is not ours: our
  provider guards its exporters, but the global slot accepts anything.

The rejected alternative was per-exporter discipline: both in-tree exporters
already swallow their own failures, and a review could require the same of
any future one. Rejected because discipline binds nobody. The premise of the
guard is an exporter we did not write, and the cost of one that misbehaves is
not its own telemetry but the silencing of every containment guard in LLP
0329's series, which is exactly the loss that decision was minted to end.
Structural guarding at the seam makes the mirror's "beside" true by
construction.

What this does not reach, named so the guarantee is not read wider than it
is: a component that fails asynchronously on a resource it owns rather than
on the call we made. `JsonlWriter` attaches no `'error'` listener to its
`fs.WriteStream`, so a write that fails after `stream.write` returned emits
`'error'` with nobody listening and ends the process, outside every seam
above. The guard covers every call our code makes into a telemetry
component, not every way such a component can break.

One consequence for test authors, recorded in the code and repeated here
because it surprises: an `assert` inside a fake exporter's `exportBatch` is
swallowed like any other throw. A fake records, and the test asserts.

## One line per broken component, marked before the write {#one-line}

`reportTelemetryFailure` (`src/core/observability/runtime.js`) is the guard's
diagnostic: one `WARN` line on `process.stderr` naming the channel, the
component, and what it threw. Its bound and its shape are each a decision:

- **Bounded to one line per broken component.** The throwing call sits on the
  path of every record, so an exporter broken by configuration would
  otherwise print once per row for the life of the daemon. The key is
  `source#index` per provider instance, not the class name alone: two
  exporters of one class (two OTLP endpoints, say) are two things to fix, and
  on a name-only key the first to break would consume the report and leave
  the second undiagnosable for the life of the process.
- **Marked before the write, not after.** `reported.add(key)` precedes the
  `process.stderr.write`, so a write syscall that itself throws (an EPIPE'd
  stderr) is not retried per record forever. The trade is deliberate: if the
  one write fails, that report is spent, because a process whose stderr is
  gone has nowhere left to say anything anyway.
- **No stack, a truncated message.** One line per source is what makes the
  report safe on the path of every record. The `error_message` attribute is
  capped, and `describeThrown` survives a thrown value that cannot be
  stringified, because a report that can itself throw reintroduces the
  escape it exists to prevent.
- **Unconditionally `process.stderr`, like the mirror and for the same
  reason:** this is the report that fires precisely when the structured
  substrate is the broken thing, the one state in which the WARN cannot be
  trusted to carry its own diagnosis.

## The emit seam's bound re-arms per installed provider {#generation-rearm}

The exporter guard hangs its `reported` set off the provider instance, so a
swapped-in provider naturally starts with a clean bound. The emit seam in
`getLogger` has no provider object of ours to hang state off, so it counts
against a module-level set keyed by the logger-provider generation
(`currentLoggerProviderGeneration`, bumped by every
`setGlobalLoggerProvider`). A seam bounded process-wide would let the first
broken provider consume the report for every provider installed after it,
which is a broken provider nobody can diagnose by another route. The
generation is read when the record is emitted, not when a rejection settles a
microtask later, so a provider swapped in between the two cannot steal the
name on the report.

## A failed flush or close gets the same line {#close-failures}

`flushExporters` and `shutdownExporters` absorb a synchronous throw as well
as a rejection, so one broken `forceFlush` cannot strand the sibling
exporters behind it. Absorbing them silently, though, meant an exporter
that fails to close at daemon shutdown lost its buffered records with no line
anywhere (hyparam/hypaware#1130 item 2, a gap that predates PR #1125:
`Promise.allSettled` and the `safe()` wrapper in `installObservability`'s
shutdown already swallowed these). The settled rejections now route through
`reportTelemetryFailure` under the same bound, with the operation in the key
(`source#index#flush`, `source#index#shutdown`) so an exporter that exports
fine all day and only breaks at close is diagnosable independently of its
export line. Noise stays bounded by that key, which holds across the repeated
flush passes one shutdown makes: under dev telemetry
`installObservability`'s shutdown calls `forceFlush` and then `shutdown`,
which flushes again.

Two boundaries the report does not reach, neither of them introduced by it:

- **A close that rejects is diagnosed; a close that hangs is not.**
  `installObservability`'s shutdown races each provider against
  `withTimeout`, so an exporter whose `shutdown` never settles loses the
  race, the process exits, and the settled results are never inspected.
- **Neither in-tree exporter can produce this line today.** The OTLP
  exporter's flush is an `allSettled` over posts that already caught their
  own failure, and `JsonlWriter.close` resolves from `stream.end`'s
  callback without reading the error that callback is handed, so a JSONL
  close failure never reaches this seam at all. What the report covers is the
  case the guard was minted for: an exporter we did not write. Teaching the
  JSONL writer to reject on its stream error is a change to that exporter,
  not to this seam, and it is where the buffered-record loss in
  hyparam/hypaware#1130 item 2 actually has to be fixed.

## Not a fifth mirror, and not blanket mirroring {#not-a-fifth-mirror}

LLP 0329#stderr-mirror settles a per-call-site opt-in for four named
containment refusals, and a reader of 0329 alone would believe those four
lines are the only unconditional stderr writes in the tree. The guard's
diagnostic is a fifth, and it is not a mirror at all: no call site asked for
`mirrorStderr`, and the line is not a copy of any log record. It is the
substrate reporting on itself, in the single state where the structured
channel cannot carry the diagnosis because the structured channel is the
broken thing.

Nor does it reopen LLP 0329#not-every-warn. That section rejects wholesale
mirroring of roughly eighty unaudited `warn` call sites, on two arguments:
an unaudited noise profile turned into user-visible output at once, and the
`ctx.stderr`-versus-`process.stderr` mismatch widened to every warn in the
tree. Neither applies here. The noise profile is one line per broken
component, zero on every healthy install, and the bypass of the
dispatch-bound `ctx.stderr` is confined to a line that only exists when
telemetry, the thing `ctx.stderr` cannot diagnose, is broken.

## The meter emit seam is knowingly unguarded {#meter-seam}

`Instrument._record` calls the global meter provider without a guard, unlike
the logger's emit. Verified acceptable at this head, on three facts together:
the package `exports` map has no subpath reaching `runtime.js`,
`src/core/observability/index.js` re-exports neither `logs` nor `metrics`, so
only in-repo code can install a meter provider; in-repo installation goes
through the guarded `MeterProvider` class, whose `exportRecords` routes
through `exportGuarded`; and none of the four containment sites in LLP 0329's
series emits a metric, so no refusal sits downstream of the seam. The
boundary this sets: **the day a plugin-facing meter-provider seam exists, the
meter emit gets the logger emit's guard first.** Whoever opens that seam
inherits this sentence.

## Consequences {#consequences}

- A broken third-party exporter costs its own telemetry and one stderr line,
  never the containment mirror, never its sibling exporters, and never the
  process. LLP 0329's guarantee no longer depends on exporters we did not
  write behaving well.
- The one-line bound means a long-lived daemon says each broken component
  once. The line is a standing diagnosis to act on, not a rate to monitor:
  after it, that component's records drop silently by design.
- A fake exporter in a test must record and let the test assert; an assert
  inside `exportBatch`, `forceFlush`, or `shutdown` is swallowed.
- An exporter whose close *rejects* is now diagnosable from the daemon's
  log. The records it buffered may still be lost; the line is the difference
  between a loss someone can investigate and one nobody knows happened. A
  close that hangs past the shutdown timeout, or one that resolves while
  swallowing its own error the way `JsonlWriter.close` does, is still
  silent (#close-failures).
- `test/core/containment-refusal-stderr.test.js` pins every clause: the
  mirror surviving a throwing and a rejecting exporter, the per-component,
  per-index, per-operation and per-generation bounds, the export line byte for
  byte, the channel the close report names, the exotic thrown values, a report
  that itself throws, and the silence of every healthy path.

## References {#references}

- [LLP 0329](./0329-a-containment-refusal-reaches-stderr.decision.md): the
  guarantee this contract exists to make structural, and the sections
  (#stderr-mirror, #not-every-warn) whose scope this decision qualifies.
- [LLP 0021](./0021-observability.spec.md): the OTel substrate, exporter
  selection, and #shutdown-and-flush, all left unchanged; this decision only
  adds what happens when a component on those paths throws.
- hyparam/hypaware#1122: the escape, with the four-guards-at-once blast
  radius that justified a structural guard.
- hyparam/hypaware#1125: the PR that landed the contract in code.
- hyparam/hypaware#1130: the follow-up recording that the contract lived
  only in code comments, and the close-failure gap this decision closes for
  exporters we did not write (item 2). The in-tree half of that gap stays
  open by the boundary in #close-failures.
