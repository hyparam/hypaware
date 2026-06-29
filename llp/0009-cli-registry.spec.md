# LLP 0009: CLI Registry and Dispatch

**Type:** Spec
**Status:** Active
**Systems:** CLI
**Author:** Phil / Claude
**Date:** 2026-06-01
**Related:** LLP 0003, LLP 0015

> Command registration, dispatch, and help. Decomposed from
> `hypaware-design.md` (CLI Registry).

> **Extended by [LLP 0034](./0034-mcp-host-intrinsic.decision.md).** Query-shaped
> operations register as **verbs** (`ctx.verbs.register`), from which the kernel
> projects *both* a CLI command and an MCP tool — one typed `inputSchema`, no CLI
> ↔ tool drift. Imperative/interactive commands stay `ctx.commands.register`. The
> core `--remote` flag ([LLP 0033](./0033-remote-query-attach.spec.md)) routes a
> verb to a remote MCP tool; being core-defined, it does not violate
> [no cross-plugin option injection](#no-cross-plugin-option-injection). `hyp mcp`
> (serve) is a core command.

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

### Top-level help lists plugin commands without booting

`hyp --help` renders *before* `bootKernel`, so the activated registry holds
only core commands at that point — booting just to populate it would import
every plugin entrypoint and bind the gateway/OTLP listeners some plugins open
during activation. Instead, top-level help reads the same cheap inputs boot uses
for *discovery* — plugin manifests (plain JSON) and the effective config — and
lists the commands each **config-active** plugin *declares* in its manifest
`contributes.commands` ([LLP 0005](./0005-plugin-manifest.spec.md#declarative):
"list datasets/commands before any plugin code is loaded"). The listing is
scoped to the plugins the `config` boot profile would activate, so every command
shown is one that will actually dispatch; a hidden/internal command stays out of
help by being omitted from the manifest (it is still registered imperatively in
`activate`). Discovery is best-effort: if it fails, help degrades to core
commands rather than failing.

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
