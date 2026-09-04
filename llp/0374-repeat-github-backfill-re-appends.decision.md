# LLP 0374: A repeat GitHub backfill re-appends, and that is the design

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Sources, Cache
**Author:** Phil / Codex
**Generated-by:** neutral
**Date:** 2026-09-04
**Related:** LLP 0023, LLP 0032, LLP 0360, LLP 0361; hyparam/hypaware#1284,
hyparam/hypaware#1330, hyparam/hypaware#1334 (acceptance condition, clause 2,
option a)
**Extends:** LLP 0360, LLP 0361

> Running `hyp github backfill` a second time over unchanged history writes a
> second full set of `github_events` rows. `count(*)` grows; it is not a
> duplication bug and it is not the poll-tick duplication #1330 fixed. Backfill
> is the deliberate cold-start pull, the poll is the idempotent trigger, and
> `github_events` keeps every snapshot it captured. A dedup against
> already-committed rows is refused here, and would be a new decision.

## Context {#context}

hyparam/hypaware#1284 reported GitHub capture writing duplicate rows and asked,
as one half of its acceptance condition, that two consecutive `hyp github
backfill` runs over unchanged history leave `count(*)` on `github_events`
unchanged. The other half was real: a poll tick re-fetched and re-appended the
items sitting exactly on its `since` watermark second, every tick, forever.
#1330 fixed that with the boundary floor in `openGate`.

The backfill half is a different claim, and the three accepted paragraphs it
lands on already answer it, in pieces:

- LLP 0360#capture-regimes: `hyp github backfill` "resets each selected
  repository cursor and fetches its available history", and both triggers
  "append only to `github_events`".
- LLP 0360#cursoring: "Rows appended by an earlier attempt remain valid
  snapshots and are included in the tick's written-row count."
- LLP 0361#budget: "Repeating `hyp github backfill` while that backfill is
  active continues it; invoking it after completion starts a deliberate new
  backfill."

A reset cursor plus a full re-fetch plus an append-only dataset is a second set
of rows. Nothing in the capture path reads `github_events` back, so nothing
could suppress them: LLP 0360#resource-bounds scopes event-id deduplication to
one API result batch on purpose. The entailment is settled, but it was written
nowhere an operator or a release reviewer would look, so the row growth reads
as the bug that was just fixed next door.

## Decision {#decision}

A repeat backfill re-appends, by design.

A second backfill invoked after the first has **completed** writes a second row
for every event the first captured. `github_events` carries no capture-time
column and `event_id` is deterministic, so those rows are the same observation
appended twice: `count(*)` grows, roughly doubling for the repositories the run
visited, while `count(distinct event_id)` does not move.

Completion is the condition LLP 0361#budget sets, and it is load-bearing rather
than decorative. A backfill that exhausts its request budget leaves its work on
the cursor, and the next invocation continues that backfill instead of
resetting the cursor. The same is true of a poll or `hyp github sync` tick that
finds the unfinished work: it resumes the backfill. Growth measured across
either is first capture, not re-capture, and only a completed-then-repeated
backfill demonstrates this decision.

Neither the daemon poll nor `hyp github sync` behaves this way. They resume
from the durable cursor and append only what it has not already published,
which is what makes them safe to run on a schedule, and which #1330 repaired
at the watermark second.

The dataset is where the redundancy stops mattering. `github_events` is an
append-only structural log (LLP 0360#concrete-columns), and the T0 projection
reads it into node and edge rows whose ids are content-addressed over the
normalized natural key, then drops every row whose id is already committed
before it writes (LLP 0023#content-addressed-ids, LLP 0023#pre-write-dedup).
Two snapshots of one pull request build the same PullRequest node id, so the
second is dropped rather than appended. `hyp graph project` after a repeat
backfill therefore does not double the graph, and a query over `github_events`
that wants current state rather than capture history groups by the natural key.

LLP 0032 is a narrower guarantee and is not what saves the graph here: it makes
the `Repo`, `Commit`, and `File` keys byte-compatible with the ones local
session capture mints, so those nodes converge **across domains**. `Issue`,
`PullRequest`, and `Review` are GitHub-internal types outside that vocabulary,
and they converge for the ordinary reason every T0 node does.

## Why not a committed-row dedup {#no-committed-dedup}

Suppressing the second write needs the capture path to consult rows it already
committed, and that is refused here for three reasons:

1. **It costs the budget the source is built around.** LLP 0361#budget fixes a
   whole-tick request budget precisely so a large repository cannot starve its
   neighbors, and LLP 0360#resource-bounds keeps per-batch identity out of
   memory for the same reason. A dedup that is actually correct has to know
   every event id a repository ever wrote, which is a cache read proportional
   to captured history on every tick, not a bounded one.
2. **It contradicts what a snapshot is for.** LLP 0360#cursoring keeps earlier
   attempts' rows because they are valid observations. A dedup keyed on event
   id would also refuse the re-capture an operator ran deliberately after a
   partial or wrong-looking history, which is the only repair the source
   offers.
3. **Bare event ids cannot tell repeat from change.** The gate note in
   `capture.js` already records that an item re-updated inside the second it
   was captured keeps its `updated_at`, so identity alone cannot separate a
   redundant snapshot from a newer one. Curing that needs a content
   fingerprint, which is a new column and a new decision, not a guard.

If suppression is ever wanted, it is a new request against this document, with
its own answer to all three.

## Operator contract {#operator-contract}

`docs/ACCEPTANCE.md` carries the operator-facing half:
[`github_since_inclusivity`](../docs/ACCEPTANCE.md#github_since_inclusivity)
states the row growth as the expected result of a repeat backfill, so a release
reviewer measuring `count(*)` across two runs does not file it again. The same
procedure is where the still-unconfirmed half of #1284's acceptance condition
gets settled: whether GitHub's issues-family `since` really is inclusive of the
boundary second. That answer needs a real token, no fixture can supply it, and
the boundary floor is correct either way.

## Consequences {#consequences}

- `hyp github backfill` stays the cold-start command. Repeating it is a
  supported way to re-observe history, not an idempotent no-op, and the
  scheduled trigger remains the poll.
- A count over `github_events` is a count of observations. Anything that wants
  one row per GitHub object groups by the natural key, as the graph projection
  already does.
- Deduplicating against committed rows remains available as a future decision,
  and this document is what it would supersede.
