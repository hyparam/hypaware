# LLP 0514: An append in flight holds the rotated file it writes into

**Type:** design
**Status:** Active
**Systems:** Cache
**Author:** HypForge steward
**Date:** 2026-10-16
**Extends:** [LLP 0513#scope](./0513-one-spool-drainer-per-table.design.md#scope) (closes the append-against-rotation gap it left open)
**Related:** LLP 0013, LLP 0321, [issue 2654](https://github.com/hyparam/hypaware/issues/2654)

@ref LLP 0513#scope [extends]: the drain claim coordinates drain against drain; this coordinates an append against a drain

## Why {#why}

An append opens `active.jsonl`, writes one line, fsyncs and closes it, under a
write lock that exists only inside its own process. A flush in another process
renames `active.jsonl` to a `flush-*.jsonl` name, drains it, and unlinks it.
An append whose open came before that rename and whose write came after the
drain read the file wrote into a file that was already gone, and the row was
lost though the append resolved (issue 2654). The drain claim (LLP 0513) does
not help: it orders drains, and an append takes no claim.

A lock between append and rotation would close the gap, but it would let one
stuck writer (a hung disk, a stopped process) stall every rotation, and so
every flush, for as long as it is stuck. This design never makes a rotation
wait.

## The marker {#marker}

- Before it writes, an append creates `<spool>/.append-<pid>-<uuid>` (exclusive
  create, mode 0600) holding the inode number of the `active.jsonl` handle it
  opened. It removes the marker after it closes the handle, whatever the
  outcome.
- After creating the marker, the append checks that `active.jsonl` still names
  that inode. A match means any rename of the file comes after the marker
  exists. A mismatch (or a missing file) means a rotation got in first: the
  handle is closed unwritten, the marker removed, and the open retried on the
  new file, at most 8 times before the append fails with nothing written. Each
  retry needs another rotation inside one open-to-check window, so a working
  spool never reaches the bound.
- A marker is not a lock. Nothing waits on it, and it names one file.

## Hold the file, not the drain {#hold-the-file}

- A drain lists the markers once, after its rotation. Any append that can
  still write into one of the rotated files published its marker before that
  rotation, so it is listed, or it has already finished and its bytes are in
  what the drain reads.
- The drain's own process is excluded: its appends and its rotations share the
  in-process write lock, so they never span each other.
- A drain reads and commits every rotated file as before. Before unlinking
  one, it asks whether a listed marker names that file's inode and belongs to
  a live process. If so, the file and its progress record are kept, and a
  later drain resumes from the progress offset, reading only what the writer
  added. Rows are never held back; only the unlink is deferred.
- If no listed writer holds it but the file grew while it was read, the drain
  reads again from the progress offset before unlinking, so a write that
  finished between the read and the check is committed, not unlinked.
- An empty or unreadable marker counts as holding: keeping a file costs a
  resumed read later, while unlinking it early costs the rows.
- A stuck writer holds only the one file it opened. Later appends open the new
  `active.jsonl`, later rotations and drains go through, and the held file
  waits in the spool and counts as pending.

## Dead writers {#dead-writers}

- A marker whose pid is gone (`kill(pid, 0)` reports `ESRCH`) is removed when
  a drain lists it. A killed append writes nothing more, so its file is
  released by that drain, and a torn half-line it left is dropped with it
  (it has no newline, so the reader never takes it as a row, and it was never
  acknowledged).
- A reused pid reads as live, so the file stays held until that process
  exits. That fails toward keeping data.
- A writer in another pid namespace (a container sharing the cache volume)
  reads as dead, which falls back to the behavior before this design.
- A marker whose removal failed holds its file until its process exits.

## Cost {#cost}

- Per append: one small exclusive file create, one path `stat`, one handle
  `stat`, and one unlink. No retained memory.
- Per drain pass: one `readdir` of the spool. Only when another live process
  has an append in flight: two `stat`s and one marker read per rotated file.
  No timers, no waiting, nothing per row.

## Mixed versions {#mixed-versions}

- A binary from before this change neither writes nor reads markers. Its
  appends can still be lost under a new drain, and its drains still unlink
  under a new append. Restart every writer on the new version.
- Old binaries tolerate the marker files: every spool reader lists only
  `active.jsonl` and `flush-*.jsonl`.
