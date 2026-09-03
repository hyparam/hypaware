# LLP 0090: general derivation registration seam

**Type:** decision
**Status:** Draft
**Systems:** Plugins, Daemon, Graph
**Author:** Phil / Claude
**Date:** 2026-07-07
**Related:** LLP 0086, LLP 0087, LLP 0088, LLP 0089, LLP 0023, LLP 0028, LLP 0024, LLP 0006

## Decision

Core exposes a **derivation registration** on the plugin activation context. A
plugin registers a named derivation during `activate()`: a runnable plus
scheduling metadata and a default-on flag. The daemon ticks every registered
derivation under the LLP 0089 guards. The mechanism is not graph-specific;
`@hypaware/context-graph` is the first consumer.

```
ctx.derivations.register({
  name,        // stable id, e.g. 'graph project'
  plugin,      // owning plugin
  defaultOn,   // see below
  run,         // ({ query, storage, config, budgetMs, signal }) => Promise<result>
})
```

This mirrors the registrations plugins already contribute and the daemon already
drives: sources ([LLP 0012](./0012-sources.spec.md)), sinks
([LLP 0014](./0014-sinks.spec.md)), commands, verbs, datasets, capabilities. Core
owns the registry and the tick; each plugin owns its derivation's runnable, id,
and default-on declaration. Same ownership split as LLP 0023's contract
contribution: a plugin maps *into* a fixed seam core owns, it does not fork it.

The runnable shape is exactly what the graph engine already consumes
(`projectGraph({ query, storage, config })`,
[`project.js`](../hypaware-core/plugins-workspace/context-graph/src/project.js)), so
the graph plugin wraps its existing engine rather than rewriting it.

## Default-on is a per-derivation property, not a global truth

A derivation declares whether it is default-on. This keeps the "automatic by
default" policy ([LLP 0087](./0087-automatic-projection-default.decision.md)) from
silently switching on paid or off-machine work:

- **Deterministic, on-machine, free** derivations declare `defaultOn: true`. The
  T0 activity graph is one.
- **Cost- or exfiltration-bearing** derivations declare `defaultOn: false` and run
  only when the user enables them explicitly. LLP 0028 T1/T2 enrichment is the
  motivating case: it spends model tokens and can send captured content
  off-machine, and it already depends on the explicit-opt-in `hypaware.completion`
  capability ([LLP 0024](./0024-vector-search-plugin.decision.md#embedding-is-a-separate-capability),
  the same rule that excludes the completion providers from default activation in
  the bundled allowlist). A default-off derivation requires an explicit
  per-derivation enable in config; it never rides the global default-on.

## Relationship to enrichment's ongoing regime

LLP 0028 already defines an "ongoing" automatic regime for enrichment (a daily
batch over newly-settled sessions). That is a related but distinct mechanism
(model-backed, batch-API-driven). This seam does not absorb it in this slice;
enrichment keeps its own regime and stays `defaultOn: false` here. Folding the
ongoing regime into this seam is a later slice
([LLP 0086 non-goals](./0086-automatic-derivation.spec.md#non-goals)).
