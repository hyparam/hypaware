# LLP 0373: The GitHub boundary guard's identity is the event id, not the snapshot

**Type:** RFC
**Status:** Draft
**Systems:** Plugins, Sources, Graph
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-09-04
**Related:** [LLP 0360](./0360-github-source-is-bundled.decision.md)
(#cursoring the sidecar and phase-boundary publication this guard rides on,
#resource-bounds the identity budget it is sized against, #concrete-columns
the structural columns a fingerprint could cover),
[LLP 0361](./0361-github-capture-is-work-budgeted.decision.md) (#page-work
"equal-timestamp unseen pulls are still captured", the rule the pulls-pass half
of this identity exists to keep, and "the cursor retains observed pull numbers",
the separate set the comments pass types its rows from),
[LLP 0032](./0032-github-llm-graph-bridge.decision.md) (the natural keys the
event ids are built from), [LLP 0023](./0023-context-graph-projection.decision.md)
(#merge-policy the order-independent props merge and #pre-write-dedup the
committed-id filter in front of it: together they decide what a second snapshot
is worth downstream), hyparam/hypaware#1333,
hyparam/hypaware#1284 (the unguarded behavior this guard replaced), PR #1330,
hyparam/hypaware#1335 and PR #1340 (where `work.pulls_emitted` landed),
hyparam/hypaware#1345 and PR #1347 (where `work.gate_emitted` landed),
hyparam/hypaware#1353 (the loss they widen, with a verified probe),
hyparam/hypaware#1354 (the invariant the `openGate` docstring leaves unstated)

