# HypAware Implementation Plan

Companion to [`hypaware-design.md`](hypaware-design.md) and
[`collectivus-plugin-kernel-types.d.ts`](collectivus-plugin-kernel-types.d.ts).
The design wins where they disagree; this plan turns it into ordered
work with concrete file targets and a log-driven verification loop
attached to every step.

## Operating Principles

1. **Donor-code migration, not rewrites.** Each piece of current
   behavior moves into a plugin by reorganizing the existing file
   into a plugin tree. We do not reimplement the proxy, the
   recorder, the OTLP collector, the gascity supervisor, the Iceberg
   cache, or the Claude/Codex settings writers. They keep their
   shape and gain a thin manifest + `activate(ctx)` wrapper.
2. **Breaking v2 from the start.** No compatibility branches with
   the v1 `mode/role/sink/upload` config. The kernel speaks v2
   only; a one-shot migrator converts existing `collectivus.json`
   files at first run.
3. **Log-driven verification.** Every step adds OTEL instrumentation
   before it adds behavior. Each commit lands with a smoke command
   that emits a `dev_run_id` across logs/traces/metrics and
   leaves enough evidence in the local cache that `ctvs query` (now
   `hyp query`) can confirm the step worked. A step is not "done"
   until both external assertions and internal telemetry agree.
4. **The kernel observes itself first.** The plugin runtime, the
   capability registry, the sink driver, the cache, the command
   dispatcher — all emit spans/logs/metrics on the same OTLP
   pipeline plugins use. This is the load-bearing invariant: if
   `@hypaware/otel` is even partially wired, the kernel's own
   telemetry tells us what the kernel just did.
5. **One repo per first-party plugin, but a temporary in-repo
   workspace first.** During cutover, every first-party plugin
   lives under `hypaware-core/plugins-workspace/<name>/` with the
   manifest and code laid out exactly as it would in its eventual
   GitHub repo. The "extract to its own repo" step is mechanical
   and gated by a parity smoke that doesn't change with the move.

## Self-Instrumentation Contract

All kernel and first-party plugin code MUST emit telemetry via a
single shared instrumentation module (`@hypaware/core/observability`,
detailed below) so a developer can attribute every observed event to
a concrete subsystem, plugin, or call.

Attribute conventions (snake_case, queryable via
`JSON_VALUE(attributes, '$.key')`):

| Key                  | Meaning                                                                     |
| -------------------- | --------------------------------------------------------------------------- |
| `dev_run_id`         | Per-run id set from `DEV_RUN_ID`; smoke tests propagate to every emission   |
| `hyp_component`      | `kernel`, `plugin-loader`, `cap-registry`, `cmd-dispatch`, `sink-driver`, ... |
| `hyp_plugin`         | Plugin name owning this operation (e.g. `@hypaware/ai-gateway`)             |
| `hyp_capability`     | Capability name when capability registry/lookup is involved                 |
| `hyp_operation`      | `manifest_load`, `dep_resolve`, `activate`, `start_source`, `export_batch` ... |
| `hyp_dataset`        | Dataset name when a row/batch is involved                                   |
| `hyp_sink_instance`  | User-named sink instance from config                                        |
| `status`             | `ok` \| `failed` \| `skipped` \| `degraded`                                 |
| `error_kind`         | Short tag (`config_invalid`, `cap_missing`, `cap_version_clash`, ...)       |
| `smoke_name`         | Smoke command name when invoked under a smoke harness                       |
| `smoke_step`         | Step within a smoke command                                                 |

Signal choice:

- **Traces** for unit-of-work: `kernel.boot`, `plugin.activate`,
  `command.run`, `source.start`, `sink.export_batch`,
  `cap.require`. One root span per kernel boot; plugin activation
  spans are children of `kernel.boot`; command runs are independent
  roots with `parentSpanId` set when invoked from another command.
- **Logs** for discrete decisions: which plugin satisfied a
  capability, which writer/destination pair was chosen,
  validation diagnostics, retry choices, attach/detach outcomes.
- **Metrics** for things we want trended across runs:
  - `hyp_plugins_loaded` (Sum, by plugin)
  - `hyp_capabilities_provided` (UpDownCounter, by capability)
  - `hyp_sources_started` (UpDownCounter, by source name)
  - `hyp_rows_written` (Sum, by dataset, plugin)
  - `hyp_sink_exports_total` (Sum, by sink instance, status)
  - `hyp_sink_export_bytes` (Sum, by sink instance)
  - `hyp_command_runs_total` (Sum, by command, exit_code)
  - `hyp_command_duration_ms` (Histogram, by command)
  - `hyp_query_runs_total` (Sum, by status)
  - `hyp_query_duration_ms` (Histogram)
  - `hyp_query_cache_hits_total` / `hyp_query_cache_misses_total`

Endpoint default: `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318`.
When the OTLP receiver is itself a plugin we're working on, the
kernel falls back to local JSONL (`<state>/dev-telemetry/*.jsonl`)
that the daemon picks up and ingests as soon as the receiver is up.
This loopback is what makes log-driven development viable from the
very first commit.

