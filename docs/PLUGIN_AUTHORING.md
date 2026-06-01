# Authoring a HypAware plugin

This guide takes you from nothing to a working, validated plugin. The
fast path is two commands:

```sh
hyp plugin new @yourorg/my-thing --kind source   # scaffold
hyp plugin doctor ./my-thing                      # validate
```

`hyp plugin doctor` runs static checks **and** a dry-run of your
`activate()` function, then prints every problem at once with a fix for
each. Run it after every change. It also accepts `--json` for use by
agents and scripts.

> The dry-run imports and runs your entrypoint **in-process**, isolating
> only its state/cache/temp paths to a throwaway directory — it is not a
> security sandbox. Run the doctor only on plugin code you trust, just as
> you would before installing it.

A plugin is two things:

1. a **manifest** (`hypaware.plugin.json`) that *declares* what the
   plugin contributes, and
2. an **entrypoint** (`src/index.js`) that exports `activate(ctx)` and
   *registers* those contributions at runtime.

The doctor's most important check is that these two agree: anything you
declare in the manifest must actually be registered in `activate()`.

---

## Quickstart

```sh
# 1. Scaffold (kinds: source | sink | dataset)
hyp plugin new @yourorg/widget --kind source --dir hypaware-core/plugins-workspace

# 2. Edit src/index.js — fill in the TODOs in activate()

# 3. Validate
hyp plugin doctor hypaware-core/plugins-workspace/widget
```

The scaffold is intentionally minimal and passes the doctor out of the
box, so you always start from green and edit toward your feature.

---

## Manifest

`hypaware.plugin.json` lives at the plugin root. Required and optional
fields (validated by `src/core/manifest.js`):

