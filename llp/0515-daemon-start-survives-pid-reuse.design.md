# LLP 0515: A daemon start survives a reused pid in a stale pid file

**Type:** design
**Status:** Active
**Systems:** Daemon
**Author:** HypForge steward
**Date:** 2026-10-16
**Extends:** [LLP 0417#cache-mutation-guard](./0417-session-purge-across-storage.spec.md#cache-mutation-guard) (the same guard, keyed on the daemon pid file)
**Related:** LLP 0017, LLP 0300, [issue 2583](https://github.com/hyparam/hypaware/issues/2583), [PR 2587](https://github.com/hyparam/hypaware/pull/2587)

@ref LLP 0417#cache-mutation-guard [extends]: the start check and the pid write take the cross-process guard this doc defines

## Why {#why}

The gateway refused to start whenever its pid file named a live process. A
daemon that did not shut down cleanly (a crash, a VM rebuild, a container
restart) leaves its pid file behind, and once the system hands that pid to an
unrelated process every later start fails with `daemon already running`, with
nothing for the operator to act on except deleting the file by hand
(issue 2583). The check also ran apart from the write that replaced the file,
so two starts that both found a stale file could both pass it.

## Identity {#identity}

- A live pid in the pid file is the daemon unless its command line shows it
  is not: every daemon start runs `daemon run` (the launchd plist, the systemd
  unit, and a foreground `hyp daemon run` alike), so a readable command line
  without the `daemon run` argument pair is another program.
- The program name is not tested. A `hyp` shim, a global npm bin, or a
  `node` path need not contain `hypaware`, and a test on the name would read a
  real daemon as foreign and let a second one start beside it.
- A command line that cannot be read (no `/proc`, a failed `ps`, an empty
  result) counts as the daemon. That keeps the behavior before this design:
  refuse, and let the operator look.
- A pid file naming the starting process itself is a previous incarnation's:
  this process has not written one yet. A containerized daemon restarts as
  the same pid, which a liveness probe alone reads as running (the guard in
  LLP 0417 makes the same call for its own owner files).
- Start time is not compared. A wall-clock step between the old daemon's
  start and the check could misjudge a live daemon as stale, which is the
  unsafe direction.
- The holder is never signalled, adopted, or waited on. A stale file is
  overwritten; whatever process owns the pid keeps running.

## The claim {#claim}

- The read of the pid file, the liveness and identity check, the clearing of
  leftover control requests (LLP 0300), and the write of the new pid file all
  run while holding the LLP 0417 guard keyed on the pid file path
  (`<run>/.hypaware.pid.mutation-lock`). A second start either finds the
  guard held and refuses (`daemon start already in progress`) or finds the
  first start's pid file naming a live `daemon run` process and refuses
  (`daemon already running`). Two starts cannot both pass.
- The guard is held only for those few file operations, never for the
  daemon's lifetime. A start killed inside it leaves a dead owner, which the
  next start reclaims; a malformed guard fails closed as LLP 0417 describes.

## Scope {#scope}

- `hyp daemon stop`'s stale-file cleanup and the gateway's own pid-file
  removal at shutdown do not take the guard. Each removes a file whose holder
  is gone, so a race with a start costs at most a missing pid file for a
  running daemon until its next restart, not a second daemon.
- The processor child's pid write is unchanged.

## Cost {#cost}

- Per start: one guard directory create and remove, one owner file, one pid
  file read and write. Only when the pid file names a live process other than
  this one: one `/proc/<pid>/cmdline` read on Linux, or one `ps` exec
  (5 second bound) elsewhere. Nothing at runtime, nothing per row.