The instrumentation module is the canonical channel; ad-hoc
`console.log` calls in kernel and first-party code are removed in
the cutover. The only stdout/stderr writes that remain are the ones
the user is meant to read (CLI output, the daemon's "listener
bound" lines).

## Smoke Harness

A single `hyp smoke <name>` command (internal, not user-facing)
runs a named smoke flow with a fresh `DEV_RUN_ID`. The harness:

1. Computes `DEV_RUN_ID=smoke-<name>-<utc>-<pid>`, sets
   `HYP_DEV_TELEMETRY=1`, `OTEL_SERVICE_NAME=hypaware-dev`,
   `OTEL_RESOURCE_ATTRIBUTES=deployment.environment=development`.
2. Brings up a transient HypAware install rooted at a tmpdir
   (`HYP_HOME=$tmp/.hyp`) so the smoke does not touch the user's
   real state.
3. Runs the named scenario from `hypaware-core/smoke/<name>.js`.
4. Calls `hyp query` against the tmp install to verify
   internal sequence (e.g. there should be exactly one
   `plugin.activate` span per configured plugin, all with
   `status=ok`).
5. Exits non-zero on first failed assertion; prints the failing
   `ctvs query` (`hyp query`) the developer can re-run.

Every step below names the smoke flow it adds and the SQL it runs.

## Phase 0 — Project Rename and Branch Reset

Concrete deliverable: the repo at `/Users/phil/workspace/collectivus`
is renamed in-place to `hypaware`, but the npm package keeps
shipping under `collectivus` until parity is proven so the daily
flow doesn't regress.

Steps:

1. **Branch.** `git switch -c hypaware/kernel-cutover`. All Phase 0–9
   work lands on this branch; main keeps shipping v3.x.
2. **Add `@hypaware/core` skeleton** under `src/core/`. This is the
   future kernel: `manifest.js`, `dep_graph.js`, `registry/*.js`,
   `observability/*.js`, `runtime/*.js`. Empty modules with
   `.d.ts` types pulled from
   [`collectivus-plugin-kernel-types.d.ts`](collectivus-plugin-kernel-types.d.ts).
3. **Add the observability module first** (`src/core/observability/`):
   - `tracer.js` — wraps an OTel `NodeTracerProvider` with an OTLP
     HTTP exporter pointed at `OTEL_EXPORTER_OTLP_ENDPOINT`.
     Falls back to a `JsonlExporter` writing to
     `<state>/dev-telemetry/traces-<pid>.jsonl` when the env says
     dev mode and the endpoint is unreachable.
   - `logger.js` — structured logger that emits OTel `LogRecord`s
     and mirrors them to stderr in dev mode for live debugging.
   - `meter.js` — Prometheus-style counters/histograms exported
     via the OTel metric exporter on the same endpoint.
   - `attrs.js` — central place that builds the
     `hyp_component`/`hyp_plugin`/`status`/`error_kind` attribute
     bag; ensures snake_case and bounds high-cardinality values.
   - `span_helpers.js` — `withSpan(name, attrs, fn)` and
     `runRoot(name, attrs, fn)` so kernel and plugins do not
     reach into the tracer directly.
4. **Wire env-driven enable.** `HYP_DEV_TELEMETRY=1` enables the
   exporter; absence disables it cheaply (no-op tracer). Production
   default is on for the OTLP exporter and off for the JSONL
   fallback.
5. **Smoke `core_boot_noop`.** A flow that imports
   `@hypaware/core/observability`, opens a root span
   `kernel.boot`, closes it, and exports. Assertions:
   - logs table contains one `severityText=INFO` row with
     `hyp_component=kernel` and `smoke_step=core_boot_noop`
   - traces table contains one span named `kernel.boot` with
     `durationMs > 0` and `status=ok`
   - metrics table contains `hyp_plugins_loaded` at value 0

SQL the smoke runs:

```sql
select count(*) as n from traces
where serviceName = 'hypaware-dev'
  and JSON_VALUE(attributes, '$.dev_run_id') = '<run-id>'
  and name = 'kernel.boot'
```

## Phase 1 — Manifest, Dependency Graph, Capability Registry

Deliverables:

- `src/core/manifest.js` — loader+validator for `PluginManifest`,
  manifests live as `hypaware.plugin.json` (renamed from the old
  `ctvs.plugin.json`) inside each plugin tree.
- `src/core/dep_graph.js` — toposort over `requires.plugins` and
  `requires.capabilities`, errors on cycles and on missing
  capability providers, errors on duplicate capability providers
  per the resolved policy in `hypaware-design.md` §Resolved.
- `src/core/registry/capabilities.js` — implements
  `CapabilityRegistry` from the types file. Each `provide` /
  `require` emits a log: `cap.provide`, `cap.require_satisfied`,
  `cap.require_missing`. Counter `hyp_capabilities_provided` ticks
  on `provide`.

Instrumentation:

- `manifest.load` span per manifest, with attributes `hyp_plugin`,
  `hyp_manifest_path`, `status`, `error_kind` on failure.
- `dep_graph.resolve` span per kernel boot, attributes
  `hyp_plugin_count`, `hyp_capability_count`,
  `hyp_resolve_order_hash` (so we can detect re-orderings between
  boots).
- Logs whenever a plugin is rejected with `error_kind=cycle`,
  `cap_missing`, `cap_version_clash`, `manifest_invalid`.

Smoke `manifest_dep_resolve`:

- Seeds three temp plugin trees with manifests:
  - `@hypaware/dummy-a` provides `hypaware.dummy@1.0.0`
  - `@hypaware/dummy-b` requires `hypaware.dummy@^1.0.0`
  - `@hypaware/dummy-cycle` requires `@hypaware/dummy-cycle`
- Asserts traces show `manifest.load` for a and b, but
  `dummy-cycle` rejected with `error_kind=cycle`.
- Asserts logs contain exactly one `cap.require_satisfied` event
  for `hypaware.dummy@^1.0.0` with `provider=@hypaware/dummy-a`.

SQL:

```sql
select count(*) from logs
where JSON_VALUE(attributes, '$.dev_run_id') = '<run-id>'
  and body = 'cap.require_satisfied'
  and JSON_VALUE(attributes, '$.hyp_capability') = 'hypaware.dummy'
```

## Phase 2 — Activation Context, Path Service, State Dirs

Deliverables:

- `src/core/runtime/paths.js` — builds `PluginPaths` per plugin
  (`rootDir`, `stateDir=<state>/plugins/<name>`,
  `cacheDir=<state>/cache/plugins/<name>`,
  `tempDir=<os tmp>/<name>-<run-id>`).
- `src/core/runtime/activation.js` — assembles
  `PluginActivationContext`. Wraps every registry call so it auto-
  populates `hyp_plugin` on emitted spans/logs (a plugin can't
  pretend to be a different one without going around the context).
- `src/core/runtime/loader.js` — `import()` the plugin's
  `entrypoint` after manifests are validated; awaits `activate()`
  inside a `plugin.activate` span.

The activation context's `log`, `capabilities`, `commands`,
`sources`, `sinks`, `query`, `skills`, `initPresets` are thin
facades that delegate to the kernel-global registries with
`hyp_plugin=<plugin name>` mixed into every emission.

Smoke `activation_lifecycle`:

- Loads two real-but-empty plugins (`@hypaware/dummy-a`,
  `@hypaware/dummy-b`) that just log `info('hello', {})` in
  `activate`.
- Asserts the traces table has exactly two `plugin.activate`
  spans, both children of the same `kernel.boot` span; both
  `status=ok`.
- Asserts metrics table has `hyp_plugins_loaded` Sum at value 2,
  attributes `hyp_plugin=@hypaware/dummy-a` and
  `=@hypaware/dummy-b` at value 1 each.
- Asserts each plugin's `stateDir` is created under the temp
  install root.

SQL:

```sql
select parentSpanId, name, JSON_VALUE(attributes, '$.hyp_plugin')
from traces
where JSON_VALUE(attributes, '$.dev_run_id') = '<run-id>'
order by startTimestamp
```

## Phase 3 — Command Registry, CLI Bridge, Built-In Commands

Deliverables:

- `src/core/registry/commands.js` — `CommandRegistry` matching the
  types file; sorts commands for help rendering; routes argv to
  the longest matching prefix (`gascity attach` beats `gascity`).
- `src/core/cli/dispatch.js` — replaces `bin/cli.js`'s hard-coded
  `SUBCOMMANDS` set. The new dispatch boots the kernel, loads the
  manifests of installed plugins (in Phase 3 the "installed" set
  is just the in-repo workspace), and then dispatches argv against
  the assembled registry.
- Core commands moved from plugin contributions to direct
  registrations: `query`, `query schema`, `query status`, `query
  sql`, `query refresh`, `collect`, `collect list`, `collect
  remove`, `status`, `plugin install/list/info/update/remove`,
  `init`, `attach`, `detach`, `ignore`, `skills install`. All of
  these were already core commands in collectivus and stay core
  in hypaware (per V1 Parity Table).
- The default CLI binary is now `hyp` (with `ctvs` kept as an
  alias inside `package.json` `bin` while the rename is in
  flight).

Instrumentation:

- `command.run` root span per invocation, attributes
  `command_name`, `argv_count`, `status`, `exit_code`.
- `hyp_command_runs_total` and `hyp_command_duration_ms` ticked on
  exit.
- `cli.help_rendered` log when `--help` is generated, with the
  current command count attribute (catches a registry that fails
  to populate after a load failure earlier in the boot).

Smoke `command_dispatch`:

- Configures the temp install with no plugins, just core.
- Runs `hyp status`, `hyp query schema logs`,
  `hyp plugin list --json`.
- Asserts each exited 0 and emitted exactly one `command.run` span
  with `status=ok` and the matching `command_name`.
- Asserts `command.run` span for `query schema logs` is followed
  by a `query.resolve_tables` child span with
  `hyp_dataset=logs` — which proves the dataset registry was at
  least consulted, even if no rows exist.

SQL:

```sql
select name, JSON_VALUE(attributes, '$.command_name'),
       JSON_VALUE(attributes, '$.exit_code')
from traces
where JSON_VALUE(attributes, '$.dev_run_id') = '<run-id>'
  and name = 'command.run'
order by startTimestamp
```

## Phase 4 — Intrinsic Cache and Query as a Core Service

The Iceberg-backed cache, the SQL surface, and the dataset
registry stop being entangled with plugins.

Donor files (kept, repointed):

- `src/query/iceberg/*` becomes `src/core/cache/iceberg/*`.
- `src/query/refresh.js`, `paths.js`, `sql.js`, `schema.js`,
  `format.js`, `collections.js`, `random-sample.js` move to
  `src/core/cache/` and `src/core/query/`. Anything that imports a
  specific dataset (`logs`, `proxy_messages`, `gascity_messages`)
  is rewritten to ask the dataset registry by name.

New code:

- `src/core/registry/datasets.js` implementing `QueryRegistry`.
  Built-in core registers **zero** datasets — even `logs`, `traces`,
  `metrics`, `ai_gateway_messages`, `gascity_messages` come from
  plugins.
- `src/core/cache/storage.js` exposes `QueryStorageService`
  (`appendRows`, `tableExists`, `tableUrl`, `readRows`). Plugins
  call this through `ctx.storage` rather than reaching into the
  Iceberg modules directly. Every `appendRows` emits a
  `cache.append` span with `hyp_dataset`, `row_count`,
  `bytes_written`.
- `src/core/cache/retention.js` enforces per-dataset retention from
  `config.query.cache.retention`. A `retention.evict` span runs
  per dataset per partition on the daily tick;
  `hyp_rows_evicted` Sum increments by row count.

Open question carried from design (not resolved in this plan):
**cache eviction vs. export coupling.** Implementation default
is "evict on retention alone" with a feature flag
(`query.cache.retention.wait_for_sink_ack=true`) reserved for a
future change. Document the flag in the schema but don't
implement the wait path at V1.

Smoke `cache_roundtrip`:

- Registers a synthetic dataset `dummy_rows` through the dataset
  registry from a test fixture plugin.
- Writes 100 rows via `ctx.storage.appendRows`.
- Runs `hyp query sql "select count(*) from dummy_rows"
  --refresh always --format json` and asserts the count is 100.
- Asserts the trace tree has `cache.append` → row_count=100 and a
  later `query.execute_sql` span whose `status=ok` and child
  `query.scan_dataset` has `hyp_dataset=dummy_rows`.

SQL:

```sql
select JSON_VALUE(attributes, '$.row_count')
from traces
where JSON_VALUE(attributes, '$.dev_run_id') = '<run-id>'
  and name = 'cache.append'
```

## Phase 5 — Source Registry and Sink Driver (Core-Only)

Deliverables:

- `src/core/registry/sources.js` matching `SourceRegistry` in the
  types file. Owns `start`/`stop`/`reload`/`status` per source and
  emits `source.start`, `source.stop`, `source.reload`,
  `source.status` spans. `hyp_sources_started` ticks up on start
  and down on stop.
- `src/core/registry/sinks.js` matching `SinkRegistry`. Validates
  blob-sink (writer+destination) vs. request-sink shape at
  registration time and emits `sink.register` logs with
  `sink_kind`, `writer`, `destination`, `supports` so a
  misconfigured pair is greppable. Counter `hyp_sinks_registered`.
- `src/core/sinks/driver.js` — the kernel's cron loop. Reads
  `sinks.*.config.schedule`, computes ready partitions out of the
  cache, calls `sink.exportBatch(...)`. Each tick is a
  `sink.export_batch` span with `hyp_sink_instance`,
  `partitions_count`, `bytes_written`, `status`. Failed batches
  go into a per-sink outbox under
  `<state>/sinks/<name>/outbox/` for retry; an
  `hyp_sink_export_failures_total` Sum ticks.
- `src/core/sinks/encoder.js` — utility for blob sinks to drive
  their `SinkEncoder`. Each `encodePartition` call is a
  `sink.encode_partition` span tagged with `format`, `extension`,
  `row_count`, `bytes_written`.

Smoke `sink_export_driver`:

- Registers a fake blob destination `@hypaware/test-fs` providing
  `hypaware.blob-store` that writes to the smoke tmp dir.
- Registers a fake encoder `@hypaware/test-encoder` providing
  `hypaware.encoder` (writes one CSV-ish line per row, plain
  bytes; encoder choice doesn't matter — we're testing the
  driver).
- Writes 50 dummy rows to the cache (via Phase 4 fixture
  plugin).
- Sets `sinks.test.schedule = "* * * * *"` and fires the cron tick
  manually from the smoke harness (`driver.tick({ now })`).
- Asserts files appeared in the destination, asserts there is one
  `sink.export_batch` span with `status=ok` and
  `bytes_written>0`.
- Asserts the metrics table records
  `hyp_sink_exports_total{sink_instance="test", status="ok"} >= 1`.

SQL:

```sql
select JSON_VALUE(attributes, '$.partitions_count'),
       JSON_VALUE(attributes, '$.bytes_written'),
       status
from traces
where JSON_VALUE(attributes, '$.dev_run_id') = '<run-id>'
  and name = 'sink.export_batch'
```

## Phase 6 — Config v2, Validation, Migrator

Deliverables:

- `src/core/config/schema.js` — the v2 shape from
  [`hypaware-design.md`](hypaware-design.md) §Config Model and the
  `HypAwareV2Config` interface, validated through
  `ConfigRegistry.registerSection` for per-plugin sections (each
  plugin owns its own validator).
- `src/core/config/validate.js` — kernel-level cross-plugin
  validation:
  - blob sink writer/destination compatibility
    (`hypaware.blob-store` + `hypaware.encoder`),
  - request sinks reject `writer`/`destination` keys,
  - sink schedule is a 5-field cron,
  - dataset retention references known datasets,
  - duplicate capability providers must have an explicit
    `disambiguate` pin (per resolved policy).
- `src/core/config/migrator.js` — best-effort v1→v2 conversion.
  Reads the current `collectivus.json`:
  - `role` is dropped.
  - `proxy` + `claude` settings become a default
    `@hypaware/ai-gateway` plugin entry plus `@hypaware/claude`
    plugin entry.
  - `sink.dir` + `upload` becomes either no sink (default) or a
    Parquet-to-local-fs sink, depending on whether `upload` was
    set.
  - `gascity[]` becomes a `@hypaware/gascity` plugin entry with the
    same per-city array under `config.cities`.
  - The migrator writes the v2 file alongside the v1 file (saved
    as `collectivus.json.v1.bak`) and prints a diff.
- Config loading emits `config.load` and `config.validate` spans
  with attributes `config_path`, `plugin_count`, `sink_count`,
  `error_kind`. Each per-plugin validator emits one log per
  validation error.

Smoke `config_migrate_v1`:

- Stages a tmp `~/.hyp` containing the current example
  `collectivus.json` from the repo (proxy + claude + gascity).
- Runs `hyp init --migrate` against it.
- Asserts the v2 file matches a golden file in
  `hypaware-core/smoke/fixtures/v2-after-migrate.json`.
- Asserts `config.load` then `config.validate` spans both
  `status=ok` and there are no `error_kind` attributes on logs in
  that run.

SQL:

```sql
select body, JSON_VALUE(attributes, '$.error_kind'), severityText
from logs
where JSON_VALUE(attributes, '$.dev_run_id') = '<run-id>'
  and severityText in ('WARN', 'ERROR')
```

## Phase 7 — Plugin Install Path and Lock File

Deliverables:

- `src/core/plugin_install/resolver.js` — short-name resolution
  (first-party, scoped third-party, unscoped third-party, git URL,
  local directory) per design §Plugin Install and Locking.
- `src/core/plugin_install/fetch.js` — git tarball/clone, copy
  artifact tree into `<state>/plugins/<name>/`. No `npm install`,
  no native build steps. For the in-repo cutover, `local-dir`
  source resolves to `hypaware-core/plugins-workspace/<name>/`.
- `src/core/plugin_install/lock.js` — read/write
  `<state>/plugin-lock.json` per `PluginLockFile`.
- `src/core/plugin_install/update_check.js` — best-effort, shares
  policy with the existing npm update check, runs once per 24h,
  silent on failure. Updates the lock's
  `PluginUpdateState.checked_at`; surfaces `available=true` to
  `hyp status` and `hyp plugin outdated`.
- CLI: `hyp plugin install/list/info/outdated/update/remove`.

Instrumentation:

- `plugin.install`, `plugin.update_check`, `plugin.remove` spans.
- `hyp_plugin_installs_total` (by status), `hyp_plugin_updates_available`
  (Gauge by plugin).

Smoke `plugin_install_local_dir`:

- Installs the fixture plugin
  `hypaware-core/plugins-workspace/dummy-a` via
  `hyp plugin install ./hypaware-core/plugins-workspace/dummy-a`.
- Asserts the lock file gained an entry with
  `source.kind="local-dir"`, `content_hash` matches a re-hash on
  read.
- Reruns `hyp plugin list --json` and asserts the dummy plugin
  appears with `installed_at` set.
- Asserts the run contains a `plugin.install` span with
  `status=ok` and a `plugin.update_check` span with
  `available=false`.

SQL:

```sql
select JSON_VALUE(attributes, '$.hyp_plugin'),
       JSON_VALUE(attributes, '$.status')
from traces
where JSON_VALUE(attributes, '$.dev_run_id') = '<run-id>'
  and name = 'plugin.install'
```

## Phase 8 — First-Party Plugin Extraction (in-repo workspace)

This is the heavy lift. Each subphase migrates one piece of
current behavior into a plugin under
`hypaware-core/plugins-workspace/<name>/`. The donor files keep
their internal shapes; only their entry point changes from
"imported by `src/cli.js`" to "called from the plugin's
`activate(ctx)`".

The order is dictated by dependencies: capability providers go
first, consumers second.

### 8.1 `@hypaware/otel`

Donor files: `src/collector.js`, `src/server.js`, `src/otlp/*`,
`src/upload/schema.js` (for column specs).

Plugin tree:
```
plugins-workspace/otel/
  hypaware.plugin.json
  src/index.js          # activate() registers source + datasets
  src/collector.js      # moved from src/collector.js, unchanged
  src/server.js
  src/otlp/*
  src/datasets.js       # registerDataset('logs'|'traces'|'metrics') wrappers
```

`activate(ctx)`:

- Registers source `otlp` with `start(ctx)` returning a
  `StartedSource` that owns the listener.
- Registers datasets `logs`, `traces`, `metrics`, each with the
  schema from `src/upload/schema.js` and the discover/refresh
  pair adapted from `src/query/refresh.js`/`paths.js`.
- Source `start` instruments `otel.receive` per OTLP POST, with
  `signal`, `payload_bytes`, `row_count`. Failures get
  `error_kind=otlp_parse`/`otlp_persist`.

Smoke `otel_listener_writes_rows`:

- Boots a temp install with `@hypaware/otel` configured at
  `127.0.0.1:0`.
- Reads back the bound port from `source.start` span attributes
  (yet another reason every source span carries
  `listen_host:listen_port` once started).
- POSTs one OTLP log payload via curl/fetch with
  `attributes.dev_run_id` set.
- Asserts `hyp query sql "select count(*) from logs where
  JSON_VALUE(attributes,'$.dev_run_id')='<run-id>'"
  --refresh always` returns 1.
- Asserts a `source.start` span with `hyp_plugin=@hypaware/otel`
  is followed by an `otel.receive` span with `status=ok`.

SQL:

```sql
select count(*) from logs
where JSON_VALUE(attributes, '$.dev_run_id') = '<run-id>'
```

### 8.2 `@hypaware/ai-gateway`

Donor files: `src/proxy.js`, `src/recorder.js`, `src/sse.js`,
`src/cli/messages-walker.js`, `src/cli/messages-parquet.js`,
`src/cli/stream-reconstruct.js`, `src/cli/claude-transcripts.js`
(only the bits the gateway plugin needs; the Claude-specific
enrichment moves to `@hypaware/claude` in 8.4),
`src/sinks/file.js` (for the gateway's own JSONL stage rows
before they land in the cache).

`activate(ctx)`:

- `provideCapability('hypaware.ai-gateway', '1.0.0', api)` where
  `api` exposes `registerUpstreamPreset`,
  `registerClient`, `registerMessageEnricher`, `localEndpoint`.
- Registers source `proxy` (renamed `ai-gateway` to match the
  capability), schema for `ai_gateway_messages`.
- Renames the dataset from `proxy_messages` →
  `ai_gateway_messages` per the "one source, one table" rule.
  The migrator and the cache schema bump handle this — the
  query-cache schema version (`QUERY_CACHE_SCHEMA_VERSION`)
  bumps to 5 so any cache under the old name is treated stale
  and gets rebuilt from the JSONL stage on first refresh.
- Every exchange emits an `aigw.exchange` log with
  `upstream`, `path`, `status_code`, `request_bytes`,
  `response_bytes`, `is_sse`, and a `dev_run_id` propagated
  from any `x-hyp-dev-run-id` header (a contract for
  smoke-test clients to thread the run id through the proxy
  without crossing into real production telemetry).
- The recorder's `writeRow` path is wrapped to emit
  `hyp_rows_written{dataset="ai_gateway_messages"}` per row and
  to bump a `aigw.exchange_bytes` Sum.

Smoke `ai_gateway_passthrough`:

- Boots `@hypaware/otel` + `@hypaware/ai-gateway` in the temp
  install. Configures an upstream pointing at a tiny in-process
  echo server (smoke harness owns it).
- Issues a request through the gateway with
  `x-hyp-dev-run-id: <run-id>`.
- Asserts the echo server saw the request.
- Asserts a row landed in `ai_gateway_messages` with the same
  `dev_run_id` after running
  `hyp query sql "select * from ai_gateway_messages where
  JSON_VALUE(attributes,'$.dev_run_id')='<run-id>'"`.
- Asserts an `aigw.exchange` log row exists.

### 8.3 `@hypaware/local-fs` + `@hypaware/format-parquet` + `@hypaware/format-jsonl`

Donor files: `src/upload/parquet.js`, `src/upload/reader.js`,
`src/upload/connectors/memory.js` (for fixture-style writers),
`src/upload/uploader.js`'s partition-walking code (split: cache
discovery stays in core, blob writes move into the writer/destination
pair).

