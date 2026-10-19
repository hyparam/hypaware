# LLP 0484: Discovery Walks `touched`, and the Build Is Bounded Before It Starts

**Type:** Decision
**Status:** Superseded
**Superseded-by:** [LLP 0491](./0491-team-history-uses-remote-graph-and-agent-guidance.spec.md) (client replication and its commands; shared kernel utilities remain)
**Systems:** Graph, Daemon
**Author:** HypForge designer
**Date:** 2026-10-09
**Extends:** [LLP 0480#discovery](./0480-fastask.design.md#discovery) (which edge kinds discovery follows) and [LLP 0480#index](./0480-fastask.design.md#index) (the build's memory bound)
**Extended-by:** [LLP 0485#memory](./0485-the-client-work-budget-is-clocked-on-process-cpu.decision.md#memory) (the 1x bound is per build; back-to-back refreshes must not grow)
**Related:** LLP 0023 (graph projection), LLP 0481 (plan; tasks T1, T6, T11); server LLP 0554#data-files, server LLP 0556 T1, server LLP 0560

> LLP 0481 T6 (implementer-5, `0f9ab58b`) raised two questions. Discovery
> walks `touched` edges, while the pinned server fixture's Session-to-File
> edges are named `EDITED` and `READ`. And a build's peak process memory is
> about four times the index it produces. This records which edge kinds
> discovery follows, which artifact changes, and the memory bounds T11
> asserts.

## Edge kinds {#edge-kinds}

**Discovery walks `touched` edges into File anchors** and takes their
Session sources as leads, as LLP 0480#discovery says. T6's code stands.

- The server's graph is written by the same projection contracts as the
  client's (server LLP 0010 and LLP 0037 run the client's
  `@hypaware/ai-gateway-graph` contract per org). Its Session-to-File edges
  are `touched` (`ai-gateway-graph/src/graph_contract.js`). The GitHub
  contract's Commit and PullRequest `touched` File edges exist only in the
  server's deployment-wide scope, which org snapshots never carry (server
  LLP 0554#authorization).
- Edge and node type strings are the projectors' vocabulary, passed through
  the snapshot unchanged (server LLP 0554#data-files). The protocol neither
  defines nor translates them.
- The pinned server fixture (server LLP 0556 T1, `5f342be7`) uses `EDITED`,
  `READ` and `CHANGES`, which no projector produces. They are valid for
  format tests, but a client test over them proves anchor resolution only,
  never discovery. **The fixture changes:** a follow-up on server LLP 0556 T1
  renames them to real vocabulary (Session `touched` File for `EDITED` and
  `READ`; PullRequest `touched` File for `CHANGES`) and regenerates the
  manifest and digests; client LLP 0481 T1 then re-pins it, and T6's fixture
  discovery test asserts leads, not only anchors.
- **Guard against vocabulary drift.** The index records a count per edge
  type. When a generation has File nodes but no `touched` edges, the build
  still succeeds, the replica's status records `vocabulary_mismatch` with the
  edge types it did see, discovery answers through the `team_server`
  fallback with that reason, and the span `replica.index` carries
  `error_kind: vocabulary_mismatch`. A future projector rename then shows up
  as a labeled fallback, not as silent empty discovery.

## Build memory {#build-memory}

T6 measured, per fresh process (baseline 51 MB RSS):

| Graph | Index | Peak RSS |
| --- | --- | --- |
| 1x (142,766 nodes, 462,042 edges) | 48 MB | 191 MB (daemon duty), 214 MB (cold) |
| 4x | 179 MB | 525 MB |
| 12x | refused | 871 MB before the refusal |

The extra above the index is short-lived parse garbage and heap headroom, not
retained data. Decision:

- **About four times the index, transient, is accepted for v1.** No tighter
  streaming is required before T8 wires the builder into the daemon.
- **Refuse before building.** The builder refuses a generation whose manifest
  row counts (`files.nodes.rows + files.edges.rows`) times 100 bytes exceeds
  `MAX_INDEX_BYTES` (T6 measured about 79 bytes per row; 100 leaves margin),
  before downloading. The running estimate during the build stays as a second
  check. This keeps an oversized graph from reaching 871 MB on the way to a
  refusal.
- **`MAX_INDEX_BYTES` default becomes 256 MB** (was 512 MB in
  LLP 0480#index). At about four times, 512 MB would allow a transient peak
  near 2 GB in a background process on a laptop. 256 MB admits graphs up to
  about 4.2 times the measured size (the 4x graph's 179 MB index fits) and
  refuses the 12x graph up front.

**Bounds T11 asserts** (process RSS above the pre-build baseline, including
the swap overlap with the previous index):

- 1x: peak increase at most 256 MB; retained index at most 128 MB (target,
  LLP 0480#index).
- 4x: the build completes with a peak increase at most 4.5 times the final
  index bytes plus 64 MB, or is refused up front.
- A generation refused up front: peak increase at most 32 MB (nothing is
  downloaded or parsed).
- Event-loop delay as LLP 0481 T11 already states (p95 at most 20 ms, max at
  most 100 ms), measured at 4x under load.

If T11 fails the 1x bound, tighter streaming (smaller parse batches and
earlier release of decoded rows) becomes required before release.

## Consequences {#consequences}

- T6 follow-up (implementer-5): per-edge-type counts and the
  `vocabulary_mismatch` guard; the up-front refusal from manifest row counts;
  `MAX_INDEX_BYTES` 256 MB; tests for the guard and the up-front refusal.
- Server LLP 0556 T1 follow-up: real edge vocabulary in the v1 fixture.
  Client LLP 0481 T1 re-pins it.
- T11 asserts the bounds above.
- CPU and memory: removes the late-refusal peak; one counter per edge type.
