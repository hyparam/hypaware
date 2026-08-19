# LLP 0266: `claude_telemetry_events` rows carry `cwd`, so the export seam can withhold them

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Sources, Cache, Usage-Policy
**Author:** neutral / Claude
**Date:** 2026-08-19
**Related:** LLP 0069, LLP 0070, LLP 0103, LLP 0105, LLP 0188, LLP 0254, LLP 0255, LLP 0257

> `claude_telemetry_events` forwards to a fleet server under the
> `claude_telemetry` signal, but its rows carried no `cwd`, and the export
> seam's `local-only` filter reads exactly that column. The filter could
> never fire for the dataset, so behavioral rows from a `local-only`
> directory forwarded. The fix is a `cwd` column stamped at ingest from the
> hook record the ingest verdict was already resolved against; the seam that
> owns `local-only` does not move.
>
> Extends [LLP 0255 #row-shape](./0255-claude-telemetry-events-dataset.decision.md#row-shape):
> `cwd` joins the typed columns, for a privacy reason rather than a
> query-ergonomics one.
>
> @ref LLP 0070#derive [constrained-by]: the verdict is derived from the row's own `cwd` at export time, so a forwarding dataset has to persist one.
> @ref LLP 0254#policy-inline [constrained-by]: ingest settles `ignore` and the undetermined case; `local-only` is deliberately kept, which is what makes the downstream seam load-bearing.

## Context {#context}

Two comments in the tree could not both be true.

`events_dataset.js` justified having no `cwd`, no `attribution_column`, and
no `localOnlyContentColumns` with: an ignored session's events are dropped
before any row is written ([LLP 0254 #policy-inline](./0254-otel-path-settles-at-ingest.decision.md#policy-inline)),
so the rows that exist are recordable by construction.

`policy.js` said, correctly, that this covers `ignore` and not `local-only`:

> `local-only` is kept, exactly as the proxy projector keeps it: that class is
> enforced at the export and query seams ([LLP 0070](./0070-local-only-export-seam.decision.md)),
> not by refusing to record.

The export seam's filter (`src/core/cache/storage.js`, `readRowsSince`) fires
only for a row with a non-empty `cwd`. A dataset with no `cwd` column is
structurally invisible to it. Since [LLP 0255 #owned-by-claude](./0255-claude-telemetry-events-dataset.decision.md#owned-by-claude)
gives the dataset a source signal, every behavioral event from a `local-only`
directory (session ids, tool names, decisions, `tool_input` excerpts, cost)
shipped on the next sink tick: the one outcome
[LLP 0069](./0069-local-only-dir-selection.spec.md) exists to prevent.

## Decision {#decision}

**Behavioral rows carry `cwd`. The seam that enforces `local-only` does not
move.**

- **A nullable `cwd` column** joins `CLAUDE_TELEMETRY_EVENT_COLUMNS`, appended
  last so the change is additive under
  [LLP 0029](./0029-additive-cache-schema-evolution.decision.md): existing
  tables evolve in place and pre-existing rows read `null`.
- **The listener stamps it at ingest** from `pickLatestMatching(records)`,
  the same SessionStart hook record `applyUsagePolicy` resolved that session's
  verdict from. A row is therefore stamped with the cwd it was judged by, and
  the message dataset and the behavioral dataset cannot disagree about where
  one session ran.
- **An event naming no session stamps `null`.** There is no session, so there
  is no cwd to resolve, and a null `cwd` reads `full` at both seams - the
  polarity `ai_gateway_messages` has always had and that
  `test/core/null-cwd-full-class.test.js` pins. Nothing conversational rides
  out that way: content events are not stored in this dataset at all.

### Why a column, not an ingest-time drop {#why-column}

An ingest-time drop for `local-only` would be a different product.
`local-only` means *recorded locally, never forwarded*: refusing to record is
`ignore`. Dropping here would also make the class irreversible for this
dataset (un-marking a directory could not bring back rows that were never
written) and would contradict the proxy path, where the same session's message
rows are kept.

### Why stamping a cwd is not the marker LLP 0070 rejected {#not-a-marker}

[LLP 0070 #derive](./0070-local-only-export-seam.decision.md#derive) rejected a
capture-time `local-only` marker, because class membership is a function of the
user's *current* list and a baked boolean goes stale. `cwd` is not that: it is
an immutable fact about where the row came from, and it is what the seam
already reads on every other forwarding dataset. Stamping it keeps the verdict
derived at export time and keeps the retroactive and reversible properties
LLP 0070 bought.

### The query seam comes along {#query-seam}

`withLocalOnlyVisibility` (`src/core/query/visibility.js`) keys on the same
column, so [LLP 0105](./0105-query-seam-local-only-visibility.decision.md)'s
filter starts working for this dataset with no further change: a
`local-only` session's behavioral rows no longer surface as tool results
inside a synced transcript. The dataset still declares no
`localOnlyContentColumns`; that fallback is for rows that cannot prove their
provenance, and these prove it with `cwd`.

## Consequences {#consequences}

- Rows written before this change carry `null` `cwd` and are treated `full`.
  They are not reclassified: [LLP 0069 non-goal 1](./0069-local-only-dir-selection.spec.md#non-goals)
  already says already-passed history is not recalled, and a backfill would
  have to invent provenance the rows never had.
- The forwarded payload gains a `cwd` field for this signal, matching the
  field the message signal has always carried.
- `test/plugins/claude-telemetry-local-only-export.test.js` pins the
  withholding at the export seam, and `claude_telemetry_capture` asserts every
  behavioral row carries the hook's cwd end to end.

## Alternatives considered {#alternatives}

- **Declare `attribution_column`.** Wrong key: [LLP 0188](./0188-enrolled-default-sync-with-client-optout.decision.md)
  withholds by picker-source opt-out, not by directory. Every row here is a
  `claude` row, so the dataset-scoped rule already covers that axis.
- **Declare `localOnlyContentColumns: ['attributes']`.** Rejected: it would
  null the attributes JSON for every ordinary caller of a `cwd`-less dataset,
  degrading the table for everyone while still forwarding the rows, which is
  the actual leak.
- **Drop `local-only` events at ingest.** Rejected: see
  [why-column](#why-column).