Three plugins land together because they only make sense as a
unit. The default install pairs `local-fs` + `format-parquet`.

`@hypaware/local-fs` provides `hypaware.blob-store@1.0.0`,
`supports: ["queryable"]`. Its `Sink.exportBatch` calls the
encoder, writes bytes under `config.dir/<dataset>/<partition>/`.

`@hypaware/format-parquet` provides `hypaware.encoder@1.0.0`,
encodes each partition via `hyparquet-writer`. Emits
`encoder.encode_parquet` spans with `row_count`, `bytes_written`,
`compression`.

`@hypaware/format-jsonl` provides `hypaware.encoder@1.0.0`,
encodes each partition as gzipped JSONL.

Smoke `blob_sink_parquet_local_fs`:

- Extends the Phase 5 smoke: registers the real
  parquet+local-fs pair, writes 50 cache rows, fires one cron
  tick.
- Asserts a Parquet file appeared at the expected path and is
  readable by `parquetReadObjects` (use the existing
  `hyparquet` dep).
- Asserts the resolved sink reports `supports=["queryable"]`
  via a `sink.resolved` log.

### 8.4 `@hypaware/claude` and `@hypaware/codex`

Donor files: `src/claude-code/settings.js`,
`src/codex/*`, `src/skills/install.js`,
`skills/collectivus-query/`, `skills/ctvs-ignore/`,
`skills/ctvs-unignore/`, `src/cli/claude-hook.js`,
`src/cli/attach.js`, `src/cli/detach.js`,
`src/cli/claude-transcripts.js`.

