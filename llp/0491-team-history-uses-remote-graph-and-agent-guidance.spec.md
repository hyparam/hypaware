# LLP 0491: Team History Uses the Remote Graph and Agent Guidance

**Type:** Spec
**Status:** Accepted
**Systems:** CLI, Graph, Query, MCP, Daemon, Clients, Plugins, Config
**Author:** Phil / Codex
**Date:** 2026-10-09
**Supersedes:** LLP 0479 through LLP 0490 for the client team-graph replica, plugin, planner, commands and enrollment. Shared kernel utilities and ordinary local capture remain.
**Related:** LLP 0023 (local capture graph), LLP 0064 (graph queries), LLP 0213 (graph guidance in the query skill), LLP 0415 (grep migration)

Phil requested removal of the local team graph and a focus on the improved
retrieval instructions. This replaces the earlier request to name and enable
the graph-cache plugin. It does not make replication an optional product mode.

## Product scope {#scope}

Remove the bundled fastask/graph-cache plugin, snapshot sync and verification,
warm and cold indexes, helper processes, replica status/refresh, team-graph
commands, evidence-forwarding wrapper and deferred deterministic planner.
Remove component-specific tests, fixtures and benchmarks with that code.
Do not introduce a replacement plugin or a new deterministic retrieval command.

Keep existing remote SQL, grep and graph-neighbor tools, the server's indexed
session reads and its advertised session_evidence MCP tool. Keep ordinary local
capture and its activity graph. Existing general kernel helpers (including the
cooperative work budget and source status summary) remain independently usable.
Remove the retired commands from the client telemetry allowlist; the server
continues admitting historical event names. No server settings,
indexes or production deployment change in this client PR. Snapshot publication
is not a dependency of the new workflow and must not be enabled for it.

## Agent guidance {#guidance}

Both shipped hypaware-query skills teach the tested remote process:

1. Search compact File node path metadata for feature, action and object terms,
   including alternatives. Inspect the candidates and refine broad/capped matches.
2. Follow specific decision documents, focused tests or feature modules to
   Session nodes. Use natural_key as session_id; prefer the relevant repository.
3. Search a small batch of sessions with explicit session predicates, bounded
   excerpts and at most two concurrent reads. After a miss, reassess the file
   leads before broadening. This checkpoint is not a completeness limit.
4. Read the original exchange around a hit, distinguish it from captured
   instructions and quoted content, and check later relevant sessions for reversal.

The skills name existing CLI and MCP surfaces. They need neither local graph
state nor setup. If the remote graph is unavailable, use message searches and
report that limit. Report freshness only when supplied; capped or partial
results and absent graph links are not proof of absence. Keep test-answer IDs
and filenames out of the skill and selection logic.

## Upgrade behavior {#upgrade}

Do not auto-install or enroll clients in graph-cache. Restore the existing grep
migration unchanged. Phil confirmed that only his development machine can have
the prerelease plugin entries, so ship no legacy-name filter, migration or
snapshot cleanup code. Any cleanup of that machine is a separate local action,
not behavior every client carries. Existing installations use their normal
remote configuration and the updated skills.

## Evidence and verification {#verification}

The same specific onboarding question with improved guidance completed in
110.085 seconds through the remote tools and 142.600 seconds through the local
prototype. Remote graph calls totaled 2.088 seconds; local graph handlers totaled
0.064 seconds. The tool interfaces and agent choices differed, so this is evidence
for simplifying the product, not a controlled estimate of locality's effect or a
production latency promise. The frozen server copy's indexed reads remain the
basis of the comparison. Private transcripts and answer keys stay outside Git.

Verify both client copies stay in sync, all taught commands exist without the
retired plugin, and the removed plugin contributes no commands or background sources. Run traditional tests, typecheck, package inspection
and the relevant boot, remote-query and capture smokes. Leave the PR draft and
unadopted for Phil's review; do not merge or publish from this change.

CPU/memory: removing the replica removes downloads, background refresh, index
construction and helper RSS. Queries keep server-side work bounded through specific
file/session predicates, output limits and concurrency. No new runtime dependency
or retained client graph allocation is introduced.
