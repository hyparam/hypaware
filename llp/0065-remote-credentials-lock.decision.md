# LLP 0065: The remote-credentials lock is an age-stale mutex, not a liveness probe

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Query, MCP
**Author:** Kenny / Claude
**Date:** 2026-06-30
**Related:** LLP 0033, LLP 0058

> LLP 0058 D5 introduced a cross-process write lock on the shared `0600`
> credential store so a one-time-use refresh token is rotated single-flight. The
> lock worked; its *crash-recovery* mechanism (a `{host, pid}` liveness probe plus
> an age backstop plus a rename-aside-and-restore steal) did not. A review of the
> shipped code found six defects clustered entirely in that recovery path. This
> decision replaces the recovery mechanism with the simplest thing that is
> provably safe, and supersedes the second half of LLP 0058 D5.

## What stays (and why)

The **single-flight refresh under the lock** decision of LLP 0058 D5 is sound and
unchanged: the read-decide-refresh-commit still runs inside one lock hold, so only
one process calls the token endpoint for a given store at a time, and an
`invalid_grant` observed under the lock is an unambiguous revocation rather than a
lost race. We do **not** move the network refresh outside the lock. LLP 0058 D5
already rejected that ("optimistic compare-and-swap"), and the rejection is
correct: the refresh token is one-time-use, so two processes refreshing the same
token concurrently would double-spend it, and a loser that re-read before the
winner committed could not tell a contended `invalid_grant` from a real
revocation. Holding the bounded (30s token-endpoint timeout) refresh inside the
lock is the price of correctness and we keep paying it.

The bugs were never in *holding* the lock. They were in *recovering* a lock whose
holder died.

## The defects being retired

The recovery mechanism (`lockHolderIsDead`, `stealLockIfAbandoned`, the
`{host, pid}` owner tag, `LOCK_STALE_MS` OR-d with liveness, `LOCK_TIMEOUT_MS`)
produced:

1. **Live-holder theft.** `abandoned = lockHolderIsDead(...) || age > LOCK_STALE_MS`
   applied the age backstop even to a probeable, *alive* same-host holder, so a
   holder suspended past 90s (laptop sleep, NFS stall) had its lock stolen and two
   writers clobbered a just-rotated refresh token. This contradicted the function's
   own doc comment.
2. **Unreachable steal.** `LOCK_TIMEOUT_MS` (45s) was smaller than `LOCK_STALE_MS`
   (90s), so an in-flight waiter gave up before an abandoned lock ever aged into
   stealable territory; cross-host crashes and PID reuse wedged every contender for
   45s.
3. **Empty-lock wedge.** A failed owner-tag write left a 0-byte lock that parsed as
   "not dead" and blocked all writes until the 90s backstop.
4. **Restore-gap double-hold.** `stealLockIfAbandoned`'s rename-aside-then-restore
   branch left `lockPath` briefly absent, so a third contender's `O_EXCL` create
   could succeed alongside the restored holder.

(Numbering here is local to this doc; the PR review thread carries the full list.)

## Decision

<a id="d1"></a>

### D1: One age threshold, break by unlink, grant only by `O_EXCL`

Replace the entire recovery apparatus with three rules:

- **Grant only by `O_EXCL`.** A process holds the lock if and only if its
  `fs.open(lockPath, 'wx')` (i.e. `O_CREAT | O_EXCL`) succeeds. The OS guarantees
  exactly one winner per file-existence epoch. Nothing else ever confers the lock.
- **Break by age, with one constant.** A contender that sees `EEXIST` stats the
  lock; if its mtime is older than `LOCK_STALE_MS`, the holder is treated as dead
  and the contender `fs.rm`s the lock, then loops back to the `O_EXCL` create.
  `LOCK_STALE_MS` is set to **60s**, comfortably above the longest legitimate hold
  (the 30s-bounded token call plus a millisecond commit) and below user patience.
  There is **no** liveness probe, **no** `{host, pid}` tag, and **no** second
  timeout: because the lock's mtime is fixed at acquisition and the wall clock only
  advances, every waiter is guaranteed to either acquire (the holder released) or
  break (age crossed `LOCK_STALE_MS`) within one stale interval. A generous overall
  deadline (`2 × LOCK_STALE_MS`) remains only as a runaway-loop backstop.
