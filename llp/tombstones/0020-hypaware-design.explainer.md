# LLP 0020: HypAware Design (decomposed)

**Type:** Explainer
**Status:** Tombstoned
**Systems:** Core
**Author:** HypAware team
**Date:** 2026-05-20
**Related:** LLP 0000

> **Tombstoned.** This monolithic design doc was decomposed into the active LLP
> corpus and is kept for provenance only. Its content now lives in:
> Mission/Summary → [LLP 0000](../0000-hypaware.explainer.md); Design Decisions →
> LLP 0003–0017 (see the [subsystem map](../0000-hypaware.explainer.md#subsystem-map)).
> Where this doc and the active LLPs disagree, **the LLPs win** — and note this
> doc describes a target architecture that V1 deliberately diverged from
> ([LLP 0002](../0002-v1-scope.decision.md)).
>
> **Not fully lifted:** the appendix (V1 Parity Table, Interface Definitions,
> Migration Strategy) and the gascity example plugin walkthrough remain here as
> reference; pull them into dedicated LLPs if they become load-bearing again.
> Original body follows verbatim.

---

## Mission

HypAware is a modular logs and telemetry collector that stores data in the
most efficient way possible and surfaces that data for efficient LLM-native
querying.

## Design Summary

HypAware is split into three pieces: a small **core kernel**, a separate
**server package**, and a set of **plugins** that provide every piece of
domain behavior.

### What the core package does

Core is the host runtime. It owns the mechanics that should be identical
for every plugin so that plugins can stay focused on their domain:

- plugin discovery, manifest loading, dependency resolution, activation,
  and lifecycle
- versioned capability registry (`hypaware.ai-gateway`, etc.)
- config parsing, per-plugin section dispatch, and cross-plugin validation
- CLI command registry, dispatch, common flags, help assembly
- source lifecycle: start, stop, reload, status
- sink registry and sink lifecycle
- query dataset registry, SQL execution, read-only query enforcement
- Iceberg-backed cache/storage implementation and freshness checks
- result formatting (table / json / jsonl / markdown)
- managed state directories, lock files, permission prompts

Storage and query are intrinsic, not plugin-provided. Every plugin can
assume Iceberg-backed storage with a SQL surface in front of it, and every
plugin that registers a dataset gets the same query and formatting
behavior for free.

### What the server package does

The server is the enterprise companion: it receives logs forwarded from
HypAware instances across an organization, composes them into files, and
uploads those files to a sink. That is the whole job. Full server design
is **TK** and will land in a separate document.

### Types of plugins

Plugins fall into a handful of categories defined by the capability they
provide or consume:

- **Source plugins.** Produce normalized rows and own a daemon lifecycle.
  Examples: proxy listener, OTLP receiver, gascity supervisor subscriber.
- **Sink plugins.** *Export targets* — not the write path. Every
  HypAware instance lands captured data in a **local Iceberg query
  cache** (intrinsic to core, not a plugin, at a HypAware-managed
  location) where it is queryable until a configurable retention
  window elapses. The cache is not a user-controllable destination;
  if you want data in a layout, location, or format you control, you
  configure a sink. Sinks receive scheduled exports out of the cache.
  Sinks come in two shapes — *blob destinations*
  (`@hypaware/local-fs`, `@hypaware/s3`) paired with a *writer plugin*
  (`@hypaware/format-parquet`, `@hypaware/format-jsonl`,
  `@hypaware/format-iceberg`) that encodes batches into the destination,
  and *request destinations* (`@hypaware/central` forwarding to a HypAware
  enterprise server, `@hypaware/webhook` pushing to an external HTTP
  endpoint) whose wire format is intrinsic. A source plugin never
  depends on a sink — if no sink is configured, data simply lives in
  the cache until it expires. A blob sink whose writer produces a
  format HypAware can read back (Parquet locally or on S3, Iceberg
  on either) can additionally serve as a query target for data beyond
  the cache window.
- **Client adapter plugins.** Wire an external tool to a HypAware
  capability. Claude Code and Codex are adapters that depend on the
  `hypaware.ai-gateway` capability; they write client settings, install
  client-side skills, and may enrich the dataset they feed.
- **Composition plugins.** Things like init presets and skill scaffolds —
  small surface, no daemon — that contribute to the user-facing experience
  without owning data flow.

Every plugin ships the same manifest shape regardless of category. The
category is expressed by what it `requires`, `provides`, and `contributes`.

## V1 Plugins

V1 is "kernel cutover with no user-visible regression": the default
plugin set must reproduce today's behavior end to end. Each plugin
lives in its own repository and is installed by the kernel like any
other external plugin. The local query cache is intrinsic to core and
does not appear in this list.

- **`@hypaware/ai-gateway`** — HTTP/SSE AI gateway source. Provides
  `hypaware.ai-gateway`, registers the `ai_gateway_messages` dataset, owns
  redaction and SSE state.
- **`@hypaware/claude`** — Claude Code adapter. Requires `hypaware.ai-gateway`.
  Settings writer, transcript enricher, Claude skills.
- **`@hypaware/codex`** — Codex adapter. Requires `hypaware.ai-gateway`.
  OpenAI-compatible upstream preset, provider writer, Codex skills.
- **`@hypaware/otel`** — OTLP HTTP listener. Registers `logs`, `traces`,
  `metrics`.
- **`@hypaware/local-fs`** — blob destination on the local
  filesystem; provides `hypaware.blob-store`. Pairs with a writer
  plugin (default `@hypaware/format-parquet`) to land data in a layout
  and location you own. The cache itself is not user-controllable;
  this is how you escape it.
- **`@hypaware/format-parquet`** — writer plugin that encodes batches
  as Parquet. Requires `hypaware.blob-store`. Default writer for
  queryable sinks.
- **`@hypaware/format-jsonl`** — writer plugin that encodes batches
  as JSONL. Requires `hypaware.blob-store`. Useful for grep-friendly
  archives and downstream tools that don't speak Parquet.
- **`@hypaware/central`** — export sink that forwards cache contents
  to a central HypAware server on a configurable schedule. Replaces
  the role of the old Gateway mode. The server itself lives in a
  separate `@hypaware/server` package; the kernel only ever talks to
  it through this sink plugin.

Post-V1 export sinks (`@hypaware/s3`, `@hypaware/webhook`) are not
required for cutover but the design leaves room for them and for
per-source export routing.

`@hypaware/gascity` is intentionally outside the V1 first-party set.
It ships as the **first external plugin** after cutover — same
authoring path any third party would take — and serves as our
dogfood proof that the plugin model works end to end for use cases
the kernel does not bundle. The example plugin walkthrough in the
next section uses it precisely because it is external.

The full feature-to-plugin parity matrix is in the appendix.

## Example Plugin: `@hypaware/gascity`

The canonical external plugin example. Not part of the V1 first-party
set — it is the first plugin shipped through the same install path
any third party would use, and serves as proof that the plugin model
works for use cases the kernel does not bundle.

It registers a source, registers a dataset, contributes a few
commands, contributes an init preset, and installs a skill — roughly
the maximum surface area a single plugin is expected to touch. It
depends on no other plugin; rows land in the local query cache via
core.

### Manifest

```json
{
  "schema_version": 1,
  "name": "@hypaware/gascity",
  "version": "1.0.0",
  "description": "Gascity supervisor source for HypAware",
  "hypaware_api": "^2.0.0",
  "runtime": "node",
  "node_engine": ">=20",
  "entrypoint": "./dist/index.js",
  "permissions": ["network", "read_state", "write_state"],
  "contributes": {
    "sources": [{ "name": "gascity" }],
    "datasets": [{ "name": "gascity_messages" }],
    "commands": [
      { "name": "gascity attach" },
      { "name": "gascity detach" },
      { "name": "gascity list" }
    ],
    "config_sections": [{ "section": "gascity" }],
    "init_presets": [{ "name": "gascity" }],
    "skills": [{ "name": "hypaware-gascity", "clients": ["claude", "codex"] }]
  }
}
```

### Activation

```js
// @hypaware/gascity/src/index.js
import { runAttach, runDetach, runList } from './commands.js'
import { startGascitySource } from './source.js'
import {
  GASCITY_SCHEMA,
  discoverParts,
  refreshPartition,
  createDataSource,
} from './dataset.js'
import { gascityInitPreset } from './init.js'

export async function activate(ctx) {
  ctx.sources.register({
    name: 'gascity',
    plugin: '@hypaware/gascity',
    summary: 'Gascity supervisor subscription source',
    configSection: 'gascity',
    start: startGascitySource,
  })

  ctx.query.registerDataset({
    name: 'gascity_messages',
    plugin: '@hypaware/gascity',
    schema: GASCITY_SCHEMA,
    primaryTimestampColumn: 'event_time',
    discoverPartitions: discoverParts,
    refreshPartition,
    createDataSource,
  })

  ctx.commands.register({
    name: 'gascity attach',
    plugin: '@hypaware/gascity',
    summary: 'Subscribe to a gascity supervisor',
    usage: 'hypaware gascity attach <city|path> [--api-url <url>]',
    run: runAttach,
  })
  ctx.commands.register({
    name: 'gascity detach',
    plugin: '@hypaware/gascity',
    summary: 'Unsubscribe from a gascity supervisor',
    usage: 'hypaware gascity detach <city|path>',
    run: runDetach,
  })
  ctx.commands.register({
    name: 'gascity list',
    plugin: '@hypaware/gascity',
    summary: 'List attached supervisors',
    usage: 'hypaware gascity list',
    run: runList,
  })

  ctx.initPresets.register({
    name: 'gascity',
    plugin: '@hypaware/gascity',
    summary: 'Initialize a HypAware install pointed at gascity',
    run: gascityInitPreset,
  })

  ctx.skills.register({
    name: 'hypaware-gascity',
    plugin: '@hypaware/gascity',
    clients: ['claude', 'codex'],
    sourceDir: new URL('./skills/hypaware-gascity', import.meta.url).pathname,
    projectLocal: true,
  })
}
```

Everything below this point explains *why* each surface in that example
looks the way it does.

## Design Decisions

### Plugin Manifest

Each plugin has a manifest. First-party plugins use the same manifest
shape as third-party plugins; there is no privileged variant.

The manifest is declarative — what the plugin *requires*, *provides*,
and *contributes*. It enumerates the surfaces the plugin will populate
at activation, which is enough for core to resolve the dependency
graph, route argv to the owning plugin, and list available datasets
and commands before any plugin code has been loaded. Concrete
implementations (callbacks, schemas, render functions) only exist at
activation time, so anything that depends on them — schema validation,
SQL execution, command dispatch into a plugin's `run` — requires the
plugin to be activated first.

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
  "contributes": { "sources": [...], "datasets": [...], "commands": [...] }
}
```

### Dependencies and Capabilities

The example plugin has no dependencies — the most common case. Source
plugins do not depend on sinks (the cache is intrinsic) and they do not
depend on each other unless they're an adapter wired to another
plugin's capability. When a plugin *does* need cross-plugin behavior,
it declares one of two kinds of dependency:

- A **plugin dependency** says "this named plugin must be installed and
  activated before me." Used when you specifically need that plugin's
  presence (e.g., adapter plugins that exist *for* it).
- A **capability dependency** says "some plugin must provide this
  versioned API." Used when the implementation is interchangeable.

Capability identifiers are bare names like `hypaware.ai-gateway`; version
requirements travel alongside as a semver range, never baked into the
identifier. Most adapters use both kinds of dependency. `@hypaware/claude`
depends on `@hypaware/ai-gateway` as a plugin (it doesn't make sense without
it) **and** requires the `hypaware.ai-gateway` capability (so a future
drop-in proxy replacement could satisfy the contract):

```json
{
  "name": "@hypaware/claude",
  "requires": {
    "plugins": { "@hypaware/ai-gateway": "^1.0.0" },
    "capabilities": { "hypaware.ai-gateway": "^1.0.0" }
  }
}
```

```js
// In @hypaware/claude's activate():
const proxy = ctx.requireCapability('hypaware.ai-gateway', '^1.0.0')
proxy.registerClient({
  name: 'claude-code',
  defaultUpstream: 'anthropic',
  attach: writeClaudeSettings,
  detach: restoreClaudeSettings,
})
```

A plugin that provides a capability declares its version explicitly
under `provides`:

```json
{
  "name": "@hypaware/ai-gateway",
  "provides": { "capabilities": { "hypaware.ai-gateway": "1.2.0" } }
}
```

Rules:

- Core resolves dependencies before activation.
- Missing or incompatible capabilities fail early, with a clear error.
- Plugin dependencies must be acyclic.
- Plugins must not import another plugin's private files.
- Plugins talk to each other only through `ctx.requireCapability(...)`.

### CLI Registry

Core owns command dispatch and help assembly. Plugins register commands;
core routes argv to the owning command and renders top-level help by
asking the registry.

```js
ctx.commands.register({
  name: 'gascity attach',
  plugin: '@hypaware/gascity',
  summary: 'Subscribe to a gascity supervisor',
  usage: 'hypaware gascity attach <city|path> [--api-url <url>]',
  run: runAttach,
})
```

Plugins may **not** inject options into commands they do not own. That
keeps `hypaware --help` legible and stops one plugin from silently
breaking another. Where cross-plugin extension is genuinely needed, core
exposes typed extension points instead:

- `query.datasets`
- `init_presets`
- `skills`
- source commands
- sink commands

`hypaware status` is core-rendered from the source and sink registries
(name, plugin, lifecycle state, last error, rows written, last export).
Plugins do not register status renderers; if a plugin needs a richer
view it ships its own subcommand (e.g. `hypaware ai-gateway debug`).

### Config Model

Use a breaking v2 config shape. There is no `mode` field and no
architectural role label. A host is described entirely by the plugins
it loads, the sinks (if any) it exports to, and its cache retention
settings.

Example config — proxy + claude + gascity, data lives in the cache:

```json
{
  "version": 2,
  "plugins": [
    {
      "name": "@hypaware/ai-gateway",
      "config": {
        "listen": "127.0.0.1:8787",
        "upstreams": [
          {
            "name": "anthropic",
            "base_url": "https://api.anthropic.com",
            "match": { "path_prefix": "/v1/messages" }
          }
        ]
      }
    },
    { "name": "@hypaware/claude", "config": { "proxy": "@hypaware/ai-gateway" } },
    { "name": "@hypaware/gascity" }
  ],
  "query": {
    "cache": {
      "dir": "~/.hyp/hypaware",
      "retention": { "default_days": 30 }
    }
  }
}
```

Adding a `sinks` block turns the host into one that exports. Each
entry under `sinks` is a user-chosen instance name (used in logs and
status); `plugin` says which sink package implements it; `config`
carries that plugin's settings, schedule, and format. To forward to a
central HypAware server, add:

```json
{
  "sinks": {
    "forward": {
      "plugin": "@hypaware/central",
      "config": {
        "endpoint": "https://hypaware.acme.internal",
        "schedule": "*/5 * * * *",
        "format": "parquet"
      }
    }
  }
}
```

The central server itself is a separate `@hypaware/server` package
(its own binary, its own kernel host); the local kernel never loads
it. A host becomes "the gateway" purely by configuring an
`@hypaware/central` sink. There is no mode flag to keep in sync.

Each plugin validates its own `config` section through core's
validation framework, which is why the example plugin declares
`"config_sections": [{ "section": "gascity" }]` in its manifest. Core
validates cross-plugin references after all manifests are loaded.

The config does not yet expose per-source export routing (e.g. "send
`ai_gateway_messages` to S3 but `logs` to a webhook"). The sinks block
applies to all datasets at V1. This is by design — V1 doesn't need it
— but the shape leaves room for a future `sinks.<name>.datasets` or
top-level `exports` block without breaking changes.

### Setup and Onboarding

The primary way to get a HypAware install on the ground is the
interactive setup:

```text
$ npx hypaware

What do you want to collect? (Space to toggle, Enter to confirm)
  ◉ Claude Code conversations
  ◯ Codex conversations
  ◯ Raw Anthropic / OpenAI API traffic
  ◯ OpenTelemetry (traces, metrics, logs)

Where should HypAware export captured data?
  ◉ Keep local only — query against the cache for the retention window
  ◯ Export to a local directory (Parquet)
  ◯ Forward to a HypAware enterprise server
  ◯ Configure later

Cache retention (days, default 30): 30

✓ Wrote ~/.hyp/hypaware-config.json
✓ Wired Claude Code to use the local proxy
✓ Started the HypAware daemon

Try it:  hypaware query "select * from ai_gateway_messages limit 10"
```

The walkthrough is the canonical first-run experience. It composes
plugin-contributed picks (each source/client plugin registers what it
collects; each sink plugin registers what it exports to) and writes a
config the daemon can load. There are no architectural names like
"standalone" or "gateway" — the user describes what they want to
collect and where they want it to go, and HypAware picks the plugin
set.

The written config enumerates the chosen plugins explicitly in
`plugins[]` — there is no implicit "use defaults" mode. This keeps
`hypaware status` and any future diff against the live config trivially
grep-able and avoids the failure mode where the default set drifts
between releases and silently changes a user's running install. Query
is intrinsic and never appears in `plugins[]`.

**Non-interactive entry.** For scripted installs (CI, fleet
provisioning), `hypaware init <preset>` accepts named presets
contributed by plugins:

```text
$ hypaware init gascity   # writes config for gascity capture w/ defaults
$ hypaware init --from-file ./team-default.json
```

Plugin-contributed presets are named after what they're *for*, never
after an architectural role. A team can ship their own preset (an
internal repo with a `team-default.toml`) and use `--from-file` to
provision a fleet of identical installs. The interactive walkthrough
may also surface these presets as picks where they apply.

### Sources

Source plugins produce normalized rows and own a daemon lifecycle. Core
provides state dirs, the cache write path, query registration APIs,
lifecycle hooks, reload context, and logging — the plugin just
implements `start` and returns a `StartedSource` handle. Rows go to the
intrinsic local query cache; the source does not see sinks at all.

```js
ctx.sources.register({
  name: 'gascity',
  plugin: '@hypaware/gascity',
  summary: 'Gascity supervisor subscription source',
  configSection: 'gascity',
  start: startGascitySource,
})
```

`startGascitySource(ctx)` returns:

```ts
interface StartedSource {
  status?(): Promise<SourceStatus>
  reload?(ctx: ActivationContext): Promise<void>
  stop(): Promise<void>
}
```

`reload` and `start` take the same `ActivationContext` shape; the
context carries a fresh `config` slice, so a plugin reads its current
config from `ctx.config` in both calls and never has to handle two
parameter conventions. Whether the source is a long-lived listener
(proxy, OTLP) or a polling subscriber (gascity) is opaque to core.

### Local Query Cache

The cache is the always-on intrinsic store for captured data. It is
not a plugin and not configurable as a destination — its location is
HypAware-managed (under `~/.hyp/hypaware/` by default; an admin can
relocate the root, but the layout inside it is fixed) and its on-disk
format is an implementation detail.

Every row a source produces is written into the cache. `hypaware
query` runs against it. Retention is **configurable per dataset**;
rows older than the retention window are deleted from the cache
permanently — if the data wasn't exported to a sink before then, it's
gone. This is the central tradeoff to surface to users: the cache is
recent-data only by design.

```json
{
  "query": {
    "cache": {
      "retention": { "default_days": 30, "datasets": { "logs": 7 } }
    }
  }
}
```

Default retention is 30 days. A deployment with no export sink relies
entirely on this window.

### Sinks

Sinks are *export targets*. They receive data out of the cache on a
configurable schedule and ship it somewhere durable. Sinks are the
long-term-storage and downstream-integration story; the cache is the
recent-query story. The two are decoupled: sources write to the cache
only, the export pipeline reads from the cache and pushes to sinks.

There are two sink shapes, because "destination" is two different
kinds of thing:

1. **Blob destinations** — local filesystems and object stores
   (`@hypaware/local-fs`, `@hypaware/s3`, future `@hypaware/gcs`).
   Accept "put these bytes at this path." Format is a separable
   concern: you can write Parquet, JSONL, or Iceberg to any of them.
2. **Request destinations** — endpoints with their own wire protocol
   (`@hypaware/webhook`, `@hypaware/central`). Accept "send this
   structured payload via my protocol." Format is bound to the
   destination — there is no "Parquet to a webhook" use case.

For blob destinations, format is factored out into **writer plugins**
that require a destination capability:

```text
Blob destinations              provide:  hypaware.blob-store@1
  @hypaware/local-fs
  @hypaware/s3

Encoders (per-batch)           require:  hypaware.blob-store
                               provide:  hypaware.encoder@1
  @hypaware/format-parquet
  @hypaware/format-jsonl

Table formats                  require:  hypaware.blob-store
                                         + hypaware.encoder
                               provide:  hypaware.table-format@1
  @hypaware/format-iceberg

Request destinations           (no separable format)
  @hypaware/webhook
  @hypaware/central
```

Bytes flow down, semantics flow up. The Parquet writer doesn't know
or care whether it's writing to local disk or S3; the S3 plugin
doesn't know or care whether it's holding a Parquet file, a JSONL
file, or an Iceberg manifest. Iceberg-on-S3 and Parquet-on-S3 share
the same S3 plugin. Adding GCS later is one plugin and every existing
writer works.

A sink plugin implements an export contract — not a per-row writer:

```ts
interface Sink {
  // Called on the configured schedule. The driver passes a batch of
  // ready partitions from the cache; the sink writes them to its
  // destination and acks.
  exportBatch(batch: ExportBatch, opts: ExportOptions): Promise<ExportResult>
  flush?(): Promise<void>
  close(): Promise<void>
}
```

Concrete plugins shipped or planned:

- **`@hypaware/local-fs`** — blob destination on the local
  filesystem. Provides `hypaware.blob-store`. Queryable.
- **`@hypaware/s3`** (post-V1) — blob destination on S3. Provides
  `hypaware.blob-store`. Queryable.
- **`@hypaware/format-parquet`** — Parquet encoder. Requires
  `hypaware.blob-store`. Default writer for queryable sinks.
- **`@hypaware/format-jsonl`** — JSONL encoder. Requires
  `hypaware.blob-store`.
- **`@hypaware/format-iceberg`** (post-V1) — Iceberg table format.
  Requires `hypaware.blob-store` and `hypaware.encoder` (typically
  Parquet). Owns directory layout, manifests, and snapshot commits;
  delegates byte writes to the underlying blob store.
- **`@hypaware/central`** — request destination forwarding cache
  contents to a HypAware enterprise server. Not queryable on the
  forwarding host; queries against historical data run on the server.
- **`@hypaware/webhook`** (post-V1) — request destination pushing
  batches to an external HTTP endpoint. Write-only.

Config has two shapes, matching the two sink kinds. Blob sinks
compose a writer and a destination:

```json
{
  "sinks": {
    "archive": {
      "writer": "@hypaware/format-iceberg",
      "destination": "@hypaware/s3",
      "config": {
        "bucket": "acme-hyp-archive",
        "prefix": "hypaware/",
        "schedule": "0 * * * *"
      }
    },
    "raw_parquet": {
      "writer": "@hypaware/format-parquet",
      "destination": "@hypaware/local-fs",
      "config": {
        "dir": "/var/log/hypaware",
        "schedule": "0 * * * *"
      }
    }
  }
}
```

Request sinks are one-piece (their wire format is intrinsic):

```json
{
  "sinks": {
    "forward": {
      "plugin": "@hypaware/central",
      "config": {
        "endpoint": "https://hypaware.acme.internal",
        "schedule": "*/5 * * * *"
      }
    }
  }
}
```

`schedule` is a standard 5-field cron expression — chosen over a
friendly DSL because cron expresses "02:00 UTC nightly" naturally
and the kernel only needs to parse one grammar. The cron field lives
on the sink instance regardless of shape.

The kernel validates writer/destination compatibility at config-load
time. A misconfigured sink like `format-parquet` + `@hypaware/webhook`
is rejected with an explicit message — writer `format-parquet`
requires `hypaware.blob-store`; `@hypaware/webhook` provides
`hypaware.http-endpoint` instead — so the failure is configuration,
not runtime.

Sinks (and destinations, and writers) declare what they support in
their manifest using the `supports` list (renamed from the older
`capabilities` array to avoid clashing with the global capability
registry):

```json
{
  "name": "@hypaware/local-fs",
  "provides": { "capabilities": { "hypaware.blob-store": "1.0.0" } },
  "contributes": {
    "sinks": [{ "name": "local-fs", "supports": ["queryable"] }]
  }
}
```

`supports` tags drive validation and feature gating in
`hypaware status` and help output. Recognized tags at V1:
`queryable`. More can land as needed without changing the shape.
Queryability for a blob sink is a property of the
writer/destination pair: a Parquet writer on local-fs is
queryable; a JSONL writer on local-fs is not. The kernel surfaces
the effective `supports` set after resolving the pair.

**Queryable sinks.** A sink whose resolved writer/destination pair
exposes `queryable` adds a read API in addition to its export API;
`hypaware query` can scan its data in place. A typical enterprise
setup pairs a 30-day cache with a queryable sink (local-fs+parquet,
or S3+iceberg) holding years of data; queries transparently span
both. From the user's perspective the cache vs. sink distinction is
invisible. From a cost perspective recent queries stay local and
historical queries reach into the sink.

If no queryable sink is configured, queries simply run against the
cache and the retention window bounds your query horizon.

**Default install.** The walkthrough installs `@hypaware/local-fs` +
`@hypaware/format-parquet` together when the user picks "export to a
local directory," so the common case still feels like one decision.
The two-package install only becomes visible when the user wants a
non-default pairing (e.g., switching to Iceberg or JSONL).

### Query and Datasets

Query and Iceberg storage are intrinsic services. Plugins register
datasets; core handles the rest (SQL, cache cursors, freshness, output
formatting).

```js
ctx.query.registerDataset({
  name: 'gascity_messages',
  plugin: '@hypaware/gascity',
  schema: GASCITY_SCHEMA,
  primaryTimestampColumn: 'event_time',
  discoverPartitions: discoverParts,
  refreshPartition,
  createDataSource,
})
```

A dataset contribution owns:

- name and schema
- source discovery (where do raw partitions live on disk?)
- source-to-row materialization (`refreshPartition`)
- direct parquet discovery when there's no JSONL stage to refresh
- dataset-specific canned query helpers

Core does not hard-code dataset names. `hypaware query` asks the dataset
registry. `hypaware schema gascity_messages` works because the gascity
source registered its schema — not because core knows what gascity is.

### Collect Command

`hypaware collect` is the ad-hoc on-ramp to the dataset registry: it
takes an external JSONL file (or a glob of them) the user already has
on disk and registers it as a queryable table without writing a plugin.
It is a **core command**, not a plugin contribution, because the
collection lands in the intrinsic local query cache and rides the same
dataset registry, partition discovery, and refresh machinery as any
plugin-owned dataset. The only thing that differs is who registers the
dataset entry — the user, at the CLI, instead of a plugin at activation.

Surfaces:

```text
$ hypaware collect <file.jsonl> --name <name> [--replace] [--timestamp-column <field>]
$ hypaware collect --glob <pattern>  --name <name> [--replace] [--timestamp-column <field>]
$ hypaware collect list
$ hypaware collect remove <name-or-table>
```

What core does on `collect <add>`:

1. Normalizes `--name` to a SQL-safe table name (`my-log` → `my_log`).
2. Persists a collection entry under the managed recording root
   (collection name, table name, source path or glob, optional
   timestamp column, `--replace` semantics).
3. Registers a synthetic dataset with the query engine. A file-backed
   collection materializes as a single partition; a glob-backed
   collection materializes as one cache partition per matched file, so
   one logical table can span many JSONL files on disk.
4. Runs a one-shot cache refresh against the new dataset so
   `hypaware query` returns rows immediately.
5. Prints the resolved table name and a ready-to-run query example.

`collect list` and `collect remove` operate on the persisted entries;
removal drops the dataset registration but does not delete the source
files on disk. The `--timestamp-column` hint is what lets `--from` /
`--to` / `--since` filtering work on a user-registered table — without
it the column is treated as opaque.

Collections are stored under the recording root, not in the v2 config
file. They are per-host state (analogous to the lock file), not part of
the configuration a team would commit and share — a collection points
at paths or globs that are only meaningful on the machine that ran
`collect`. If a team wants the same table everywhere, the right
mechanism is a plugin that registers the dataset, not a synced
collections list.

The collect command is intentionally narrow: it does not transform
rows, infer schemas beyond what the JSON shape provides, or own a
daemon lifecycle. If a workload outgrows it — needs normalization, a
live source, redaction, or a custom schema — the next step is to wrap
the same work in a source plugin that registers its own dataset. The
shared registry means nothing about the query surface changes when
that happens.

### AI Gateway as a Plugin

The AI gateway plugin is worth calling out because it's the load-bearing
capability for client adapters and it deliberately knows nothing about
Claude or Codex.

`@hypaware/ai-gateway` owns:

- local HTTP listener
- upstream routing
- SSE capture
- redaction
- request/response recording
- `ai_gateway_messages` dataset registration
- `hypaware.ai-gateway` capability

Client adapters (`@hypaware/claude`, `@hypaware/codex`) require the
`hypaware.ai-gateway` capability and use it to:

- register upstream presets
- attach/detach client settings
- install client-side skills
- enrich rows in `ai_gateway_messages` from local transcripts (Claude only)

The gateway exposes typed hooks (`registerUpstreamPreset`, `registerClient`,
`registerMessageEnricher`) so a new adapter never has to modify gateway
code.

**Naming rule: one source, one table.** Each dataset table has exactly
one producer plugin, and the table is named after that producer
(`ai_gateway_messages`, `gascity_messages`, `logs`, `traces`, `metrics`).
There is no shared `proxy_messages` schema that multiple plugins
contribute to. This keeps schema ownership unambiguous: the producing
plugin evolves its own shape without cross-plugin coordination, and
adapter enrichers/skills compile against a stable, single-owner table.

A different source for similar data — e.g. a `@hypaware/litellm` plugin
that ingests from a LiteLLM gateway's webhook or log API — registers
its own table (`litellm_messages`) under its own name. It is free to
adopt the same column shape as `ai_gateway_messages` if it wants to, but
that is a stylistic convergence between unrelated plugins, not a shared
contract enforced by core. Users who run both and want a unified view
define a SQL view over the union themselves; HypAware does not federate
across producers for them.

This naming pattern extends to other proxy plugins the design
anticipates: a future `@hypaware/mcp-proxy` registers `mcp_proxy_messages`,
a future `@hypaware/http-proxy` registers `http_proxy_messages`, and so
on. The shared substrate is the plugin shape (local listener, upstream
routing, SSE/streaming capture, redaction hooks, structured recording),
not the table.

### Plugin Install and Locking

All plugins — first-party and third-party — install through a single
CLI surface (`hypaware plugin install <name>`). The resolver tries:

1. `@hypaware/<name>` — first-party scope, resolved to
   `github:hyperparam/hypaware-<name>`
2. `@scope/hypaware-plugin-<name>` — third-party scoped, resolved via
   the npm registry to its `repository` URL
3. `hypaware-plugin-<name>` — third-party unscoped, same path as above

Scoped community plugins (`@acme/hypaware-plugin-foo`) must be
installed by full name; short-name resolution can't guess the scope.

**Namespacing (ESLint-style).** Any package the kernel discovers under
`@hypaware/<name>`, `@scope/hypaware-plugin-<name>`, or
`hypaware-plugin-<name>` is expected to expose a HypAware manifest.
Discovery scans filter by these patterns. The `@hypaware/` scope is
reserved for first-party.

**Install path.** The kernel fetches a prebuilt artifact from git: it
clones (or fetches a tarball of) the resolved ref, reads the manifest,
and copies the directory tree into the install root. The plugin's own
CI is responsible for committing its built `dist/` to the release tag
named in the manifest's `version`. The kernel never runs `npm install`
on the user's machine. npm is a naming authority (and a metadata
lookup for third-party scoped plugins), not an install source.

**Install root and lock file.**

```text
~/.hyp/hypaware/plugins/<plugin-name>/
~/.hyp/hypaware/plugin-lock.json
```

Lock entries record: plugin name, installed version, source spec
(including resolved short-name expansion), resolved git commit, the
artifact's content hash, manifest hash, install time, last update
check, and available update metadata. Startup update checks are
best-effort, cached, silent, and share policy with the existing npm
update check.

**Where V1 plugins live.** Each first-party V1 plugin (`@hypaware/ai-gateway`,
`@hypaware/claude`, `@hypaware/codex`, `@hypaware/otel`,
`@hypaware/local-fs`, `@hypaware/format-parquet`,
`@hypaware/format-jsonl`, `@hypaware/central`) lives
in its own `github:hyperparam/hypaware-<name>` repository and is
installed by the kernel through the same code path third-party plugins
use. No first-party monorepo, no privileged workspace resolution — the
kernel cannot tell at install time whether a plugin is first-party
beyond the `@hypaware/` scope check. Kernel CI installs the full
default plugin set from its release tags on every kernel release as
the V1 end-to-end test.

### Plugin Runtime Dependencies

The dependency story is intentionally narrow. Every plugin ships a
self-contained pre-bundled JavaScript entrypoint built by its own CI.
The kernel does not run `npm install` on the user's machine, does not
compile native modules, and does not bring in non-JS runtimes.

V1 supports pure-JS plugins only. The plugin's CI bundles all
transitive deps into the entrypoint named in the manifest. Native
modules and non-JS runtimes (Python, ffmpeg, …) are out of scope; the
kernel does not provide a host-side process supervisor and any
extension that needs one is post-V1 work.

**Deliberately ruled out at V1:** `npm install` at user install time
(too many failure modes), plugin-declared peer deps on host-provided
libs (couples plugins to the kernel version), in-process native
modules (would require a C toolchain on every user's machine), and any
plugin runtime that isn't pure JS in-process.

**Version conflicts** dissolve with bundled output: each plugin's
bundle carries its own copy of its deps. The duplication is real but
predictable — the same tradeoff browser and VS Code extensions make.

**Private files.** Plugins must not reach into each other's
filesystem. The kernel loads each plugin only through its manifest
`entrypoint`; cross-plugin imports must go through
`ctx.requireCapability(...)`. Plugins should declare a package.json
`exports` map that exposes only the entrypoint so a deep import is a
loader error, not a successful coupling.

## Open Questions

- **Per-source export routing.** V1 applies the configured sinks to
  all datasets. The intended shape for per-source routing — extra key
  on the sink (`"datasets": ["ai_gateway_messages"]`) or a separate
  top-level `exports` block — should be decided before a second sink
  ships, so the V1 config doesn't paint us into a corner.
- **Cache eviction vs. export coupling.** Should the cache wait to
  evict a partition until all configured sinks have acked their
  export, or evict purely on retention? The latter is simpler; the
  former protects against data loss if a sink is slow.

### Resolved

- **Export format vocabulary and sink composition.** Resolved: two
  sink shapes. Blob destinations (`@hypaware/local-fs`,
  `@hypaware/s3`) provide the `hypaware.blob-store` capability;
  writer plugins (`@hypaware/format-parquet`,
  `@hypaware/format-jsonl`, `@hypaware/format-iceberg`) require it
  and encode batches into the destination. Iceberg additionally
  requires `hypaware.encoder` since it composes on top of a
  per-batch encoder. Request destinations (`@hypaware/webhook`,
  `@hypaware/central`) stay one-piece because their wire format is
  intrinsic and they share no substrate with the blob sinks. The
  kernel rejects incompatible writer/destination pairings at
  config-load time. The walkthrough installs
  `@hypaware/local-fs` + `@hypaware/format-parquet` together by
  default so the common case remains a single decision; the
  two-package install only surfaces when the user picks a
  non-default pairing.

- **Default config.** Resolved: written out explicitly. `npx hypaware`
  emits the first-party plugin set in `plugins[]` so `hypaware status`
  shows it without inferring an implicit default.
- **`@hypaware/query` as a package identity.** Resolved: query is
  built-in and does not appear in the plugin list at all. No facade
  package.
- **Sidecars.** Resolved: out of V1 scope and removed from the design.
  If a future non-JS extension is needed, it lands as a separate
  proposal then.
- **Capability replacement policy.** Resolved: third-party plugins
  *can* provide replacement implementations for first-party
  capabilities. When two plugins provide the same capability at a
  compatible version, the kernel errors and requires the user to
  disambiguate with an explicit pin in config.
- **Cache retention default.** Resolved: 30 days.
- **Export schedule format.** Resolved: standard 5-field cron. Only
  grammar the kernel parses; the friendly DSL is rejected.
- **Permission prompts.** Resolved: surfaced as context messaging
  during the CLI walkthrough (init/attach flow), not as per-write
  modal prompts. The manifest's `permissions` list drives the copy
  shown to the user; once the walkthrough completes, writes proceed
  without per-action confirmation.
- **Project-local skills.** Resolved: keep `projectLocal` as a
  boolean. `projectLocal: true` copies the skill into the active
  project (`.claude/skills/` or `.codex/skills/`); `projectLocal:
  false` (default) installs into the user-global skills directory.
  Both are valid V1 cases.

---

## Appendix

### Status

Draft for iteration.

This replaces the earlier incremental plugin plan as the target
architecture. The intent is a breaking v2 shape: HypAware becomes a
plugin host. Every plugin — first-party included — lives in its own
repository and is installed by the kernel through the same code path,
while core keeps the platform services that all plugins share. The
central server moves out of the main package entirely and ships as a
separate companion package; the local kernel only ever reaches it
through the `@hypaware/central` sink plugin.

### Goals

- Make sources, adapters, commands, init presets, skills, and dataset
  definitions plugin-provided.
- Keep Iceberg-backed storage and query as intrinsic HypAware services
  with stable APIs that plugins consume.
- Treat the central server as a separate package reached only via the
  `@hypaware/central` sink plugin, rather than a built-in operating
  mode of the kernel.
- Use explicit plugin dependencies and capability contracts instead of
  plugins importing each other directly.
- Allow first-party plugins to provide the default experience, so the
  out-of-the-box path still feels simple even though it is assembled
  from plugins installed at first run.
- Prefer a breaking config shape over compatibility branches. Current
  behavior can be donor code, not the architecture to preserve.

### Non-Goals

- Do not make every platform subsystem optional. Query and storage are
  core services.
- Do not let plugins monkey-patch arbitrary existing CLI parsers.
- Do not require normal users to manually install default plugins for
  the default out-of-the-box experience.
- Do not expose in-process internals as plugin APIs. Plugins communicate
  through versioned capabilities.

### Core vs Plugin Surface (detailed)

**Intrinsic core** owns mechanics that should be consistent for every
plugin:

- plugin loading, manifests, dependency graph, capability registry
- config parsing, config section dispatch, validation diagnostics
- command registration, dispatch, common flags, help rendering
- source lifecycle: start, stop, reload, status
- sink API and registry
- query dataset registry
- Iceberg cache/storage implementation
- SQL execution and read-only query enforcement
- table/json/jsonl/markdown result formatting
- managed state directories and lock files
- permission prompts and policy enforcement

**Plugin-owned surface:**

- source implementations
- sink implementations
- config section schemas
- commands and subcommands
- query dataset definitions
- source discovery
- source-to-row materialization
- canned query commands or query helpers
- skills and project-local skill scaffolding
- init presets
- client attach/detach adapters

### Interface Definitions

The draft public type surface lives in
[`collectivus-plugin-kernel-types.d.ts`](collectivus-plugin-kernel-types.d.ts)
(rename pending alongside the rest of the project). That companion
file covers plugin manifests, dependency declarations, registry
entries, source specs, update metadata, lock files, runtime modules,
activation contexts, paths, logging, permissions, capability
registration, v2 config objects, plugin/sink config instances,
plugin-owned config validators, command registry, command runtime
contexts, source contributions and started source lifecycle handles,
sink contributions and capabilities, row write APIs, query dataset
registration, schemas, partitions, refresh hooks, data sources, scan
APIs, storage service hooks, proxy capability APIs (upstream presets,
clients, message enrichers), and skill and init preset contributions.

Interfaces are still draft-level. The design should be evaluated against
them: if a plugin behavior cannot be expressed through one of these
interfaces, either the behavior is outside v1 scope or the interface set
is missing a deliberate extension point.

### First-Party Plugin Set (per-plugin detail)

#### `@hypaware/ai-gateway`
- Provides the `hypaware.ai-gateway` capability
- Contributes proxy source commands
- Registers `ai_gateway_messages`
- No sink dependency (writes to the local cache via core)

#### `@hypaware/otel`
- Contributes OTLP source
- Registers `logs`, `traces`, and `metrics`
- No sink dependency

#### `@hypaware/claude`
- Requires the `hypaware.ai-gateway` capability
- Contributes Claude Code attach/detach behavior
- Contributes Claude transcript enrichment for `ai_gateway_messages`
- Contributes Claude skills

#### `@hypaware/codex`
- Requires the `hypaware.ai-gateway` capability
- Contributes Codex attach/detach behavior
- Contributes Codex provider config
- Contributes Codex skills

#### `@hypaware/local-fs`
- Blob destination on the local filesystem
- Provides the `hypaware.blob-store` capability
- `supports: ["queryable"]` — pairs with a queryable writer (Parquet,
  Iceberg) to extend the query horizon beyond cache retention
- Distinct from the intrinsic cache: the cache is HypAware-managed
  and not user-controllable, this destination lets users land data
  in a layout they own

#### `@hypaware/format-parquet`
- Writer plugin that encodes export batches as Parquet files
- Requires the `hypaware.blob-store` capability
- Default writer for queryable blob sinks
- Provides the `hypaware.encoder` capability so table-format plugins
  (Iceberg) can compose on top

#### `@hypaware/format-jsonl`
- Writer plugin that encodes export batches as JSONL
- Requires the `hypaware.blob-store` capability
- Non-queryable; useful for grep-friendly archives and downstream
  tools that don't speak Parquet

#### `@hypaware/central`
- Export sink that forwards cache batches to a central HypAware server
- `supports: []` — not queryable from the gateway side; queries
  against historical data run on the server
- Owns outbox semantics: batching, retry, backpressure, credentials
  for the central server endpoint
- Required when a deployment wants the role previously called Gateway

#### `@hypaware/server` (separate package, not loaded by the kernel)
- A separate binary with its own kernel host; lives in its own
  repository and is versioned independently
- Receives forwarded batches from `@hypaware/central` and persists
  them to server-managed storage
- The local kernel never imports or loads this package — the only
  cross-boundary contract is the HTTP/wire format that
  `@hypaware/central` speaks to it

### V1 Parity Table

V1 is complete when every current feature is reachable through plugins
on the new kernel.

| Current feature                                  | Required plugin(s)                                  | Notes                                                                                       |
| ------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Default local recordings + query store           | core (intrinsic cache)                              | The local Iceberg cache is intrinsic; no plugin is required for a host to capture data.     |
| AI gateway capture (HTTP + SSE), `ai_gateway_messages` | `@hypaware/ai-gateway`                               | Provides the `hypaware.ai-gateway` capability; registers `ai_gateway_messages`; owns redaction and SSE state. |
| Claude Code attach/detach, transcript enrichment | `@hypaware/claude` (requires `@hypaware/ai-gateway`) | Adds Anthropic upstream preset, settings writer, transcript enricher, Claude skills.        |
| Codex attach/detach, provider config             | `@hypaware/codex` (requires `@hypaware/ai-gateway`)  | Adds OpenAI-compatible upstream preset, Codex provider writer, Codex skills.                |
| Anthropic / OpenAI-compatible passthrough        | `@hypaware/ai-gateway` alone                         | No client-adapter plugin needed for raw API use; upstreams configured directly.             |
| OTLP traces / metrics / logs                     | `@hypaware/otel`                                    | OTLP HTTP listener; registers `logs`, `traces`, `metrics` datasets.                         |
| `hypaware query` SQL, catalog, schema, status    | core (no plugin)                                    | Query engine and Iceberg cache stay intrinsic; plugins only register datasets.              |
| Registered ad-hoc JSONL as SQL tables            | core (`hypaware collect`)                           | Core command registers a file or glob against the dataset registry; collections persist under the recording root, not the config. |
| Local Parquet export to a user-chosen directory  | `@hypaware/local-fs` + `@hypaware/format-parquet`   | Optional export sink; blob destination paired with the Parquet writer. Default install pairs these together so the common case is one decision. |
| Local JSONL export to a user-chosen directory    | `@hypaware/local-fs` + `@hypaware/format-jsonl`     | Same blob destination, different writer. Non-queryable; for grep-friendly archives.         |
| `npx hypaware` interactive walkthrough           | core + first-party plugin set                       | Multiselect over sources/sinks/retention; replaces the old `init standalone/gateway/server`. |
| Background daemon install                        | core (no plugin)                                    | Daemon supervises whatever sources/sinks the active plugins start; not plugin-owned.        |
| Gateway forwarding to a remote control plane     | `@hypaware/central`                                 | Replaces the old Gateway mode; exports cache batches to the central server on a schedule.   |
| Central server ingest and storage                | `@hypaware/server` (separate package, not loaded by the kernel) | Replaces the old Central server mode; reached from the kernel only via `@hypaware/central`. |

V1 is considered complete when:

- `npx hypaware` on a fresh box walks a user through the multiselect
  setup and produces a working config with no manual plugin install.
- Every command, dataset, init preset, and skill currently shipped is
  reachable through a plugin contribution.
- `hypaware query` returns identical results against the same recordings
  before and after the cutover.
- A host configured with `@hypaware/central` can forward to an
  existing central server without any kernel changes.
- Removing any single first-party plugin from the config disables only
  its own feature surface and does not break the rest.

### Migration Strategy

Because current behavior can break, avoid compatibility branches. Use
current code as donor code.

1. Define core plugin manifest, `.d.ts` types, validators, and host
   context.
2. Build a command registry and route existing top-level commands
   through it.
3. Promote the existing local file/Iceberg path to the intrinsic cache
   service (HypAware-managed, retention-bounded). Build the sink
   registry separately as the export-target plane; the cache is not a
   sink.
4. Build dataset registry and remove hard-coded query dataset names
   from core.
5. Convert proxy into `@hypaware/ai-gateway`.
6. Convert OTLP into `@hypaware/otel`.
7. Convert Claude and Codex attach/enrichment/skills into adapters
   depending on `hypaware.ai-gateway`.
8. Build the interactive `npx hypaware` walkthrough on top of the
   plugin registries (each plugin contributes the multiselect picks it
   owns). Render `hypaware status` from the source and sink registries
   in core. Drop the `init standalone/gateway/server` vocabulary.
9. Replace the old `mode` field: delete it from config, route init
   presets to pick plugin sets instead, and derive the status label
   from active sources and sinks.
10. Extract the central server into a separate `@hypaware/server`
    package (its own repo, its own binary); introduce `@hypaware/central`
    as the export sink that gateways use to reach it (replaces the old
    Gateway-mode wiring). The kernel never loads `@hypaware/server`.
11. Ship the writer/destination pair `@hypaware/local-fs` +
    `@hypaware/format-parquet` as the second V1 export sink: scheduled
    Parquet to a user-chosen directory, queryable. Ship
    `@hypaware/format-jsonl` alongside as the non-queryable variant.
12. Add external plugin install/list/info/remove/update.
13. Delete old direct wiring once first-party plugin tests cover the
    behavior.
14. Ship `@hypaware/gascity` as the first external plugin (separate
    repo, installed through the external plugin install path) — proves
    the install/lock/update flow against a non-bundled plugin and
    re-establishes gascity capture.
