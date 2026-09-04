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
"equal-timestamp unseen pulls are still captured" and "the cursor retains
observed pull numbers", the pulls-pass half of this identity),
[LLP 0032](./0032-github-llm-graph-bridge.decision.md) (the natural keys the
event ids are built from), [LLP 0023](./0023-context-graph-projection.decision.md)
(#merge-policy the order-independent props merge that decides what a second
snapshot is worth downstream), hyparam/hypaware#1333,
hyparam/hypaware#1284 (the unguarded behavior this guard replaced), PR #1330

> Every `since`-windowed GitHub capture pass refuses an item it has already
> captured at exactly the watermark second, and it recognizes "already
> captured" by the item's stable event id. An item updated twice inside one
> wall-clock second therefore keeps the identity it was first captured under,
> and its second snapshot never lands. Curing that means keying the guard on
> the row's content rather than its identity, across four passes whose durable
> boundary state has two different shapes and one of which (`pullChangedSince`)
> settled this trade before the guard existed. This document states the defect,
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
identity is durable sidecar state, its pulls-pass half is a decided property of
LLP 0361#page-work, and the two halves are not even the same type.

## The guard, precisely {#guard}

Affected code at `origin/master` (`610aacfc`):

- `capture.js`, `openGate(staged, stagedIds, published, publishedIds)`: the
  high-water gate for the issues, commits, and comments passes. `admit(at, id)`
  refuses when `at === published && floorIds.has(id)`, and refuses a repeat
  within the running maximum's own set. The ids are event ids
  (`issue:owner/repo#N`, `commit:<sha>`, `comment:<id>`), published to
  `cursor.boundary[pass]` as `string[]` and capped at `MAX_BOUNDARY_IDS`
  (`cursors.js`).
- `capture.js`, `pullChangedSince(pr, high, capturedAtHigh)`: the same guard for
  the pulls pass, predating the others. It refuses when
  `updated === high && capturedAtHigh.has(pr.number)`, and its durable half is
  `cursor.pulls_high_numbers`, a `number[]` of PR numbers validated by
  `readNumbers` as positive integers.

Both exist because GitHub's `since` is inclusive and its timestamps are
second-granular, so every tick re-fetches whatever sits exactly on the
watermark. Advancing the watermark past that second instead would lose an item
stamped in the same second but published after the request, which the tests
"an item tied at the watermark but not yet captured is still captured next tick"
and "new activity does not drag the already-captured boundary rows back in"
(`test/plugins/github-capture.test.js`) both pin. Removing the guard is
issue #1284, already closed: the unguarded passes re-appended every boundary row
on every idle tick.

So the guard is right and the identity it uses is the question.

## How far the defect actually reaches {#reach}