Both depend on the `hypaware.ai-gateway` capability.

`@hypaware/claude.activate(ctx)`:
- Calls `ctx.requireCapability('hypaware.ai-gateway', '^1.0.0')`.
- Registers Anthropic upstream preset.
- Registers attach/detach via `registerClient`.
- Registers a transcript enricher via `registerMessageEnricher`
  (moves the local-transcript columns from
  `src/cli/claude-transcripts.js`).
- Registers skills (`collectivus-query`, `ctvs-ignore`,
  `ctvs-unignore`) via `ctx.skills.register`.

`@hypaware/codex.activate(ctx)`:
- Same shape; registers OpenAI-compatible preset, Codex
  provider writer, Codex skill copy targets.

Each `attach` and `detach` emits a span with
`hyp_plugin`, `client_name`, `status`, `restored=true|false`.

Smoke `claude_attach_detach`:

- Boots `@hypaware/ai-gateway` + `@hypaware/claude` in a tmp
  install with `HOME=$tmp` so the Claude settings file lives
  under the tmp tree.
- Runs `hyp attach --client claude --yes`.
- Asserts the Claude settings JSON was patched (golden compare).
- Asserts a `client.attach` span with `client_name=claude`,
  `status=ok` exists.
- Runs `hyp detach --client claude`.
- Asserts the settings file matches its pre-attach state.

