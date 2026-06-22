# LLP 0028: Context-graph T1/T2 enrichment + completion capability

**Type:** Decision
**Status:** Active
**Systems:** Graph, Plugins
**Author:** Phil / Claude
**Date:** 2026-06-15
**Related:** LLP 0006, LLP 0008, LLP 0016, LLP 0023, LLP 0024

> A recall-tuned **proposer (T1)** over-proposes prospect knowledge from a
> **full, DAG-ordered session** of source text, and a graph-and-source-aware
> **curator (T2)** clusters, prunes / merges / deepens / commits it — the
> projection pipeline *above* the
> [T0 activity graph](./0023-context-graph-projection.decision.md). One pipeline
> runs in **two regimes**: a deliberate **backfill** command over all history,
> and an automatic **ongoing** daily batch over newly-settled sessions. Both
> tiers depend on a new **`hypaware.completion`** capability. Shipped as
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
  for T1, Opus for T2). Refusals come back as `stopReason`, never thrown. It also
  exposes the optional **`batch`** surface on the capability (Anthropic Message
  Batches: `submit` / `poll` / `results` / `cancel`) that the regimes
  ([§two-regimes](#two-regimes)) submit through; a provider without a batch API
  simply omits it, and callers feature-detect and fall back to sequential
  `complete`.
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

## Two tiers, one pipeline

`@hypaware/context-graph-enrich` is one plugin requiring
`hypaware.context-graph`, `hypaware.vector-search`, and `hypaware.completion`.
The pipeline is the same in both regimes ([§two-regimes](#two-regimes)):
**select sessions → propose (T1) → embed → cluster → curate (T2) → project.**

- **`enrich-propose` (T1)** extracts prospects from a **whole session at once**,
  not a watermark-bounded slice. The session's filtered parts
  ([§row-selection](#row-selection)) are stitched into one transcript by a
  deterministic **`(timestamp, tiebreak)` sort**: the gateway assigns
  `message_created_at` in logical message order, so this reconstructs the
  conversation **without coupling to the `ai_gateway_messages`-specific
  message-graph columns** (`message_index` / `previous_message_id` / `agent_id`)
  a custom source may lack, and the row-unique tiebreak keeps the order total so
  re-runs over a session yield the identical transcript (hence the same prospect
  ids). `tool_result` is excluded, and the transcript is passed to a **single
  frontier-model call** — every session in the measured corpus fits the 1M-token
  context (largest ~415k tokens). One coherent transcript per session carries the
  **whole** session, closing the truncation defect
  ([§per-session-watermark](#per-session-watermark)). Recall over precision —
  T2 prunes.
- **`enrich-curate` (T2)** groups pending prospects into **similarity / recall
  clusters**, not by anchor, and makes **one curator call per cluster**
  ([§curate-clustering](#curate-clustering)). The shared context — recalled
  committed knowledge and the source excerpt (provenance deref) — is read once
  per cluster, and clustering lets the curator **merge duplicates across
  sessions** in one call, which per-session grouping structurally cannot.

The `hyp enrich propose|curate|backfill|status` commands run on demand; the
ongoing regime drives the same code on a schedule.

### Lazy capability resolution

Only **graph** is resolved eagerly at activation — `registerContract` and the
id kit are needed then, and context-graph is ordered first. **vector-search +
completion are resolved on first use** (tick/command time): the dependency
resolver orders by `requires.plugins`, not `requires.capabilities`, so their
providers may activate *after* this plugin, and the completion provider is
swappable so it can't be named in `requires.plugins` at all. Resolving lazily
after boot completes sidesteps both.

## Two regimes

The pipeline runs in two regimes that differ only in **session selector** and
**trigger**:

- **Backfill** — a deliberate, **on-demand command** (`hyp enrich backfill`),
  out of the daemon entirely, mirroring `hyp graph project`
  ([LLP 0023](./0023-context-graph-projection.decision.md#on-demand-projection)).
  Selector: **all sessions**. The graph starts cold, so recall finds nothing and
  dedup is prospect-vs-prospect ([§curate-clustering](#curate-clustering)). It is
  expensive and one-shot, so it is **never automatic** — running it is a user
  decision, like enabling a completion provider
  ([§excluded-from-default-activation](#excluded-from-default-activation)). The
  curate phase accepts a `--since <YYYY-MM-DD>` bound that scopes the pending
  pool to sessions active on or after that day (and `--dry-run` to preview the
  pool + cluster count before submitting). This keeps a recent-window run
  tractable: the cold-regime clustering is per-prospect recall + greedy O(n²)
  cosine ([§curate-clustering](#curate-clustering)), so an unbounded pool of
  thousands is intractable, while a two-week slice is a few hundred. The bound
  is a **read-side filter on `selectPending`, not a mutation** — out-of-window
  prospects stay pending for a later, separately-scoped run, never deleted or
  `skip`-drained ([§salience-drain](#salience-drain)).
- **Ongoing** — an automatic **periodic batch** (default daily). Selector:
  **settled, not-yet-enriched sessions** — latest part older than the run cutoff
  *and* past the session's watermark. "Settled" is a SQL predicate evaluated at
  run time, **not** a per-session idle timer: a daily cadence need not *detect*
  idle, it just enriches whatever went quiet since the last run. Each session is
  thus extracted **once, in full, after it is complete** — never re-extracted
  while hot (which would be quadratic, and the ≤1h prompt-cache TTL cannot span a
  daily gap). A resumed session advances past its watermark and is re-picked when
  it next settles.

Both regimes submit curator calls through the **Anthropic Batch API** (50% off,
async, latency-insensitive). This is sound because **eventual graph freshness is
acceptable** — the graph answers "what happened", not "what is happening"
([LLP 0023](./0023-context-graph-projection.decision.md#on-demand-projection)) —
so a session enriched up to a day after it settles, plus Batch latency, is fine.
It also keeps the heavy frontier-model work off the daemon's critical path:
backfill is a command, and the ongoing batch submits-and-collects rather than
blocking a tick.

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

The contract emits one node per committed item plus a **`produced` edge from
each contributing session** — not a single anchor. Cross-session merge
([§curate-clustering](#curate-clustering)) collapses duplicate proposals into one
committed node (content-addressed id,
[LLP 0023](./0023-context-graph-projection.decision.md#content-addressed-ids)),
and every session that proposed it gets a `produced` edge to that node. This is
append-only — a session that contributes later just appends one more edge, no
retract — so multi-session provenance lives in the **edges**, and the node's
inline `source_keys` keeps 0023's first-sighting collapse
([LLP 0023](./0023-context-graph-projection.decision.md#inline-provenance))
unchanged.

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
against any duplicate rows already on disk. The append is genuinely idempotent,
which is what lets the regimes overlap safely: a session seen by both backfill
and a later ongoing run, or a resumed session re-extracted after it settles
again, yields the same prospect ids and appends nothing new
([§per-session-watermark](#per-session-watermark)).

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

The batch regimes ([§two-regimes](#two-regimes)) process the whole eligible
pool, so the per-tick `max_prospects_per_tick` cap does not apply; salience still
orders the pool and seeds recall-region clustering
([§curate-clustering](#curate-clustering)), and the `skip`-drain still retires
below-threshold prospects without a curator call.

## Curate clustering

T2's cost driver is the frontier-model `complete` call — recall is per-prospect,
cheap, and local. The curate unit is therefore a **similarity / recall cluster**,
not a session:

- **Recall-region grouping** — prospects whose recall hits an overlapping region
  of committed knowledge are curated together against that shared region, read
  once. This dominates the **ongoing** regime, where the graph is already
  populated.
- **Embedding clustering of the no-recall remainder** — prospects that recall
  nothing (a cold graph, or genuinely novel knowledge) are clustered by their
  own embeddings, so near-duplicate proposals from different sessions land in one
  call. This dominates **backfill**, whose first runs face an empty graph. The
  embeddings come from the **`hypaware.embedder`** capability, resolved
  best-effort like vector-search (it is already present transitively, since
  vector-search requires it); if no embedder is installed the remainder falls
  back to per-session grouping rather than failing the tick. Concretely:
  recall-region prospects bucket by their top recalled node id, the remainder is
  greedily clustered by embedding cosine, and every cluster is chunked to a
  `max_cluster_size` so the decisions JSON stays inside the output budget.

The shared context a cluster reuses is therefore **content-based** (the union of
recalled committed nodes) rather than the **structural** one-hop neighborhood
around a single Session anchor the per-session model read. The payoff is cost
(one shared-context read and one curator call spread over more prospects) and
quality: a cluster lets the curator **merge duplicate proposals across sessions
in one call**. Distinct sessions proposing the same thing stay distinct prospects
(different anchor → different `prospect_id`,
[§idempotent-prospects](#idempotent-prospects)) and collapse only when the
curator assigns them the same canonical committed key, which the content-addressed
graph id then dedups
([LLP 0023](./0023-context-graph-projection.decision.md#content-addressed-ids)).

Cluster size is bounded by **output** tokens (the decisions JSON, ~512 per
prospect), not input — raise `max_tokens` / stream to grow clusters; the prospect
text and shared context sit far inside the context window.

## Per-session watermark

Enrichment tracks a **per-session high-water mark** — the latest source part a
session has been enriched through — not a global keyset cursor. A session is
eligible for the ongoing regime when its latest part is past its mark *and* the
session has settled ([§two-regimes](#two-regimes)); backfill ignores the mark and
processes every session. This is what lets the regimes share one pipeline and one
state: backfill seeds the marks, the ongoing batch advances them, and a resumed
session re-qualifies automatically.

This **replaces** the original global `(timestamp, tiebreak)` keyset cursor,
which was coupled to the truncation defect: T1 concatenated a session's filtered
parts only up to a 12k-char cap, but the cursor still advanced past the
**un-extracted overflow** — the dropped parts' ids were recorded as provenance
and the anchor was marked processed — so their text never reached the model and
never would. On the measured corpus that silently lost the tail of **47% of
sessions** and **70% of NL content by volume**, worst on the longest sessions.
Full-session extraction ([§two-tiers-one-pipeline](#two-tiers-one-pipeline)) plus
a per-session mark removes both the cap and the coupling: a session is either
fully enriched through its mark or not yet picked up. Curate has no mark; its
queue is "prospects with no resolution", computed by query.

## Row selection

The enrichment scans **signal, not plumbing**. The T1 propose scan and the T2
source deref share one content filter (`contentFilterClauses`), so the curator
never sees a row the proposer was steered away from. Two knobs, both on the
source config:

- **`require_text`** (default `true`) drops rows whose text column is null/empty
  *before* the per-tick row budget is spent on them. On a real
  `ai_gateway_messages` corpus (~634k parts) **33% of rows carry no
  `content_text`** — every `tool_call` part, plus the thinking/`reasoning` parts
  whose text a proxy never persists (signature only; ~1.7 chars each). These
  already contributed nothing to the model; filtering them in SQL just stops
  them consuming `max_rows_per_tick` and watermark cycles. **This is why
  "thinking tokens" need no dedicated filter** — they are empty, so
  `require_text` already excludes them.
- **`exclude_part_types`** (default `['tool_result']`) drops whole content
  kinds. `tool_result` — raw file/command/search output — is **~60% of the
  corpus by character volume** yet is bulk, not durable knowledge worth
  extracting; feeding it to the recall-tuned T1 model is mostly noise. (It also
  keeps the largest sessions well inside the model's context, but the exclusion
  stands on the signal-not-plumbing rationale, not a hard cap — full sessions now
  fit, [§per-session-watermark](#per-session-watermark).) An explicit `[]`
  disables the filter.

`part_type_column` names the column the second knob reads (default `part_type`).
Filtered-out rows are simply never returned; this is safe because the per-session
mark records progress over the session, not over individual rows, so excluded
parts neither block nor advance it.

The default `exclude_part_types` is **schema-bound**, not global. `part_type` is
a column the base source contract (text / timestamp / id / tiebreak / anchor
columns) never required, and only the default `ai_gateway_messages` schema is
known to have it. So the `['tool_result']` default applies *only* when
`source_dataset` is the default; a custom source defaults to `[]` (no part-type
predicate) rather than emitting `part_type NOT IN (…)` against a column it may
not have and silently breaking every scan. A custom source opts into part-type
filtering explicitly. `require_text` is not gated — it reads `text_column`,
which every source already configures, so it stays on by default everywhere.

**Sub-agent rows were considered and deferred.** Excluding sidechain
(sub-agent) content was the original ask, but on the measured corpus it is only
~12% of text — ~80% of which is *already* removed as `tool_result` — and the
signal is unreliable: `is_sidechain` is `NULL` for ~37% of rows (it depends on
Claude-transcript matching) and only ~4% of conversations carry any flagged
sidechain row. It is also a recall *policy* question (a research sub-agent's
findings may be exactly the knowledge worth capturing), not a pure cost lever
like `tool_result`. `exclude_part_types` is part-type-based and cannot express
it; a sidechain predicate is left as a future knob if the signal firms up.

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
  The ongoing regime makes this reachable in practice — a later session may
  *deepen* a node an earlier one committed — but adding a `produced` edge or a
  new committed node is append-only and works today; only **revising a committed
  node's props** waits on retract.
- **T2 cost** — *resolved by the two-regime rework.* Clustering collapses the
  shared-context cost across more prospects per call
  ([§curate-clustering](#curate-clustering)) and the Batch API halves the spend
  ([§two-regimes](#two-regimes)); backfill is an opt-in command, so its lump cost
  is a user decision. A token/spend-denominated budget is still optional future
  tuning, not a gating concern.
- **Salience tuning** — novelty is `1 - top-1 similarity` against the recall
  index; whether a fixed threshold or an adaptive percentile better separates
  "already covered" from "genuinely new" is unproven and waits on real corpora.
