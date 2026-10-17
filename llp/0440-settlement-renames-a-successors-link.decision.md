# LLP 0440: A settled row's successors follow the id settlement gave it

**Type:** Decision
**Status:** Accepted
**Systems:** Gateway, Sources, Cache, Plugins
**Author:** Phil / Claude
**Date:** 2026-09-25
**Related:** LLP 0026 (#consequences, the immediate-predecessor contract), LLP
0027 (the re-settle sweep that cannot retry these rows), LLP 0085 (the drop
this deliberately does not chase), LLP 0435 (the identity rewrite this repairs
the last consequence of), LLP 0439 (the scope-change relink this completes)
**Extends:** LLP 0439
**Extended-by:** LLP 0441 (#select-the-successors: the settle pass now selects
the in-batch successors of the rows it can rename, so this repair reaches a
successor that already carried native identity and a cwd), LLP 0442 (draft
request to extend #batch-local for the maintenance lane, whose whole-generation
rewrite already pays the scan this refused to put on the flush path)
**Tracker:** hyparam/hypaware#2172

> LLP 0439 re-links a settled row whose agent scope moved, because the link it
> was projected with was computed in a scope it no longer belongs to. A second
> way to invalidate a link survived that: a row whose scope never moved can
> still be chained to a PREDECESSOR whose `message_id` settlement just rewrote.
> Nothing then repairs it. This extends 0439's trigger to the rewrite itself.

## Context

The gateway chains `previous_message_id` at projection time. A Claude message
whose transcript line has not landed yet projects under a fallback hash id
(LLP 0027), so a successor projected in the same exchange is chained to that
hash. Settlement later matches the predecessor's line and
`assignTranscriptIdentity` renames it to its native uuid.

`assignTranscriptIdentity` renames on ANY match. LLP 0439's relink fires only
on a scope change. So the successor of a renamed predecessor keeps a pointer to
the hash whenever its own scope did not move, and settlement strips
`claude.match_key` from both rows, which is the flag the LLP 0027 re-settle
sweep selects on. The dangling pointer is therefore permanent.

No subagent is needed for this. Two consecutive fallback rows of one main-loop
body reproduce it: the first settles to its uuid, the second keeps
`previous_message_id` naming the first's pre-settlement hash. It is also
reachable with subagents, as the shape that found it shows: one
`api_request_body` with no `agent.name` carrying two assistant `tool_use`
messages, the first matching a subagent line (which re-scopes and relinks) and
the second a main-loop line (which does not).

The damage is bounded but real: a thread walk stops at an id no row carries,
instead of reaching the turn before it.

LLP 0439 #relink-from-the-transcript's rationale says "the scope change is what
invalidates the link". Read as the reason THAT rule exists it is exact; read as
an exclusive claim it is not, and this document is where the fuller condition
is recorded. 0439's normative text is unchanged and still complete on its own
question.

## Decision

### A rename in a settle pass carries that pass's links with it {#successors-follow-the-rewrite}

**When settlement rewrites a row's `message_id`, every row in the same settle
batch whose `previous_message_id` names the old id follows it: to the new id
when the rewritten row is still in the successor's agent thread, and past it,
to the link the rewritten row was projected with, when it is not.**

The same-thread case is a rename of a pointer, never a new choice of
predecessor. The projection-time chain already decided WHICH message precedes
this one, over the full live message stream including wire-only traffic no
transcript holds, and that decision stands; only the name it was recorded
under changes.

Identity settles per PART, not per message, but `message_id` is shared by
every part row the same API message expanded into. A message whose content is
`[text, tool_use]` projects two rows under one `message_id`; if only the
`tool_use` part finds a transcript match, the `text` part is still in the
batch carrying the old id when the pass is done. That id was never
invalidated, so it must not enter the map the walk below reads: a key stays
only when NO surviving row of the batch still carries it as its `message_id`.
Without that check the pass reads an ordinary sibling-part row as a vacated
predecessor and splices a successor past it, which is a wrong rename, not a
missing one - the ordinary Claude tool-calling shape (an assistant turn whose
tool call re-scopes to a subagent while its own text part settles nowhere)
hits this on every such turn.

The other case is the one LLP 0439 sees from the far end. A predecessor that
settled into a different thread has left this chain, and pointing at it anyway
would rebuild the cross-agent pointer 0439 removed, so the successor inherits
that predecessor's own projection-time link. The merged chain is a list, and
taking a node out of a list joins its neighbours. The neighbour may itself have
moved, so the step repeats, and it ends at `[]` when nothing in the successor's
thread is left behind it, which is the same "earliest turn we can name" answer
0439 gives a re-scoped row whose matched line opens its thread.

The pass runs after every row of the batch has settled, so it does not depend
on the order rows arrive in: a successor delivered before its predecessor is
repaired just the same.

The two triggers compose without overlapping. LLP 0439 re-derives a re-scoped
row's link from the transcript, which yields a native uuid; a native uuid is
never a key here, since the keys are the pre-settlement ids of rows this pass
upgraded, and a row is upgraded only if it carries a match key, and so a
fallback id. A row 0439 relinked is therefore untouched, and a row it left
alone is repaired here if, and only if, its predecessor was renamed.

### The repair reaches only the batch that made the rename {#batch-local}

**The rename applies to the rows of the settle call that performed it, and
nothing else.** A settle pass knows the ids it rewrote; it does not read the
cache, and making it do so would put a scan and a rewrite of committed
partitions on the flush path for a pointer whose worst case is an early stop in
a thread walk. A link into a row that settled in an EARLIER batch keeps the id
it has.

## Consequences

- Every `previous_message_id` a settle pass produces, for a row the pass
  actually touches, names either a row of that pass, a row already committed
  under the id it still carries, or `[]`. No pass leaves a pointer to an id it
  invalidated itself, and none follows a row into an agent thread settlement
  just moved it to. "Invalidated" is judged against the whole batch, not the
  single renamed row: a `message_id` shared by a surviving sibling part is
  never treated as vacated (#successors-follow-the-rewrite).
- The pass only ever sees `settleSelect`'s rows (`dataset.js`): a fallback row
  or a null-cwd row. A successor that already carries native identity and a
  known cwd is never handed to the enricher, so it never reaches this repair
  and keeps whatever `previous_message_id` it already had, rewritten or not.
  The claim above is therefore scoped to rows the enricher is called with, not
  every row of the conversation.
- A splice can shorten a thread's visible chain: a row whose only recorded
  predecessor turned out to belong to another agent reads as that thread's
  earliest known turn. That is what settlement can actually establish. The
  alternative, keeping the pointer, is the cross-agent link LLP 0439 exists to
  remove.
- Rows whose predecessor this pass did not rename are byte-identical to before,
  so no chain is rewritten speculatively and no migration is implied.
- The cross-batch case (LLP 0435's remaining consequence, narrowed again) is
  still open: a committed successor whose predecessor is renamed by a later
  pass keeps the stale id. It needs a cache rewrite, which is a different
  decision from this one and is not taken here.
- A predecessor that settlement DROPS (LLP 0085's late `ignore` verdict) still
  leaves its successor pointing at a row that is gone. Renaming the pointer
  does not change that, and the drop's own contract owns it.
- Cost: one `Map` entry per row the pass renamed, holding two strings and a
  reference to the row's existing link array, plus one pass over the batch's
  rows doing a hash lookup per link (links are 0- or 1-element by LLP 0026
  #consequences). The splice walk is bounded by the map size, so a malformed
  cycle cannot spin. All of it is allocated only by a pass that renamed
  something; a settle pass that upgrades no identity pays nothing, and no row
  object is copied unless its link actually moved.
