# LLP 0372: A scheduled sweep run cannot hold the queue forever

**Type:** Decision
**Status:** Accepted
**Systems:** Backfill, Daemon, Plugins
**Author:** Phil / Claude
**Date:** 2026-09-04
**Related:** LLP 0017 (#the-primary-daemon: the tick loop this rides), LLP 0170, LLP 0172 (#lane-b-sweep: the per-provider no-overlap guard this keeps), LLP 0359 (#serialized-providers: the queue this bounds)

> The sweep driver's serialization queue waits on the run at its head for a
> bounded time. A run that settles neither way is abandoned by the queue,
> logged with its own `error_kind`, and left holding only its own provider's
> in-flight guard, so one hung provider costs the sweep that provider rather
> than every provider behind it.

## Problem {#problem}

LLP 0359 put every due provider on one background promise chain so two
same-cadence providers cannot scan and write the shared cache concurrently.
The chain advances on either settlement of the run at its head, which is every
settlement a provider has, unless it has none.

`runProvider` is plugin code walking a user's transcript tree. A stalled
network mount under `~/.claude/projects`, or a wedged storage read, gives it
neither settlement. The chain then stays pending for the life of the daemon:
no provider queued behind it ever starts, each of those stays in `inFlight`,
and every later tick can only log `already_running` at them. The live capture
lanes keep working and the transcripts stay on disk, so nothing is lost, but
scheduled capture is off until someone restarts the daemon, and the only signal
is a warning that repeats forever.

The per-provider guard from LLP 0172 does not help here. It is doing its job:
the hung provider genuinely still has a run out there. The failure is that the
guard's blast radius is now every other provider too.

## Decision {#decision}

### The queue's wait on its head is bounded {#bounded-handoff}

The driver waits for the run at the head of the queue for at most
`SWEEP_RUN_TIMEOUT_MS` (30 minutes, six times the tightest cadence any shipped
contribution sweeps on). On expiry the queue advances to the next provider and
the driver logs `backfill.sweep_queue_abandoned` with `error_kind`
`run_timed_out`, distinct from the `sweep_run_rejected` a failing run already
emits: nothing failed and nothing finished.

The bound starts when the run starts, not when it was enqueued, so a provider
that waited its turn behind a long predecessor still gets its own full budget.

Abandoning the wait is not abandoning the run. A run cannot be cancelled, so
its settlement handlers stay attached: a run that comes back late still clears
its in-flight entry and still logs its outcome, and until then that provider,
and only that provider, is skipped by every due tick. This is the rule
`probeSourceDetails` already applies to a hung source `status()` probe in
`src/core/daemon/runtime.js`: bound the wait, keep the guard, never fire a
second call at the same plugin.

Serialization is otherwise unchanged. Every due provider is still queued in
registry order, still runs one at a time, and no healthy run is expected to
reach the bound: only a run with no settlement left in it does.

## Consequences {#consequences}

- A hung provider costs the sweep that provider until the daemon restarts,
  which is the most any bound can recover without cancelling plugin work. The
  other providers recover within the bound instead of never.
- Two providers can overlap after an abandonment, which LLP 0359's queue
  otherwise prevents. This is deliberate: the alternative is that the second
  one never runs at all. LLP 0359#bounded-dedupe already isolates in-run
  materializer state by run token, so the exposure is the shared backfill
  spool, not run-local memo replacement.
- A wedge is now diagnosable from one record rather than inferred from a
  repeating `already_running` warning, and it names the provider and the budget
  it exceeded.
- The bound is a module constant, not an operator-facing config key. Nothing
  in the product asks a user how long a transcript walk may take, and a
  configurable answer would be a new schema field for a pathological case.

## Verification {#verification}

- A driver regression holds one provider's run open forever and proves the
  provider behind it starts after the bound, having proved it had not started
  before it.
- A second regression proves the abandoned provider keeps its own in-flight
  guard (a later due tick fires nothing for it) while a different provider
  coming due later still fires.
