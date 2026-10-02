[← All documentation](README.md)

---

# Authoring a HypAware plugin

Create a plugin, register its contributions, and check it before enabling it.

`hyp dev plugin doctor` runs static checks **and** a dry-run of your
`activate()` function, then prints every problem at once with a fix for
each. Run it after every change. It also accepts `--json` for use by
agents and scripts.

> The dry-run imports and runs your entrypoint **in-process**, isolating
> only its state/cache/temp paths to a throwaway directory: it is not a
> security sandbox. Run the doctor only on plugin code you trust, just as
> you would before installing it.

A plugin is two things:

1. a **manifest** (`hypaware.plugin.json`) that *declares* what the
   plugin contributes, and
2. an **entrypoint** (`src/index.js`) that exports `activate(ctx)` and
   *registers* those contributions at runtime.

The doctor's most important check is that these two agree: anything you
declare in the manifest must actually be registered in `activate()`.

## Contents

- [Quickstart](#quickstart)
- [Manifest](#manifest)
- [The activate(ctx) contract](#the-activatectx-contract)
- [Capabilities](#capabilities)
- [Config sections](#config-sections)
- [Permissions](#permissions)
- [Logging and errors](#logging-and-errors)
- [Troubleshooting (doctor diagnostics)](#troubleshooting-doctor-diagnostics)
- [See also](#see-also)

## Quickstart

```sh
# Scaffold (kinds: source | sink | dataset)
hyp dev plugin new @yourorg/widget --kind source --dir ./plugins

# Edit ./plugins/widget/src/index.js, then check it
hyp dev plugin doctor ./plugins/widget

# Register the local plugin installation
hyp plugin install ./plugins/widget
```

Enable it by adding `{ "name": "@yourorg/widget" }` to the existing `plugins`
array in your [configuration](CONFIGURATION.md#locate-and-validate-configuration),
then run `hyp config validate` and restart the daemon. Installation alone does
not enable a plugin.

The scaffold is a starting point. Doctor checks the manifest and activation
registrations, but does not prove that a source captures data, a sink exports it,
or a dataset can be queried. Test the contribution you implement in an isolated
installation. For a dataset, run a query that reads its rows as well as doctor.

---

## Manifest

`hypaware.plugin.json` lives at the plugin root. Required and optional
fields (validated by `src/core/manifest.js`):

| Field | Required | Notes |
|-------|----------|-------|
| `schema_version` | yes | Must be `1`. |
| `name` | yes | Scoped, `@scope/slug` by convention, e.g. `@yourorg/widget`. |
| `version` | yes | Semver `X.Y.Z`. |
| `hypaware_api` | yes | A declared API semver range, e.g. `^1.0.0`. Doctor checks its syntax; the runtime does not enforce compatibility against a kernel API version. |
| `runtime` | yes | Must be `"node"`. |
| `entrypoint` | yes | Path to the module exporting `activate`, e.g. `./src/index.js`. |
| `node_engine` | no | Informational, not enforced by the plugin loader. HypAware itself requires Node.js 22.12 or later; use `">=22.12"`. |
| `description` | no | One line; shown in help. |
| `permissions` | no | String array, e.g. `["network", "read_env"]`. |
| `requires` | no | `{ plugins?, capabilities? }`: see [Capabilities](#capabilities). |
| `provides` | no | `{ capabilities? }`: see [Capabilities](#capabilities). |
| `contributes` | no | What the plugin adds: `sources`, `sinks`, `datasets`, `commands`, `skills`, `agents`, `init_presets`, `config_sections`, `client`. |

Each entry under `contributes.{sources,sinks,datasets,commands,skills,agents,init_presets}`
needs a non-empty `name`; `config_sections` entries use `section`.

---

## The `activate(ctx)` contract

The entrypoint exports one function:

```js
// @ts-check

/**
 * @import { PluginActivationContext } from 'hypaware'
 */

const PLUGIN_NAME = '@yourorg/widget'

/** @param {PluginActivationContext} ctx */
export async function activate(ctx) {
  // Register everything the manifest declares. Do NOT do real work
  // (open sockets, read large config, hit the network) here - defer
  // that to a source's start() or a sink's create().
}
```

The type import above resolves through the installed `hypaware` package, which
must be resolvable from your development project. A global CLI installation alone
does not make it resolvable to your editor. The generated scaffold may instead
contain a relative type path to the CLI installation; update that path if you
move the plugin.

`activate()` runs once at boot. Its job is to *register* contributions
on the registries hanging off `ctx`. The kernel handles dependency
order, paths, logging, and lifecycle. Common context members include:

- `ctx.sources`, `ctx.sinks`, `ctx.query`, `ctx.commands`, `ctx.skills`,
  `ctx.agents`, `ctx.initPresets`, `ctx.configRegistry`: the registries.
- `ctx.requireCapability(name, range)` / `ctx.provideCapability(name, version, value)`.
- `ctx.config`: the validated config slice for this plugin.
- `ctx.paths`: `{ rootDir, stateDir, cacheDir, tempDir }`, created for you.
- `ctx.log`: structured logger; `ctx.log.info('event', { ... })`.
- `ctx.permissions`: check declared permissions.

See the [shipped plugin API types](../hypaware-plugin-kernel-types.d.ts) for the
complete context and registration contracts.

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
  schema: {
    columns: [
      { name: 'event_time', type: 'TIMESTAMP', nullable: false },
      { name: 'message', type: 'STRING', nullable: true },
    ],
  },
  primaryTimestampColumn: 'event_time',
  async discoverPartitions() { return [] },
  async refreshPartition() { return { status: 'skipped', rows: 0 } },
  createDataSource() {
    return {
      columns: ['event_time', 'message'],
      scan() {
        return {
          async *rows() {
            yield {
              columns: ['event_time', 'message'],
              cells: {
                event_time: async () => Date.parse('2026-09-01T00:00:00Z'),
                message: async () => 'hello',
              },
            }
          },
          appliedWhere: false,
          appliedLimitOffset: false,
        }
      },
    }
  },
})
```

This example exposes one fixed row through a `ScannableDataSource`. Each cell
is an async function. A real dataset must implement partition discovery and
refresh for its storage, and stream its records from `scan().rows()`. The two
`applied` flags stay false unless the source applies those query hints itself.

Column `type` is one of `STRING | INT32 | INT64 | DOUBLE | BOOLEAN | TIMESTAMP | JSON`.

### Registering commands

Keep the manifest's command name and summary identical to the registration:

```json
{
  "contributes": {
    "commands": [{ "name": "widget sync", "summary": "Sync widgets now" }]
  }
}
```

Register its implementation inside `activate(ctx)`:

```js
ctx.commands.register({
  name: 'widget sync',
  plugin: PLUGIN_NAME,
  summary: 'Sync widgets now',
  usage: 'hyp widget sync',
  run: async (argv, runCtx) => {
    runCtx.stdout.write('ok\n')
    return 0
  },
})
```

Register a plain object. The registry stores a shallow copy of what you pass
and runs its shape checks on that copy, so only *own enumerable* properties
survive: a class instance whose `run()` lives on its prototype, or a member
defined non-enumerable, is refused with `missing run()` even though the
registration visibly declares it. TypeScript cannot warn you here, because it
has no notion of property ownership, so the error arrives at runtime as a
`plugin.activate_failed` log line and the plugin does not load.

Only the four required members are checked, so only they are refused. An
optional member the copy leaves behind (`plugin`, `aliases`, `hidden`,
`audience`, a `help` string) is not refused: registration succeeds and the
command runs with that member simply absent, so a prototype-resident
`aliases` is a dead alias and a prototype-resident `hidden` still lists in
`hyp --help`. Nothing fails, so the only sign is a WARN the registry writes
at register time, on stderr and into the structured log, naming the command
and the members its copy did not carry. `plugin` is worth naming separately,
because the registry derives `category` and `audience` from it: losing it
does not leave a field blank, it files the command under a category named
after the first word of its own name and gives it the `everyday` audience
instead of `operator`. Assign optional members onto the instance too, or
register a plain object.

Every declared command is public CLI surface: it appears in `hyp --help` and
in its group's subcommand table, and a visible diagnostic should carry a
`help` string explaining what its output means. A command whose caller is a
program rather than a person (a wrapper script, an orchestration step another
command drives) is an *internal mechanism*: keep the manifest entry, so a
dispatch miss can still name the owning plugin, and set `hidden: true` on
**both** the manifest entry and the `register` call. The manifest flag governs
the help rendered before boot; the registration flag governs group help after
it.

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

### Agents

Materialize a custom subagent into client agent directories (e.g.
`.claude/agents/`). Unlike a skill, an agent is a single markdown
definition file installed flat as `<agent_dir>/<name>.md`. Declare
`contributes.agents: [{ name, clients }]` and register:

```js
ctx.agents.register({
  name: 'hypaware-widget-analyst',
  plugin: PLUGIN_NAME,
  clients: ['claude'],
  sourceFile: '/abs/path/to/agents/hypaware-widget-analyst.md',
})
```

Only clients whose manifest declares `contributes.client.agent_dir`
receive agents; a target without one is skipped.

Skills and agents are both **client assets** and share one install path:
attaching a client materializes them, and `hyp client skills
install` re-copies both on demand. There is no separate `agents`
command.

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
"requires": { "capabilities": { "hypaware.ai-gateway": "^2.0.0" } }
```

```js
const gateway = ctx.requireCapability('hypaware.ai-gateway', '^2.0.0')
```

Doctor checks required capability ranges against bundled and installed provider
manifests. Its unresolved-capability diagnostic names the providers and versions
it found. `hyp plugin list` lists plugins, not capability versions; inspect a
provider's manifest with `hyp plugin info <name>`.

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

Registering a validator is optional: a declared section without one is
documented but unvalidated.

---

## Permissions

Declare what the plugin needs in `manifest.permissions` (e.g. `network`,
`read_env`, `read_state`, `write_state`). These are declarations, not a security
sandbox or independently granted permissions. Plugins run as your user and can
access its resources. The context helpers check membership in the declared set:

```js
if (ctx.permissions.has('network')) { /* ... */ }
ctx.permissions.require('network') // throws if not declared
```

---

## Logging and errors

Use `ctx.log` with structured fields, not `console.log`:

```js
ctx.log.info('widget.sync', { component: 'widget', operation: 'sync', status: 'ok', count })
```

Tag thrown errors with a stable `hypErrorKind` so logs can group them:

```js
const err = new Error('widget endpoint unreachable')
/** @type {any} */ (err).hypErrorKind = 'widget_unreachable'
throw err
```

Keep logs free of secrets: no credentials, raw prompts, or private data.
Hash or redact values when identity matters.

---

## Troubleshooting (doctor diagnostics)

Every `hyp dev plugin doctor` finding has a stable `kind`. What each means
and how to fix it:

| `kind` | Meaning | Fix |
|--------|---------|-----|
| `manifest_invalid` | `hypaware.plugin.json` is missing, not JSON, or fails validation | Compare against [Manifest](#manifest); `hyp dev plugin new` emits a valid one |
| `entrypoint_missing` | `entrypoint` doesn't resolve to a file | Create the file or fix the path (usually `./src/index.js`) |
| `semver_invalid` | `version` isn't `X.Y.Z`, or `hypaware_api` isn't a valid range | Use `"1.0.0"` / `"^1.0.0"` |
| `name_convention` (warn) | `name` isn't `@scope/slug` | Rename to a scoped form |
| `contributes_malformed` | A `contributes` entry is missing its `name`/`section` | Give every entry a name |
| `entrypoint_import_failed` | Importing the entrypoint threw | Fix the syntax/import error shown |
| `activate_missing` | The entrypoint exports no `activate` function | Add `export async function activate(ctx) { ... }` |
| `activate_threw` | `activate(ctx)` threw during the dry run | Only register in `activate()`; defer work to `start()`/`create()` |
| `contribution_not_registered` | Manifest declares something `activate()` never registered | Add the matching `ctx.<registry>.register(...)` call |
| `contribution_unreadable` | The registration was made, but the doctor would not vouch for it: the name, summary or aliases it re-read off the record the registry holds are not what `register` indexed, so it was left out of the dry-run snapshot | Register a plain object with fixed fields; drop the getter, Proxy, or post-`register()` mutation |
| `contribution_undeclared` (warn) | `activate()` registered something the manifest doesn't declare | Add it to `contributes.*` so discovery and inactive-command ownership stay complete |
| `command_help_drift` | A declared command's manifest summary or `hidden` visibility differs from its registration. An entry with no `summary` at all counts: top-level help then lists the command blank | Make the summary and visibility agree on both sides |
| `command_help_drift` (warn) | `ctx.commands.registerGroup` describes a group the manifest declares no command under | Declare the group's subcommands, or drop the `registerGroup` call |
| `capability_unresolved` | A required capability has no provider, or none in the required version range | Install a provider matching the range, widen the range, or drop the requirement |
| `capability_unprovided` (warn) | Manifest says it provides a capability `activate()` never provided | Call `ctx.provideCapability(...)` |

---

## See also

- [Plugin API types](../hypaware-plugin-kernel-types.d.ts): the shipped context and registration contracts.
- [OTEL integration](../hypaware-core/plugins-workspace/otel/src/index.js): source registration.
- [S3 integration](../hypaware-core/plugins-workspace/s3/src/index.js): a sink and blob-store capability provider.
- [Dataset registry](../src/core/registry/datasets.js): dataset registration and validation.