| Field | Required | Notes |
|-------|----------|-------|
| `schema_version` | yes | Must be `1`. |
| `name` | yes | Scoped, `@scope/slug` by convention, e.g. `@yourorg/widget`. |
| `version` | yes | Semver `X.Y.Z`. |
| `hypaware_api` | yes | Semver **range** against the kernel API, e.g. `^1.0.0`. |
| `runtime` | yes | `"node"` (the only V1 runtime). |
| `entrypoint` | yes | Path to the module exporting `activate`, e.g. `./src/index.js`. |
| `node_engine` | no | e.g. `">=20"`. |
| `description` | no | One line; shown in help. |
| `permissions` | no | String array, e.g. `["network", "read_env"]`. |
| `requires` | no | `{ plugins?, capabilities? }` — see [Capabilities](#capabilities). |
| `provides` | no | `{ capabilities? }` — see [Capabilities](#capabilities). |
| `contributes` | no | What the plugin adds: `sources`, `sinks`, `datasets`, `commands`, `skills`, `init_presets`, `config_sections`, `client`. |

Each entry under `contributes.{sources,sinks,datasets,commands,skills,init_presets}`
needs a non-empty `name`; `config_sections` entries use `section`.

---

## The `activate(ctx)` contract

The entrypoint exports one function:

```js
// @ts-check

/**
 * @import { PluginActivationContext } from '<path>/collectivus-plugin-kernel-types.d.ts'
 */

const PLUGIN_NAME = '@yourorg/widget'

export async function activate(ctx) {
  // Register everything the manifest declares. Do NOT do real work
  // (open sockets, read large config, hit the network) here — defer
  // that to a source's start() or a sink's create().
}
```

`activate()` runs once at boot. Its job is to *register* contributions
on the registries hanging off `ctx`. The kernel handles dependency
order, paths, logging, and lifecycle. `ctx` gives you:

- `ctx.sources`, `ctx.sinks`, `ctx.query`, `ctx.commands`, `ctx.skills`,
  `ctx.initPresets`, `ctx.configRegistry` — the registries.
- `ctx.requireCapability(name, range)` / `ctx.provideCapability(name, version, value)`.
- `ctx.config` — the validated config slice for this plugin.
- `ctx.paths` — `{ rootDir, stateDir, cacheDir, tempDir }`, created for you.
- `ctx.log` — structured logger; `ctx.log.info('event', { ... })`.
- `ctx.permissions` — check declared permissions.

> **Style** (see `CLAUDE.md`): JavaScript, no semicolons, JSDoc types.
> Declare type imports with `@import` at the top of the file; never use
> inline `import('...')` types or `@typedef`. Define shared types as
> `interface`s in a `.d.ts` and `@import` them.

### Registering sources

A source produces rows and owns a lifecycle. Declare it in the manifest
(`contributes.sources: [{ name: "widget" }]`) and register it:

```js
ctx.sources.register({
  name: 'widget',
  plugin: PLUGIN_NAME,
  summary: 'Widget event source',
  configSection: 'widget',
  async start(startCtx) {
    // Read startCtx.config, begin producing rows.
    return {
      async status() { return { state: 'ready' } },
      async reload(reloadCtx) { /* config changed */ },
      async stop() { /* clean up */ },
    }
  },
})
```

### Registering sinks

A sink is an export target. Declare `contributes.sinks: [{ name, supports }]`
and register a `create()` that returns a `Sink`:

```js
ctx.sinks.register({
  name: 'widget',
  plugin: PLUGIN_NAME,
  supports: ['queryable'], // or []
  async create(sinkCtx) {
    return {
      async exportBatch(batch) {
        // Write batch.partitions to your destination.
        return { status: 'exported', partitionsExported: batch.partitions.length }
      },
      async close() {},
    }
  },
})
```

Blob sinks pair with an encoder (`hypaware.encoder`) or table-format
writer (`hypaware.table-format`); see [Capabilities](#capabilities).

### Registering datasets

Declare `contributes.datasets: [{ name }]` and register a schema plus
the partition/row callbacks:

```js
ctx.query.registerDataset({
  name: 'widget_events',
  plugin: PLUGIN_NAME,
  schema: [
    { name: 'event_time', type: 'TIMESTAMP', nullable: false },
    { name: 'message', type: 'STRING', nullable: true },
  ],
  primaryTimestampColumn: 'event_time',
  async discoverPartitions() { return [] },
  async refreshPartition() { return { rowCount: 0 } },
  createDataSource() {
    return { async *[Symbol.asyncIterator]() { /* yield rows */ } }
  },
})
```

Column `type` is one of `STRING | INT32 | INT64 | DOUBLE | BOOLEAN | TIMESTAMP | JSON`.

### Registering commands

Declare `contributes.commands: [{ name }]` and register a `run`:

```js
ctx.commands.register({
  name: 'widget sync',
  plugin: PLUGIN_NAME,
  summary: 'Sync widgets now',
  usage: 'hyp widget sync',
  run: async (argv, runCtx) => { runCtx.stdout.write('ok\n'); return 0 },
})
```

### Skills

Materialize a skill into client skill directories. Declare
`contributes.skills: [{ name, clients }]` and register:

```js
ctx.skills.register({
  name: 'hypaware-widget',
  plugin: PLUGIN_NAME,
  clients: ['claude', 'codex'],
  sourceDir: '/abs/path/to/skill/dir',
})
```

### Init presets

Declare `contributes.init_presets: [{ name }]` and register a `run` that
writes a starter config:

```js
ctx.initPresets.register({
  name: 'widget',
  plugin: PLUGIN_NAME,
  summary: 'Initialize HypAware pointed at widget',
  run: async (argv, runCtx) => 0,
})
```

---

## Capabilities

Capabilities are versioned contracts between plugins. To **provide** one,
declare it in the manifest and call `provideCapability` in `activate()`:

```jsonc
// manifest
"provides": { "capabilities": { "hypaware.blob-store": "1.0.0" } }
```

```js
ctx.provideCapability('hypaware.blob-store', '1.0.0', blobStoreImpl)
```

To **require** one, declare the range and resolve it at use time:

```jsonc
"requires": { "capabilities": { "hypaware.ai-gateway": "^1.0.0" } }
```

```js
const gateway = ctx.requireCapability('hypaware.ai-gateway', '^1.0.0')
```

The doctor checks that every required capability is provided by some
bundled or installed plugin (`hyp plugin list` shows what is available).

---

## Config sections

If your plugin reads config, document the section in the manifest
(`contributes.config_sections: [{ section, summary }]`). To have the
kernel *validate* that section, register a validator:

```js
ctx.configRegistry.registerSection({
  section: 'widget',
  plugin: PLUGIN_NAME,
  validate(raw) { return { ok: true } },
})
```

Registering a validator is optional — a declared section without one is
documented but unvalidated.

---

## Permissions

Declare what the plugin needs in `manifest.permissions` (e.g. `network`,
`read_env`, `read_state`, `write_state`). At runtime, check before use:

```js
if (ctx.permissions.has('network')) { /* ... */ }
ctx.permissions.require('network') // throws if not granted
```

---

## Logging and errors

Use `ctx.log` with structured fields, not `console.log`:

```js
ctx.log.info('widget.sync', { component: 'widget', operation: 'sync', status: 'ok', count })
```

Tag thrown errors with a stable `hypErrorKind` so telemetry and smokes
can group them:

```js
const err = new Error('widget endpoint unreachable')
/** @type {any} */ (err).hypErrorKind = 'widget_unreachable'
throw err
```

Keep dev telemetry local and secret-safe: no credentials, raw prompts,
or private data — hash or redact when identity matters (see `CLAUDE.md`).

---

## Troubleshooting (doctor diagnostics)

Every `hyp plugin doctor` finding has a stable `kind`. What each means
and how to fix it:

| `kind` | Meaning | Fix |
|--------|---------|-----|
| `manifest_invalid` | `hypaware.plugin.json` is missing, not JSON, or fails validation | Compare against [Manifest](#manifest); `hyp plugin new` emits a valid one |
| `entrypoint_missing` | `entrypoint` doesn't resolve to a file | Create the file or fix the path (usually `./src/index.js`) |
| `semver_invalid` | `version` isn't `X.Y.Z`, or `hypaware_api` isn't a valid range | Use `"1.0.0"` / `"^1.0.0"` |
| `name_convention` (warn) | `name` isn't `@scope/slug` | Rename to a scoped form |
| `contributes_malformed` | A `contributes` entry is missing its `name`/`section` | Give every entry a name |
| `entrypoint_import_failed` | Importing the entrypoint threw | Fix the syntax/import error shown |
| `activate_missing` | The entrypoint exports no `activate` function | Add `export async function activate(ctx) { ... }` |
| `activate_threw` | `activate(ctx)` threw during the dry run | Only register in `activate()`; defer work to `start()`/`create()` |
| `contribution_not_registered` | Manifest declares something `activate()` never registered | Add the matching `ctx.<registry>.register(...)` call |
| `contribution_undeclared` (warn) | `activate()` registered something the manifest doesn't declare | Add it to `contributes.*` so it appears in help/discovery |
| `capability_unresolved` | A required capability has no provider, or none in the required version range | Install a provider matching the range, widen the range, or drop the requirement |
| `capability_unprovided` (warn) | Manifest says it provides a capability `activate()` never provided | Call `ctx.provideCapability(...)` |

---

## See also

- [`collectivus-plugin-kernel-types.d.ts`](../collectivus-plugin-kernel-types.d.ts) — the full plugin API surface.
- `hypaware-core/plugins-workspace/gascity/` — a complete worked example (source + dataset + commands + init preset + skill).
- `hypaware-core/plugins-workspace/s3/` — a blob-store sink that provides a capability.
