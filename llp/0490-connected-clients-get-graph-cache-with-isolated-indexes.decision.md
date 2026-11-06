# LLP 0490: Connected Clients Get Graph Cache with Isolated Indexes

**Type:** Decision
**Status:** Superseded
**Superseded-by:** [LLP 0491](./0491-team-history-uses-remote-graph-and-agent-guidance.spec.md) (client replication and its commands; shared kernel utilities remain)
**Systems:** Plugins, Config, Clients, Onboarding
**Date:** 2026-10-09
**Extends:** LLP 0489 (activation and upgrade), LLP 0486 (memory), LLP 0415 (guarded client migration)

Phil requested the name `graph-cache`, automatic installation for central-server
setup and upgrades, and a reduction in the measured memory footprint.

## Activation {#activation}

The bundled plugin is `@hypaware/graph-cache`. Its agent-directed commands,
replica protocol and scope checks remain unchanged. `hyp fastask` and Jev stay
deferred. The existing internal `fastask/*` control routes and telemetry names
remain compatible; the plugin directory and plugin identifier use the new name.

Central-server clients gain the plugin through the existing client config
migration on boot and reload, whether the server connection is new or predates
the release. Connection means an enabled `@hypaware/central` entry with a central
sink origin in the managed central layer. A hand-authored local sink is not
an enrollment (the existing central-enrollment definition). A query-only remote or local gateway does
not qualify. The gateway rider is removed, and the local-only Claude preset stops including
the plugin. A central rider would be wrong too: setup composes the local layer
without central plugins, then drops unmet riders, losing an explicit disable.
One migration covers both setup and upgrades and leaves manual entries intact.

Reuse the grep migration's lock, backup, atomic replacement and concurrency
checks. Preserve unrelated fields and explicit plugin entries, including a
disable in either layer. Never rewrite a central document or create a local
picker answer. Central-only and answer-less installs compose the entry in memory.
The pre-release `@hypaware/fastask` config name normalizes to the new name,
including its enabled flag; an existing canonical entry takes precedence.
The new plugin has its own state directory and downloads a fresh verified copy.

The shipped query skills still teach discovery, traversal, session search and
original evidence reads. Their availability guard describes automatic upgrades
and preserves remote-tool fallback without telling the agent to run setup.

## Memory {#memory}

Snapshot verification also runs in an isolated process that exits before index
construction starts. In full-daemon testing, verification allocations grew the
parent even after index construction was isolated. The verifier uses the same
streaming digests, line-size bound, abort path and work budget as in-process sync.

One isolated Node process owns each warm generation. Build and query that index
in the same process; only bounded query inputs and results cross IPC. Building
in a child and deserializing the entire index back into the daemon failed the
experiment: memory still grew and bulk deserialization stalled its event loop.

Keep the old owner available while a replacement builds. Activate only after
the build succeeds, then terminate and await the old process. At most one active
owner and one candidate exist. Failed candidates, withdrawal, expiration and
shutdown retire their owners. A disconnected parent makes its child exit.
A dead owner makes the warm route unavailable and the next sync rebuilds it.
Cold CLI reads remain in-process because the CLI exits after the query.

Children receive no inherited credentials, preload hooks or recording environment.
Helpers use V8's `--optimize-for-size` to collect build garbage sooner rather
than expanding the heap for throughput. A measured-size isolated build fell
from about 227 MiB peak RSS to 131 MiB with this flag. Builds retain the
cooperative work budget and sleeps. Replies are encoded once in the helper and
forwarded without parsing and re-encoding their objects in the daemon. A single post-build garbage
collection runs only in the isolated owner. Query IPC allows at most 16 pending
calls, a 5-second deadline and a 2 MiB response cap. Recheck servability after
awaiting a query so a withdrawal or generation swap cannot return stale evidence.
Telemetry includes the owner PID and RSS at build completion alongside index bytes.

The 256 MiB index estimate remains an admission bound, not an RSS ceiling. Count
all graph processes when measuring memory and CPU, including old/new overlap.
The experiment at 142,766 nodes and 462,042 edges reduced end-of-run memory from
about 461 MiB in one repeatedly building process to about 259 MiB across parent
and owner after 20 replacements. These are synthetic fixture measurements, not a
fleet guarantee or a week-long soak. Full-daemon results belong with the benchmark.

## Validation {#validation}

Exercise new and upgraded central clients, local-only installs, explicit disables,
pre-release names, read-only/central-only config and repeat boots. Check helper
exit, bounded IPC, build failure, swap, withdrawal and shutdown. Run the existing
replica authorization and command tests, hermetic flows, and measured-size daemon
stress with aggregate process accounting. No production rollout is implied:
server snapshots still require `HYPSERVER_GRAPH_SNAPSHOTS=1`, a server restart and
a successfully published generation.

## Measured outcome {#measured-outcome}

Final full-daemon run: Node 24.2.0, Apple M4 Max, macOS 25.5.0. Synthetic
142,766-node / 462,042-edge graph, 20 refreshes at the production work budget,
then a 4x graph. All 32 resource and lifecycle checks passed. The processing
process and all graph helpers are summed; the separate gateway is reported
separately by the benchmark.

- Current-size index: 48.8 MiB estimated; 411 MiB aggregate RSS after refresh 20.
- RSS after refresh 10: 391 MiB; growth to refresh 20: 20 MiB (bound 32).
- Peak aggregate RSS during 1x refreshes: 551 MiB; largest per-refresh increase:
  173.9 MiB (bound 256). Old/new overlap is included.
- 4x index: 189 MiB estimated; 674.8 MiB settled RSS, 815.2 MiB peak.
- Background CPU: 0.217 cores mean, 0.236 maximum measured 10-second window.
- Warm discovery under refresh: 9.74 ms median, 13.79 ms p95; no failed queries.
- All helpers exited on shutdown; processing shutdown took 33 ms.
- 1,304 concurrent capture smoke runs passed.

The external process sampler runs every 250 ms. A retired child's CPU tail
shorter than that interval may be missed; CPU measurements are approximate.
The runner explicitly samples after retirement when recording post-refresh RSS.
Two earlier runs needed post-analysis of their stored raw samples because their
last pre-readiness sample could still contain the old owner. Their peaks were
not changed and their memory failures were not waived. The final run uses the
fixed sampling boundary directly.

CPU/memory review: no unbounded helper or request accumulation was found.
Transient old/new overlap remains intentional, and the fixed index estimate
ceiling is not presented as a whole-process RSS limit. Build garbage is reclaimed
on process exit; no new runtime dependency or global daemon V8 flag is added.
