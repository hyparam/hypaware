# LLP 0004: Activation, Paths, and State Directories

**Type:** Spec
**Status:** Active
**Systems:** Core
**Author:** Phil / Claude
**Date:** 2026-06-01
**Related:** LLP 0005, LLP 0006, LLP 0012

> How a plugin is activated and what the kernel hands it. Decomposed from
> `hypaware-design.md` (Activation, Sources).

## Activation contract

After dependency resolution ([LLP 0006](./0006-dependencies-and-capabilities.spec.md)),
the kernel calls each plugin's exported `activate(ctx)`. The plugin uses `ctx`
to populate the surfaces its manifest declared — sources, datasets, commands,
init presets, skills, capabilities. Concrete implementations (callbacks,
schemas, render functions) only exist at activation time; anything depending on
them (schema validation, SQL execution, command dispatch into a plugin's `run`)
requires the plugin to be activated first.

```js
export async function activate(ctx) {
  ctx.sources.register({ name, plugin, configSection, start })
  ctx.query.registerDataset({ name, plugin, schema, /* … */ })
  ctx.commands.register({ name, plugin, summary, usage, run })
  ctx.initPresets.register({ name, plugin, summary, run })
  ctx.skills.register({ name, plugin, clients, sourceDir })
}
```

## The activation context

`ctx` carries, per plugin:

- `config` — a fresh slice of this plugin's validated config section
- the registry facades (`sources`, `sinks`, `commands`, `query`, `initPresets`,
  `skills`, `capabilities`)
- `requireCapability(name, range)` — the only sanctioned cross-plugin channel
- scoped paths, a permission context, and a scoped logger

### Same-shape reload

`reload` receives the **same `ActivationContext` shape** as `start`/`activate`,
with a refreshed `config`. A plugin always reads current config from
`ctx.config` and never handles two parameter conventions. See
[LLP 0012](./0012-sources.spec.md#reload-context).

## State directories

The kernel owns managed state under the recording root (`~/.hyp/hypaware/` by
default): per-plugin state dirs, the plugin install root and lock file
([LLP 0007](./0007-plugin-install-and-locking.decision.md)), the cache
([LLP 0013](./0013-local-query-cache.decision.md)), and collection entries
([LLP 0015](./0015-query-and-datasets.spec.md)). Plugins receive scoped paths
and must not reach into each other's directories.