> Every incremental GitHub capture pass refuses an item it has already
> captured, and it recognizes "already captured" by the item's stable event id.
> At the watermark second that means an item updated twice inside one wall-clock
> second keeps the identity it was first captured under, and its second snapshot
> never lands; for a pull, neither do the reviews and changed files of that
> second. Within a phase the same bare id also drives the per-phase `emitted`
> sets added for the pagination duplicate (#1335, #1345), so an item that
> changes between two sightings of one traversal loses that snapshot too.
> Curing either means keying on the row's content rather than its identity,
> across four passes and the four identity sets they use, which come in two
> shapes (event-id strings and PR numbers) and two lifetimes (durable cursor
> state and in-flight work state), and one of which (`pullChangedSince`) settled
> this trade before the others existed. This document states the defect,
> measures which passes it can actually damage, and lists the options. It
> decides nothing.

## Summary

Issue #1333 (deferred from PR #1330 triage, severity LOW) records that
`openGate` in `hypaware-core/plugins-workspace/github/src/capture.js` refuses a
boundary item by event id. Capture issue #1 at second `T` while it is `open`,
close it 0.7s later so `updated_at` still reads `T`, and the `closed` snapshot
is refused on every subsequent tick until unrelated activity pushes the
watermark past `T`. The reviewer's probe is `tick1: [[issue:o/r#1, open]]`,
`tick2: []`.

The issue's own acceptance condition says this is only actionable together with
the pulls pass, and that curing it needs "a design decision (LLP) [that] chooses
a content-aware identity ... for all four `since`-windowed passes". That is what
this document asks for. The trade is not a bug that a patch can quietly fix: the
identity is sidecar state, half of it published and half of it in-flight work,
its pulls-pass half is a decided property of LLP 0361#page-work, and the halves
are not even the same type. Since #1333 was filed, PR #1340 and PR #1347 have
added a third and a fourth set of the same identity at a wider scope (#guard),
so the window this asks about is no longer only the watermark second (#reach).

## The guard, precisely {#guard}

Affected code at `origin/master` (`245ab780`):

- `capture.js`, `openGate(staged, stagedIds, published, publishedIds,
  phaseEmitted)`: the high-water gate for the issues, commits, and comments
  passes. `admit(at, id)` refuses when `at === published && floorIds.has(id)`,
  and refuses a repeat within the running maximum's own set. The ids are event
  ids (`issue:owner/repo#N`, `commit:<sha>`, `comment:<id>`), published to
  `cursor.boundary[pass]` as `string[]` and capped at `MAX_BOUNDARY_IDS`
  (`cursors.js`).
- `capture.js`, `pullChangedSince(pr, high, capturedAtHigh)`: the same guard for
  the pulls pass, predating the others. It refuses when
  `updated === high && capturedAtHigh.has(pr.number)`, and its durable half is
  `cursor.pulls_high_numbers`, a `number[]` of PR numbers validated by
  `readNumbers` as positive integers.
- `capture.js`, the `emitted` set inside that same `openGate`, carried on
  `work.gate_emitted`: the event ids the in-flight gate phase has already
  appended a row for, consulted after the floor and after the running maximum's
  own set. It exists for a different failure, the pagination reshuffle that
  re-lists an item on a later page of one traversal (#1345, PR #1347), but it
  recognizes "already appended" by the same bare event id, so it is this
  document's identity at a wider scope. It is staged after the page's rows
  flush, read back by `readWork` through the same `readBoundaryIds` the boundary
  sets use, and capped by the same `MAX_BOUNDARY_IDS`, keeping the newest
  admissions (`slice(-MAX_BOUNDARY_IDS)`) where the boundary sets keep the
  first. Issues, commits and comments share the one field because exactly one of
  them is live at a time, and every phase transition clears it: `beginPulls`,
  `finishPulls` and `finishCommits` each `delete work.gate_emitted`, and the
  comments phase ends by deleting `cursor.work` outright.
- `capture.js`, `emittedPulls` in the pulls phase, carried on
  `work.pulls_emitted`: the same phase-scoped shape one pass over, a `number[]`
  of PR numbers seeded on entry to the phase, consulted before
  `pullChangedSince` is ever reached (`if (emittedPulls.has(pr.number))
  continue`), staged after the flush, and dropped by `finishPulls`. It predates
  `gate_emitted` and was already on `master` at the SHA this document first
  cited, unnamed. It refuses a pull, not a sighting of one, which is why it
  belongs here. Nothing caps it on either side; its own comment puts a
  backfill's phase at "the order `cursor.pull_numbers` beside it already is".

The first two exist because GitHub's timestamps are second-granular and every
tick re-reads the watermark second. For issues, commits and comments that is the
server's inclusive `since`. The pulls listing takes no `since` at all
(`github_client.js`, `listPullRequestsPage`: `sort=updated&direction=desc`
plus an `If-None-Match`); it is windowed client-side by `work.baseline_pulls`
and the `olderThan` stop condition, which reaches the same equal-second overlap
by a different route. "Four `since`-windowed passes" is the issue's phrasing,
and it is loose in exactly that one place.

Advancing the watermark past that second instead would lose an item stamped in
the same second but published after the request, which the tests
"an item tied at the watermark but not yet captured is still captured next tick"
and "new activity does not drag the already-captured boundary rows back in"
(`test/plugins/github-capture.test.js`) both pin. Removing the guard is
issue #1284, already closed: the unguarded passes re-appended every boundary row
on every idle tick.

The two pairs differ in lifetime. The boundary sets are durable cursor state,
published with a watermark and consulted on every later tick; the two `emitted`
sets are work-descriptor state that lives one phase and is deleted at its end.
Neither pair subsumes the other: the boundary sets answer for the watermark
second across ticks, the `emitted` sets for everything a single traversal has
already appended, at any timestamp between the floor and the running high.

So the guards are right and the identity all four of them use is the question.

## How far the defect actually reaches {#reach}

Two questions, not one: what a refusal loses, and over what window a refusal
happens. The four identity sets differ on both.

### What a refusal loses {#reach-loss}

The four passes do not share the exposure. What a refusal loses is what the
captured row would have recorded differently, plus, on the pulls pass, what the
item's admission would have gone on to fetch. `base()` writes a fixed column
set (LLP 0360#concrete-columns) and each pass fills a known subset:

- **issues** (`issueRow`): `actor_login`, `actor_type`, `number`, `state`,
  `created_at`. `state` is `open` or `closed` and changes over an item's life.
  **Exposed.** This is the issue's example.
- **pulls** (`pullRow`): the same plus `payload: { merged, draft }`, with
  `state` resolving to `merged` when `merged_at` is set. **Exposed**, and it
  carries the fan-out: an admitted pull re-queues its files, reviews, and
  commits sub-resources, so re-admission spends requests against the LLP 0361
  budget, not just a row. The fan-out also runs the other way, and this is the
  one place the guard costs more than a snapshot. `work.pull_tasks` is built
  only from the pulls that page admitted, and `review` and `pull_request_file`
  rows reach the table by no other route, so a pull refused at the boundary
  second withholds any review submitted or file changed in that second. Those
  rows land when the pull is next admitted; if the second update was the pull's
  last activity - a merge, typically - they never land at all. That is a
  dropped row, not a stale one.
- **commits** (`commitRow`): `actor_login`, `actor_type`, `sha`, `pr_number`,
  `created_at`, gated on `commitTime`. A commit's content is its identity: a
  changed commit is a different sha and therefore a different event id, which
  the guard admits already, and the repo-level pass always passes `prNumber`
  null. **Not exposed by anything the commit carries.** The one column that is
  not commit content is `actor_login`/`actor_type`, read off `c.author`: that
  is GitHub's account resolution for the commit rather than part of the commit,
  so it can change under a fixed sha (an address linked to an account later, a
  renamed or deleted login). A far rarer window than the one this document is
  about, and no arm below is worth choosing for it; recorded so the "identical
  by construction" reading is not taken as stronger than it is.
- **comments** (`commentRow`): `actor_login`, `actor_type`, `number`,
  `created_at`, gated on `updated_at ?? created_at`. Editing a comment moves
  `updated_at` (not a stored column) and the body (never stored, LLP 0360), so
  no content the comment carries reaches a stored column, and `actor_login` /
  `actor_type` are read off `c.user` and carry the same account-resolution
  caveat recorded for commits above. **Exposed through `event_type`.** That
  column is not read off the comment: `pull_request_comment` versus
  `issue_comment` is decided by whether the comment's subject number is in
  `prNumbers`, the run-varying set seeded
  from `cursor.pull_numbers` and extended by the same tick's issues and pulls
  pages (the retention LLP 0361#page-work describes). That set only grows, so a
  comment first typed `issue_comment` because its pull had not been sighted is
  typed `pull_request_comment` on a later tick, and the guard refuses the
  correction for as long as the comment sits on the watermark second. Narrow: it
  needs a pull absent from `cursor.pull_numbers` and from both listings of the
  capturing tick, and the loss is a misclassification rather than a stale
  snapshot. A tick that resumes straight into a budget-split comments phase is
  the easiest way to reach it, because it runs neither listing that would have
  sighted the pull. Not cosmetic downstream: the `commented` edge is built off
  the event type (`github/src/graph_contract.js:201-202`,
  `actorTo('commented', 'Issue', 'issue_comment', ...)` and its `PullRequest`
  twin), so the actor is attached to the wrong node kind, and because edges are
  id-addressed too a later corrected row mints the right edge beside the wrong
  one rather than replacing it.

### Over what window {#reach-window}

The boundary sets refuse only at the watermark second: two updates inside one
wall-clock second, which is the window issue #1333 measured and the one this
document was first written against. The two `emitted` sets refuse anywhere in a
single phase traversal, at any timestamp between the floor and the running high,
because the id they key on carries no timestamp. So the same trade also costs a
snapshot whenever an item changes between two sightings of one traversal.
`openGate`'s own docstring says as much: the set "widens the trade above rather
than escaping it".

How wide a traversal is depends on the mode. A poll's issues phase walks the
pages an inclusive `since` returns; a backfill's phase is the repository's whole
history, and the pulls phase's set is scoped the same way. The request budget
splits either across ticks, and both sets are staged on the work descriptor
precisely so they survive that resume, so the window is as long as the traversal
takes in wall-clock time, not as long as one tick. The set itself is bounded
only for the gate half: `openGate` is opened afresh for every page and stages
the newest `MAX_BOUNDARY_IDS` (1000) admissions after each one, with
`readBoundaryIds` capping the read back to match, so `gate_emitted` is a sliding
window of recent ids inside a tick as much as across a resume, and a long
backfill forgets an id once 1000 later admissions have pushed it out. That
bounds the set, not the window: a pagination re-listing surfaces near the page
just read, so the ids that matter are still in it. `work.pulls_emitted` is
capped at neither end.

Two of the four passes change under that wider window and two do not:

- **issues**: `state` becomes losable on any re-listing within a traversal, not
  only on the watermark second. Issue #1353 records the verified probe: #3 is
  listed `open` at `2026-02-01`, closed mid-traversal, and re-listed `closed` at
  `2026-02-03` on the page a newly created issue shifted it onto; the floor does
  not match, `at !== high` skips the boundary block, and `emitted` refuses it.
  The traversal ends with `since.issues` at `2026-02-05`, above the refused
  snapshot, so no later tick lists that item again at all.
- **pulls**: `work.pulls_emitted` widens the pass that carries the fan-out, but
  far less than the gate set widens issues, and the listing's own order is why.
  Once a number is in the set, every later sighting in that phase is skipped
  before `pullChangedSince` is consulted, so a refused sighting loses its
  `state`/`payload` snapshot and is not re-queued into `work.pull_tasks`, the
  only route `review` and `pull_request_file` rows have into the table. What a
  reshuffle actually puts on a later page, though, is not the changed pull:
  `/pulls` is `sort=updated&direction=desc`, so a pull updated mid-traversal
  jumps to offset zero, on a page the traversal has already consumed, and is not
  re-listed at all. (It is picked up by the next poll instead, since its new
  `updated_at` is above the baseline that traversal publishes.) The item a
  reshuffle does re-list is the one pushed back across a page boundary, whose
  own `updated_at` did not move and whose row is therefore identical: exactly
  the duplicate #1335 reported and the set exists for. `pulls_emitted` refuses a
  genuinely newer snapshot only when enough other pulls are updated after it to
  push it back down into a page the traversal has not reached yet, a page's
  worth (100) per page of distance. Reachable in a long backfill on a busy
  repository, not in a poll. `/issues` sends no `sort` and so orders on
  `created`, where position is independent of `updated_at`, which is why the
  probe above holds there and this reasoning does not carry over to it.
- **commits**: unchanged. A changed commit is a different sha and therefore a
  different event id, so no re-listing under one id can carry different commit
  content. The `actor_login` caveat above is unchanged too, and no likelier
  inside one traversal than across ticks.
- **comments**: unchanged, for a reason worth stating because it is not obvious.
  The exposed column is `event_type`, decided by `prNumbers`, which is seeded
  once per `captureRepo` call before any page runs and grown only by the issues
  and pulls phases, both strictly earlier in the sequential phase machine; a
  budget-split resume re-seeds it from `cursor.pull_numbers`, which no comments
  page writes until the phase ends. Both sightings of a comment within one phase
  therefore compute the same `event_type`, so the misclassification stays what
  it was, an effect of the cross-tick boundary set. (That `openGate`'s docstring
  asserts this scoping without stating the invariant it rests on is #1354.)

The observable defect is therefore `state` (and the pull `payload`) on the
issues and pulls passes, the reviews and changed files of a refused pull, and a
comment's `event_type` discriminator, across two windows: two updates inside one
watermark second with no later activity on the item, and, on the issues pass,
any change to an item between two sightings of one phase traversal (on the pulls
pass only in the push-down case above). The second window runs as long as the
traversal does, which in a backfill is a whole repository history, less whatever
the gate set has forgotten to its 1000-id window.

Neither refusal is recoverable without a further update. A boundary refusal
repeats on every tick while the watermark sits on that second, and the item
stops being listed at all once something newer moves it past. A traversal
refusal is not re-offered even once: if the re-listing carried a timestamp above
the running high, `admit` raises the watermark and claims the id into the
boundary set before `emitted` answers, so the next tick's floor refuses the same
item on the same id; if it did not, the traversal ends with the watermark above
it and an inclusive `since` never returns it again. So both windows heal on the
item's next update and neither heals without one.

### What a landed snapshot would be worth {#reach-value}

One measurement bounds what any arm can buy before the question of downstream
value arises. `github_events` has no capture-time column
(`dataset.js`, `GITHUB_EVENTS_COLUMNS`) and one partition
(`PARTITION_LABEL = 'all'`); the only monotonic value, `_hyp_ingest_seq`, is an
`INTERNAL_FIELDS` column stripped from query output and from every `readRows`
consumer (`src/core/cache/streaming-reader.js`). Two snapshots of one item
therefore share `event_id` and `created_at` and differ only in `state`, with no
column a reader can order them by, and #constraints forbids an arm from adding
one. So landing the second snapshot makes the newer state present, not
readable-as-current: whichever arm is chosen has to say what a consumer does
with two rows. The #decision proof obligation below is about capture, not about
resolution.

Downstream, a second measurement bears on what a fix is worth, and it turns on
two mechanisms rather than one. The graph's props merge is order-independent by
design (LLP 0023#merge-policy, `mergeRow`/`propsValueWins` in
`context-graph/src/project.js`): the value from the earliest `first_seen` wins,
and equal times tie-break on the stable JSON encoding. `Issue` and
`PullRequest` nodes take `firstSeen: r.created_at`, the item's creation time,
which is identical across every snapshot of that item, so within one projection
run the state prop resolves by the lexicographic tie-break: `closed` beats
`merged` beats `open`. But a run reaches that merge only for a node it has not
already committed. `node_id` is `sha('node\0<type>\0<natural key>')`
(`context-graph/src/ids.js`) and does not cover `props`, and `dedupExisting`
drops every built row whose id is already in the `node` dataset, so no later
run can revise a committed node's props: `graph project` is on demand and
append-only ("built on demand and never updates itself", the `graph` group help
in `context-graph/src/index.js`), and `graph compact` only merges duplicate
committed rows, of which this path produces none.

So landing the second snapshot changes the graph only when it lands before the
item's node is first projected. Then the tie-break sees both rows and, for the
`open`-then-`closed` transition #1333 reports, resolves to `closed`. On a graph
already projected from the first snapshot the refused row would change nothing
even if it landed, and neither would the eventual unrefused update that follows
it. There the loss shows only as the missing row in `github_events` (with the
ordering caveat above) and in a graph projected afresh after it lands. The
reopen (`closed` then `open`) does not change either way, because the tie-break
keeps `closed`. That is an observation
about the value of each option, not a proposal to change the merge policy or
the dedup in front of it, both of which LLP 0023 settled.

## What the corpus already settles {#constraints}

- **The pulls tie guard is decided, not incidental.** LLP 0361#page-work states
  that equal-timestamp unseen pulls are still captured, and a tie guard is the
  only thing that keeps that rule from re-appending the boundary second every
  tick. (Its neighbouring sentence, "the cursor retains observed pull numbers",
  is about `cursor.pull_numbers` and comment discrimination; the tie guard's own
  `cursor.pulls_high_numbers` came later and falls back to `pull_numbers` on an
  older sidecar.) Changing how that rule recognizes an unseen pull, from a
  number to a content fingerprint, reworks the mechanism that document settled,
  so it needs this document (or its successor), not a patch.
- **Identity carried across ticks is budgeted.** LLP 0360#resource-bounds caps
  what capture may retain, and `openGate` is annotated `[constrained-by]`
  against it: identity carried across ticks stays capped, never a repository's
  history. `MAX_BOUNDARY_IDS` (1000) is that cap made concrete, and since
  PR #1347 it bounds two identity sets rather than one, and not the same amount
  of history each: the boundary sets hold one watermark second's worth, and
  `work.gate_emitted` a sliding window of one traversal's most recent
  admissions. The third set that outlives a page, `work.pulls_emitted`, sits
  outside the cap entirely and is bounded only by the pull count of the phase it
  lives in. A fingerprint is the same count of strings, so the bound survives
  any option here, but the
  cap's own documented failure mode (overflow re-appends every tick until the
  watermark moves) is unchanged by all of them and is not what this asks about.
- **Cursors are sidecar control state.** LLP 0360#cursoring puts them beside
  the table, not in `github_events`. Every option below changes the meaning of
  a persisted field, so each carries the same migration sub-question (below);
  none of them may answer it by adding a `github_events` column.
- **Phases publish after their rows land.** LLP 0360#cursoring, realized by
  `beginPulls`/`finishPulls`/`finishCommits`. A boundary identity is published
  with the watermark it describes, and the two only mean anything together, so
  any new identity must be written and read at the same points.

## The migration sub-question {#migration}

`github-cursors.json` carries `SCHEMA_VERSION = 1` and `readCursors` discards
the whole file on a version it does not recognize. Any content-aware identity
makes existing durable values unrecognizable in kind rather than in shape:
`cursor.boundary[pass]` holds event-id strings that will never match a
fingerprint, and `cursor.pulls_high_numbers` holds integers a fingerprint
cannot be written into at all without changing that field's type or minting a
sibling. The choices are to bump the schema version, to accept one transitional
tick in which the boundary second is re-admitted once (duplicate rows for that
second, plus a re-spend of the boundary pulls' and commits' sub-resource
requests), or to read both shapes for a release.

The two `emitted` sets cost less here, and that is worth separating out. They
live in `cursor.work`, not in the published cursor, so re-keying one costs at
most the phase in flight when the release lands: `readWork` drops a value it
cannot read and the phase resumes with an empty set, which re-admits whatever
that traversal had already appended (the #1345 duplicate, once). Neither needs a
schema bump. `work.pulls_emitted` does share `pulls_high_numbers`' type problem:
it is a `number[]` and `readNumbers` rejects anything that is not a positive
integer, so a fingerprint cannot be written into it either.

The schema bump is the expensive one, and more expensive than it looks. A
discarded cursor leaves a repository with no `since` at all, and
`sinceQuery(undefined)` emits no window, so the next poll re-walks the whole
repository rather than resuming from a horizon. `baseline_pulls` goes with it,
so `reachedHighWater` never fires and every pull is re-emitted with its files,
reviews and commits re-queued against the tick budget. That is the duplication
#1284 reported, paid deliberately and once. (There is no configured poll
horizon in the plugin: `readCursors`' own comment says a fresh poll re-reads
from one, and nothing in `config.js` backs it.)

Whichever arm is chosen below, this has to be chosen with it.

## Options {#options}

### A. A content fingerprint on all four passes {#option-fingerprint}

The boundary identity becomes a hash (or a canonical encoding) of the structural
fields the pass writes, so the guard's rule reads "refuse a row identical to one
already appended at this second" instead of "refuse an item already seen at this
second". `pulls_high_numbers` is replaced by, or joined by, a fingerprint list.
This is the issue's acceptance condition read literally, and it is the only
arm that makes the four passes consistent in mechanism.

Costs and open sub-decisions:

- "All four passes" is now four passes and four identity sets. A fingerprint on
  `cursor.boundary[pass]` and `pulls_high_numbers` alone leaves `gate_emitted`
  and `pulls_emitted` id-keyed, so the mid-traversal half of #reach survives the
  arm untouched and the arm buys only the one-second window it was first written
  for. Covering the `emitted` sets as well is what makes A cure the defect as it
  now stands, and it is the cheaper half: they carry no #migration.
- It buys nothing on commits, and on comments it does not buy the `event_type`
  case either: rows are append-only and an edge id varies with its destination
  node, so admitting the corrected row adds a `pull_request_comment` row and a
  second `commented` edge beside the wrong ones rather than replacing them. On
  those two passes the fingerprint is mostly a more expensive spelling of the
  event id, and it enlarges the sidecar's per-entry size on all four.
- Fingerprint input has to be pinned exactly, because it is durable state read
  by a later release: which columns, what encoding, and what happens when a
  column is added to `github_events` later (a changed input silently re-admits
  every boundary item once).
- The pulls fan-out means a flapping pull at the boundary second can re-spend
  its files, reviews, and commits requests each tick it flaps. Re-keying
  `pulls_emitted` extends that inside one traversal: every changed re-listing
  re-queues the pull's files, reviews and commits against the LLP 0361 budget,
  which is part of what the id-keyed set was buying.
- Carries #migration for the two published sets; the two `emitted` sets do not.

### B. A content fingerprint only where a snapshot field exists {#option-narrow}

Issues and pulls key on identity plus the mutable snapshot fields (`state`, and
the pull `payload`); commits and comments stay id-keyed, because nothing those
items themselves carry can differ between two snapshots. The issue's own defect
is cured, the pulls half also recovers the dropped boundary-second reviews and
files (#reach), the sidecar grows only where growth buys something, and the
guard's rule is still one rule ("refuse a row identical to one already
appended"), just recognized to be a no-op on two passes.

Costs and open sub-decisions:

- The same set question as A, one pass narrower, and on the issues pass it is
  not optional: `gate_emitted` is what widens the exposure B exists to cure, so
  B has to re-key it or it cures the sub-second window and leaves the
  traversal-long one, which is the larger. `pulls_emitted` is the open half.
  Under the listing's order it refuses a changed pull only in the narrow
  push-down case (#reach-window), so re-keying it buys little and still buys A's
  re-spent pulls fan-out, on the same terms.
- It leaves the comment `event_type` case in #reach uncured, because that is
  not an item field: covering it means fingerprinting the built row rather than
  the item, which is arm A's mechanism on a pass arm B keeps id-keyed.
- The four passes then differ in mechanism, which is exactly what the issue's
  deferral reasoning warned against ("fixing only the three new passes would
  leave the four passes inconsistent"). Accepting it means accepting that
  argument only applied to leaving a pass *exposed*, not to spending identity
  where nothing can change.
- It is a standing claim about the row builders: if a mutable field is added to
  the commits or comments rows later, the guard silently under-covers again.
  A test that asserts the row-builder column sets would carry that claim.
- Carries #migration, though only for two passes if the pulls arm is kept as
  numbers plus state.

### C. Admit the boundary and let the reader settle it {#option-admit}

Drop the identity entirely and re-append the boundary second on every tick,
deduplicating in the query and graph layers instead. This is exactly the
behavior issue #1284 reported and PR #1330 replaced, recorded here so its
rejection stays on the record rather than being rediscovered. It is dearer now
than when it was rejected: dropping the identity drops the `emitted` sets with
it, which returns the pagination duplicates and the repeat `commit_file`
fan-out that #1345 reported and PR #1347 closed, on top of #1284's per-tick
boundary re-append.

### D. Accept and document {#option-accept}

Accepting means accepting both windows in #reach, not only the one this document
was first written against. The boundary window is two updates inside one second
on one item with no later activity on it. The `emitted` window is a change to an
issue between two sightings of one phase traversal, which a budget split spreads
across ticks and which in a backfill runs as long as the repository's whole
history; that second window is this arm's real price, and it is the larger of
the two. The pulls pass reaches it only in the narrow push-down case
#reach-window records, so what is accepted there is chiefly `state` on issues.
On the issues pass the loss is still one stale snapshot rather than a dropped
item, and the next update on that item lands the current state in
`github_events`. Three of its costs are not stale-snapshot shaped (all
from #reach): a pull refused at either window withholds the reviews and changed
files of the sighting it was refused on, permanently when that update was the
pull's last; a graph projected before the eventual correction commits the stale
`state` and can never revise it; and the comment `event_type`
misclassification, a boundary-window effect only, is accepted with its
`commented` edge. `openGate`'s doc comment already names both windows
explicitly, and #1353 measures the wider one with a verified probe. Promote that
comment to a decided position, note it on LLP 0361, and close #1333 and #1353
against it. This is the
honest null option, and its cost is bounded by how long an affected item stays
quiet, except for a pull whose refused update was its last, where that
sighting's reviews and files are lost for good.

## Decision requested {#decision}

1. Which arm: a fingerprint on all four passes (A), a fingerprint only where a
   captured field can change (B), or explicit acceptance (D). C is on the
   record as already rejected.
2. If A or B: the exact fingerprint input (columns and encoding); whether the
   pulls pass's `pulls_high_numbers` is replaced, extended, or paired; and
   whether the two phase-scoped `emitted` sets are re-keyed with them. The last
   is what decides which of #reach's two windows the arm actually closes. #1353
   records the minimal form for the gate set, a sighting key
   (`emitted.add(id + '\0' + at)`), which still refuses a byte-identical
   pagination re-listing while admitting a genuinely newer snapshot;
   `pulls_emitted` needs the equivalent or it keeps refusing the pull rather
   than the sighting.
3. The #migration arm: schema bump and full re-poll, one transitional
   re-admission of the boundary second, or a dual-shape read for one release.

The proof obligation from issue #1333 carries over: a regression test in which
an item updated twice inside one second has its second snapshot captured on the
following tick, exercised across the passes the chosen arm claims to cover, and
the existing boundary tests in `test/plugins/github-capture.test.js` still
green. An arm covering the pulls pass owes one more: that the boundary second's
`review` and `pull_request_file` rows land too, since those are dropped rather
than staled (#reach) and a snapshot-only assertion would pass without them. An
arm claiming #reach's traversal-long window owes the #1353 probe as well: a
two-page traversal in which an item changes between its two sightings appends
both snapshots, with the pagination-duplicate tests PR #1347 added still green,
since those pin the case the `emitted` sets exist for.

## References

- hyparam/hypaware#1333 (deferred finding, PR #1330 triage)
- hyparam/hypaware#1284 (the unguarded behavior, closed by PR #1330)
- hyparam/hypaware#1335 (the pulls-lane pagination duplicate) and PR #1340
  (where `work.pulls_emitted` landed)
- hyparam/hypaware#1345 (the gate-lane pagination duplicate) and PR #1347 (where
  `work.gate_emitted` landed)
- hyparam/hypaware#1353 (the traversal-long loss, with the probe #reach cites)
  and hyparam/hypaware#1354 (the `prNumbers` invariant behind the comments case)
- `hypaware-core/plugins-workspace/github/src/capture.js`
  (`openGate` and its `emitted` set, `pullChangedSince`, `emittedPulls`,
  `advancePullsHigh`, `beginPulls`/`finishPulls`/`finishCommits`, the row
  builders)
- `hypaware-core/plugins-workspace/github/src/cursors.js`
  (`SCHEMA_VERSION`, `MAX_BOUNDARY_IDS`, `readWork`, `readBoundaryIds`,
  `readNumbers`)
- `hypaware-core/plugins-workspace/github/src/graph_contract.js`
  (the `commented` edge rules keyed on `event_type`)
- `hypaware-core/plugins-workspace/context-graph/src/project.js`
  (`mergeRow`, `propsValueWins`, `dedupExisting`) and `ids.js` (`nodeId`)
- `test/plugins/github-capture.test.js` (the boundary tests any arm must keep)