### 8.5 `@hypaware/central`

Donor files: `src/gateway/*`, `src/server/*` (the *client* side;
the server-side `control_plane.js` will be lifted out into
`@hypaware/server` in Phase 10),
`src/rendezvous/*`, `src/cli/invite.js`,
`src/cli/join.js`, `src/cli/rendezvous.js`,
`src/upload/aws_credentials.js`.

`@hypaware/central` is a request sink. Its `Sink.exportBatch`
forwards ready cache partitions to the central server via the
existing `OutboxSink`/`IdentityClient`/`ConfigClient` machinery.
No more `role: gateway` — the *behavior* previously gated by
`role: gateway` is just this plugin being configured.

Smoke `central_forward_outbox`:

- Boots `@hypaware/otel` + `@hypaware/central` against an
  in-process fake central server endpoint that records what it
  received.
- Posts one OTLP log payload to the OTLP listener.
- Fires the export driver tick.
- Asserts the fake central server received one batch with the
  expected `signal=logs` and the same `dev_run_id` payload
  attribute.
- Asserts `sink.export_batch` span with
  `hyp_sink_instance="forward"` and `status=ok`.

### 8.6 `@hypaware/gascity` (in-repo until Phase 11)

Donor files: `src/gascity/*`, `src/cli/gascity.js`,
`src/cli/init_presets/gascity*`.

