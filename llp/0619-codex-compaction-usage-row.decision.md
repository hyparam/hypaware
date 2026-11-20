# LLP 0619: A Codex remote compaction call bills its usage to a row of its own

**Type:** Decision
**Status:** Draft
**Systems:** Gateway, Plugins
**Author:** HypForge
**Date:** 2026-11-20
**Related:** LLP 0016 (ai-gateway), LLP 0049 (hypignore usage policy)
**Extends:** LLP 0035 (#one-carrier, #per-turn)

> Each Codex remote compaction call's billed usage lands on one row of its
> own: role `system`, one `status` block, no text, keyed by the call's
> response id. Live capture reads it from the response, the rollout import
> from the call's `token_usage_record`, and both settle to one `part_id`. It
> counts in every token total. No retained history message carries it.

## Context

A remote compaction is a billed model call that returns opaque state, not a
summary. Codex makes it two ways:

- The older `/responses/compact` endpoint, whose output is the retained history
  plus an encrypted compaction item.
- Remote compaction v2 (Codex `compact_remote_v2`), a normal `/responses` call
  whose input ends with `{ type: 'compaction_trigger' }` and whose output is one
  `compaction` item with `encrypted_content`. Usage arrives on
  `response.completed` as for any response.

LLP 0035 puts a response's usage on its last assistant row (#one-carrier), and
Codex backfill reads per-turn usage from `token_count` (#per-turn). A
compaction has no assistant row: #2882 rightly stopped the `/responses/compact`
usage from landing on a retained history message that was mislabeled
`assistant`, and since then the call's tokens land nowhere. A session that
compacts three times is short by three calls in every sum.

Phil, picking the follow-up the #2882 review offered (issue #3049): "Compaction
tokens are real usage, so let's give them their own row and get them back into
the totals."

## Decision

- <a id="row"></a>**One row per call, from existing columns.** The row is a
  projected message with:
  - `role: 'system'`, `message_id` = the call's response id;
  - `content: [{ type: 'status', status: 'compaction.usage' }]`, so the part is
    `part_type: 'status'` with no `content_text`;
  - `provider_type: 'compaction'`, `provider_subtype: 'compaction.usage'`;
  - `compact_metadata: { compaction_response_id }`;
  - `attributes.usage`, normalized by the lane's existing usage function (net
    input, per LLP 0035 #net-input).

  It is not a compact summary (`is_compact_summary` stays unset). The token
  columns fill from `attributes.usage` as for any row. No column, config key,
  schema field or partition declaration is added. The `system` role is never
  a LLP 0035 carrier, so nothing else ever stamps usage on it, and the status
  block is the same shape the session-usage rows of other adapters use.

- <a id="live"></a>**Live capture.** The exchange projector builds the row when
  a response has no assistant output and its output holds a compaction item
  (`compaction`, `compaction_summary` or `context_compaction`). It reads the
  body, or for a streamed reply the `response.completed` event, and keys the
  row by the response id (else the stream's `response.created` id, else the
  compaction item's id). On `/responses/compact` the retained history keeps
  its roles and carries no usage; the usage row is added after it. The stream
  is scanned only when there is no assistant output, so a normal turn does no
  extra work.

- <a id="backfill"></a>**Backfill.** The rollout does record the call's tokens.
  Since Codex #41912 (2026-08-31) every foreground response writes a
  `token_usage_record` line `{ response_id, usage }`, and v2 writes no
  `token_count` with the call's usage. Its `compacted` checkpoint follows,
  with an empty `message` and `compaction_response_id` equal to the same
  response id. The import keeps the last record in one slot and, at a
  `compacted` checkpoint with no plaintext summary whose id matches it, emits
  the usage row at the checkpoint's timestamp. A record that no checkpoint
  claims (a normal turn's) adds nothing; `token_count` stays the per-turn
  source (LLP 0035 #per-turn). The row's id is a response id, so it does not
  count toward the session's native message identity.

- <a id="count-once"></a>**Counted once.** Both lanes key the row by the same
  response id, so both produce `part_id` `<response id>#0` with the same
  session and conversation, and settlement keeps one. A repeated import yields
  identical rows. The recompute `token_count` Codex writes after a checkpoint
  is already ignored (the checkpoint closes the turn).

- <a id="privacy"></a>**Privacy.** The row carries usage and classification,
  nothing from the opaque state: no `encrypted_content`, no plaintext a
  compaction item may hold. It inherits the session's `cwd` and `client_name`,
  so the existing gates apply to it as to any row: the hypignore capture drop
  (live and backfill), local-only and source opt-out export withholding, and
  local-only query visibility. Covered by
  `test/core/usage-policy-export-drop.test.js`,
  `test/core/source-withhold-export-drop.test.js`,
  `test/core/query-local-only-visibility.test.js` and the smokes
  `hypignore_capture_drop`, `local_only_export_withhold` and
  `source_optout_export_withhold`; the new Codex tests check the ignored-cwd
  drop on both lanes.

## Readers

What each reader does with the row, read from the code at the time of this
decision:

- **Sums it once, shows nothing:** `hyp query` overview (sums `attributes.usage`
  by model), the server usage rollup (sums the token columns; its message count
  is distinct assistant ids, so no turn is counted), server ingest, sinks,
  central sync and redaction (pass through), `hyp status`, the first-ask
  evidence, the context graph, enrich and vector search (text only), the server
  report stages (user text only), and the dashboard Ask tables.
- **Dashboard conversation view:** drops a message with no text, thinking or
  tools unless it is a compact summary, so the row draws no bubble. Setting
  `is_compact_summary` would draw a misleading "Conversation compacted" bubble,
  which is why it stays unset.
- **Counts it as a message** (a count goes up by one per compaction; tokens are
  right): the server session summaries' message count, the dashboard session
  list, and the `hyp usage` digest's `msgs` column. The same holds today for
  other adapters' session-usage status rows. Not changed here.
- **Shows it as an empty row:** the server's session evidence for Ask returns
  it with no text. `grep` can match it on session, model or cwd with an empty
  snippet. Not changed here.

## Recovery

Calls captured live between #2882 (merged 2026-11-05) and this change lost
their usage. A rollout import recovers a call only when all of these hold: it
was a foreground remote compaction, Codex wrote it at or after #41912, the
rollout file still exists, and it is inside the import or sweep window. `hyp
backfill` does that, and so does the first scheduled sweep after the upgrade
restarts the daemon (the sweep's file fingerprints live in memory). Background
compaction writes no record, and older Codex writes none either, so those calls
stay short.

## CPU and memory

- Live: O(1) more per exchange with assistant output. With none, one pass over
  the response output and, for a stream with no body output, one pass over its
  events.
- Backfill: one slot holding the last record; no per-session growth.
