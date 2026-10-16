# LLP 0286: Session-context compaction gives up a session's middle before its endpoints, within the window a reader can read

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Sources, Privacy
**Generated-by:** neutral
**Author:** Brendan / Claude
**Date:** 2026-08-19
**Extends:** LLP 0085 (compaction now guarantees a session's session-start
record survives eviction, which is what `pickRecordForRow`'s at-or-before rule
needs once the file is over cap)
**Related:** LLP 0254 (#policy-inline, #hook-stays: the ingest verdict this file feeds, and why the hook record is load-bearing for privacy), LLP 0257 (#ingest: S10, "a session with no hook record is undetermined, not clean"), LLP 0253 (#delete-on-drop: what an undetermined verdict costs a session), LLP 0085 (the settlement backstop that reads a session's record history), LLP 0032 (the repo identity the record also carries)

> `<stateDir>/session-context.jsonl` is bounded by compaction, and until now
> compaction dropped records purely by position. Position is the one axis on
> which a live session is indistinguishable from a dead one, so the record it
> evicted was whichever session had been quiet, and a session with no record
> is `undetermined` at ingest: its events are withheld and its spooled bodies
> are deleted unread. Compaction now evicts a session's *interior* records
> first and its two endpoints last (its session-start record, which settlement
> resolves an opening row against, and its newest, which ingest reads), and it
> does so within the window a reader is actually able to read rather than any
> wider cap a caller passes.

## Context

The SessionStart / UserPromptSubmit / PostToolUse hook appends one line per
fire (two, since LLP 0085 part (a)) into an append-only JSONL file, and
`appendSessionContext` compacts that file once it passes
`SESSION_CONTEXT_MAX_BYTES`. Compaction kept the last N records and then
shifted from the front until the body fit.

Every reader of the file asks it a per-session question. The projector, the
backfill runner and the telemetry listener all call `pickLatestMatching` for
one `session_id`; settlement (LLP 0085) walks one session's records by time.
None of them wants "the most recent 1 MB of hook traffic"; they want "this
session's record". Dropping by position answers a question nobody asked, and
answers it in the worst direction: a session firing the hook on every Bash
call writes hundreds of records, and each one pushes a quiet session (one that
spent the turn reading files, or thinking) closer to the front of the file.

On the OTEL ingest path that is not a nullable column. LLP 0254 #policy-inline
resolves the usage policy from the hook's cwd, LLP 0257 S10 reads a missing
record as `undetermined`, and the listener answers `undetermined` by
withholding the batch and calling `deleteSpooledBodiesForEvents` (LLP 0253
#delete-on-drop). So a compaction that evicts a live session's only record
turns that session's turn into withheld events plus deleted bodies, for a
session nobody opted out.

The companion half of this defect is the reader's window (issue #880, PR #896):
a read tail narrower than the writer's cap hides records that are still on
disk. That one is recoverable by widening the window, and until it is widened
it also bounds this one, which is why the clamp below targets the read tail and
not the max constant. This half is not recoverable: once
compaction rewrites the file, the record is gone.

## Decision

### A session's endpoint records are evicted last {#endpoints-evicted-last}

**Compaction evicts a session's INTERIOR records first (oldest record first
across all sessions), and only then its ENDPOINTS: its earliest and its newest
record, stalest SESSION first.** A session therefore loses its middle before
either end, and loses an end only when every session's middle is already gone.

The tier-two order is by session, not by record position, and that distinction
is the whole rule. "Oldest record first" reads the front of the file as the
cheapest thing to drop, but the front of the file is exactly where a
long-running session's session-start record lives, so it would evict the
session-start record of the session that has been alive longest before touching
anything belonging to a session that ended hours ago. Ordering by the position
of each session's NEWEST record instead means a whole stale session is given up
before a live one gives up either end: the record a session loses is decided by
when that session last fired the hook, never by how much a neighbour wrote in
between.

What this does not buy, because a byte cap cannot buy it: a session that stops
firing the hook for longer than the window holds is still evicted, endpoints and
all. Presence costs about two records per session in the window, so on today's
512 KB that is thousands of sessions of headroom, but it is headroom, not a
guarantee. Compaction ranks sessions by last activity; it cannot tell a live
session that spent an hour thinking from one that exited.

Two endpoints, not one, because the file answers two different questions and
each end answers one of them:

- **Newest** is what ingest reads. The projector, the backfill runner and the
  telemetry listener all call `pickLatestMatching` for one `session_id`, and a
  session with no record at all is `undetermined` (LLP 0257 S10): batch
  withheld, spooled bodies deleted unread (LLP 0253 #delete-on-drop).
- **Earliest** is what settlement reads. LLP 0085 resolves an OPENING row
  against the record live at that row's own time, and for an opening row that
  record is the session-start one. Keeping only the newest would resolve an
  opening row that ran in an ignored dir against a later, clean cwd
  (`pickRecordForRow` finds nothing at-or-before the row and falls back to
  `earliestRecord`), and settlement would retain a row it exists to drop. That
  is a leak, the one direction that cannot be taken back; `undetermined` at
  least errs toward dropping.

The cost is bounded and known: at most two records per distinct session in the
window, about 150 to 400 bytes each, so the cap still holds thousands of
sessions' presence even in the degenerate case. What it buys is that the number
of hook events a *neighbour* writes no longer decides whether this session is
attributable, nor whether its opening rows settle against the right cwd.

This is deliberately the endpoints, not "all records per session". A session's
intermediate records are not worthless; they are just worth less than another
session's existence and than a correct drop. Above the cap a session can still
lose intermediate records it would have kept before, and settlement then
resolves a mid-session row against the record nearest in time that survived,
exactly as it already does for a session whose hook fired late.

### The retained window never exceeds the readable window {#writer-cap-is-clamped}

**`opts.maxBytes` is clamped to the smaller of `SESSION_CONTEXT_MAX_BYTES` and
`SESSION_CONTEXT_READ_TAIL_BYTES`.** Every reader calls `readSessionContext`
with no opts (`createSessionContextReader`, settlement, backfill), so the tail
constant, not the max constant, is the real limit on what a reader can see.
Retaining past it keeps records on disk that no reader will ever read, which is
the silent eviction above reached through the other door, and it is why pinning
a session's endpoints is not on its own enough: after compaction the pinned
records sit at the HEAD of the rewritten file, which is exactly the half a tail
read discards.

Today those constants are 1 MB and 512 KB, so the clamp binds and the effective
retained window is 512 KB. Widening it is a one-line change to
`SESSION_CONTEXT_READ_TAIL_BYTES` (issue #880; PR #896 raises it), and the
clamp is written so that widening the read window widens the retained window
with it, in that order and never the other.

The option stays useful for what it is actually used for (a test compacting at
240 bytes, a caller wanting a *tighter* bound); it stops being a way to raise a
bound that only the module can raise, because raising it means moving the
reader's window too.

A clamp rather than a throw: compaction is best-effort by construction (the
hook must never interrupt Claude Code), so the failure mode of a wrong option
has to be a tighter file, never a refused append.

## Consequences

- A quiet session survives a noisy neighbour at the writer, and survives it
  inside the window the default reader reads. Pinned by
  `test/plugins/claude-session-context-compaction.test.js`.
- A session that changed dirs mid-turn and is still firing the hook keeps the
  session-start record its opening rows settle against, so LLP 0085's
  at-or-before rule still has a record to find on a file over cap and cannot
  fall back to a later, cleaner cwd. A session that has gone quiet for longer
  than the window holds loses it anyway; that is the cap, not the order.
- The existing shape is unchanged where it was already right: with every
  record belonging to a distinct session, eviction is still oldest-first, so
  the assertion in `test/plugins/claude-session-context-hook.test.js`
  ("appendSessionContext compacts large state files to recent records") still
  holds and is not flipped by this decision.
- Compaction now reads the whole retained window rather than slicing it, and
  spends one pass building the eviction order. It runs only when the file is
  over cap, in a best-effort tail of a hook invocation, so the cost sits where
  the previous byte loop's did.
- A caller passing a cap wider than the readable window now gets the readable
  window instead of its own. Nothing in the tree passes one; the clamp exists so
  that a future caller cannot reopen the eviction by option.
- The effective retained window drops from 1 MB to 512 KB until
  `SESSION_CONTEXT_READ_TAIL_BYTES` is raised. That is not lost coverage: the
  bytes above 512 KB were already unreadable by every caller in the tree.
- The `undetermined` verdict is still what an evicted session meets, and it
  still deletes bodies. That asymmetry is not settled here: see LLP 0287.

## References

- `hypaware-core/plugins-workspace/claude/src/session_context.js`
  (`compactSessionContextIfNeeded`, `compactBody`)
- `hypaware-core/plugins-workspace/claude/src/telemetry/source.js`
  (`applyUsagePolicy`, `suppressSession`)
- Issue #918 finding 1 and finding 3; PR #896 (the reader's half); issue #880
