# LLP 0088: scheduled daemon tick as the projection trigger

**Type:** decision
**Status:** Draft
**Systems:** Daemon, Graph
**Author:** Phil / Claude
**Date:** 2026-07-07
**Related:** LLP 0086, LLP 0087, LLP 0089, LLP 0013, LLP 0017, LLP 0028

## Decision

Automatic projection fires on a **scheduled interval inside the daemon**, reusing
the shape of the existing cache-maintenance loop
([`runtime.js` maintenance tick](../src/core/daemon/runtime.js)): a config-driven
interval, an `unref()`'d timer, a single-flight guard, a per-tick time budget, and
error isolation. It does not fire on a per-commit or post-settle event.

## Alternatives considered

**Post-settle / commit event hook (rejected).** Projecting incrementally the
moment new source rows commit gives the freshest possible graph. But it requires a
kernel commit/settle seam that LLP 0023 explicitly noted does not exist, and it
couples derivation latency to the capture hot path, reintroducing the exact
blocking risk LLP 0023 feared. The graph answers "what happened," so real-time
freshness buys little ([LLP 0086 R5](./0086-automatic-derivation.spec.md#requirements)).

**Subprocess per tick (rejected as the default, kept as an escape hatch).** The
daemon could spawn a `hyp graph project` child on the interval, the way the
client-action reconciler spawns `hyp backfill`
([LLP 0037](./0037-backfill-on-join.decision.md)), so a heavy projection can never
grow the daemon's own heap. This is full isolation but adds process-spawn overhead
every interval, and the T0 projection is deterministic in-process cache I/O, not
the parquet encoder whose heap behavior motivates subprocess isolation elsewhere.
A derivation that proves heap-heavy can still opt into subprocess execution
([LLP 0089](./0089-bounded-isolated-derivation.decision.md)); the default stays
in-process.

**Scheduled in-process tick (chosen).** It matches a pattern already proven safe
in the daemon, needs no new kernel seam, and is bounded at any interval by its
budget ([LLP 0089](./0089-bounded-isolated-derivation.decision.md)). Eventual
freshness is exactly what the graph needs.

## Cadence

The interval is config-driven (see the `derive` config block in
[LLP 0091](./0091-automatic-derivation.design.md)). Because each tick is
budget-capped and single-flight, a short interval is cheap: the design picks a
default short enough that the graph feels fresh for interactive queries, while any
value stays safe. The specific default number is a design detail, not part of this
decision.
