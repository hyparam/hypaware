# LLP 0512: Local session graph projects automatically

**Type:** Spec
**Status:** Accepted
**Systems:** Graph, Sources, Plugins
**Author:** Phil / Codex
**Date:** 2026-10-16
**Extends:** LLP 0023, LLP 0392
**Related:** LLP 0012, LLP 0213, LLP 0491

Phil requested automatic local graph projection. GitHub capture already projects
its own dataset; recorded AI sessions must also reach the local graph without
an operator running `hyp graph project`.

## Lifecycle {#lifecycle}

The existing `@hypaware/ai-gateway-graph` connector registers a daemon source.
It requests `project('ai_gateway_messages')` through the graph capability one
second after source start, then checks five minutes after each completed tick.
All session adapters feeding this dataset are covered, including backfill.
CLI activation only registers the source; it starts no background timer.
No new plugin, config key, runtime dependency or kernel capture hook is added.
GitHub retains its existing scoped trigger. Remote team graph behavior from
LLP 0491 is unchanged.

The first tick catches up existing history. Later ticks compare the committed
partition path, epoch and row count and check the dataset's discovered paths
for pending spools. Unchanged ticks perform metadata discovery only. Projection
settles pending rows through its existing query path. Remember the fingerprint
from before projection so writes during the scan remain due; a spool flush can
cause one additional idempotent pass. Restart forgets the fingerprint and
catches up again. Same-count, same-epoch rewrites are not an incremental change
signal; explicit projection and daemon restart still perform a full catch-up.

Only successful projection clears due work. Failures log the dataset and error,
appear in source status, and retry on the ordinary cadence, even when no new
capture arrives. Timer callbacks do not overlap. Stop clears the timer, aborts
in-flight work and awaits it for at most two seconds before returning. The abort
reaches every projection query, and the signal is checked before each graph
write, so no write starts after it; only a write already under way settles. If
that write outlasts the bound, stop returns with a warning log and the write may
settle afterwards, but nothing after it starts. A run that ends under stop is
logged as cancelled, never as completed or as an error, and the next start
catches up because projection is idempotent. No reload-specific settings exist.
Structured start/completion/failure logs complement the engine's existing
`graph.project` spans and write counts.

## Cost and validation {#cost}

This reuses full-history projection, not an incremental engine. Active histories
still incur a full source scan and graph-id dedup scan when changed. The existing
finite query heap budget and cooperative rule-loop yields remain in force;
they do not establish a whole-process RSS ceiling. The timer retains one source
fingerprint, one promise, and status counters, with no growing work queue.
Fingerprint storage and discovery cost grow with partition count. GitHub's
independent projection can overlap a session projection as before independent
manual projections could; content-addressed duplicates remain compactable.

Test startup catch-up, idle skipping, pending-only data, new committed data,
capture during projection, failures and retry, restart, and shutdown. The
existing context-graph smoke must start the registered source and observe nodes,
edges and completion telemetry before invoking the manual command. Preserve
manual idempotency and explicit refresh checks. Review CPU and memory on these
paths and run traditional tests, typecheck and that smoke.
