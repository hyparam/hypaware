# LLP 0086: automatic projection of derived datasets

**Type:** spec
**Status:** Draft
**Systems:** Graph, Daemon, Config, Plugins
**Author:** Phil / Claude
**Date:** 2026-07-07
**Related:** LLP 0023, LLP 0017, LLP 0013, LLP 0028, LLP 0024, LLP 0031, LLP 0010, LLP 0006

> The activity graph (and derived datasets like it) must stay fresh on its own.
> Today the T0 projection runs only when an operator types `hyp graph project`
> ([LLP 0023](./0023-context-graph-projection.decision.md#on-demand-projection)),
> so a running install accumulates capture while its graph silently drifts stale
> until someone remembers to re-project. This spec makes the running daemon keep
> derived datasets projected automatically, by default, safely, with a config
> opt-out. It reverses the *default* of LLP 0023 §on-demand-projection while
> keeping the rest of that decision (contracts, ids, merge, dedup, compaction)
> intact: those are exactly what make automatic re-projection safe.

## Motivation

A derived dataset that only updates on a manual command is stale the moment
capture continues. For the activity graph this is a real gap: it is a query
substrate a user hits interactively (`hyp graph neighbors`, SQL over `node`/`edge`),
so "silently stale until a human runs a command" is a poor default. LLP 0023
accepted that staleness because projecting from the daemon risked blocking or
OOMing it. That objection is now answerable (see [R4](#requirements)): the daemon
already hosts bounded background work safely (the cache-maintenance loop,
[LLP 0013](./0013-local-query-cache.decision.md) / [LLP 0017](./0017-daemon-runtime.decision.md)).

The user framed this as "things like the graph," so the requirement is a reusable
mechanism, not a graph-only patch.

## Requirements

- **R1 - Automatic freshness.** A running daemon keeps registered derived datasets
  projected without an operator invoking a command. The T0 activity graph is the
  first such dataset.
- **R2 - On by default.** Automatic derivation is enabled by default for
  deterministic, on-machine, free derivations. This is the reversal of LLP 0023's
  on-demand-only default.
- **R3 - Config opt-out.** A user can disable automatic derivation globally and
  per-derivation, mirroring `query.cache.maintenance.enabled: false`
  ([LLP 0013](./0013-local-query-cache.decision.md)).
- **R4 - Bounded, never harmful.** Automatic derivation must never block, starve,
  or OOM the daemon or its capture path. This is the hard constraint LLP 0023
  raised; here it is a requirement, not a nicety.
- **R5 - Eventual freshness, not real-time.** The graph answers "what happened,"
  so bounded staleness (one tick interval) is acceptable. No per-commit trigger is
  required.
- **R6 - Idempotent and skip-safe.** A tick cut short by its budget, skipped
  because one is in flight, or failed, must leave committed derived data correct
  and must never double-write. LLP 0023's content-addressed ids and pre-write
  dedup already provide this; this spec depends on it.
- **R7 - General seam.** The mechanism is a reusable registration any plugin can
  contribute a derivation into. The graph is the first consumer, not a special
  case.
- **R8 - Cost/exfiltration-gated derivations stay opt-in.** A derivation that
  spends money or sends captured content off-machine (for example the LLP 0028
  T1/T2 enrichment, which runs through the explicit-opt-in `hypaware.completion`
  capability) must NOT be default-on. The default-on policy of R2 is for
  deterministic, on-machine, free derivations only. This mirrors the
  embedder/completion explicit-opt-in rule
  ([LLP 0024](./0024-vector-search-plugin.decision.md#embedding-is-a-separate-capability)).
- **R9 - Manual command stays.** `hyp graph project` / `hyp graph compact` remain
  for on-demand and forced runs, one-off backfills, and non-daemon installs.
  Automatic derivation is additive.
- **R10 - Observable.** Each automatic tick emits a span/log recording which
  derivations ran, rows written, duration, and whether it was skipped or budgeted,
  so a stale graph is diagnosable from telemetry, not guesswork
  (log-driven-development).

## Non-goals

- Real-time or per-commit projection. R5 accepts eventual freshness; a kernel
  commit/settle hook (which LLP 0023 noted does not exist) is out of scope.
- Auto-running model-backed enrichment (R8). Its ongoing regime
  ([LLP 0028](./0028-context-graph-enrichment.decision.md#two-regimes)) is a
  related mechanism the seam may later absorb; this slice does not move it.
- A declarative contract compiler. LLP 0023 already defers that as a later slice.

## Settled by

The choices this spec implies are settled in narrow decisions:
[LLP 0087](./0087-automatic-projection-default.decision.md) (default-on reversal),
[LLP 0088](./0088-scheduled-daemon-tick.decision.md) (trigger),
[LLP 0089](./0089-bounded-isolated-derivation.decision.md) (safety),
[LLP 0090](./0090-general-derivation-seam.decision.md) (general seam). The
buildable design is [LLP 0091](./0091-automatic-derivation.design.md); steps are
[LLP 0092](./0092-automatic-derivation.plan.md).
