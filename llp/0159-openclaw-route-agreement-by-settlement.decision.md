# LLP 0159: OpenClaw backfill route agreement rides native-identity settlement

**Type:** Decision
**Status:** Draft
**Systems:** Plugins, Gateway, Cache, Sources
**Author:** Phil / Claude
**Date:** 2026-07-30
**Related:** LLP 0026, LLP 0027, LLP 0030, LLP 0037, LLP 0049, LLP 0085, LLP 0144, LLP 0157, LLP 0158

> Codex proved both capture routes agree by construction: live and backfill
> rows carry the same native ids, so the `part_id` dedupe collapses the
> overlap and `rows_written: 0` is the acceptance pass condition. OpenClaw
> cannot copy that directly, because its live rows have no native identity
> at capture time (LLP 0144: prompt-head-hash session id, gateway fallback
> message ids). The routes are made to agree the way LLP 0027 made the
> Claude twins agree: settlement upgrades live rows to the session JSONL's
> native identity at flush, backfill emits rows under that same native
> identity, and the existing `part_id` dedupe layers do the rest, unchanged.

## Context

For Codex, the backfill provider writes rows that are byte-identical in
identity to live rows, because both routes read the same native ids from
the same payloads. Route overlap is then resolved entirely by the
gateway's `part_id` dedupe (committed-partition scan plus spool scan), and
there is no backfill marker on any row.

OpenClaw's live rows cannot start native. The request-time contexts a
plugin controls carry no session id (LLP 0144 Consequences), so the live
projector keys sessions on a prompt-head hash and messages on the
gateway's fallback content-hash identity. The session JSONL, by contrast,
carries native ids for the session and for every message
(verified 2026-07-30; see LLP 0158 for the reader). A backfill that emits
native-identity rows while live rows sit committed under fallback identity
would double-import every turn that was captured live: no id-keyed layer
can see the pairs are the same message. This is precisely the
finalize-vs-transcript twin problem LLP 0026/0027 solved for Claude,
arriving by a different door.

## Options considered

1. **Conversation-grain skip: backfill drops any session that overlaps
   live capture.** Requires recomputing the live route's prompt-head hash
   from the transcript to find the overlap, but the transcript does not
   reliably reproduce the wire-request system prompt the hash was computed
   from. Fragile, and a partial overlap (session half-captured live) would
   either double-import or drop real history.
2. **Backfill-time content matching against committed rows.** Reimplements
   the settlement enricher's match logic on a second seam, which is the
   drift shape LLP 0158 exists to prevent, and it scales with the whole
   committed table rather than with the flush batch.
