# LLP 0442: A maintenance re-settle's rename reaches a successor committed in an earlier batch

**Type:** Issue
**Status:** Draft
**Systems:** Cache, Gateway, Plugins
**Author:** Phil / Claude
**Date:** 2026-09-26
**Generated-by:** neutral
**Extends:** LLP 0440 (#batch-local, the bound this request asks to relax for
the maintenance lane and only for that lane), LLP 0441
(#select-the-successors, the selection widening this asks to reach the
maintenance re-settle)
**Related:** LLP 0027 (#re-settle-sweep, the sweep this runs inside), LLP 0085
(the drop authority no option here may widen), LLP 0301 (#bounded-resettle,
the memory bound every option here inherits), LLP 0311 (#date-partition, why
one rewrite covers every date of a source segment), LLP 0312 (#settle-purity,
what makes a second settle call legal), LLP 0435, LLP 0439
**Tracker:** hyparam/hypaware#2192

> @ref LLP 0440#batch-local [constrained-by]: "the rename applies to the rows
> of the settle call that performed it, and nothing else" is the settled bound
> this request asks to extend, for the maintenance lane only.
> @ref LLP 0301#bounded-resettle [constrained-by]: whatever the maintenance
> sweep retains across scan batches stays bounded by `compact_batch_bytes`,
> or by identity strings rather than rows.

> LLP 0441 made the flush-time settle pass select the in-batch successors of
> the rows it can rename, so LLP 0440's relink reaches them. The maintenance
> re-settle sweep hands the enricher only fallback rows, so the same relink
> never reaches any successor there, and a successor committed in an earlier
> flush keeps a pointer to a hash its predecessor has now vacated. Closing
> that needs the sweep to carry something across its scan batches, which is a
> design decision LLP 0440 #batch-local settled the other way. This is the
> request to reopen it for that lane.

## Problem {#problem}

Take a fallback predecessor P committed in flush batch A and its native
successor S committed in flush batch B. Nothing at flush time repairs the
pair: LLP 0441's widening is in-batch, and its own Consequences record that
"its cross-batch sibling stands". The LLP 0027 re-settle sweep is the only
later pass that looks at P at all, and when it upgrades P's `message_id` to
the native uuid, S is rewritten into the new generation byte-identical, so
`S.previous_message_id` names an id no row in the cache carries. A thread walk
from S stops there instead of reaching the turn before it.

The sweep cannot reach S because of what it hands over, not because of what
the enricher does:

- `src/core/cache/maintenance.js` `compactGeneration` streams the generation
  and sends every non-fallback row straight to `emit`. Only
  `isGatewayFallbackRow(row)` rows are held back, into a `fallbackBatch`
  bounded by `compact_batch_bytes` and `COMPACT_BATCH_SIZE`
  (LLP 0301 #bounded-resettle). S is never in a settle batch at all, so no
  predicate change alone can select it.
- `victimFallbacksSettleable` probes with `rows.filter(isGatewayFallbackRow)`
  for the same reason: it is asking whether a rewrite is worth routing to.
- `createResettleBatch` (`hypaware-core/plugins-workspace/ai-gateway/src/dataset.js`)
  passes no `select`, so `upgradeFallbackRows` falls back to plain
  `isFallbackRow`. The flush lane's `planSettleSelection`, which is where
  LLP 0441's third shape lives, is not on this path.

The damage is a stale lineage pointer, not data loss and not a privacy-gate
miss: export withholding re-derives from the row's own `cwd`
(`src/core/cache/storage.js`), and no row is dropped or duplicated.

## What LLP 0440 settled, and why this is a request rather than a fix {#why-a-request}

LLP 0440 #batch-local is `Accepted`, and its normative sentence covers any
settle call, this lane included. Its stated rationale, however, is about the
flush path: making the pass read the cache "would put a scan and a rewrite of
committed partitions on the flush path for a pointer whose worst case is an
early stop in a thread walk."

That rationale does not transfer to the maintenance lane, and the evidence is
in the lane itself. The whole-generation rewrite already scans and rewrites
committed partitions as its entire job; it already pays a second, narrow
full-generation scan to retain identity keys across scan batches
(`scanNativePartIds`, LLP 0301 #bounded-resettle); and it already calls the
settle hook speculatively on committed rows and throws the answer away
(`victimFallbacksSettleable`, legal only because of LLP 0312 #settle-purity).
The cost 0440 refused to put on the flush path is the maintenance lane's
baseline.

So an extension for this lane is coherent rather than contradictory. It is
still an extension: the bound is settled, LLP 0441 leaned on it ("#batch-local
is untouched"), and the repair needs state carried between scan batches, which
is precisely what #batch-local forbids. Hence a request, not a patch.

## Requirements {#requirements}

1. After the sweep upgrades P, a successor S in the same generation names P's
   upgraded `message_id`, whether S streamed before or after P and whether or
   not they landed in the same settle batch.
2. Retention across scan batches stays bounded, and the bound is named. Peak
   resident bytes must not grow with the generation's row count in the way
   LLP 0301 removed. No option may retain rows to the end of the scan without
   a cap.
3. The set of rows a settle pass may remove is unchanged (LLP 0085,
   LLP 0441 #no-new-drop-authority). The maintenance re-settle never drops a
   committed row.
4. A row whose predecessor was not renamed is emitted byte-identical, so no
   chain is rewritten speculatively and the rewrite stays idempotent across
   ticks.
5. The de-twin contract holds: an upgraded fallback still collapses onto a
   native twin found in the narrow identity pass or in a later settle batch.
6. No new cursor field, config key, or schema column.

## Options {#options}

### A. Retain the rename map, apply it in a second full-row pass

Pass 1 settles the generation's fallback rows in the existing byte-bounded
batches and records only `oldMessageId -> newMessageId` for each rename. Pass
2 is the output rewrite: it calls settle again for the fallback batches (pure
and idempotent by LLP 0312, so a repeat call is legal) and rewrites
`previous_message_id` on any row whose link the map names.

- Bound: one map entry, two strings, per fallback row the sweep actually
  renamed. Strictly smaller than the identity-key set LLP 0301 already retains
  for the whole generation, and it holds no row references.
- Cost: one extra full-row read of the generation, and the transcript work of
  settle is done twice per generation. Complete within the generation.

### B. Hold back candidate successors in a byte-bounded buffer

Extend the existing narrow pass (it already reads `attributes` and
`message_id`) to also collect the generation's fallback `message_id` set. In
the rewrite, a non-fallback row whose `previous_message_id` names one of those
ids is held back instead of emitted, and released after the last fallback
batch settles, with its link rewritten if its predecessor was renamed.

- Bound: the hold-back buffer shares one byte budget with the fallback settle
  batch, so peak retention is still `compact_batch_bytes`. When the budget
  fills, the oldest held rows are emitted with their links untouched, which is
  exactly today's behavior. The repair is therefore best-effort under memory
  pressure rather than a heap risk. Plus one `Set` of fallback `message_id`
  strings, O(fallback rows), the same order as the key set LLP 0301 keeps.
- Cost: one settle pass, no extra read. Incomplete by construction: a long run
  of successors can overflow the budget and keep stale links.

### C. Stay inside #batch-local: relink only within the pending settle batch

Apply LLP 0441's widened selection to the maintenance batch by holding back a
non-fallback row whose link names a `message_id` in the CURRENTLY pending
fallback batch, so predecessor and successor reach the enricher in one call.

- Bound: the same batch cap, nothing new retained.
- No LLP 0440 extension needed, and no new decision. But which successors get
  repaired depends on scan order, so the outcome is nondeterministic across
  ticks, and the acceptance condition on #2192 (predecessor and successor in
  DIFFERENT scan batches) is not met. Recorded here as the honest floor, not
  as a recommendation.

### D. Rejected: defer the repair through the cursor

Recording pending renames in `cursor.json` for a later pass to apply needs a
new cursor field, which requirement 6 and the repo's "do not invent schema
fields" rule both refuse, and it turns one bounded rewrite into two states to
keep consistent.

## Recommendation and open question {#recommendation}

A is the option that satisfies requirement 1 unconditionally with the stronger
memory bound, and its cost is CPU and read I/O on a lane that already pays
both. B is cheaper per tick but buys an incomplete repair, which for a
pointer whose worst case is an early stop in a thread walk may well be the
right price.

The open question for review is which trade this lane should take: a second
settle pass per generation for a complete repair (A), or a bounded best-effort
repair at today's cost (B). Requirement 2 is what makes it a real question
rather than a preference, and no option may be implemented as an unbounded
successor buffer.

## Residue this cannot reach {#residue}

- One rewrite covers one `source=` segment of the dataset (the segment columns
  are `client_name`, `conversation_source`, `provider`; the `date` partitions
  live inside that table, LLP 0311 #date-partition). A successor in a
  different source segment is outside the rewrite and out of reach of every
  option above.
- The in-place merge path does not settle at all, so any repair here happens
  only on the whole-generation rewrite the settle escape routes to.
- The relink itself is claude-only (LLP 0441, Consequences): the OpenClaw
  enricher has no `previous_message_id` handling, so this request changes
  nothing for it.
- A predecessor that settlement DROPS still leaves its successor pointing at a
  row that is gone (LLP 0085, LLP 0440). Renaming a pointer does not address
  that and this does not claim to.

## Verification {#verification}

- A maintenance-lane regression stages a `gateway_fallback` predecessor and
  its native successor so that they fall in DIFFERENT scan batches (a settle
  batch cap small enough to split them), runs the compaction re-settle, and
  asserts the successor's `previous_message_id` names the predecessor's
  upgraded `message_id`. It fails on today's code.
- A retention assertion proves whatever the chosen option carries across scan
  batches stays within its named bound, in the shape LLP 0301's regression
  already uses for the settle batches.
- The existing `test/core/cache-resettle-sweep.test.js` cases stay green, and
  a generation with no fallback rows takes the identical path to today's, to
  the row.
