# LLP 0579: A machine-wide pause is a set of time windows on row time

**Type:** Decision
**Status:** Accepted
**Systems:** Privacy, Sources, Storage
**Author:** Kenny / Claude
**Date:** 2026-11-04
**Related:** LLP 0050, LLP 0066, LLP 0395

> `hyp session ignore` pauses one session, and usage classes work per folder or client.
> A person who wants nothing recorded for the next hour has no control for that.
> `hyp privacy pause` adds it, and a pause means the time is lost for good.

## Why not a machine-wide `ignore` marking

`hyp privacy set / ignore` stops every recorder today. But clients keep writing
transcripts during the pause, and once the marking is removed the scheduled imports
read them. Tested on a Claude transcript: a session from the pause and a new turn in an
older session both came back on the first import after resuming.

## Decision

<a id="windows"></a>**A pause is a stored list of windows.** `hyp privacy pause` opens one
and `hyp privacy resume` closes it. Closed windows are kept, because they're what keeps
those turns out of later imports. The row's own time decides, using `message_created_at`,
`event_timestamp` or `timestamp`. A turn that began before a pause and finished during it
may be kept if its timestamp is before the window.

<a id="seam"></a>**It's enforced in the storage service.** Every recorder and import writes
through `survivingRows`, including the reconcile lanes, so plugins don't need to know. A
row with no time is dropped only during a live pause, and only if it belongs to a session,
so derived datasets keep working.

<a id="fail-closed"></a>**Unreadable state counts as paused.** The person asked for nothing to
be recorded, and we can't tell since when, so writes stop until the file is repaired.

## Consequences

- Rows from a pause are dropped silently, and backfill's `rows_written` still counts them
  as produced, because the count happens before the storage call.
- Pausing doesn't stop sync of rows recorded earlier, and it doesn't touch AI traffic.
- Org locks on this control are a separate decision.
