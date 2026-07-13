# LLP 0070: ship `local-only` at the export seam, derived from `cwd`

**Type:** Decision
**Status:** Accepted
**Systems:** Sinks, Cache
**Author:** Phil / Claude
**Date:** 2026-07-06
**Related:** LLP 0049, LLP 0050, LLP 0051, LLP 0069, LLP 0014, LLP 0022, LLP 0030, LLP 0038, LLP 0039, LLP 0029

> Promotes the [`local-only`](./0051-usage-policy-future-extensions.decision.md#local-only)
> usage class from *reserved/deferred* to *shipped*, and fixes its mechanics:
> the shared export read seam (`storage.readRowsSince`) drops each row whose
> `cwd` resolves to `local-only`, via the shared usage-policy resolver, as the
> rows are already being scanned for forwarding. No cache-schema column, no
> capture-time marker — the verdict is derived from the row's existing `cwd` at
> export time. Local *query* uses a different read path, so `local-only` rows
> stay locally queryable.
>
> **Extended-by [LLP 0105](./0105-query-seam-local-only-visibility.decision.md):**
> "stays locally queryable" is qualified: queryable from contexts that are
> themselves non-exported; query surfaces filter `local-only` rows out of
> results returned into synced contexts, closing the transcript leak around
> this seam.
>
> @ref LLP 0051#local-only [implements] — realizes the deferred class.
> @ref LLP 0069 [implements] — the export-seam half of the login directory picker.
> @ref LLP 0050#shared-matcher-in-core [constrained-by] — one shared resolver, extended not duplicated.

## Context

[LLP 0049](./0049-hypignore-usage-policy.spec.md) defined a scope→class usage
model and shipped exactly one class, `ignore`, dropped at the **capture seam**
(the projector returns no rows — [LLP 0050](./0050-ignore-enforced-in-adapters.decision.md)).
It reserved a second class, `local-only` — *recorded locally, never
exported/forwarded* — and [LLP 0051 §local-only](./0051-usage-policy-future-extensions.decision.md#local-only)
deferred it, sketching three costs that made it "bigger than `ignore`":

1. a **persistent marker** on cached rows surviving restart — an additive
   cache-schema column ([LLP 0029](./0029-additive-cache-schema-evolution.decision.md));
2. a new **filter in the export driver** every sink path honors;
3. a **granularity** decision — per-row attribute vs. riding the partition key
   ([LLP 0030](./0030-session-id-partition-key.decision.md)).

[LLP 0069](./0069-local-only-dir-selection.spec.md) now needs `local-only`
shipped. This decision resolves all three — and collapses the first one to
nothing.

## Decision {#enforce}

**`local-only` is enforced at the export seam as a per-row filter on the shared
export read (`storage.readRowsSince`): a row whose `cwd` resolves to `local-only`
is dropped from the outgoing stream before it reaches any sink. The verdict is
derived from the row's existing `cwd` at export time; there is no capture-time
marker and no cache-schema change.**

The physical cache partition is `source=<client>` (all Claude/Codex traffic for
a client — `src/core/cache/partition.js`, `ai-gateway/src/dataset.js`
`cachePartitioning.source`), **not** keyed by `cwd`; a single partition holds
many directories' rows. So there is no whole-partition-skip-by-`cwd`: the filter
is necessarily per row. That costs nothing extra, because every sink **already
scans every row** of a ready partition through one API — `storage.readRowsSince`
(`src/core/cache/storage.js`), used by the `@hypaware/central` forward sink
(`central/src/sink.js` `forwardPartition`) directly and by every blob/Iceberg
sink via `src/core/sinks/incremental.js`. The filter lives at that one seam:
`readRowsSince` resolves each row's `cwd` through the shared usage-policy
resolver (§[resolver](#resolver)) and omits `local-only` rows from what it yields
to the sink, so **every** sink honors it by construction (central forward, blob,
Iceberg alike — [LLP 0051](./0051-usage-policy-future-extensions.decision.md#local-only)
requires all of them skip it). The rows stay in the cache and, because local
query does not go through `readRowsSince` (§[why-export](#why-export)), remain
locally queryable.

### Why derive from `cwd`, not stamp a marker {#derive}

[LLP 0051](./0051-usage-policy-future-extensions.decision.md#local-only)'s cost
(1) assumed `local-only` needs a persistent per-row column written at capture
time. It does not, because the fact enforcement needs — *which directory did this
row come from* — is **already persisted on the row itself**: `cwd` is a
first-class column on `ai_gateway_messages` (`message_projector.js`), carried on
every row the export read yields. (It is *also* an Iceberg sub-partition field
inside each `source=` table — [LLP 0022](./0022-iceberg-export-partitioning.spec.md),
[LLP 0030](./0030-session-id-partition-key.decision.md) — but the export path
reads rows, not manifest partition values, so that is incidental here.) The
`local-only` membership is not an intrinsic property of the row frozen at
capture; it is a function of *the user's current exclusion list* applied to that
row's `cwd`. So the honest place to evaluate it is **at export time**, against
the list as it stands then — not a stale boolean baked in when the row was
written.

This is strictly better than the additive-column sketch:

- **No cache-schema change** — no [LLP 0029](./0029-additive-cache-schema-evolution.decision.md)
  migration, no backfill to populate the column on historical rows.
- **Retroactive by construction** — the instant a directory is added to the
  list, *every* already-cached partition from it (including backfilled history)
  stops being forwarded on the next export pass. A capture-time marker would
  cover only rows written after the marker existed, leaving the backlog exposed —
  the exact history [LLP 0069](./0069-local-only-dir-selection.spec.md) exists to
  withhold.
- **Reversible by construction** — removing a directory from the list resumes
  forwarding with no row rewrite. (Rows already forwarded before exclusion are
  not recalled — that is [LLP 0069 non-goal 1](./0069-local-only-dir-selection.spec.md#non-goals).)

### Granularity: per row, keyed on the row's `cwd` {#granularity}

Resolving [LLP 0051](./0051-usage-policy-future-extensions.decision.md#local-only)'s
cost (3): `local-only` is evaluated **per row**, keyed on each row's `cwd` — not
at partition granularity. The physical partition (`source=<client>`) mixes many
directories, so a partition-level verdict would be wrong (it would forward or
withhold a whole client's traffic indiscriminately). Per-row is also exactly the
right grain for the motivating case — a session that `cd`s between an org repo
and a personal tree emits rows with different `cwd`s into the *same* partition,
and per-row filtering forwards the org-repo rows while withholding the
personal-tree rows of that one session.

Per-row does **not** mean per-row cost. The export read already visits every row
(to serialize and chunk it — `central/src/sink.js`), and the resolver is memoized
per distinct `cwd` ([LLP 0049 R6](./0049-hypignore-usage-policy.spec.md#requirements)),
of which a partition has few, so the added work is one cached lookup per row and
one real resolve per distinct directory.

### The resolver gains a second source {#resolver}

The shared matcher in `src/core/usage-policy/`
([LLP 0050 §shared-matcher](./0050-ignore-enforced-in-adapters.decision.md#shared-matcher-in-core))
today answers *given a `cwd`, walk ancestors → nearest `.hypignore` → class*.
It gains a **second source** feeding the same answer: the machine-local
`local-only` list ([LLP 0071](./0071-machine-local-exclusion-list.decision.md)).
Given a `cwd`, the resolver now considers both `.hypignore` ancestors and the
`local-only` list and returns the **most restrictive** class:

`ignore` (never recorded) **>** `local-only` (recorded, not forwarded) **>**
`full` (default).

`ignore` dominating `local-only` is not a special case — an `ignore`d row never
enters the cache, so it never reaches the export seam and the `local-only` check
is moot. The ordering just makes the precedence explicit and total. This is the
extension [LLP 0050](./0050-ignore-enforced-in-adapters.decision.md#consequences)
anticipated ("a future call site reuses the same core matcher"); it does **not**
reopen LLP 0050 — the gateway stays `cwd`-blind, and the new call site is the
shared export read (`storage.readRowsSince`), not the gateway.

## Why `readRowsSince`, the one seam that is export-only {#why-export}

`local-only`'s definition is *recorded locally, not forwarded*. Recording locally
means the row must pass the capture seam and enter the cache — so enforcement
cannot live there (that is `ignore`). It must live on the read path *to sinks*,
and the seam has to satisfy two constraints at once
([LLP 0000 cross-cutting invariant](./0000-hypaware.explainer.md): *sources write
only to the cache; the export pipeline reads the cache and pushes to sinks*):

1. **Cover every sink, once.** [LLP 0051](./0051-usage-policy-future-extensions.decision.md#local-only)
   requires central forward, blob, and Iceberg sinks all skip `local-only`; a
   per-sink filter is one a new sink forgets, and duplicating privacy-critical
   logic is what [LLP 0050](./0050-ignore-enforced-in-adapters.decision.md) forbids.
2. **Not touch local query.** `local-only` rows must stay locally queryable — that
   is the whole difference from `ignore`. So the filter must sit on a read path
   that sinks use but query does not.

`storage.readRowsSince` (`src/core/cache/storage.js`) satisfies both exactly. It
is the **shared export read**: the forward sink reads through it
(`central/src/sink.js` `forwardPartition`) and every blob/Iceberg sink reads
through it via `src/core/sinks/incremental.js`. Local query uses an entirely
different path — `executeQuerySql` → `squirreling` → `parquet-source.js`
([LLP 0015](./0015-query-and-datasets.spec.md)) — which never calls
`readRowsSince`. Filtering inside `readRowsSince` therefore covers all sinks by
construction *and* leaves local query untouched, making "recorded locally,
queryable, never forwarded" a **structural property of the read-path split**
rather than a flag every sink and every query must remember to check. (The
[LLP 0038](./0038-split-query-export-daemon-from-gateway.todo.md) query/export
daemon split does not move this seam; `readRowsSince` stays the sinks' read
regardless of which process runs the driver.)

## Interaction with incremental sink reads {#incremental}

[LLP 0039](./0039-incremental-sink-reads.spec.md)/0040 advance a per-`(sink,
partition)` watermark keyed on the monotonic `_hyp_ingest_seq`
(`src/core/sinks/watermarks.js`, `src/core/cache/streaming-reader.js`): the
forward sink ships a chunk, then checkpoints the watermark to the `after` token
of the last row shipped (`central/src/sink.js`, ship-first/advance-second). A
per-row drop introduces one requirement the naïve filter would get wrong:

> **The watermark must advance past dropped rows, not just past the last
> *shipped* row.**

`readRowsSince` must therefore still surface the `after`/`seq` of a `local-only`
row it drops (e.g. yield it marked drop-only, payload omitted), so the sink
advances the cursor across it. Otherwise a partition ending in a run of
`local-only` rows would never checkpoint past them, and every tick would
re-scan-and-re-drop the same tail forever — wasteful, and it would also re-send
those rows the instant they were un-excluded (the seq never having advanced).
With the cursor advancing across drops, a `local-only` row is **durably passed**:
not re-scanned, and **not re-sent on un-exclusion** — consistent with
[LLP 0069 non-goal 1](./0069-local-only-dir-selection.spec.md#non-goals) (no
re-send of already-passed history) while all *future* rows from a still-excluded
directory keep being dropped. The exact "drop-but-advance" shape of the
`readRowsSince` yield is a design detail for the follow-on design doc; this
decision fixes the invariant: **the filter drops the row from the payload but
advances the cursor across it.**

## Consequences

- Code landing this carries `@ref LLP 0070#enforce [implements]` on the
  `readRowsSince` row filter (`src/core/cache/storage.js`) and
  `@ref LLP 0070#resolver [implements]` on the resolver's `local-only` source,
  alongside the existing `@ref LLP 0050` on the shared matcher. The cursor-advance
  invariant ([incremental](#incremental)) carries
  `@ref LLP 0070#incremental [constrained-by]` at the watermark write site.
- **No [LLP 0029](./0029-additive-cache-schema-evolution.decision.md) migration**
  and no capture-path change — the AI gateway, the adapters, and the recorder are
  untouched. This is purely an export-read + resolver change, confined to
  `src/core/cache/storage.js` and `src/core/usage-policy/`.
- [LLP 0051 §local-only](./0051-usage-policy-future-extensions.decision.md#local-only)
  moves from *deferred* to *shipped*; a forward-ref note is added there pointing
  here (mirroring how session-opt-out was promoted to LLP 0066).
- **Fail-safe preserved.** [LLP 0049 §fail-safe](./0049-hypignore-usage-policy.spec.md#fail-safe)
  guaranteed a version that cannot honor `local-only` resolves it to `ignore`
  (suppress more). A version that *can* (this one) records-and-withholds — a
  loosening the user explicitly asked for, never the reverse. The invariant
  "upgrading can only ever expose *less*" holds.

## Alternatives considered

- **Capture-time `local-only` column (LLP 0051's original sketch).** Rejected:
  needs a cache-schema migration and a historical backfill, bakes a mutable
  policy decision into immutable rows, and cannot withhold the pre-existing
  backlog without rewriting it. Deriving from `cwd` at export time is smaller and
  more correct.
- **Filter in each sink plugin.** Rejected: a privacy control that every sink
  must remember to implement is one a new sink will forget. The shared
  `readRowsSince` filter covers all sinks by construction ([why-export](#why-export)).
- **Filter in the sink driver / change the `exportBatch` contract.** The driver
  (`src/core/sinks/driver.js`) hands whole `source=` partitions to
  `sink.exportBatch` and never sees rows, so it cannot filter by `cwd` without a
  new contract passing a row predicate into every sink — heavier than, and
  redundant with, the one read seam the sinks already share. Rejected in favor of
  `readRowsSince` ([why-export](#why-export)).
- **Reuse `ignore` (capture seam) and skip `local-only` entirely.** Rejected at
  the spec level ([LLP 0069](./0069-local-only-dir-selection.spec.md)): it throws
  away the local recording the user wants to keep. Different product.