`activate(ctx)`:
- Registers source `gascity` with `configSection: "gascity"`.
- Registers dataset `gascity_messages` with the existing
  Parquet-direct discover/refresh path (no JSONL stage —
  gascity writes Parquet directly under the cache).
- Registers commands `gascity attach`, `gascity detach`,
  `gascity list`.
- Registers an init preset `gascity` that drives a tmp config
  with the gascity plugin enabled.
- Registers a skill `hypaware-gascity` (the existing
  `gascity_skill.md`).

Existing local SIGHUP reload becomes `StartedSource.reload(ctx)`;
the kernel routes per-section config edits through `reload`
without a daemon restart, mirroring the current behavior.

Smoke `gascity_attach_writes_partition`:

- Boots `@hypaware/gascity` with a tmp config that points at a
  fixture supervisor running in-process.
- Runs `hyp gascity attach <fixture-city>`.
- Drives a few SSE frames through the fixture supervisor.
- Asserts `gascity_messages` table has the expected rows under
  `hyp query sql "select count(*) from gascity_messages"`.
- Asserts a `source.start` span exists with
  `hyp_plugin=@hypaware/gascity` and a follow-up `source.reload`
  span when the second `attach` ran.

## Phase 9 — Walkthrough, Init Presets, Status, Skills

Deliverables:

- `hyp` (no args, TTY): launches the interactive multiselect from
  the design's setup walkthrough. The walkthrough is built on top
  of:
  - the source picks contributed by each source plugin
    (`@hypaware/ai-gateway`, `@hypaware/otel`, `@hypaware/gascity`),
  - the sink picks contributed by each sink plugin
    (`@hypaware/local-fs` + `@hypaware/format-parquet|jsonl`,
    `@hypaware/central`, plus the "Keep local only" no-sink
    option),
  - the client picks contributed by adapter plugins
    (`@hypaware/claude`, `@hypaware/codex`),
  - cache retention prompt (default 30 days).
- `hyp init <preset>` for scripted installs; presets are
  contributed by plugins.
- `hyp status` rendered from the source + sink registries (per
  design §CLI Registry).
