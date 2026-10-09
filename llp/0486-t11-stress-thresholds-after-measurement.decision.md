# LLP 0486: Fastask Stress Thresholds After Measurement

**Type:** Decision
**Status:** Superseded
**Superseded-by:** [LLP 0491](./0491-team-history-uses-remote-graph-and-agent-guidance.spec.md) (client replication and its commands; shared kernel utilities remain)
**Extended-by:** [LLP 0490](./0490-connected-clients-get-graph-cache-with-isolated-indexes.decision.md)
**Systems:** Daemon, Graph
**Author:** HypForge designer
**Date:** 2026-10-09
**Extends:** [LLP 0485](./0485-the-client-work-budget-is-clocked-on-process-cpu.decision.md) (#decision: the slice time cap; #memory: the no-growth window and the follow-up) and [LLP 0481](./0481-fastask.plan.md) task T11 (the foreground check for OTLP ingest)
**Related:** LLP 0484#build-memory

> LLP 0481 T11 reran the stress suite on the process-CPU budget of
> LLP 0485 (duty 0.2, sleeps capped at 2 s). CPU now passes everywhere. Two
> checks needed a ruling with the data in hand: the memory no-growth window,
> and OTLP ingest latency, which shares the processing child with the build.

## Measurement {#measurement}

LLP 0481 T11 (implementer-5, 2026-10-09 ~06:15Z; evidence
`project/missions/fastask/T11-evidence/` in the HypForge workspace), four
reruns plus a 20-refresh diagnostic on the reference Mac:

- CPU: worst 10-second window 0.219 to 0.246 cores attributable, 4x verify
  included. Per-build memory peaks 0 to 125 MB (bound 256 MB); refusal adds
  at most 0.6 MB; shutdown during a build 34 to 233 ms; event-loop delay max
  at most 47 ms.
- Memory over refreshes: V8 committed heap 185 to 229 MB, heap used and
  typed-array memory flat from build 2 to build 20, so no old index is
  retained. Process RSS climbs only in native memory (RSS minus heap minus
  external: about 121 to 330 MB), reaches about 553 MB by build 6 or 7, then
  stays at 549 to 570 MB through build 20. LLP 0485's check (3rd to 10th
  refresh, at most 32 MB) failed three of four runs (26, 72, 77, 80 MB)
  while the curve was still rising to that plateau.
- OTLP ingest, which runs in the same processing child as the build: median
  latency rose 7 to 21 percent during builds (0.4 to 1.2 ms on about 6 ms),
  measured as the median of 10-second bucket medians against no-build
  windows. Separate 50 to 60 second host episodes at 14 to 17 ms also hit
  no-build windows, so relative medians are noisy. Gateway capture and
  discovery stayed within 10 percent.

## Decision {#decision}

1. **No-growth window: 10th to 20th refresh.** T11 asserts process RSS after
   the 20th back-to-back 1x refresh is at most RSS after the 10th plus 32 MB.
   This replaces LLP 0485#memory's 3rd-to-10th window, which measured the
   climb to the plateau rather than growth past it.
2. **The plateau is a release-note fact.** About 560 MB processing-child RSS
   (about 11 times the 1x index of 48 MB) from native allocator retention. It
   does not depend on back-to-back refreshes: at about one new generation a
   day, a long-running daemon reaches it within a week. LLP 0481 T14's release
   notes state it.
3. **Slice time cap 4 ms** (was 8 ms in LLP 0480#cooperative). The rows check,
   the process-CPU clock, duty 0.2 and the 2-second sleep cap are unchanged.
   This roughly halves how long a foreground request can wait for the current
   slice to end.
4. **OTLP ingest is judged by an absolute ceiling: added median latency
   during builds at most 1 ms**, measured as T11 measured it (median of
   10-second bucket medians, build windows against no-build windows). If the
   4 ms slice does not reach 1 ms, up to 2 ms is accepted when the evidence
   records it. This replaces the 10 percent relative check for OTLP only;
   gateway capture and discovery keep the 10 percent check.

## Rejected or deferred {#rejected}

- **Accept OTLP at 25 percent relative, unchanged slice:** a percentage of a
  6 ms median is fragile against the host noise measured, and it skips a
  cheap, bounded improvement worth measuring first.
- **A worker thread for the build** (LLP 0485's follow-up): not needed for
  OTLP latency, and it would not help memory: a worker thread shares the
  process allocator, so allocator-retained native memory would stay. The
  LLP 0485#memory follow-up therefore becomes **build the index in a
  short-lived child process**, still only if LLP 0481 T13 or real use shows
  the footprint matters.

## Consequences {#consequences}

- T11 (implementer-5): slice time cap 4 ms in the client work-budget helper's
  default, one rerun, the 10th-to-20th no-growth assertion, and the absolute
  OTLP check; record the result against 1 ms (or the accepted 2 ms).
- T14 release notes: the memory plateau.
- CPU and memory: shorter slices add a few more yields per build; no memory
  change.
