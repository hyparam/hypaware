# LLP 0091: automatic derivation - technical design

**Type:** design
**Status:** Draft
**Systems:** Daemon, Plugins, Graph, Config
**Author:** Phil / Claude
**Date:** 2026-07-07
**Related:** LLP 0086, LLP 0087, LLP 0088, LLP 0089, LLP 0090, LLP 0017, LLP 0013, LLP 0031, LLP 0010

> Buildable design for automatic projection of derived datasets.
> `@ref LLP 0086 [implements]` - realizes the spec (R1-R10).
> `@ref LLP 0090 [constrained-by]` - a general derivation registration, not
> graph-specific.
> `@ref LLP 0089 [constrained-by]` - every tick runs under budget, single-flight,
> error isolation, and non-blocking lifecycle.
> `@ref LLP 0088 [constrained-by]` - scheduled in-process tick, reusing the
> cache-maintenance loop shape.

## Shape at a glance

Three parts, each independently mergeable:

1. **A core derivation registry** contributed through the activation context,
   alongside the existing `ctx.commands` / `ctx.verbs` / `ctx.skills` /
   `ctx.query.registerDataset` registrations.
2. **A daemon derivation-tick loop** in
   [`runtime.js`](../src/core/daemon/runtime.js), a sibling of the existing
   `maintenance.tick` block, copying its guards.
3. **A `derive` config block** ([LLP 0010](./0010-config-model.spec.md) /
   [LLP 0031](./0031-layered-config.decision.md)) with a `normalizeDeriveConfig`
   mirroring `normalizeMaintenanceConfig`.

Then the graph plugin registers its projection as the first, default-on
derivation.

## 1. The registry seam

New activation-context registrar `ctx.derivations.register(entry)`:

```
DerivationEntry {
  name: string             // stable id, e.g. 'graph project'
  plugin: PluginName
  defaultOn: boolean       // LLP 0090: per-derivation, not global
  isolation?: 'in-process' | 'subprocess'   // default 'in-process' (LLP 0089 escape hatch)
  run(args: {
    query: QueryRegistry,
    storage: ExtendedQueryStorageService,
    config?: HypAwareV2Config,
    budgetMs: number,
    signal: AbortSignal,
  }): Promise<{ label: string, wrote: number }>
}
```

The kernel keeps a `DerivationRegistry` (list + lookup) built at boot, exposed on
the runtime the way `runtime.sources` / `runtime.sinks` are, so the daemon can
enumerate `runtime.derivations.list()`. Registration only; the registry never
runs anything. A plain `hyp` CLI boot builds the registry but nothing ticks it.

## 2. The daemon tick loop

A new block in `runDaemon`, structured exactly like the maintenance block it sits
next to (interval from config, `unref()`'d `setInterval`, single-flight
`derivationInFlight` guard, `derivation.tick` span, `.catch` to
`daemon.derivation_failed`, and shutdown that clears the handle and awaits any
in-flight tick). Per tick:

```
for (const d of runtime.derivations.list()) {
  if (!derivationEnabled(d, deriveCfg)) continue          // R3 + LLP 0090 resolution
  await d.run({ query, storage, config, budgetMs, signal })  // LLP 0089 budget/abort
}
```

`derivationEnabled(d, cfg)` is the resolution rule:

- global off (`cfg.enabled === false`) - nothing runs;
- else a per-derivation override in `cfg.derivations[d.name].enabled` wins if
  present;
- else fall back to `d.defaultOn`.

So a default-on derivation (graph) needs an explicit `enabled: false` to stop, and
a default-off derivation (enrich) needs an explicit `enabled: true` to start
([LLP 0090](./0090-general-derivation-seam.decision.md)). A `subprocess`
derivation is dispatched by spawning its command child instead of calling `run`
in-process (LLP 0089 escape hatch); the graph is `in-process`.

Daemon-only by construction: the loop lives in `runDaemon`, so `hyp status` and
other plain CLI boots never tick derivations, exactly as the client-action
reconciler is daemon-only ([LLP 0041](./0041-central-config-client-actions.design.md)).
Automatic projection therefore requires the installed daemon; the manual command
([LLP 0086 R9](./0086-automatic-derivation.spec.md#requirements)) covers non-daemon
installs.

## 3. The `derive` config block

A new top-level section (peer of `query`, `plugins`, `sinks`), because a derivation
is plugin/graph-level, not a property of the query cache:

```
derive: {
  enabled: true,          // global opt-out (R3), default true
  interval_minutes: 15,   // default cadence; fresher than the hourly cache loop
  max_tick_ms: 30000,     // per-tick budget (LLP 0089), matches maintenance default
  derivations: {          // per-derivation overrides (optional)
    "graph project": { enabled: true },
    // model-backed derivations stay off unless explicitly turned on:
    // "context-graph-enrich": { enabled: true }
  }
}
```

Defaults mirror `query.cache.maintenance` (`enabled: true`, `max_tick_ms: 30000`),
with a shorter default interval (15 min vs 60) because the graph is user-facing
query data and each tick is cheap under budget + single-flight
([LLP 0088](./0088-scheduled-daemon-tick.decision.md#cadence)).
`normalizeDeriveConfig` supplies these defaults; validation lives with the config
layer ([LLP 0031](./0031-layered-config.decision.md)) and is section-scoped so a
malformed `derive` block is rejected/rolled back like any other.

## 4. What the graph plugin registers

In `@hypaware/context-graph`'s `activate()`, alongside the existing `graph project`
command registration, add:

```
ctx.derivations.register({
  name: 'graph project',
  plugin: PLUGIN_NAME,
  defaultOn: true,
  run: async ({ query, storage, config }) =>
    projectGraph({ query, storage, contracts: requireGraphRuntime().registry.list(), config }),
})
```

It wraps the same engine the command already calls
([`project.js`](../hypaware-core/plugins-workspace/context-graph/src/project.js) /
[`command.js`](../hypaware-core/plugins-workspace/context-graph/src/command.js)), so
there is one projection code path, driven either by the command or by the tick. The
`graph compact` step stays manual in this slice (duplicates are benign and
mergeable per LLP 0023); auto-compaction is a follow-on.

## Observability (R10)

The `derivation.tick` span carries `component=daemon`, `operation=derivation.tick`,
and per-derivation attributes: `derivation` (name), `rows_written`, `duration_ms`,
plus `skipped_in_flight` / `budget_exceeded` flags. A `daemon.derivation_ran`
info log lists which derivations ran and their row counts; failures log
`daemon.derivation_failed` with `error_kind`. A stale graph is then diagnosable
from telemetry (did the tick run? was it budgeted out? did it error?), not by
guesswork.

## Follow-ons (out of this slice)

- **Incremental projection**: a per-source cursor so each tick projects only
  newly-settled rows, bounding tick cost as history grows
  ([LLP 0089](./0089-bounded-isolated-derivation.decision.md#the-growing-scan-follow-on)).
- **Auto-compaction** as a lower-cadence default-on derivation.
- **Absorbing enrichment's ongoing regime** ([LLP 0028](./0028-context-graph-enrichment.decision.md#two-regimes))
  into this seam as a default-off derivation.