- `hyp skills install` continues to work via the skill registry.

Instrumentation:

- `walkthrough.start`, `walkthrough.finish`, with attributes
  `sources_picked`, `sinks_picked`, `clients_picked`. One log per
  user pick (`walkthrough.pick` with `pick_type`, `pick_value`),
  high-cardinality bounded since the set is tiny.
- `hyp status` emits a single `status.render` span with
  attributes `source_count`, `sink_count`, `cache_size_bytes`,
  `oldest_partition_date`.

Smoke `walkthrough_to_first_query`:

- Drives `hyp init claude-and-otel-local` (a preset we ship
  exactly for this smoke — picks ai-gateway + otel + local-fs +
  parquet + claude).
- Asserts the v2 config was written and matches a golden.
- Asserts `hyp status` exits 0, prints the four plugins, prints
  the cache retention window.
- Posts one OTLP log payload at the OTLP listener.
- Issues one proxy request through the gateway.
- Asserts both rows are visible in `logs` and `ai_gateway_messages`
  under the same `dev_run_id`.

## Phase 10 — Split `@hypaware/server` Into Its Own Package

`src/server/control_plane.js`, `src/server/*` (server-side bits)
and `src/server/identity.js` move into a new repository
`hyperparam/hypaware-server`. The local kernel never imports
this. The HTTP/wire contract `@hypaware/central` speaks is
extracted into `@hypaware/central/proto.md` (markdown) plus a
TypeScript types file that both packages depend on.

This is intentionally a separate phase because it's mechanical and
high-blast-radius. It only runs after Phase 8.5 (`@hypaware/central`
forward smoke is green).

Smoke `server_round_trip`:

- Boots `hypaware-server` from its own repo against a tmp data
  dir.
- Boots a hypaware host with `@hypaware/central` pointed at it.
- Posts an OTLP payload through the gateway.
- Asserts the server's storage saw the row, with `dev_run_id`
  preserved through the central forward.

## Phase 11 — Extract First-Party Plugins to Standalone Repos

Each `plugins-workspace/<name>` becomes
`github:hyperparam/hypaware-<name>`. The plugin's CI commits its
built `dist/` to release tags named by `version`. Kernel CI
installs the full default set from those release tags on every
kernel release; this *is* the V1 end-to-end test.

After this phase, `plugins-workspace/` is deleted from the kernel
repo; resolution for `@hypaware/<name>` short names defaults to
`github:hyperparam/hypaware-<name>`.

Smoke `kernel_release_full_install`:

- A clean tmp `HYP_HOME`, no installed plugins.
- Runs `hyp plugin install @hypaware/ai-gateway @hypaware/claude
  @hypaware/otel @hypaware/local-fs @hypaware/format-parquet
  @hypaware/format-jsonl @hypaware/central`.
- Asserts the lock file lists all seven plugins with non-empty
  `resolved_ref`.
- Re-runs the `walkthrough_to_first_query` smoke against the
  install. Same passes.

## Phase 12 — Ship `@hypaware/gascity` as the First External Plugin

Move `plugins-workspace/gascity` to
`github:hyperparam/hypaware-gascity` and install it via
`hyp plugin install @hypaware/gascity` rather than from the
in-repo workspace. This is the dogfood test for the install +
lock + update path against a non-bundled plugin.

Smoke `external_plugin_gascity_install`:

- Clean install, no gascity preinstalled.
- `hyp plugin install @hypaware/gascity`.
- Run `gascity_attach_writes_partition` smoke against this
  install. Same assertions.

## Phase 13 — Delete Donor Wiring

Everything inside `src/cli.js`, `src/server.js`,
`src/collector.js`, `src/proxy.js`, etc. that the plugins already
own is removed. The kernel keeps only:

- `src/core/*` (kernel)
- `src/cli/dispatch.js` (boots the kernel)
- `bin/hyp.js` (and `bin/ctvs.js` as a thin compat shim)

`bin/cli.js`'s `SUBCOMMANDS` set is removed. All subcommands come
from the registry. No first-party command lives in the kernel
except the meta commands listed in Phase 3.

The kernel CI keeps two test suites:

- `npm test` — unit tests against `src/core/*`, no plugins.
- `npm run smoke:all` — runs every smoke flow from Phases 0–12 in
  order against a tmp `HYP_HOME`, fails on the first regression.

## Continuous Smoke Harness Layout

```
hypaware-core/smoke/
  README.md
  index.js                # `hyp smoke <name>` entrypoint
  fixtures/
    v1-collectivus.json
    v2-after-migrate.json
  flows/
    core_boot_noop.js
    manifest_dep_resolve.js
    activation_lifecycle.js
    command_dispatch.js
    cache_roundtrip.js
    sink_export_driver.js
    config_migrate_v1.js
    plugin_install_local_dir.js
    otel_listener_writes_rows.js
    ai_gateway_passthrough.js
    blob_sink_parquet_local_fs.js
    claude_attach_detach.js
    central_forward_outbox.js
    gascity_attach_writes_partition.js
    walkthrough_to_first_query.js
    server_round_trip.js
    kernel_release_full_install.js
    external_plugin_gascity_install.js
```

Each flow follows the same shape:

```js
export async function run({ harness, expect }) {
  const runId = harness.devRunId
  await harness.startKernel({ plugins: [...], config: {...} })
  await harness.do(/* the action */)
  await expect.sql(
    "select count(*) from logs where JSON_VALUE(attributes,'$.dev_run_id')=$1",
    [runId],
    (n) => n >= 1
  )
  await expect.traces({
    name: 'plugin.activate',
    where: { hyp_plugin: '@hypaware/x', status: 'ok' },
    count: 1,
  })
  await harness.stopKernel()
}
```

`expect.sql` and `expect.traces` route through `hyp query` so the
assertion language is exactly the language a developer would use
manually after a failure. If a smoke fails it prints the
copy-pastable `hyp query sql "..."` plus the file path it queried,
because the harness is just emitting the same JSONL/parquet a
real install does.