The four passes do not share the exposure, because the guard only loses what
the captured row would have recorded differently. `base()` writes a fixed
column set (LLP 0360#concrete-columns) and each pass fills a known subset:

- **issues** (`issueRow`): `actor_login`, `actor_type`, `number`, `state`,
  `created_at`. `state` is `open` or `closed` and changes over an item's life.
  **Exposed.** This is the issue's example.
- **pulls** (`pullRow`): the same plus `payload: { merged, draft }`, with
  `state` resolving to `merged` when `merged_at` is set. **Exposed**, and it
  carries the fan-out: an admitted pull re-queues its files, reviews, and
  commits sub-resources, so re-admission spends requests against the LLP 0361
  budget, not just a row.
- **commits** (`commitRow`): `actor_login`, `actor_type`, `sha`, `pr_number`,
  `created_at`, gated on `commitTime`. A commit's content is its identity: a
  changed commit is a different sha and therefore a different event id, which
  the guard admits already. There is no "second snapshot of the same commit".
  **Not exposed.**
- **comments** (`commentRow`): `actor_login`, `actor_type`, `number`,
  `created_at`, gated on `updated_at ?? created_at`. Editing a comment moves
  `updated_at` (not a stored column) and the body (never stored, LLP 0360).
  No field this pass captures can change without changing the event id.
  **Not exposed**: the refused second snapshot is byte-identical to the first.

The whole observable defect is therefore `state` (and the pull `payload`) on the
issues and pulls passes, in the window where two updates land inside one second
with no later activity on the item.

Downstream, one more measurement bears on what a fix is worth. The graph's
props merge is order-independent by design (LLP 0023#merge-policy,
`mergeRow`/`propsValueWins` in `context-graph/src/project.js`): the value from
the earliest `first_seen` wins, and equal times tie-break on the stable JSON
encoding. `Issue` and `PullRequest` nodes take `firstSeen: r.created_at`, the
item's creation time, which is identical across every snapshot of that item, so
the state prop always resolves by the lexicographic tie-break: `closed` beats
`open`, `closed` beats `merged` beats `open`. A landed second snapshot changes
the graph only when the tie-break disagrees with recency (a reopen), and the
loss is fully visible only in raw SQL over `github_events`. That is an
observation about the value of each option, not a proposal to change the merge
policy, which LLP 0023 settled.

## What the corpus already settles {#constraints}

- **The pulls tie guard is decided, not incidental.** LLP 0361#page-work states
  that equal-timestamp unseen pulls are still captured and that "the cursor
  retains observed pull numbers". Changing the pulls identity from a number to
  a content fingerprint edits what that document decided, so it needs this
  document (or its successor), not a patch.
- **Identity carried across ticks is budgeted.** LLP 0360#resource-bounds caps
  what capture may retain, and `openGate` is annotated `[constrained-by]`
  against it: one watermark second's worth of identity, never a repository's
  history. `MAX_BOUNDARY_IDS` (1000) is that cap made concrete. A fingerprint
  is the same count of strings, so the bound survives any option here, but the
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
sibling. The choices are to bump the schema version (discarding every cursor,
so every repository re-polls from its configured horizon), to accept one
transitional tick in which the boundary second is re-admitted once (duplicate
rows for that second, plus a re-spend of the boundary pulls' and commits'
sub-resource requests), or to read both shapes for a release. Whichever arm is
chosen below, this has to be chosen with it.

## Options {#options}

### A. A content fingerprint on all four passes {#option-fingerprint}

The boundary identity becomes a hash (or a canonical encoding) of the structural
fields the pass writes, so the guard's rule reads "refuse a row identical to one
already appended at this second" instead of "refuse an item already seen at this
second". `pulls_high_numbers` is replaced by, or joined by, a fingerprint list.
This is the issue's acceptance condition read literally, and it is the only
arm that makes the four passes consistent in mechanism.

Costs and open sub-decisions:

- It buys nothing on commits and comments (see #reach), where the fingerprint
  is a strictly more expensive spelling of the event id, and it enlarges the
  sidecar's per-entry size on all four.
- Fingerprint input has to be pinned exactly, because it is durable state read
  by a later release: which columns, what encoding, and what happens when a
  column is added to `github_events` later (a changed input silently re-admits
  every boundary item once).
- The pulls fan-out means a flapping pull at the boundary second can re-spend
  its files, reviews, and commits requests each tick it flaps.
- Carries #migration.

### B. A content fingerprint only where a snapshot field exists {#option-narrow}

Issues and pulls key on identity plus the mutable snapshot fields (`state`, and
the pull `payload`); commits and comments stay id-keyed, because their captured
rows cannot differ between two snapshots. The observable defect is fully cured,
the sidecar grows only where growth buys something, and the guard's rule is
still one rule ("refuse a row identical to one already appended"), just
recognized to be a no-op on two passes.

Costs and open sub-decisions:

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
rejection stays on the record rather than being rediscovered.

### D. Accept and document {#option-accept}

The window is two updates inside one second on one item with no later activity
on it, the loss is one stale snapshot rather than a dropped item, the graph
result is usually unchanged (see #reach), and the next update on that item
recovers the current state. `openGate`'s doc comment already names the trade
explicitly. Promote that comment to a decided position, note it on LLP 0361, and
close the issue. This is the honest null option and it costs nothing.

## Decision requested {#decision}

1. Which arm: a fingerprint on all four passes (A), a fingerprint only where a
   captured field can change (B), or explicit acceptance (D). C is on the
   record as already rejected.
2. If A or B: the exact fingerprint input (columns and encoding), and whether
   the pulls pass's `pulls_high_numbers` is replaced, extended, or paired.
3. The #migration arm: schema bump and full re-poll, one transitional
   re-admission of the boundary second, or a dual-shape read for one release.

The proof obligation from issue #1333 carries over unchanged: a regression test
in which an item updated twice inside one second has its second snapshot
captured on the following tick, exercised across the passes the chosen arm
claims to cover, and the existing boundary tests in
`test/plugins/github-capture.test.js` still green.

## References

- hyparam/hypaware#1333 (deferred finding, PR #1330 triage)
- hyparam/hypaware#1284 (the unguarded behavior, closed by PR #1330)
- `hypaware-core/plugins-workspace/github/src/capture.js`
  (`openGate`, `pullChangedSince`, `advancePullsHigh`, the row builders)
- `hypaware-core/plugins-workspace/github/src/cursors.js`
  (`SCHEMA_VERSION`, `MAX_BOUNDARY_IDS`, `readBoundaryIds`, `readNumbers`)
- `hypaware-core/plugins-workspace/context-graph/src/project.js`
  (`mergeRow`, `propsValueWins`)
- `test/plugins/github-capture.test.js` (the boundary tests any arm must keep)
