# LLP 0205: A rotated OpenClaw session file is still that session's history

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Sources
**Author:** Brendan / Claude
**Date:** 2026-08-10
**Related:** LLP 0158 (#decision: the one reader whose filename contract this widens), LLP 0157 (#backfill: the provider that scans), LLP 0161 (#backfill-provider: native identity straight off the record), LLP 0170, LLP 0172 (#lane-b-sweep: the sweep that runs the same scan on a cadence), LLP 0193; issue #694

> Extends [LLP 0158](./0158-one-reader-for-openclaw-session-jsonl.decision.md).
> The reader's parse rules are unchanged. What widens is the filename the
> backfill scan accepts: OpenClaw rotates a session file in place on reset or
> delete, so `<sessionId>.jsonl` also appears as
> `<sessionId>.jsonl.reset.<ts>` and `<sessionId>.jsonl.deleted.<ts>`, and
> those names carry the same session's history.

## Context {#context}

LLP 0158 states the reader's contract as
`~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`, which is the name
a live session is written under and the only name the scan looked for
(`if (!name.endsWith('.jsonl')) continue`).

OpenClaw does not delete a session's file when the user resets or deletes the
session. It renames it in place, appending a marker and a timestamp AFTER the
extension:

```
e10e0488-2f6b-4b1f-9a55-0f6d2c8a11ca.jsonl.reset.2026-08-05T17-28-41.908Z
probe-anthropic-1e0c.jsonl.deleted.2026-07-31T17-26-46.386Z
```

Neither name ends in `.jsonl`, so neither was ever scanned. On the verifying
install five of seven sessions were rotated, and every turn in them was
invisible to `hyp backfill --client openclaw` and to the Lane B sweep alike:
not excluded with an event, not reported as unreadable, simply never seen.
That is the silent-zero-rows failure mode LLP 0158's rule 5 and issue #543
are both about, one layer out from the parse: a scan that cannot name the
file answers "nothing here" in exactly the voice of an empty history.

Rotation is not deletion of the data, and HypAware's own retention window is
the thing that decides how far back a run reaches (LLP 0157). A session the
user reset yesterday is history the same way a session they left open is.

## Decision {#decision}

The backfill scan accepts `<sessionId>.jsonl` with an OPTIONAL rotation
marker, and derives the fallback session id by removing the `.jsonl`
extension and any rotation marker:

```js
/^(.+?)\.jsonl(?:\.(?:reset|deleted)\..+)?$/
```

- **The markers are named, not open.** `reset` and `deleted` are the two
  OpenClaw writes. A blanket `*.jsonl*` glob would also swallow editor and
  backup artifacts (`<id>.jsonl.bak`, `<id>.jsonl.swp`), which are not
  sessions and whose contents nothing here can vouch for.
- **The id is the name with its `.jsonl` extension and any rotation marker
  removed.** `basename(f, '.jsonl')` strips nothing off a rotated name, so
  once the scan widened it would have partitioned rows under a `session_id`
  carrying the rotation marker and its timestamp, splitting one session
  across as many ids as it was ever rotated to. The header's own `sessionId`
  still wins wherever the file states one (LLP 0158); this is only the
  fallback for a file whose header stated none.
- **Rotation changes nothing downstream.** The records inside a rotated file
  are the records OpenClaw wrote, so the LLP 0158 reader reads them
  unchanged, the LLP 0193 CLI-backend exclusion applies unchanged, and the
  policy gate reads the same header `cwd`.

### No dedupe question {#no-dedupe}

Re-scanning a session that was already imported before it was rotated does
not double it. Identity is the record's own native `message_id` and
`part_id` is `<message_id>#<part_index>` (LLP 0161#backfill-provider,
LLP 0157 R11), so the second import collapses through the existing `part_id`
dedupe to zero writes, the same way a backfilled row already collapses
against its settled live twin. This is the property that lets the scan be
generous about which files it reads.

### The trajectory siblings stay out {#trajectory-siblings}

`<sessionId>.trajectory.jsonl` sits in the same directory and is a different
schema: it stamps the same turns with their wire shape rather than the
session convention (LLP 0193#context), and it holds no `type: "session"`
header and no `type: "message"` records, so the LLP 0158 reader resolves
nothing out of it and it projects zero rows. That is its behavior today and
this decision does not change it.

What the decision does have to protect is that a trajectory file stays
DISTINGUISHABLE from the session beside it. The lazy capture is what does it:
`sess.trajectory.jsonl` resolves its own id as `sess.trajectory`, not `sess`,
so no future reader can quietly fold a trajectory file's records into the
session's identity. A greedy or `.jsonl`-stripping match would have merged
them, and a blanket glob would have removed the distinction entirely.

## Consequences {#consequences}

- The scan's file count grows on any install with reset or deleted sessions,
  and the first run after this lands imports their history (subject to the
  retention window and the quiesce gate, both unchanged).
- The quiesce window (LLP 0170, LLP 0172#45-the-quiesce-window) applies to a
  rotated file exactly as it does to a live one, but `rename(2)` does not
  touch `mtime`: a rotated file is windowed by its last CONTENT write, not by
  the rename. An already-quiet session (its last write already outside the
  window) clears the quiesce window immediately on rotation, not one sweep
  later; only a session rotated while still inside the window waits out the
  remainder of it, same as it would have unrotated.
- The live settlement lane's own enumeration
  (`listOpenclawSessionFiles` in `session_file.js`) now shares
  `SESSION_FILE_NAME` with this scan rather than its own
  `endsWith('.jsonl')` filter. That was not optional: because rename
  preserves mtime, settlement's own mtime-slack candidate filter
  (`candidateSessionFiles` in `settle.js`) would not have excluded a rotated
  file either, so a session reset between capture and flush could otherwise
  yield two rows for the same message once this scan started reading rotated
  names: one at fallback identity from the live row settlement never
  enriched (because it was scanning the pre-rotation name that no longer
  existed) and one at native identity from this backfill scan, and no
  `part_id` collapses them since only the settled leg's `message_id` would
  have matched. Sharing the matcher does not merge the two walks
  (settlement's stays mtime-unfiltered and unsorted; backfill's still applies
  the quiesce window and sorts), only what counts as a session-file name.
- If OpenClaw adds a third rotation marker, the alternation is the one place
  to add it, and a session under an unrecognized marker is skipped rather
  than misread.
