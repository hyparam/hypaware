# LLP 0523: Client-action markers are written under a per-key lock and a brief store lock

**Type:** Decision
**Status:** Accepted
**Systems:** Config, Daemon, CLI
**Generated-by:** neutral
**Author:** HypForge steward
**Date:** 2026-10-17
**Extends:** [LLP 0041](./0041-central-config-client-actions.design.md)
(#idempotency-and-completion-state: the marker file is still one atomically
written JSON file, but it now has writers in more than one process, so no
writer may write it from a copy it read earlier),
[LLP 0045](./0045-client-attach.design.md) (Part 3: the reconciler's
`reverse()` and the manual `hyp detach` share one undo; they now also share a
lock around it)
**Related:** LLP 0065 (#d1), LLP 0138 (#marker-undo), LLP 0186, LLP 0250,
hyparam/hypaware#224, hyparam/hypaware#217

## Context {#context}

LLP 0041 placed the client-action markers in one file,
`config-control/client-actions.json`, written by tmp+rename. When it was
written the daemon's reconciler was the only writer. Since then the CLI writes
it too: `hyp detach` and `hyp leave` clear an attach marker (#217), and
`hyp attach` re-arms a refused one (LLP 0186). Each write was atomic but
unlocked, and the reconciler wrote its whole snapshot back at the end of a
pass. A pass that read the store, spent minutes in a backfill, and then wrote
its snapshot put back an attach marker that a `hyp detach` had cleared in the
meantime, which is the #217 stuck state returning by a race (#224). Two CLI
writers racing each other could lose an update the same way, and an attach in
flight could commit a `done` marker after a detach had already reversed the
settings it describes.

## Decision {#decision}

- **Two locks** {#two-locks}: every write to a reversible effect and its
  marker happens under a per-key lifecycle lock,
  `config-control/client-action-locks/<kind>-<requestKey>.lock` (both parts
  URI-encoded). Whoever holds it (the reconciler's forward attach and reverse,
  `hyp attach`, `hyp detach`, `hyp leave`) holds it across the effect *and*
  the marker commit, so the marker never disagrees with the disk it describes.
  The marker file itself is changed only under a second, brief store lock,
  `config-control/client-actions.json.lock`, held for one synchronous read and
  one atomic write. The order is key lock, then store lock, never the reverse,
  and neither is reentrant. Keys are independent; there is no global lock. A
  run-once handler (backfill) takes no key lock: no command writes its markers,
  and its effect is a long import that would outlive the stale age. Its commit
  still takes the store lock.
- **Merge, not snapshot** {#merge-not-snapshot}: a pass reads the store once to
  decide what to skip, and never writes that copy back. Each commit re-reads
  the store under the store lock and replaces or deletes only its own key. A
  reversible action re-reads its marker after taking the key lock and decides
  the skip again, because another process may have changed it while this pass
  waited. A commit builds its carry-forward (`installed_assets`, `prior_done`,
  `attempts`) from the marker as it is at commit time, so an undo record
  another process wrote is never dropped (LLP 0138 #marker-undo, LLP 0250).
- **Detach reports the marker** {#detach-reports-the-marker}: a detach whose
  settings reversal succeeded but whose marker clear failed now fails, with a
  message that names the marker and says to re-run the detach. It was
  best-effort before. A marker left `done` makes a later join skip the
  re-attach, which is the #217 failure, and with the clear now behind a lock a
  failure is a real condition (a lock not acquired, an unwritable store), not
  a blemish. `hyp leave` counts the same failure in its exit status.
- **Bounded wait** {#bounded-wait}: both locks are LLP 0065 D1 locks: granted by
  `O_EXCL` create, released by nonce, broken by age once a holder is older
  than the stale age (60 seconds), with a deadline of twice that. A holder
  killed mid-section therefore costs the next caller at most a stale age, never
  a wedged daemon start or attach. The first time a key lock is found held the
  caller says so: the CLI prints that it is waiting for another hyp process on
  that client, and the reconciler logs `client_action.lock_wait`.
- **A dry run takes no lock** and creates no lock file.

## Consequences {#consequences}

- A `hyp detach` that runs while the daemon is attaching the same client waits
  for the attach to commit, then reverses it. The two can no longer interleave.
- The reconciler pass no longer has a single end-of-pass write. A pass that
  changes nothing still writes nothing and takes no store lock.
- A holder suspended (not killed) for longer than the stale age can lose its
  lock to a second holder, the trade LLP 0065 already accepts. Commits re-read
  under the store lock, so the store itself stays consistent; only the
  effect-to-marker ordering for that key is exposed.
- Lock files live under `config-control/` at mode 0600 in a 0700 directory, and
  are removed on release.

## Testing {#testing}

`test/core/action-marker-lock.test.js` runs the competing writers as separate
node processes against the real store, held at a stdin barrier: a pass that
read the store before a detach or re-arm, an attach in flight against a detach
of the same client, concurrent removals of different keys, a SIGKILLed holder
of the key lock and of the store lock, and the carry-forward of assets another
process committed while a pass waited.
