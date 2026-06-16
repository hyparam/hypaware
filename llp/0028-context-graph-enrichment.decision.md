# LLP 0028: Context-graph T1/T2 enrichment + completion capability

**Type:** Decision
**Status:** Active
**Systems:** Graph, Plugins
**Author:** Phil / Claude
**Date:** 2026-06-15
**Related:** LLP 0006, LLP 0008, LLP 0016, LLP 0023, LLP 0024

> A recall-tuned **proposer (T1)** over-proposes prospect knowledge from source
> text, and a graph-and-source-aware **curator (T2)** prunes / merges / deepens
> / commits it — the projection pipeline *above* the
> [T0 activity graph](./0023-context-graph-projection.decision.md). Both tiers
> depend on a new **`hypaware.completion`** capability. Shipped as
> `@hypaware/context-graph-enrich` plus two completion providers.

## Completion is a separate capability

Text generation is its own capability, **`hypaware.completion`**, which
`@hypaware/context-graph-enrich` `requires`
([LLP 0006](./0006-dependencies-and-capabilities.spec.md)) — exactly mirroring
the embedder/vector-search split ([LLP 0024](./0024-vector-search-plugin.decision.md#embedding-is-a-separate-capability)).
The provider is therefore an explicit `plugins[]` config decision, not baked
into enrichment, and a localhost `base_url` keeps inference on-machine. Two
providers ship:

- **`@hypaware/completion-anthropic`** — native Claude Messages API
  (`/v1/messages`). One provider serves both tiers by **per-call model** (Haiku
  for T1, Opus for T2). Refusals come back as `stopReason`, never thrown.
- **`@hypaware/completion-openai`** — OpenAI-compatible `/v1/chat/completions`
  (OpenAI, proxies, Ollama/LM Studio), named for its wire shape, not its vendor
  (the [embedder-openai naming rule](./0024-vector-search-plugin.decision.md#embedder-speaks-openai-compatible-base_url-configurable)).

Both resolve the API key from an env var at call time (never logged), support
streaming, and use an injected `fetch` seam for tests — the credential and
error-body posture is the `@hypaware/s3`/embedder one (config carries only the
env-var *name*; provider error bodies are never copied into logs/errors).

### Forced tools are provider-neutral

Enrichment is advertised as provider-swappable, so the structured-output
request must be too. `CompletionRequest` carries a **provider-neutral
`toolChoice`**; each provider translates it to its native shape (Anthropic
`tool_choice`, OpenAI `function` tools) rather than enrichment sending
Anthropic-native params through the opaque `params` field. The one
Anthropic-specific concession lives in the prompt builder, gated on
`provider === 'anthropic'`: adaptive thinking + high `effort` buy curation
quality but forbid forcing a tool (the API 400s on `tool_choice` with thinking
on), so T2 leaves the tool choice `auto` and the system prompt requires exactly
one `curate_decisions` call. `parseDecisions` treats a missing call as "no
decisions" either way.

## Two tiers, two daemon sources

`@hypaware/context-graph-enrich` is one plugin, two sources + commands,
requiring `hypaware.context-graph`, `hypaware.vector-search`, and
`hypaware.completion`.

- **`enrich-propose` (T1)** reads new source rows since a watermark, groups by
  anchor (session), and over-proposes prospects via a forced-tool extraction
  into `enrichment_prospects`. Recall over precision — T2 prunes.
- **`enrich-curate` (T2)** selects pending prospects ordered by **salience**
  (vector-distance novelty), groups the selection by anchor, and makes **one
  curator call per session** — the shared graph neighborhood (SQL over the
  published `node`/`edge` surface) and source excerpt (provenance deref) are
  read once and reused across the group, instead of re-sending the same session
  source per prospect.

Both sources mirror `@hypaware/vector-search`'s refresh-timer shape (interval
tick, in-flight guard, unref'd handle, reload on config change) and carry a
`max_tick_ms` budget. The `hyp enrich propose|curate|status` commands run a
tick on demand.

### Lazy capability resolution

Only **graph** is resolved eagerly at activation — `registerContract` and the
id kit are needed then, and context-graph is ordered first. **vector-search +
completion are resolved on first use** (tick/command time): the dependency
resolver orders by `requires.plugins`, not `requires.capabilities`, so their
providers may activate *after* this plugin, and the completion provider is
swappable so it can't be named in `requires.plugins` at all. Resolving lazily
after boot completes sidesteps both.

## Committed-only projection

The T0 graph projector is append + dedup-by-id with **no retract path** — the
incremental-vs-full-regeneration question is still open upstream
([LLP 0023](./0023-context-graph-projection.decision.md#merge-policy)). So the
prospect lifecycle lives entirely in **this plugin's own datasets**
(`enrichment_prospects` + the append-only `enrichment_resolutions`), and the
contributed contract projects **only `enrichment_committed`** into the graph. A
prospect is "pending" iff its id has no resolution row; a `reject`/`merge`/
`skip` resolution commits nothing, so **a rejected prospect never reaches the
graph**. This is derive-don't-store applied to the enrichment layer: the graph
stays a pure projection of committed knowledge, and re-deciding a prospect is a
matter of appending a new resolution, never mutating the graph.

## Idempotent prospects

`prospect_id` is a deterministic hash of `(extractor, version, anchor,
type+label)`, so re-proposing the same content over the same session yields the
same id. Within a tick that dedups by construction (a `Map` keyed on id).
**Across ticks** it does not by itself: the watermark deliberately errs toward
re-reading source rows (see below), and a tick that appends prospects then
crashes before persisting its watermark re-reads the same source next tick — so
without a guard a retried/overlapping tick would append duplicate prospect rows,
and T2 would then curate each duplicate (duplicate committed + resolution rows
and wasted model spend).

T1 therefore filters candidate rows against the already-persisted
`prospect_id` set before appending — the same **pre-write dedup** the graph
projector uses (read the committed id set, filter, then append;
[LLP 0023](./0023-context-graph-projection.decision.md#pre-write-dedup)). T2
additionally dedups its pending selection by `prospect_id` as defense-in-depth
against any duplicate rows already on disk. The append is now genuinely
idempotent across ticks, which is what makes the watermark's "err toward redo"
stance safe.

## Operability

Reads of the configured **source** dataset are **fail-fast**: a missing or
misspelled `source_dataset`/`text_column` must surface as an actionable error,
never silently make `enrich propose` a no-op forever. Missing-dataset tolerance
is therefore *opt-in* (`runSql(..., { allowMissing: true })`) and used only for
reads that are legitimately-not-there-yet: the plugin's own enrichment tables
before their first write, and the published `node`/`edge` surface before the
graph's first projection. This is the same line the graph projector draws —
"only a *missing dataset* is a benign failure; any other query/storage error
aborts."

Dataset/column config fields are validated as strict SQL identifiers (they are
interpolated as identifiers, which can't be parameter-bound), and all
interpolated *values* (anchor/node ids, source keys) go through a single-quote
escaper.

## Salience drain

When a `recall_index` is configured, T2 triages pending prospects by novelty
(`1 - best similarity` to committed knowledge) so the curator spends on the
least-covered first. Below-threshold prospects are **not** silently dropped —
that would re-score them every tick forever. They get a terminal `skip`
resolution (no curator call, nothing committed), so they drain from the pending
queue exactly like a curated prospect, just without the model spend. With the
default `salience_threshold` of `0.0` nothing is skipped.

## Watermark

The propose watermark is a **keyset tuple** `(timestamp, tiebreak)` over the
part-level source (`ai_gateway_messages` has many parts per
`message_created_at`). The query engine surfaces a TIMESTAMP column as a `Date`
and compares it correctly only against a numeric epoch literal, so the boundary
can't be expressed in SQL: the tick filters coarsely with `ts >= cursorMs`
(re-including the boundary millisecond so no same-`ts` part is lost), orders by
the full tuple, and drops already-processed rows by exact tuple in JS. The
cursor advances only over the **fully-processed prefix** — an early
`max_tick_ms` break must re-read, not skip, the un-proposed groups. Curate has
no cursor; its queue is "prospects with no resolution", computed by query.

## Excluded from default activation

Like the embedder/vector-search pair, the completion + enrich plugins are **not
in the default-activation allowlist** — they activate only through an explicit
`plugins[]` entry. Enabling a completion provider is the opt-in that lets
captured content leave the machine (unless `base_url` points at a local
server), so it must be a deliberate config choice, never a default.

## Open questions

- **Retract path** — the enrichment layer is committed-only precisely because
  T0 projection has no retract/regeneration story yet
  ([LLP 0023](./0023-context-graph-projection.decision.md)). If that lands
  upstream (incremental retract, or full regeneration from resolutions), the
  committed-only contract here can relax to project deepen/merge revisions too.
- **T2 cost** — batching one curator call per session already collapses the
  dominant cost (source re-reads), and `max_prospects_per_tick` + `max_tick_ms`
  bound a tick. A token- or spend-denominated budget (as vector-search added
  for embedding) remains future work if per-tick row/prospect caps prove too
  coarse for the frontier-tier curator.
- **Salience tuning** — novelty is `1 - top-1 similarity` against the recall
  index; whether a fixed threshold or an adaptive percentile better separates
  "already covered" from "genuinely new" is unproven and waits on real corpora.
