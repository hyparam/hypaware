# LLP 0283: An undetermined usage verdict deletes the session's spooled bodies unread

**Type:** Issue
**Status:** Draft
**Systems:** Sources, Usage-Policy, Privacy
**Author:** neutral
**Date:** 2026-08-19
**Related:** LLP 0253, LLP 0254, LLP 0257, LLP 0282

> The listener has two reasons to not write a row, and it treats them the
> same. "The user opted this directory out" and "I could not tell whose
> directory this is" both end in the session's spooled request bodies being
> deleted before anything reads them. Only the first is a decision.

## Observed

Not reproduced against a live install; established by reading the ingest path,
and disclosed in the body of PR #896 (issue #917, item 2; originally noted on
issue #880).

`applyUsagePolicy` (`hypaware-core/plugins-workspace/claude/src/telemetry/source.js`)
splits a batch three ways and routes two of them into the same helper:

```js
for (const [sessionId, entry] of split.droppedBySession) {
  await suppressSession({ ..., policySource: 'usage_policy', tally, ... })
}
for (const [sessionId, entry] of split.withheldBySession) {
  await suppressSession({ ..., policySource: 'undetermined_cwd', withheld: true, tally, ... })
}
```

`suppressSession` opens with `deleteSpooledBodiesForEvents`, unconditionally.
The `withheld` flag reaches only the counters and the log level: the deletion
already happened.

## Why

Deleting on a drop is deliberate and settled: LLP 0253 #delete-on-drop makes
the spool follow the row, so content the user opted out of does not linger on
disk after the row it belonged to was refused. LLP 0254 then put the policy
check inline at ingest so a row that must not exist is never written.

`undetermined` was added later, for the case the policy cannot be evaluated at
all: no hook record, so no `cwd`, so no `.hypignore` or machine-local list to
consult. It inherited the drop path because a withheld batch also writes no
row, and the spool sweep is keyed to "no row was written" rather than to "the
user said no".

The two are not equivalent:

- A **drop** is an answer. The user declared this directory out of scope, and
  deleting the bodies is the point.
- An **undetermined** verdict is an absence of an answer. The content belongs
  to a session nobody excluded, and the deletion is unrecoverable while the
  alternative (record the row with a null attribution, or leave the bodies
  spooled for the sweep) is not.

The asymmetry is sharpened by LLP 0282: eviction, not just a missing hook, can
produce `undetermined` for a session that is recording normally.

## Impact

- Content loss for sessions nobody opted out, whenever the hook record is
  missing or evicted. The drop log names `recovery: transcript_backfill`, but
  the transcript backfill recovers transcript content, not the spooled request
  bodies, which are already gone.
- The destructive step runs before the recoverable one: the events are merely
  withheld (they could be re-sent, or resolved later), while the bodies are
  deleted outright.
- Recording a null attribution would be strictly less destructive than
  deleting the content, which inverts the usual privacy trade-off: here the
  conservative-looking action is the lossy one.

## Options

1. **Leave the bodies spooled on `undetermined`, and let the cap sweep them.**
   The spool is already byte-capped and evicted oldest-first (LLP 0253
   #byte-cap), and eviction degrades to backfill rather than to loss (LLP 0253
   #eviction-degrades). The bodies then survive long enough for a later batch,
   or a hook record that arrives late, to settle the session.
2. **Write the row with a null attribution** and no `cwd`, marking it
   unattributed, so the content is recorded and the ambiguity is visible in
   the data. Revisits LLP 0254's "a row that must not exist is never written",
   because an unattributed row might turn out to be one that must not exist.
3. **Keep the deletion, and close the causes instead** (LLP 0282, plus attach
   guaranteeing the hook). Preserves the current invariant but leaves the
   asymmetry standing for every cause not yet closed.

Any of these revisits what LLP 0253 #delete-on-drop and LLP 0254 settled, which
is why this is a document rather than a patch.

## Open questions

- Is `undetermined` allowed to be *deferred* rather than answered? The spool
  outliving the batch implies a settle-later path, which this listener does not
  currently have (LLP 0254 removed flush-time settlement for this path).
- If the bodies stay, what bounds them? The spool cap answers the disk
  question, but not "how long may unattributable content sit here".
- Does an unattributed row belong in `claude_telemetry_events` at all, or does
  withholding remain right and only the deletion is wrong?

## Backlinks

Issue #917 item 2; PR #896 body; issue #880.
