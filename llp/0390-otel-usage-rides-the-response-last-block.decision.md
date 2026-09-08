# LLP 0390: The OTEL lane picks its usage carrier from the response body's last block

**Type:** Decision
**Status:** Accepted
**Systems:** Gateway, Sources, Plugins
**Author:** Phil / Claude
**Date:** 2026-09-08
**Related:** LLP 0035 (the one-carrier rule this extends to a fifth path),
LLP 0252, LLP 0262, LLP 0389
**Tracker:** hyparam/hypaware#1470

> LLP 0035 #one-carrier puts a response's `usage` on the LAST assistant row of
> that response. The transcript sweep does. The OTEL lane did not: it stamped
> usage on the `assistant_response` row whenever the response had any text, so
> a `[text, tool_use]` turn - the ordinary tool-calling shape - carried its
> tokens on the text row while the sweep carried them on the tool_use row. The
> OTEL lane now reads the response body's shape and puts usage on the last gap
> block whenever the response ends in one, and the pending `api_request` record
> is the single arbiter that keeps a turn counted exactly once.

## Context

LLP 0035 #one-carrier is a cross-provider rule: a billed response fans into
several rows, and exactly one of them - the last - carries the response-level
`usage`, so a plain `SUM(attributes.usage.*)` is correct with no dedupe. The
Claude proxy, the Claude transcript sweep, and both Codex paths follow it, and
`message_projector.js#stripUsage` enforces it within a single projected
message.

The OTEL lane (LLP 0252) reaches the same response through two events. The
`assistant_response` event carries the text and a native `message.uuid`; the
tool_use, thinking, and tool_result blocks reach the lane only through a
spooled body (LLP 0252 #bodies-for-gaps). `responseGapMessages` parked usage on
the last gap block only when the body carried NO text block, on the reasoning
that a text-bearing response has an `assistant_response` event to carry it. So
on `[text, tool_use]` the two lanes named different carriers:

| lane | carrier for a `[text, tool_use]` turn |
|---|---|
| transcript sweep | the tool_use row (LLP 0035 #one-carrier) |
| OTEL | the text row (`assistant_response`) |

That divergence was survivable while the two lanes' tool rows had different
`part_id`s: the turn was counted once per lane, or twice across both. LLP 0389
then made a body-derived block settle onto the transcript line's uuid, so the
two lanes' rows collapse. With the carriers disagreeing, a collapse can now
keep the sweep's text row (no usage) and the OTEL lane's tool row (no usage)
and the turn totals **zero** tokens (hyparam/hypaware#1470). It needs only a
mixed commit order: the scheduled sweep observing a transcript whose text line
has landed and whose tool_use line has not.

## Decision

### The carrier is the response's last block, whichever event produced it {#carrier-is-the-last-block}

**The OTEL lane's gap rows carry the response's `usage` and `stop_reason` when
the response body's LAST content block is a gap block, and leave them to the
`assistant_response` event when the response ends in text.** The predicate is
the body's own shape (`kept[last] === content[last]`), not "does the response
contain text anywhere", which is what put a tool-calling turn's tokens on its
text. It is the same rule the transcript sweep applies to the same response
(`backfill.js`, last block line per `message.id`), so the two lanes name one
row and a collapsed pair still totals the turn once.

### One `api_request` record arbitrates, so no order double-counts {#claim-order-arbitrates}

**The turn's usage lives in exactly one place before it is stamped - the
pending `api_request` record in `usageByRequestId` - and whichever of the two
rows reaches it first claims and removes it.** The projection cannot know at
`assistant_response` time whether a body follows, and the exporter can split a
turn across POSTs, so no ordering can be assumed. A single claimable record
settles the count: whatever order the events arrive in, exactly one row is
stamped, so a SUM over this lane's rows is right either way. The body's own
`usage` block stays a fallback only for a response with no text, which produces
no `assistant_response` event that could have claimed the record.

WHICH row is stamped does depend on the order, and only one of the two orders
also satisfies #carrier-is-the-last-block. Claude Code emits `api_request`,
then `api_response_body`, then `assistant_response`, and the body event's
`event.timestamp` precedes the response event's, so the body row claims the
record and the two lanes name the same carrier. A stream that put
`assistant_response` first would have the text row claim it, which is the
pre-fix placement, and hyparam/hypaware#1470's zero-token collapse would still
be reachable for that turn: one claimable record keeps the turn counted once
within this lane, it does not by itself make the two lanes agree. That residual
is accepted rather than designed out, because the emission order is the
client's and the body event is always the earlier of the two. Buying
order-independence would mean holding every `assistant_response` row back until
its body event is known not to be coming, and the event stream carries no
end-of-turn marker to wait on.

## Consequences

- A `[text, tool_use]` turn's `usage` moves from the OTEL lane's text row to
  its tool row. Nothing needs to migrate: rows already written keep the usage
  they were written with, and the placement was never load-bearing for any
  in-app consumer (LLP 0035 already records that none reads `attributes.usage`).
- The mixed commit order the other way round (the sweep committing the tool
  row, the OTEL lane the text row) counted a `[text, tool_use]` turn TWICE
  before, because each lane's surviving row carried its own copy of the usage.
  That is the pre-existing over-count hyparam/hypaware#1470's table lists, and
  naming one carrier removes it along with the zero.
- The per-request `cost_usd`, `duration_ms`, and `speed` that ride the same
  `api_request` record move with it, because the record is claimed whole: on a
  `[text, tool_use]` turn they move from the OTEL text row to the body-derived
  tool row. That changes WHICH commit order loses them to hyparam/hypaware#1472
  (a collapsed row losing the OTEL-only fields the sweep has no source for), not
  whether the shape is reachable at all. Both rows of such a turn already
  collide with the sweep's twin, so before this change the fields were lost
  whenever the sweep's TEXT row committed first, and after it they are lost
  whenever the sweep's TOOL row does. Splitting the record so the tokens and the
  cost land on different rows would trade that for a worse shape (one turn's
  accounting on two rows), so it is left to #1472 to settle where those fields
  belong.
- A turn whose `api_request` event never arrives still has no usage on either
  row, exactly as before: the body's own `usage` is not a fallback for a
  text-bearing response, because using it there is what would double-count when
  the text row already claimed the record.
- No new state and no new pass: the predicate is two array reads on a body the
  lane already walks, and the claim is the `Map` delete that was there before.