## Verification Gates Per Phase

For each phase to be considered done:

1. Its named smoke flow passes locally with
   `HYP_DEV_TELEMETRY=1 npm run smoke -- <flow>`.
2. The flow runs in CI on the cutover branch.
3. The flow can be re-run against an existing user's
   `~/.hyp` (read-only) without writing data — i.e. nothing
   in the flow assumes a freshly created install except where
   it explicitly creates the tmp `HYP_HOME`. This proves the
   flow is debuggable in real installs, not just synthetic
   ones.

V1 complete (per design appendix) when:

- `walkthrough_to_first_query` passes on a fresh box.
- Every dataset/command/init preset/skill currently shipped is
  reachable through a plugin in `plugin list`.
- `hyp query` returns the same rows against pre-cutover
  recordings as `ctvs query` did. The acceptance test imports
  the user's current `~/.hyp` into a tmp install, runs known
  queries from a golden file, asserts byte-for-byte equal
  result sets.
- `@hypaware/central` forwards successfully to an existing
  collectivus central server (or to the new `@hypaware/server`
  after Phase 10).
- Removing any one first-party plugin disables only its surface
  — verified by a "remove + run smokes" loop that asserts
  every other phase's smoke still passes.

## Risks and Mitigations

- **Iceberg cache schema drift.** The `ai_gateway_messages` rename
  forces a `QUERY_CACHE_SCHEMA_VERSION` bump. Mitigation: the
  refresh layer already treats stale-version partitions as
  unreadable and rebuilds from JSONL — verified by extending the
  existing `query/refresh.test.js` rather than writing new
  fixtures.
- **Sink driver vs. existing daily uploader.** The current
  uploader's scheduling and AWS credential handling are donor
  code for `@hypaware/central` and `@hypaware/local-fs`. Both
  plugins share `src/core/sinks/driver.js`'s cron; the existing
  `src/upload/scheduler.js` is moved into core there. Risk:
  losing the existing `signals` filter — mitigated by a smoke
  assertion that asserts each configured sink only sees the
  partitions its `datasets` filter allows (this also tests the
  per-source export routing extension point the design left
  open).
- **Hot-reload semantics.** The current SIGHUP flow only handles
  otel/proxy/sink/upload/gascity. After cutover, every plugin's
  `StartedSource.reload(ctx)` is the single hot-reload contract.
  Risk: a plugin that forgets to implement `reload` silently
  serves stale config. Mitigation: the kernel logs
  `source.reload_skipped` with `error_kind=no_reload_impl`
  whenever the diff would have applied but no reload hook is
  registered.
- **OTEL self-instrumentation circular dependency.** The kernel
  emits via OTLP, which is itself a plugin. The JSONL fallback
  keeps the developer loop unblocked during the
  pre-`@hypaware/otel` phases; after Phase 8.1 the kernel
  switches to OTLP-to-self in dev mode but still tolerates the
  receiver being momentarily down (buffers to JSONL and replays
  on reconnect).
- **Skill installation regressions.** The current
  `BUNDLED_SKILLS` list ships from the kernel; after cutover
  skills come from `@hypaware/claude` and `@hypaware/codex`.
  Mitigation: parity test imports the kernel's pre-cutover
  `BUNDLED_SKILLS` list and the post-cutover registered set,
  asserts byte-for-byte equality on the `(name, clients)`
  tuples.

## Out of Scope for V1

These are explicitly punted to post-V1 and are mentioned only so
the V1 shape doesn't accidentally close them off:

- `@hypaware/s3`, `@hypaware/webhook`, `@hypaware/format-iceberg`
  (sink shapes already accommodate them).
- Per-source export routing (extension point reserved as
  `sinks.<name>.datasets` or top-level `exports`; not implemented).
- Cache-eviction-waits-for-sink-ack (flag reserved, not
  implemented).
- Non-JS plugin runtimes (Python, native modules, sidecars).
- Server-side multi-tenant rollout for `@hypaware/server` (the
  package exists but its scaling story is its own document).

## Working Order Summary

| Phase | Output                                                      | Smoke                                     |
| ----- | ----------------------------------------------------------- | ----------------------------------------- |
| 0     | Branch, core/observability skeleton                         | core_boot_noop                            |
| 1     | Manifest, dep graph, capability registry                    | manifest_dep_resolve                      |
| 2     | Activation context, paths, loader                           | activation_lifecycle                      |
| 3     | Command registry + core commands                            | command_dispatch                          |
| 4     | Intrinsic cache + dataset registry + query                  | cache_roundtrip                           |
| 5     | Source/sink registries + sink driver                        | sink_export_driver                        |
| 6     | Config v2 + validator + v1→v2 migrator                      | config_migrate_v1                         |
| 7     | Plugin install + lock + update check                        | plugin_install_local_dir                  |
| 8.1   | `@hypaware/otel`                                            | otel_listener_writes_rows                 |
| 8.2   | `@hypaware/ai-gateway`                                      | ai_gateway_passthrough                    |
| 8.3   | `@hypaware/local-fs` + `format-parquet`/`format-jsonl`      | blob_sink_parquet_local_fs                |
| 8.4   | `@hypaware/claude` + `@hypaware/codex`                      | claude_attach_detach                      |
| 8.5   | `@hypaware/central`                                         | central_forward_outbox                    |
| 8.6   | `@hypaware/gascity` (in workspace)                          | gascity_attach_writes_partition           |
| 9     | Walkthrough, init presets, status, skills                   | walkthrough_to_first_query                |
| 10    | `@hypaware/server` extracted                                | server_round_trip                         |
| 11    | First-party plugins extracted to own repos                  | kernel_release_full_install               |
| 12    | `@hypaware/gascity` extracted                               | external_plugin_gascity_install           |
| 13    | Donor wiring deleted, kernel-only repo                      | smoke:all (every prior flow)              |

V1 is shipped when Phase 13's `smoke:all` is green on CI against
a clean `HYP_HOME` and the parity golden against a pre-cutover
`~/.collectivus` recording matches byte-for-byte.
