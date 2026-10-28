# LLP 0517: A probation this host could not confirm is retried, not marked bad

**Type:** Decision
**Status:** Draft
**Systems:** Config, Sinks
**Author:** Phil / Claude
**Date:** 2026-10-16
**Related:** LLP 0025 (#last-known-good-rollback and #post-apply-probation: the backoff this narrows), hyparam/hypaware#2547, #2662, #2664

> Extends [LLP 0025 §last-known-good-rollback](./0025-remote-config-join-flow.spec.md#last-known-good-rollback),
> which backs off re-apply of a rolled-back etag "until the etag changes".
> That holds for a revision that is bad. It does not hold for a revision
> the host was never able to judge, and everything else in LLP 0025 stands.

## Context

Probation clears on the first authenticated config poll after the staged
restart, and the central sink runs that poll. When a sink fails to
materialize on the probation boot (the daemon logs
`daemon.sink_materialize_failed`), the poll may never run, the window
expires, and the kernel rolls back and remembers the etag as bad. In #2547
the failure was a client bug (an identity URL mismatch fixed in 1.41.0),
not the revision: the host then skipped that etag on every poll, upgrading
the client did not help, and only a server-side revision change or a hand
edit of `state.json` got it out. `hyp status` already reads the same log
event to say the host could not confirm the revision (#2664); the apply
engine drew no such distinction.

## Decision

- **An expiry after a sink failure is unconfirmed** {#unconfirmed}: when a
  sink fails to materialize while a probation marker is open, the daemon
  stamps the marker with the running client version. An expiry of a
  stamped marker, by the in-process timer or at a later boot, rolls back
  exactly as before but records the reason `probation_unconfirmed`, and the
  remembered etag carries the client version it could not be confirmed
  under. The stamp is persisted because the boot-path expiry runs in a
  later process.
- **It is retried on its own** {#retry}: the re-apply backoff skips a
  `probation_unconfirmed` etag only until 6 hours have passed since the
  rollback, or until the running client version differs from the recorded
  one, whichever comes first. The retry is an ordinary apply with its own
  probation; it clears the etag's own bad mark at commit (the active slot
  never carries the remembered bad etag, LLP 0025's #141 invariant), and
  its confirmation clears the rollback record. If it fails to confirm for
  the same reason, the cycle repeats once per backoff.
- **A bad revision is unchanged** {#bad-unchanged}: a plain expiry with
  every sink materialized, and a validation, install, or hash failure,
  record their existing reasons and back off until the etag changes,
  exactly as LLP 0025 settles.

## Consequences

- One optional field, `client_version`, appears on the probation marker
  and on the remembered bad etag in `config-control/state.json`. An older
  file without it loads unchanged and reads as a bad revision.
- A revision that itself stops a sink from materializing (a central URL
  the client cannot use, say) cannot be told apart from a client bug, so
  it is retried once per backoff rather than held forever. Each retry is a
  staged restart and one probation window; rows are spooled, not lost.
- `hyp status` keeps its #2664 sink hint for the new reason, and its
  repair says the gateway retries on its own instead of asking for a new
  revision.
