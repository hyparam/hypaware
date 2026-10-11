# LLP 0092: automatic derivation - implementation plan

**Type:** plan
**Status:** Draft
**Systems:** Daemon, Plugins, Graph, Config
**Author:** Phil / Claude
**Date:** 2026-07-07
**Related:** LLP 0091, LLP 0086, LLP 0087, LLP 0088, LLP 0089, LLP 0090

> Implementation steps for the automatic derivation designed in
> [LLP 0091](./0091-automatic-derivation.design.md) (spec
> [LLP 0086](./0086-automatic-derivation.spec.md)). Small,
> independently-mergeable tasks: the core registry and the config block first
> (parallel), then the daemon tick loop (the core), then the graph registration,
> closed by a hermetic smoke and the doc/annotation pass. No task touches the
> capture path or the cache schema.

## Tasks

- **T1 - Core derivation registry + activation-context seam.** Add
  `DerivationRegistry` (list + lookup) and `ctx.derivations.register`, wired onto
  the runtime the way `sources`/`sinks` are. Types in a `.d.ts`, imported via
  `@import`. Unit tests: registration, duplicate-name rejection, and the
  `derivationEnabled` resolution rule (global-off, per-derivation override,
  `defaultOn` fallback). No daemon dependency, so it merges alone.

- **T2 - `derive` config block + validation.** Add the top-level `derive` section,
  `normalizeDeriveConfig` (mirroring `normalizeMaintenanceConfig`: `enabled`,
  `interval_minutes`, `max_tick_ms`, `derivations`), and section-scoped validation
  in the layered-config path ([LLP 0031](./0031-layered-config.decision.md)). Unit
  tests: defaults applied, opt-out honored, malformed block rejected. Parallel with
  T1.

- **T3 - Daemon derivation-tick loop.** Add the tick block to
  [`runtime.js`](../src/core/daemon/runtime.js) next to `maintenance.tick`,
  copying its guards (interval, `unref()`, single-flight, budget, span,
  catch-to-log, shutdown drain). Depends on T1 + T2. Unit test with a fake
  derivation and fake timers (mirror the maintenance-loop tests): fires on
  interval, single-flights an overrun, isolates a throwing derivation, drains on
  shutdown, and respects opt-out.

- **T4 - Graph plugin registers its projection.** In `@hypaware/context-graph`
  `activate()`, register `graph project` as a `defaultOn: true` derivation wrapping
  `projectGraph` ([LLP 0091 §4](./0091-automatic-derivation.design.md)). Keep the
  `hyp graph project` command intact (one engine, two drivers). Unit test: the
  registered `run` projects the same rows the command does.

- **T5 - Hermetic smoke.** Boot the daemon with the graph derivation and captured
  fixture rows; assert `node`/`edge` rows appear with no manual `graph project`;
  assert `derive.enabled: false` suppresses it; assert the `derivation.tick` span /
  `daemon.derivation_ran` log fired with row counts (log-driven, R10). Stable
  `DEV_RUN_ID` / `smoke_name` / `smoke_step`.

- **T6 - Docs + annotations.** Land the LLP 0023 §on-demand-projection
  superseded-by note (already staged with this set); flip this doc set from Draft
  as it lands; add `@ref LLP 0087/0088/0089/0090/0091` annotations on the daemon
  tick loop, the registry seam, and the graph registration; refresh the
  [LLP 0000](./0000-hypaware.explainer.md) subsystem map if the Graph/Daemon entry
  needs it.

## Ordering

T1 and T2 in parallel, then T3 (the core), then T4. T5 and T6 close the set once
projection runs automatically end to end. Follow-ons (incremental cursor,
auto-compaction, enrichment ongoing regime) are explicitly deferred by
[LLP 0091](./0091-automatic-derivation.design.md#follow-ons-out-of-this-slice).
