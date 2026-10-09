# LLP 0482: `hyp leave` Keeps the Team Graph Replica

**Type:** Decision
**Status:** Superseded
**Superseded-by:** [LLP 0491](./0491-team-history-uses-remote-graph-and-agent-guidance.spec.md) (client replication and its commands; shared kernel utilities remain)
**Systems:** CLI, Privacy, Daemon
**Author:** HypForge designer
**Date:** 2026-10-09
**Extends:** [LLP 0480#replica](./0480-fastask.design.md#replica) (the `hyp leave` deletion rule) and [LLP 0480#status-line](./0480-fastask.design.md#status-line) (the "not kept after leave" line)
**Related:** LLP 0063 (connection ladder: `leave` cascades down, never up), LLP 0481 (plan tasks T5, T10, T13)

> LLP 0480 had `hyp leave` delete the fastask team-graph replica and suspend
> its sync. That reaches up a level of LLP 0063's connection ladder, and it
> buys no privacy. This decision reverts it: `leave` does not touch the
> replica.

## Decision {#decision}

`hyp leave` does not delete, suspend or otherwise change the fastask
replica. The replica belongs to the query login for its server and org
(LLP 0480#replica), and LLP 0063's ladder says `leave` removes enrollment and
forwarding but keeps query logins ("leave cascades down, never up").

The replica is deleted by exactly these events, all of which LLP 0480
already names:

- `403 snapshot_access_withdrawn` from the server, immediately;
- lease expiry with no successful check;
- `hyp remote remove` of its target;
- a change of default remote or of the org on its login;
- a future explicit sign-out (`hyp remote logout`, not implemented today).

The status line "team graph: not kept after leave; queries still use your
login to <server>" (LLP 0480#status-line) is not used. The other status lines
are unchanged, and the line stays shown in every state.

## Why {#why}

- **The ladder.** Enrollment (forwarding this machine's captures) and the
  query login (reading the team's data) are separate levels in LLP 0063, and
  `leave` deliberately stops at the first. The replica is derived from the
  second, so it follows the second.
- **No privacy gain.** After `leave` the person is still logged in to query:
  `hyp fastask` would answer through `team_server`, and the next sync would
  download the replica again. Deleting it would cost a 50 MB download and
  change nothing about what the person can read.
- **The real signal already exists.** When someone is actually off the team,
  the server answers `403 snapshot_access_withdrawn` (server LLP 0554), which
  deletes the replica at the next check, and the lease bounds how long an
  offline machine keeps it.

The UX guardian first recommended the deletion, then withdrew it on reading
LLP 0063, and recommends this reversal (room hypforge, 2026-10-09 02:29Z).

## Consequences {#consequences}

- LLP 0481 T5 does not detect removed enrollment and does not suspend sync;
  T10's sync smoke does not delete on `leave`; T13's journey checks that
  `leave` leaves the replica in place and that a later `403` deletes it.
- No core change to `hyp leave` (`src/core/commands/central.js`).
- CPU and memory: removes a check; no concern.