- **Release only your own lock.** The lock file records a per-acquisition random
  nonce (`crypto.randomUUID`). Release reads the file and unlinks only if the nonce
  still matches, so a holder whose overran lock was already broken and re-acquired
  by a successor never deletes that successor's lock.

Breaking **never grants** the lock: a breaker that unlinks a stale file must still
win the `O_EXCL` create like everyone else.

**Rejected** keeping a liveness probe "for same-host precision": `process.kill(pid, 0)`
cannot see a suspended-but-alive holder, is defeated by PID reuse, is meaningless
across a shared `HOME`, and was the source of defects 1-2. A single age threshold,
chosen against the *bounded* hold time, subsumes every case the probe tried to
distinguish.

**Rejected** the rename-aside-and-verify steal: its restore branch was defect 4,
and it is unnecessary once the grant is unconditionally `O_EXCL` - a plain `fs.rm`
break is single-winner *in effect* because the grant, not the break, decides who
holds.

### Safety argument

- **Mutual exclusion.** The lock is granted only by `O_EXCL`, which has one winner.
  Breaking only removes a file. Two processes can therefore hold simultaneously
  only if a break removed a *live* (non-stale) holder's lock - which requires a
  fresh lock to be created in the window between the breaker's `stat` (which read
  `age > LOCK_STALE_MS`) and its `rm`: two adjacent filesystem awaits.
- **Bounded worst case.** Even in that window, both writers commit via atomic
  `tmp + rename` of the credential file, so no torn or partial file is ever
  observed. The refresh commit is a **compare-and-swap** against the refresh token
  it read under the lock, so a second writer in the double-hold window cannot
  resurrect a session a concurrent `remove` deleted nor clobber a fresh login - it
  declines to write when the on-disk record is no longer the one it refreshed from.
  The only remaining loss is the two writers double-spending one one-time-use
  refresh-token rotation (the loser gets `invalid_grant`), costing **at most one
  needless re-login**, which self-heals on the next refresh. We accept this bounded,
  self-healing edge instead of chasing perfect exclusion, which is unattainable
  without OS-auto-released advisory locks (`flock`/`fcntl`) that Node's standard
  `fs` does not expose and that we will not add a native dependency to reach.
- **No deadlock.** A crashed holder's lock is always broken within `LOCK_STALE_MS`,
  so no contender waits longer than one stale interval.
- **Single-flight preserved.** Absent the crash-recovery window, exactly one
  process holds the lock and therefore exactly one refreshes, so one-time-use
  rotation is never double-spent (the property LLP 0058 D5 needs).

## Consequences

- Net deletion: `lockHolderIsDead`, `stealLockIfAbandoned`, the `LOCK_OWNER`
  `{host, pid}` tag, and `LOCK_TIMEOUT_MS` all go; `withCredentialsLock` shrinks to
  an `O_EXCL` acquire loop plus a four-line `breakLockIfStale`. The `node:os` import
  is no longer needed; `node:crypto` is added for the nonce.
- One constant (`LOCK_STALE_MS`) with one job, derived from the bounded token call,
  replaces two constants that were in tension.
- The recovery semantics change is observable to exactly one test
  (`a write steals a lock abandoned by a crashed holder`), which is retargeted from
  a dead-PID steal to an age-stale steal (back-date the lock's mtime).
- Out of scope, tracked separately from this lock change: the missing `AbortSignal`
  on the MCP forward/rpc fetch, and `https` enforcement on the derived identity
  origin (both raised in the same review).

## References

- [LLP 0033](./0033-remote-query-attach.spec.md) (the `0600` query-scoped store)
- [LLP 0058](./0058-oidc-login-client.decision.md) D5 (single-flight refresh; this
  doc supersedes its recovery mechanism)
