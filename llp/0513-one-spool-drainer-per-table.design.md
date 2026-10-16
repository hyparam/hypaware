# LLP 0513: One process drains a table's spool at a time

**Type:** design
**Status:** Active
**Systems:** Cache
**Author:** HypForge steward
**Date:** 2026-10-16
**Extends:** [LLP 0417#cache-mutation-guard](./0417-session-purge-across-storage.spec.md#cache-mutation-guard) (a new key for the same guard), [LLP 0492#contention](./0492-ingest-seq-reserved-at-commit.design.md#contention) (a bounded wait, with exhaustion leaving rows in the spool)
**Related:** LLP 0321, LLP 0347, [issue 2580](https://github.com/hyparam/hypaware/issues/2580)

@ref LLP 0417#cache-mutation-guard [extends]: the same directory guard, keyed on the spool instead of a partition
@ref LLP 0492#contention [extends]: a busy claim is retried for a bounded time, then the flush fails and rows wait

## Why {#why}

The spool's write and flush locks are promise chains inside one process. A
`hyp query --refresh always` flushes from its own process while the daemon
flushes too, and nothing stopped both from listing the same rotated
`flush-*.jsonl`, reading it, and committing it. The batch then landed twice,
each copy with its own seqs (issue 2580: 2 of 8 hermetic runs on master
duplicated a batch). The partition guards did not help, because they are taken
per chunk, after the file has been read, and released between chunks.

## Drain claim {#drain-claim}

- A flush claims the table's spool before it rotates `active.jsonl` and holds
  the claim until the last rotated file it read is removed. The claim is the
  LLP 0417 guard keyed on `<spool>/drain`, so its lock directory is
  `<spool>/.drain.mutation-lock` with one `<pid>-<uuid>` owner file.
- It lives inside the spool directory, not beside the partition, because the
  partition guard is already keyed on the partition directory. Every spool
  reader lists regular files only, so the lock directory is never read as
  rows, and the maintenance walk already stops at the spool.
- Order: drain claim, then partition guards, then the seq counter. Nothing
  flushes while holding a partition guard, so the order never inverts.
- A busy claim is waited out, up to 600 attempts 50 ms apart (about 30 s). A
  forced flush resolving means everything spooled before it is committed
  (LLP 0321), so skipping a busy table would break that promise. When the wait
  runs out, the flush fails with `cache_partition_mutation_busy`, the failure
  is stamped like any other, and the rows wait in the spool for the next tick.
- A claim left by a killed process names a dead PID and is reclaimed by the
  guard on the next attempt, so it does not wedge the next drain. An empty or
  malformed claim (a kill between the directory and its owner file) fails
  closed, as LLP 0417 settles for every guard: flushes keep failing busy until
  an operator, with writers stopped, removes `.drain.mutation-lock`.
- A spool missing when the flush starts is an idle flush: the pass does not
  run at all. Nothing was spooled before the call, and a spool another process
  creates meanwhile is that process's to drain under its own claim; running
  the pass anyway drained it unclaimed and committed its batch twice.
- A symlinked spool takes no claim, so the lock is never created through it,
  and `listFlushFiles` refuses it as before.

## Cost {#cost}

- One directory create, one file create, and their removal per flush, plus a
  timer per busy retry. No per-row work, no retained memory, no heartbeat.
- A waiting flush holds no file handles and no rows while it sleeps.

## Mixed versions {#mixed-versions}

- A binary from before this change ignores the claim and can still double
  drain alongside a new one. Restart every writer on the new version.
- An old binary tolerates the lock directory: it lists the spool for regular
  files only, and it never removes the directory.
