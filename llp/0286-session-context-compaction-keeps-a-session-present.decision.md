# LLP 0286: Session-context compaction gives up a session's history before its presence, under the module's own cap

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Sources, Privacy
**Generated-by:** neutral
**Author:** Brendan / Claude
**Date:** 2026-08-19
**Related:** LLP 0254 (#policy-inline, #hook-stays: the ingest verdict this file feeds, and why the hook record is load-bearing for privacy), LLP 0257 (#ingest: S10, "a session with no hook record is undetermined, not clean"), LLP 0253 (#delete-on-drop: what an undetermined verdict costs a session), LLP 0085 (the settlement backstop that reads a session's record history), LLP 0032 (#capture: the repo identity the record also carries)

> `<stateDir>/session-context.jsonl` is bounded by compaction, and until now
> compaction dropped records purely by position. Position is the one axis on
> which a live session is indistinguishable from a dead one, so the record it
> evicted was whichever session had been quiet, and a session with no record
> is `undetermined` at ingest: its events are withheld and its spooled bodies
> are deleted unread. Compaction now evicts a session's *older* records first
> and its newest record last, and it does so under the module's own cap rather
> than any cap a caller passes.

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
disk. That one is recoverable by widening the window. This one is not: once
compaction rewrites the file, the record is gone.

## Decision

### A session's newest record is evicted last {#newest-per-session}

**Compaction evicts oldest-first among the records a session has superseded,
and only then evicts the per-session newest records, oldest-first.** A session
therefore loses its history before it loses its presence, and it loses its
presence only when every other session's history is already gone.

The cost is bounded and known: one record per distinct session in the window,
about 150 to 400 bytes each, so the 1 MB cap holds thousands of sessions'
presence even in the degenerate case. What it buys is that the number of hook
events a *neighbour* writes no longer decides whether this session is
attributable.

This is deliberately "newest per session", not "all records per session".
LLP 0085's settlement picks a session's record by the row's own time, so a
session's older records are not worthless; they are just worth less than
another session's existence. Under pressure, per-session history is what
compaction spends. Above the cap a session can still lose intermediate
records it would have kept before, and settlement then resolves an opening row
against the record nearest in time that survived, exactly as it already does
for a session whose hook fired late.

### The writer's cap is the module's, not the caller's {#writer-cap-is-clamped}

**`opts.maxBytes` is clamped to `SESSION_CONTEXT_MAX_BYTES`.** The reader's
window (`SESSION_CONTEXT_READ_TAIL_BYTES`) is a module constant and
`createSessionContextReader` has no seam to thread a per-call cap through, so a
caller that compacts to a wider window keeps records that no reader can see,
which is the silent eviction above through the other door. The option stays
useful for what it is actually used for (a test compacting at 240 bytes, a
caller wanting a *tighter* bound); it stops being a way to raise a bound that
only the module can raise, because raising it means moving the reader's window
too.

A clamp rather than a throw: compaction is best-effort by construction (the
hook must never interrupt Claude Code), so the failure mode of a wrong option
has to be a tighter file, never a refused append.

## Consequences

- A quiet session survives a noisy neighbour at the writer, which is the half
  no read window can rescue. Pinned by
  `test/plugins/claude-session-context-compaction.test.js`.
- The existing shape is unchanged where it was already right: with every
  record belonging to a distinct session, eviction is still oldest-first, so
  the assertion in `test/plugins/claude-session-context-hook.test.js`
  ("appendSessionContext compacts large state files to recent records") still
  holds and is not flipped by this decision.
- Compaction now reads the whole retained window rather than slicing it, and
  spends one pass building the eviction order. It runs only when the file is
  over cap, in a best-effort tail of a hook invocation, so the cost sits where
  the previous byte loop's did.
- A caller passing a cap wider than the module constant now gets the module's
  bound instead of its own. Nothing in the tree passes one; the clamp exists so
  that a future caller cannot reopen the eviction by option.
- The `undetermined` verdict is still what an evicted session meets, and it
  still deletes bodies. That asymmetry is not settled here: see LLP 0287.

## References

- `hypaware-core/plugins-workspace/claude/src/session_context.js`
  (`compactSessionContextIfNeeded`, `compactBody`)
- `hypaware-core/plugins-workspace/claude/src/telemetry/source.js`
  (`applyUsagePolicy`, `suppressSession`)
- Issue #918 finding 1 and finding 3; PR #896 (the reader's half); issue #880
