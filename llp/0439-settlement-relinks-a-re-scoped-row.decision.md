# LLP 0439: A settled row that changed agent scope re-links from the transcript

**Type:** Decision
**Status:** Accepted
**Systems:** Gateway, Sources, Cache, Plugins
**Author:** Phil / Claude
**Date:** 2026-09-25
**Related:** LLP 0026 (#consequences, the immediate-predecessor contract this
extends), LLP 0027, LLP 0262, LLP 0435 (the consequence retired here)
**Extends:** LLP 0435
**Extended-by:** LLP 0440 (#relink-from-the-transcript: a scope change is not
the only thing that invalidates a link, so a rewritten `message_id` also
carries its batch's successors with it)
**Tracker:** hyparam/hypaware#2150

> LLP 0435 made a body-derived tool row settle onto the transcript line its
> tool id names, and let that line rewrite the row's `agent_id`. It recorded as
> a standing consequence that `previous_message_id` is not recomputed, so two
> same-name subagents end up with correct `agent_id`s and chain pointers left
> over from the single merged `general-purpose` label. That consequence is
> retired here: when settlement moves a row into a different agent scope, the
> link it was projected with was computed in a scope the row no longer belongs
> to, so settlement re-derives it from the same transcript that decided the new
> scope.

## Context

`previous_message_id` is a queryable column of `ai_gateway_messages` whose
contract (LLP 0026 #consequences) is the IMMEDIATE predecessor in this THREAD,
with the full ancestry the transitive closure of the link. The gateway builds
that chain once, at projection time, keyed by
`(conversation_id ?? session_id, agent_id)`.

On the OTEL lane a subagent's rows are labelled from `agent.name`, the
subagent's TYPE. Two `general-purpose` subagents in one session therefore
project into ONE chain. LLP 0435's tool-id settlement then hands each row its
own per-spawn `agent_id` from the transcript, and nothing touches the link. The
observable result, with the two-subagent shape LLP 0435's own fixtures
exercise:

- a row in agent A's thread points at a message in agent B's thread, so
  walking the links to reconstruct one agent's thread jumps into another's
- where the predecessor settled too, its `message_id` became a native uuid,
  so the pointer names a gateway fallback hash no row carries at all

The transcript backfill sweep, which captures the same lines, gets this right
already: it expands timestamp-ordered transcript entries that carry their real
per-spawn `agentId`, so the gateway chains each agent separately. Both lanes
routinely capture the same session (LLP 0262 #migration) and the rows collapse
on `part_id`, so the two lanes disagreeing on `previous_message_id` for one
`part_id` makes the surviving value a race. LLP 0262 already required the two
lanes to agree on `part_id`, and LLP 0390 on which row carries a turn's usage;
this is the same requirement applied to the link.

## Decision

### Changing the agent scope re-links the row, from the transcript {#relink-from-the-transcript}

**A settled row whose `agent_id` differs from the one it was projected with
takes its `previous_message_id` from the transcript: the uuid of the line
before its matched line in the SAME agent thread, or `[]` when its matched line
opens that thread.** The answer is by construction the line the backfill sweep
chains this row to, so the two lanes agree.

**A row whose `agent_id` did not change keeps the link it was projected with.**
Its chain was computed in the scope it still occupies, so a rebuild would
decide the same question from less information: the projection-time chain sees
every message the live lane emitted, including wire-only traffic that never
reaches a transcript line, while the transcript sees only what it holds. The
trigger is the scope change, not settlement, because the scope change is what
invalidates the link. This deliberately leaves LLP 0435's other standing
consequence in place: rows already committed under a fallback id are repaired
only as far as the LLP 0027 re-settle sweep reaches them.

### The predecessor index is built on demand {#lazy-predecessor-index}

**The uuid → predecessor-uuid map is built on the first lookup of a session's
transcript index, not with the index.** A settle pass that re-scopes no row is
the common case (every session with no subagents, and every re-delivery of
already-settled rows), and it must not pay for a map nothing reads. A pass that
does re-scope builds it once for the whole session, in one pass over the
already timestamp-sorted entries, and every row then costs one hash lookup.

## Consequences

- LLP 0435's `previous_message_id` Consequences bullet is retired. Walking the
  links from a settled subagent row stays inside that agent's thread.
- A re-scoped row's link is transcript truth, so it can differ from what the
  live lane would have chained had it known the agent: a wire-only message with
  no transcript line is no longer a possible predecessor for such a row. That
  is the sweep's answer for the same row, which is the answer that has to win.
- Rows whose scope never moved are byte-identical to before, so no existing
  chain is rewritten and no migration is implied.
- Worst case cost is one `Map` of two string references per uuid-bearing line
  of one session, held only for that session's settle pass, plus one pass over
  entries already loaded and sorted. Sessions that re-scope nothing allocate
  none of it.
