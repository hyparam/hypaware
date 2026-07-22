# LLP 0005: Plugin Manifest

**Type:** Spec
**Status:** Active
**Systems:** Plugins
**Author:** Phil / Claude
**Date:** 2026-06-01
**Related:** LLP 0003, LLP 0006, LLP 0007

> The declarative manifest every plugin ships. Decomposed from
> `hypaware-design.md` (Plugin Manifest).

> **Extended by [LLP 0130](./0130-declarative-picker-descriptors.decision.md).**
> `contributes` gains a declarative `picker` block (label, detect probe
> data, `needs_setup`, `configure_command`) so the init wizard's source
> list is plugin-contributed. Normative prose lands here with the
> implementation.

## One shape, no privileged variant

Every plugin — first-party and third-party — ships the **same manifest shape**.
There is no privileged first-party variant; the kernel cannot tell at load time
whether a plugin is first-party beyond the `@hypaware/` scope check.

## Declarative

The manifest declares what the plugin *requires*, *provides*, and *contributes*.
It enumerates the surfaces the plugin will populate at activation — which is
enough for core to resolve the dependency graph, route argv to the owning
plugin, and list datasets/commands **before any plugin code is loaded**.

```json
{
  "schema_version": 1,
  "name": "@hypaware/gascity",
  "version": "1.0.0",
  "hypaware_api": "^2.0.0",
  "runtime": "node",
  "node_engine": ">=20",
  "entrypoint": "./dist/index.js",
  "permissions": ["network", "read_state", "write_state"],
  "requires": { "plugins": {}, "capabilities": {} },
  "provides": { "capabilities": {} },
  "contributes": {
    "sources": [{ "name": "gascity" }],
    "datasets": [{ "name": "gascity_messages" }],
    "commands": [{ "name": "gascity attach" }],
    "config_sections": [{ "section": "gascity" }],
    "init_presets": [{ "name": "gascity" }],
    "skills": [{ "name": "hypaware-gascity", "clients": ["claude", "codex"] }]
  }
}
```

## Field notes

- **`hypaware_api`** — the kernel API semver range the plugin builds against.
- **`entrypoint`** — a single pre-bundled JS file
  ([LLP 0008](./0008-plugin-runtime-dependencies.decision.md)).
- **`permissions`** — coarse grants (`network`, `read_state`, `write_state`)
  surfaced to the user.
- **`contributes.config_sections`** — declares which config section the plugin
  validates ([LLP 0010](./0010-config-model.spec.md)).
- **`supports`** on sink contributions — feature tags like `queryable`; see
  [LLP 0014](./0014-sinks.spec.md). Named `supports` (not `capabilities`) to
  avoid clashing with the global capability registry.

The category of a plugin (source / sink / client adapter / composition) is
**emergent from the manifest**, not a declared type.
