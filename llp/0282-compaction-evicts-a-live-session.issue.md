# LLP 0282: Session-context compaction evicts a quiet-but-live session's only record

**Type:** Issue
**Status:** Draft
**Systems:** Sources, Plugins, Usage-Policy
**Author:** neutral
**Date:** 2026-08-19
**Related:** LLP 0253, LLP 0254, LLP 0257

> `session-context.jsonl` is compacted by position. Once it genuinely reaches
> `SESSION_CONTEXT_MAX_BYTES`, the record that leaves the file is whichever
> session has been quietest, not whichever session has ended. On the OTEL
> ingest path a missing record is not a null column: the listener withholds
> the batch and deletes that session's spooled bodies unread.

## Observed

Not reproduced against a live install; established by reading the writer and
the ingest path, and raised as review round 1 finding 1 on PR #896 (issue
#917, item 1).

`compactSessionContextIfNeeded`
(`hypaware-core/plugins-workspace/claude/src/session_context.js`) keeps the
tail of the file:

```js
const keep = records.slice(-maxRecords)
// then, while still over the byte cap:
keep.shift()
```

Both steps drop by position in an append-only file, so "oldest line" is what
goes. A session that fires the hook once at `SessionStart` and then reads
files for an hour has one or two lines, and they sit at the front. A neighbour
firing `PostToolUse` on every Bash call writes hundreds. Note the hook writes
*two* records per event inside a git repo (`hook_command.js` appends a minimal
cwd-only record first, then an enriched one once the git subprocesses return),
so at the sizes the hook writes (roughly 300 bytes minimal and 500 enriched)
the effective 512 KiB cap is about 650 hook events, which a Bash-heavy agent
reaches in hours, and a mature install sits pinned at the cap permanently.

## Why

The writer's contract is "keep the file bounded", and position is the only
ordering an append-only JSONL file offers for free. Nothing in the writer
knows that the reader's question is per `session_id`, so the one record that
answers a live session's question is indistinguishable from the twelve hundred
odd repeats of a noisy one that fill the cap alongside it.

The consequence is severe because of what the reader is for. Per LLP
0254 #policy-inline, the hook record is where the ingest path gets `cwd`, and
the usage policy is evaluated inline from it:

- no record for the session, so `resolveSessionUsagePolicy` answers
  `undetermined`;
- `applyUsagePolicy` routes the batch to `suppressSession(..., withheld: true)`
  (`telemetry/source.js`);
- `suppressSession` calls `deleteSpooledBodiesForEvents` first, so the
  session's spooled request bodies are deleted before anything reads them
  (LLP 0253 #delete-on-drop).

The sub-cap half is closed separately, by making the writer's effective cap the
smaller of `SESSION_CONTEXT_MAX_BYTES` and `SESSION_CONTEXT_READ_TAIL_BYTES`:
below that cap the record is on disk and visible. (PR #896 proposes to close it
from the other side, by widening the *read* window to follow the writer's cap;
it is still open at the time of writing, so on `master` the read tail remains
half the writer cap.) Above the cap the record is gone from disk, and no read
window can recover it. That half is what this document is about.

## Impact

- A live session loses its content on a mature install, without the user ever
  having opted it out. The user-visible signal is absence: rows that were
  never written.
- The failure correlates with exactly the sessions worth keeping: the quiet
  ones are the reading-and-thinking sessions, and the noisy neighbour that
  evicts them is the one whose rows survive.
- `hyp backfill claude` is the documented recovery (`recovery:
  transcript_backfill` in the drop log), but it recovers transcript content,
  not the spooled request bodies that were already deleted.

## Options

1. **Retain the newest record per `session_id` before dropping by age.**
   Compaction becomes a two-pass rewrite: keep one line per distinct
   `session_id` (the newest), then drop the remaining lines oldest-first until
   under the cap. Bounded by `SESSION_CONTEXT_MAX_RECORDS` in the pathological
   case of more distinct sessions than records allowed. This is the fix the
   review named, and it is what LLP 0254's inline policy check needs to hold.
2. **Age out by `ts` instead of position**, so a record is dropped for being
   old rather than for being early. Cheaper, but it does not help: a live
   quiet session's only record *is* old.
3. **Do nothing, and lean on the transcript backfill.** Leaves the spooled
   bodies deleted unread, and leaves the `undetermined` verdict meaning two
   different things (no hook installed, versus hook installed and evicted).

Option 1 changes what the writer is *specified* to keep, and it flips the
accepted assertion in `test/plugins/claude-session-context-hook.test.js`
("appendSessionContext compacts large state files to recent records"), which
is why it needs this document rather than a patch.

## Open questions

- Does per-session retention belong in the writer, or does the channel want a
  keyed store (one line per session, rewritten in place) instead of an
  append-only log with a compactor?
- What is the bound when distinct sessions exceed `SESSION_CONTEXT_MAX_RECORDS`?
  Retaining "newest per session" is only bounded by the session count.
- Should an evicted-versus-never-recorded distinction be observable, so
  `undetermined` stops meaning both?

## Backlinks

Issue #917 item 1; PR #896 review round 1, finding 1; issue #880. PR #896 (open)
proposes to document the residual cliff in a doc comment on
`SESSION_CONTEXT_READ_TAIL_BYTES`.