3. **Native-identity settlement, then the existing `part_id` dedupe.**
   Chosen. One match implementation (the settlement enricher), one dedupe
   implementation (the gateway's existing layers), both already built.

## Decision

- The live projector stamps `attributes` with a content match key at
  projection time for every row it emits under fallback identity, exactly
  as LLP 0027#decision item 1 does for Claude. The wire content is in hand
  at projection; settlement is then a lookup, not a reconstruction.
- The `@hypaware/openclaw` plugin contributes a settlement enricher
  (`registerSettlementEnricher`, the LLP 0027 dispatch seam). At flush it
  reads the session JSONL through the LLP 0158 reader and upgrades a
  matched row's identity to native: the message id, and the session
  container id (`session_id`, the partition key per LLP 0030) from the
  header. `conversation_id` stays null, matching Claude's convention.
  Flush-time settlement runs before partition grouping, so the upgrade
  changes which partition the row lands in but never rewrites a committed
  row (LLP 0027's no-partition-move invariant is about committed
  rewrites, which this is not).
- The enricher also resolves the header `cwd` (through the LLP 0158
  absolute-path predicate), stamps it on settled rows, and applies the
  flush-time usage-policy drop of LLP 0085 when that cwd resolves to
  ignore. This is not an optimization: live OpenClaw proxy rows capture
  no cwd at all, so without this seam `.hypignore` would fail open for
  the entire client, permanently (LLP 0049 R1 as extended by LLP 0085).
- The backfill provider emits whole-session projected exchanges under the
  same native identity, through the same row expansion the live recorder
  uses (the `projectedExchangeItem` path), so identity construction cannot
  diverge between routes.
- Route overlap is resolved by the existing dedupe layers, unchanged: the
  backfill pre-write seen-set over committed and spooled `part_id`s, and
  the flush-time committed-`part_id` dedupe that collapses a late-settled
  live row onto an already-committed backfill row.
- Rows that commit unsettled (transcript line not on disk at flush, or no
  match) keep fallback identity. If backfill later imports the same turn,
  the fallback twin is a residual duplicate. This residue is accepted and
  bounded, in the same register LLP 0027 accepted its pre-sweep residue:
  the maintenance re-settle sweep collapses message-grain twins within a
  partition, and the cross-partition case (hash-keyed conversation vs
  native-keyed conversation) is named in Open questions rather than
  silently ignored.

## Consequences

- The Codex acceptance semantics transfer: on a machine where live capture
  ran, an overlapping `hyp backfill openclaw` reporting `rows_written: 0`
  with `rows_skipped >= 1` is the proof the routes agree
  (LLP 0157#acceptance).
- Backfilled rows carry no route marker, matching the Codex posture:
  provenance rides the `BackfillItem` envelope and structured logs, not
  the row.
- Settlement quality becomes load-bearing for dedupe, not just for
  identity niceness. The enricher's match rate at flush depends on
  OpenClaw writing transcript lines promptly (LLP 0158 Open questions);
  if it buffers until session end, the residue grows and this decision's
  cost-benefit should be revisited.
- The re-run trap documented for `hyp backfill` generally still holds:
  `part_id` dedupe drops refreshed rows, so re-running backfill never
  updates already-imported rows.
- Restart churn, verified and accepted: the live projector's replay
  dedupe seeds `seenMessages` by `session_id`
  (`message_projector.js seedSeenMessagesForSession`). After settlement
  renames a session, a post-restart replay of it misses the seed and
  re-emits rows; the re-emits settle to the same native ids and the
  flush-time committed-`part_id` dedupe drops them. Self-healing, at the
  cost of transient duplicate work in the flush batch, not corruption.

## Open questions

- The cross-partition twin: a live row that never settles keeps the hash
  `session_id` and a null `cwd`, both partition keys (LLP 0030), so it
  lives in a different partition from its native backfill twin and the
  re-settle sweep (single-partition rewrite, never moves rows) cannot
  collapse the pair. A message-grain-only sweep upgrade (message id and
  `part_id`, partition keys untouched) would still prevent actual
  duplication: run before backfill, it puts the native `part_id` in the
  backfill seen-set so the twin import is skipped, even though the live
  row itself stays hash-keyed and cwd-null. Measure the residue before
  building that.
- Match-key normalization: for Claude, the transcript stores the same
  wire-shaped messages the proxy saw, so one content key matches both
  sides. OpenClaw's session file stores its own normalized message shape
  (for example `toolCall` blocks where the Anthropic wire has
  `tool_use`), so the match key must normalize across two formats. The
  enricher's match rate is therefore an implementation risk, not a given;
  measure it during implementation and revisit this decision if content
  matching proves unreliable (timestamp-and-order matching is the
  fallback shape).
- Should backfill refuse to import a session whose JSONL predates the
  earliest settlement-capable HypAware version on the machine, to bound
  the twin residue from history captured by older builds? Likely
  unnecessary; noted so the question is asked with data.

## References

- LLP 0026, 0027, 0030, 0037, 0049, 0085, 0144, 0157, 0158
- `hypaware-core/plugins-workspace/ai-gateway/src/dataset.js`
  (`createBackfillDedupe`, `scanExistingPartIds`, `scanSpooledPartIds`,
  `dedupeByPartId`)
- `hypaware-core/plugins-workspace/codex/src/backfill.js` (the route
  agreement precedent)
