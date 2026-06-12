# LLP 0024: Vector Search Plugin

**Type:** Decision
**Status:** Active
**Systems:** Plugins, Query
**Author:** Phil / Claude
**Date:** 2026-06-12
**Related:** LLP 0003, LLP 0008, LLP 0013, LLP 0015

> Adopting [hypvector](https://github.com/hyparam/hypvector) for vector
> similarity search over cached datasets, as a bundled plugin.

## Plugin, not kernel

Vector search is a **plugin capability** (`hypaware.vector-search`), not
intrinsic query surface. "Query is intrinsic" means the SQL/dataset surface
only — see the sharpened wording in
[LLP 0003](./0003-core-vs-plugin-surface.spec.md#intrinsic-not-plugin-provided).
The plugin is `@hypaware/vector-search`, bundled in
`hypaware-core/plugins-workspace` per the V1 packaging divergence
([LLP 0002](./0002-v1-scope.decision.md#plugin-packaging-divergence)).

## Packaging

`hypvector` is a root **`optionalDependency`**, mirroring `hyparquet-writer`
(which it transitively needs for index *writes*). The plugin degrades
gracefully when the optional dep is absent: activation succeeds, commands
report the missing dependency. This follows the `@hypaware/format-parquet`
precedent — bundled plugins import from root `node_modules`; LLP 0008's
pre-bundling rule applies to separately installed plugins.

## Index files are plugin state

Vector index parquet files live under the plugin's managed state directory
([LLP 0004](./0004-activation-and-paths.spec.md)), one index per indexed
dataset — e.g. `<recording-root>/plugins/vector-search/<dataset>/`. They are
**derived artifacts**: rebuildable from the cache, never the system of record.
This deliberately does *not* touch the intrinsic cache layout
([LLP 0013](./0013-local-query-cache.decision.md) — layout is fixed, not
plugin-extensible) and does not ride the sink driver (indexes are not
exports).

## Indexes are declared in config, sharded per partition

Index definitions (`dataset` + `column`, plus embedder model) live in the
**v2 config** under the plugin's section — not per-host state. Unlike
`collect` collections ([LLP 0015](./0015-query-and-datasets.spec.md#collections-are-per-host-state)),
which point at host-only paths, an index definition is portable: every host
has its own cache of the same registered datasets, and centrally managed
config (the in-flight remote-config/join-flow spec) can push one index
policy org-wide. The built **artifacts** stay per-host plugin state.

The index is **sharded one hypvector file per cache partition**. Search
discovers partitions through the dataset registry (never hard-coded names),
fans out across shards, and merges top-K. Shards record the embedder model
and dimension; a shard built with a different model than config declares is
*stale*, not an error — it re-embeds through the normal refresh path below.
A query-time/index-time model mismatch that can't be resolved by refresh is
a hard error, never a silent degraded search.

## Freshness rides the cache-maintenance pattern

Two refresh paths, both incremental (only missing/stale shards):

- **Daemon timer**, modeled on cache maintenance
  (`src/core/cache/maintenance.js`): its own configurable interval (longer
  than maintenance's 60 min default) and a `max_tick_ms`-style budget per
  tick. Bounded per-partition shard writes match the work-shape the
  maintenance tick already performs in-daemon (compaction); the monolithic
  parquet-export OOM constraint does not apply at this granularity. Embedding
  API calls from the daemon are covered by the embedder's `network`
  permission.
- **Search-time refresh modes**, mirroring query's `refresh` flag: default
  refreshes stale shards with progress and an upfront row/token estimate;
  `--no-refresh` searches existing shards only. Per-shard writes are durable,
  so an interrupted cold build resumes.

Retention coupling dissolves: when cache retention evicts a partition, its
shard is an orphan and the next tick sweeps it. There is no
index-over-deleted-rows staleness class and no full-rebuild command in the
core flow.

## CLI surface

Contributed through the CLI registry ([LLP 0009](./0009-cli-registry.spec.md)):
`hyp vector search <query>` (with `--dataset`, `--top-k`, refresh flags) and
`hyp vector status` (per-dataset shard coverage, model, staleness). Results
format through the intrinsic formatter — table/json/jsonl/markdown for free.

## Embedding is a separate capability

Embedding production is its own capability, **`hypaware.embedder`**, which
`@hypaware/vector-search` `requires` ([LLP 0006](./0006-dependencies-and-capabilities.spec.md)).
The embedder choice is therefore an explicit `plugins[]` config decision, not
something baked into vector-search.

**The first first-party embedder is API-backed**, not local. This is a
deliberate exception to HypAware's local-only posture: enabling it sends
captured content (the text being indexed, and each query string) to an
external embedding API. Chosen for speed-to-working-feature over a local
Transformers.js/WASM embedder (~25–200 MB weight downloads, slower CPU
inference, and tension with [LLP 0008](./0008-plugin-runtime-dependencies.decision.md)'s
pure-JS rule via ONNX runtimes). A local embedder remains the intended
follow-up; the capability split means it's a config swap, not a refactor.

The index stores the embedder's **model name and dimension** in the hypvector
file metadata; query-time embedding must match, and a mismatch is a hard
error, not a silent degraded search.

## Embedder speaks OpenAI-compatible, base_url configurable

The first-party embedder is **`@hypaware/embedder-openai`** — named for its
wire shape, not its vendor, so a future local embedder takes a sibling name
instead of fighting over a generic `@hypaware/embedder`. It is a single HTTP
client for the OpenAI-compatible `POST /v1/embeddings` shape with a
**configurable `base_url`**. Defaults: `https://api.openai.com`, model
`text-embedding-3-small`. One plugin therefore covers OpenAI,
OpenAI-compatible proxies, **and local servers (Ollama, LM Studio)** —
pointing `base_url` at localhost restores a fully-local privacy path without
HypAware shipping a model runtime, keeping
[LLP 0008](./0008-plugin-runtime-dependencies.decision.md) untouched. When
the configured key env var is unset the request goes out without an
`Authorization` header, so localhost servers need zero credential config.

Because enabling the embedder is the explicit opt-in that lets captured text
leave the machine, **neither plugin is in the default-activation allowlist**
(`V1_EXCLUDED_FROM_DEFAULT`): both activate only through an explicit
`plugins[]` entry.

Credential handling follows the `@hypaware/s3` precedent: config carries only
non-secret references (the **env var name**, default `OPENAI_API_KEY`), the
key resolves from the environment at call time, the manifest declares
`permissions: ["network", "read_env"]`, and credential material never reaches
logs or telemetry.

## Open questions

- **Cost visibility** — *resolved 2026-06-12*: the daemon timer takes a
  per-tick **row budget**, `refresh.max_rows_per_tick` (default 5000),
  alongside `max_tick_ms`. Both budgets are soft — checked before each shard
  build, not mid-build — so one oversized partition overshoots a tick once
  instead of starving forever. Spend surfaces as `rows_embedded` /
  `budget_exhausted` on the `vector.refresh_tick` span and in the refresh
  source's status details. Two further mitigations fell out of the design:
  the default content-hash row id deduplicates identical texts before
  embedding, and search-time refresh (unbudgeted, since it is interactive)
  prints an upfront shard/row estimate before spending. A per-day or
  token-denominated budget remains future work if row budgets prove too
  coarse.
- **Shard search mode** — per-partition shards will usually be small enough
  for hypvector's exact scan; revisit per-shard approximate clustering only
  if shard sizes or query latency demand it. (Shards are written without
  binary/cluster columns, so hypvector's `auto` algorithm takes the exact
  path today.)
