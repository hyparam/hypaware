# LLP 0009: CLI Registry and Dispatch

**Type:** Spec
**Status:** Active
**Systems:** CLI
**Author:** Phil / Claude
**Date:** 2026-06-01
**Related:** LLP 0003, LLP 0015

> Command registration, dispatch, and help. Decomposed from
> `hypaware-design.md` (CLI Registry).

## Core owns dispatch

Core owns command dispatch and help assembly. Plugins register commands; core
routes argv to the owning command and renders top-level help by asking the
registry.

```js
ctx.commands.register({
  name: 'gascity attach',
  plugin: '@hypaware/gascity',
  summary: 'Subscribe to a gascity supervisor',
  usage: 'hypaware gascity attach <city|path> [--api-url <url>]',
  run: runAttach,
})
```

The binary is `hypaware`, with `hyp` as an alias
([LLP 0002](./0002-v1-scope.decision.md#packaging-and-cli-identity)).

## No cross-plugin option injection

Plugins may **not** inject options into commands they do not own. This keeps
`hypaware --help` legible and stops one plugin from silently breaking another.
Where cross-plugin extension is genuinely needed, core exposes **typed extension
points** instead:

- `query.datasets`
- `init_presets`
- `skills`
- source commands
- sink commands

## Core-rendered status

`hypaware status` is rendered by **core** from the source and sink registries
(name, plugin, lifecycle state, last error, rows written, last export). Plugins
do not register status renderers; a plugin needing a richer view ships its own
subcommand (e.g. `hypaware ai-gateway debug`).
