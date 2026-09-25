# LLP 0441: The settle pass selects the successors of the rows it can rename

**Type:** Decision
**Status:** Accepted
**Systems:** Gateway, Sources, Cache, Plugins
**Author:** Phil / Claude
**Date:** 2026-09-25
**Related:** LLP 0026 (#consequences, the immediate-predecessor contract), LLP
0027 (the re-settle sweep that cannot retry these rows), LLP 0085 (the drop
authority this widening is bounded by), LLP 0435, LLP 0439
**Extends:** LLP 0440
**Tracker:** hyparam/hypaware#2178

> LLP 0440 points a settled row's link at the id settlement gave its
> predecessor. It can only do that for rows the settle pass was handed, and the
> pass is handed a row only when the row itself needs settling. A successor
> that already carried native identity and a cwd needs nothing, so it was never
> handed over, and its link to a renamed predecessor was never repaired. This
> extends 0440 by fixing what the pass selects, not what it does.

## Context

`settleSelect` admitted two shapes: a `gateway_fallback` row (the identity
upgrade, LLP 0027) and a null-cwd row (the #258 session-start race, LLP 0085).
Both are rows with something wrong *with themselves*.

LLP 0440's repair is the first thing in the settle pass that is about a row's
relationship to ANOTHER row. Its subject is a successor, and a successor is
perfectly well-formed: its own transcript line had landed at projection time,
so the gateway stamped its native uuid, and its `cwd` was known. Neither
selection shape describes it. It was therefore invisible to the repair, and
LLP 0440 recorded that honestly as a scoped consequence rather than claiming
the broader invariant.

The residue is a permanently dangling pointer, not a wrong one. The successor
keeps naming the fallback hash its predecessor vacated, and no later pass
repairs it: settlement strips `claude.match_key` from the upgraded predecessor,
which is the flag the LLP 0027 re-settle sweep selects on, so the pair is never
looked at again. A thread walk stops at an id no row carries.

The shape is ordinary. One `api_request_body` carrying an assistant `tool_use`
whose transcript line has not landed yet, followed by the `tool_result` whose
line has, is exactly it: predecessor fallback, successor native.

## Decision

### Selection takes in the in-batch successors of the ids the pass can rename {#select-the-successors}

**A flush batch's settle selection is: every `gateway_fallback` row, every
null-cwd row, and every row whose `previous_message_id` names the
`message_id` of a `gateway_fallback` row of the same batch.**

The third shape is derived, not declared. The ids a settle pass can rewrite are
exactly the pre-settlement `message_id`s of its fallback rows: a row is
upgraded only if it carries a `claude.match_key`, and only a fallback row
carries one. So the successors that LLP 0440's repair could possibly move are
knowable before the pass runs, from the batch alone, with no transcript read
and no cache scan.

One level is enough. A selected successor is not itself renamed (its identity
is already native, and settlement does not touch it), so nothing chains off it:
there is no fixpoint to reach. The same holds for LLP 0440's splice case, which
changes a successor's link and not its id.

Nothing else about the pass changes. The enricher's own steps still test each
row on its own terms, and a row selected for this reason fails every one of
them: no `match_key`, so no identity upgrade; a known `cwd`, so the late
`.hypignore` resolve returns it untouched. It is in the group to be reachable,
and LLP 0440's repair is the only thing that reaches it.

### The widening grants no new drop authority {#no-new-drop-authority}

**Every row this adds to the selection carries a non-null `cwd`, and the
LLP 0085 drop is unreachable for such a row. The set of rows a settle pass may
remove is unchanged.**

This is the bound the widening had to clear, and it is structural rather than
argued. A null-cwd row was already selected, so a row selection newly admits
has a `cwd`; the enricher's late-resolve is `if (stringValue(row.cwd)) return
{ row }` on its first line, before it reads a session-context record, before it
consults the usage-policy resolver, before any `ignore` verdict exists to act
on. A row with a cwd cannot produce the `USAGE_POLICY_DROP` sentinel, so the
flush dispatcher has nothing new to filter out.

That leaves LLP 0085's decision exactly where it was: the drop is the late
resolution of a cwd that was unknown at the capture seam, and a row whose cwd
was known at capture was governed there and is not re-governed here. Widening
selection for a link repair does not reopen that question, and this document
does not authorize it to.

The one further effect the widening does have is the enricher's sidechain
provenance late-stamp (issue #1794): a newly selected successor with an
`agent_id` and no `claude.spawned_by_tool_use_id` can now receive one from the
`agent-<id>.meta.json` sidecar. That is the same value the same sidecar would
have given the row at projection time had it existed yet, written by the same
code on the same evidence. It adds an attribute; it removes and changes
nothing.

## Consequences

- LLP 0440's scoped consequence ("a successor that already carries native
  identity and a known cwd is never handed to the enricher, so it never reaches
  this repair") is retired for the in-batch case. Its cross-batch sibling
  stands: a successor committed in an earlier flush still keeps the stale id,
  because #batch-local is untouched and reaching it still needs a cache
  rewrite.
- A batch with no fallback rows selects exactly what it selected before, to the
  row. The new shape is gated on a non-empty set of renameable ids, so a
  null-cwd-only batch, and the common batch with nothing to settle at all, take
  the identical path.
- Rows the batch's fallback rows do not precede are still not selected, so the
  enricher is not handed the whole batch. The selection stays a function of the
  chain, which is what the repair is about.
- **Cost.** Selection is now one pass over the batch instead of up to two: the
  fallback test parses the `attributes` column, and folding the old
  `rows.some(isFallbackRow)` probe and the per-row `settleSelect` call into a
  single loop means the batch is parsed once per flush rather than once per
  membership question. That is a reduction, not an addition, on a
  fallback-carrying flush. What is added is a `Set` of row references and a
  `Set` of fallback `message_id` strings, both O(batch) and both freed with the
  batch, plus a second parse-free pass doing one hash lookup per link
  (0- or 1-element by LLP 0026 #consequences), skipped outright when the batch
  holds no renameable id.
- **How many more rows.** At most one selected successor per fallback row, and
  in the common case fewer: a fallback row's successor is usually a fallback
  row too (the whole turn raced the transcript), and those were already
  selected. The realistic addition on a Claude flush is the boundary rows where
  a settled turn is followed by an already-landed one, single digits per batch
  against a batch that already carried the fallback rows the enricher had to
  read a transcript for. Per added row the enricher does two field reads and a
  hash lookup, with no new file read and no new allocation unless the row's
  link actually moved.
