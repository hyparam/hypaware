# LLP 0485: The Client Work Budget Is Clocked on Process CPU

**Type:** Decision
**Status:** Accepted
**Superseded-by:** [LLP 0491](./0491-team-history-uses-remote-graph-and-agent-guidance.spec.md) (client replication and its commands; shared kernel utilities remain)
**Systems:** Daemon, Graph
**Author:** HypForge designer
**Date:** 2026-10-09
**Extends:** [LLP 0481](./0481-fastask.plan.md) task T4 (the helper's semantics change: its clock is process CPU, not elapsed time); [LLP 0480#cooperative](./0480-fastask.design.md#cooperative) (how the duty cycle is measured, and its default) and [LLP 0484#build-memory](./0484-discovery-walks-touched-and-the-build-is-bounded-before-it-starts.decision.md#build-memory) (what the 1x bound covers)
**Extended-by:** [LLP 0486](./0486-t11-stress-thresholds-after-measurement.decision.md) (no-growth window 10th to 20th refresh; slice time cap 4 ms; absolute OTLP ceiling; the follow-up is a child process, not a worker thread)
**Related:** LLP 0481 (plan; tasks T4, T5, T6, T11); server LLP 0564 (the server's budget counts whole-process CPU)

> LLP 0480 duty-cycles the replica's background work on elapsed time, at 25
> percent. On a real daemon, decompression and garbage collection run on other
> threads, so the whole process used up to 2.5 times its duty. The client's
> budget helper now measures what it limits: whole-process CPU. This also
> settles whether LLP 0484's 1x memory bound is per build.

## Measurement {#measurement}

LLP 0481 T11 (implementer-5, 2026-10-09 05:13Z): four stress runs of the real
`hyp` daemon on the reference Mac; whole-process CPU attributable to the work
(per server LLP 0564's definition), 10-second windows, idle subtracted.

| Duty (wall clock) | Average | Worst window | Worst window is |
| --- | --- | --- | --- |
| 0.25 | 0.34 cores | 0.54 | download verify, 4x graph |
| 0.18 | 0.26 | 0.42 | download verify, 4x |
| 0.12 | 0.18 to 0.20 | 0.25 to 0.33 | download verify, 4x |

Verify ticks the budget per compressed chunk while gunzip runs in the thread
pool in parallel with per-line hashing on the main thread: about 2.5 times
the duty in whole-process CPU. The index build runs about 1.5 times. Build
times at 0.12: 1x 9.7 s, 4x 59 s.

## Decision {#decision}

- **The clock is process CPU.** The client's work-budget helper (LLP 0481 T4,
  `src/core/util/`) measures each slice by `process.cpuUsage()` (user plus
  system, all threads) instead of elapsed time. After a slice it sleeps
  `cpuUsed * (1 - duty) / duty`, abortable as before. Thread-pool, hashing and
  garbage-collection work is charged where it happens, with no per-path
  multipliers.
- **Each sleep is capped at 2 seconds.** Process CPU includes foreground
  capture and queries, so a busy daemon slows background work; the cap keeps
  it from stalling.
- **Default duty 0.2**, leaving margin under the 0.25-core budget.
- **Scope.** The sync source's verify and index build use it. The command's
  cold path keeps its no-sleep mode (the user is waiting). The helper is
  unshipped (LLP 0481 T4), so the change has no compatibility cost. The server
  keeps its elapsed-time helper at 0.18, which meets its budget
  (server LLP 0564); aligning the two is not part of this change set.

**Alternatives.** One default of about 0.08 for everything (4x build about
90 s): slow, and still guessing at the multiplier. Default 0.12 with verify at
half duty: a second per-path multiplier to maintain. Both keep measuring
something other than what the budget limits.

## Build memory: per build {#memory}

LLP 0484's 1x bound (peak increase at most 256 MB) is **per build**: the peak
over that build's own pre-build baseline. T11 measured 31 to 136 MB per 1x
build.

Across back-to-back 1x refreshes, process RSS climbed from about 220 MB to
about 530 MB and levelled off; after a 4x build the processing child held about
760 MB for over 60 seconds against a 183 MB live index. That is V8 keeping
its heap high-water mark, not a leak, and real refreshes are rare (polls at
least five minutes apart, new generations about daily). So:

- T11 asserts **no growth**: RSS after ten back-to-back 1x refreshes is at
  most RSS after the third plus 32 MB.
- The plateaus are recorded as a known cost in `docs/CONFIGURATION.md`
  (LLP 0481 T12's path table).
- Follow-up, not v1, only if LLP 0481 T13 or real use shows the footprint
  matters: build the index in a worker thread so its heap is freed when the
  worker exits.

## Consequences {#consequences}

- T11 (implementer-5) changes the helper and its tests (fake CPU clock: sleep
  follows measured CPU, capped at 2 s, abortable) and reruns the four stress
  runs, asserting the worst 10-second window of attributable whole-process CPU
  is at most 0.25 cores at the default, including verify at 4x, plus the
  no-growth check.
- CPU and memory: bounds background CPU to its stated budget; no memory
  change.
