# LLP 0567: Codex completed TurnItems are captured, raw items win per turn

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Sources, Backfill
**Date:** 2026-11-01
**Related:** LLP 0429, LLP 0359, LLP 0466

Extends [LLP 0429](0429-codex-capture-leaves-inference.spec.md)
(#content: the rollout records the native capture reads grow by one shape).

## Completed TurnItems {#turn-items}

Codex threads in paginated history, and legacy threads Codex migrates to it,
can write a turn's conversation only as `event_msg` records of type
`item_completed`, each carrying one TurnItem. The parser read only
`response_item` records, so such a turn produced no rows and no error: a
resumed thread could lose every new prompt and reply while `scan_complete`
said `ok`.

The parser now reads `item_completed` too and normalizes three TurnItem types
into the response-item shape the existing projector already handles, so
lineage, entrypoint, usage, privacy gates and durable identity are the ones
LLP 0429 #content settled:

- `UserMessage` becomes a user `message`; its `text` blocks become input text.
- `AgentMessage` becomes an assistant `message`; its `Text` blocks become
  output text.
- `Reasoning` becomes a `reasoning` item from `summary_text` only.
  `raw_content` is never recorded, as raw reasoning is not today.

The provider type recorded is the TurnItem type, so a row says which shape it
came from. Tool calls and their outputs are not normalized from TurnItems:
Codex persists them as raw `response_item` records in every history mode, so
the existing projection keeps their call and output relationship.

## One representation per turn {#dedupe}

A turn may be written both ways: a fresh paginated turn has raw items and
TurnItem mirrors of the same messages. Projecting both would record each
message twice. The choice is made per turn, by turn id (`task_started`, or the
TurnItem's own `turn_id`):

- A turn with any model response item (an assistant message, a function or
  custom tool call or its output, reasoning, a web search or image generation
  call, or a compaction item) is projected from its raw items alone. Its
  TurnItems are dropped.
- A turn whose prompt is a raw user message keeps that message and drops its
  `UserMessage` mirror. The person's prompt is told apart by its
  `user.*` content item kinds; its other TurnItems are still projected.
- A turn with neither is projected from its TurnItems.
- A TurnItem with no turn id is never suppressed.

Other user-role raw messages do not count, because Codex writes harness
context as user-role raw items even in a turn whose conversation is only in
TurnItems. Nothing is matched by text: two turns saying the same thing both
stay.

## Identity {#identity}

A native TurnItem id is kept as the message id. Migrated mirrors carry
`item-N` ids that restart in every thread, so they would collide across
threads; an id of that form is dropped and the gateway's fallback identity
applies, as for a raw item with no id. A TurnItem whose `thread_id` names
another thread is not this file's row and is skipped. The session and
conversation ids still come from `session_meta` and the filename as before,
so one-ID and two-ID filenames keep the stable thread id.

## Window {#window}

A TurnItem's timestamp is its `completed_at_ms`, or the record's own
timestamp when that is absent or zero (Codex writes 0 for a missing
completion time). The backfill date window applies to that time, so a fresh
turn in an old thread is inside a recent window and an old one is not. The
sweep's settlement boundary (LLP 0359) stays positional: TurnItems after the
last `token_count`, `task_complete` or `turn_aborted` record wait for a later
sweep, whatever their times.

## Diagnostic {#diagnostic}

A TurnItem of a type with no projection is counted, not dropped silently.
`scan_complete` carries `completed_items_unsupported` (a count) and
`completed_item_unsupported_types` (the sorted type names, comma joined).
Types outside the known TurnItem list are counted as `other`, so the field is
bounded by that list whatever a file holds. Neither field carries content. A
zero-row scan with no unsupported items reports nothing new.

## Limits {#limits}

- A migrated turn that was aborted after its prompt, with no model output,
  records the prompt twice: once as the raw user message Codex leaves in the
  span before the migrated turn, and once as the TurnItem mirror. The two
  carry different turn ids, and telling them apart would need a text match,
  which #dedupe rules out. A fresh aborted turn keeps both in one turn and
  records its prompt once.
- The original report this fixes is unverified: the reporter's file and
  versions were not available, so it is a strong hypothesis that their
  missing turns were TurnItem-only. An installed Codex Desktop continuation
  end to end is still to be checked by a person with one.

## Cost {#cost}

A file with no `item_completed` record is parsed as before. A file with them
gets one more pass over its parsed items and a set of turn ids, both bounded
by the file and released with it. No state is kept across sweeps, and the
fingerprint lifecycle (LLP 0429 #sweep) is unchanged, so sweep work stays
proportional to discovered paths and changed files.
