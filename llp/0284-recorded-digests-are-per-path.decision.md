# LLP 0284: a recorded digest is evidence about a path, not about one client's record of it

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, Plugins, CLI
**Author:** Claude
**Date:** 2026-08-19
**Related:** LLP 0219 (#edited-assets-are-not-ours: the condition this widens,
#ledger: the record it reads), LLP 0226 (#unreadable-is-not-absent: the last
narrowing of the same condition), LLP 0138 (#one-materializer: the module the
condition lives in)

> One widening of [LLP 0219](./0219-retired-client-assets-are-pruned.decision.md),
> found by the review of [#893](https://github.com/hyparam/hypaware/pull/893)
> and tracked by [#921](https://github.com/hyparam/hypaware/issues/921): the
> prune's fourth condition matches the bytes on disk against **every digest the
> ledger recorded for that path**, not only against the digest on the record
> whose client the pass is walking.
>
> @ref LLP 0219#edited-assets-are-not-ours [constrained-by]: widens "a digest we
>   recorded that still matches" from one client's record to every record naming
>   the path; see #digests-are-per-path.

## Context {#context}

LLP 0219 #ledger keys the client-asset ledger on `(client, dest)`, and says why:
one physical path legitimately belongs to two clients at once, because `claude`
and `claude-desktop` both declare `.claude/skills`, and collapsing the two
records would drop the only thing making a copy removable later.

The key is right. What it also does, and what nothing weighed, is give one
physical path two digest columns that are updated at different times. Every
install path is client-scoped, and #prune-on-materialize deliberately leaves a
client this run did not install for holding every record it had, untouched, on
the ground that "this pass learned nothing about it". About that client's
contributions it learned nothing. About the *bytes at that path* it learned
everything: it just wrote them.

So a `claude-desktop`-scoped install rewrites `~/.claude/skills/<name>` and
re-records only its own digest. The `claude` record for the same path keeps the
digest of bytes that are no longer on disk. When the asset is finally retired
everywhere and a `claude`-scoped run reaches it, #edited-assets-are-not-ours
asks that stale record whether the bytes are still ours, gets a mismatch, and
takes the report exit:

```
warning: retired skill '<name>' at ~/.claude/skills/<name> changed since
HypAware installed it; left in place - remove it by hand if you no longer
want it
```

Both halves of that are wrong. The asset stays on the machine, still
model-invocable, carrying whatever bug the retirement was for, which is exactly
the leave-behind LLP 0219 exists to end (#726, #660). And the message blames the
user for a rewrite HypAware made itself, in the one place a user has no way to
check the claim.

The window is reachable whenever two scoped runs write the same shared
destination in turn, which is an ordinary sequence: `hyp client attach claude-desktop`
after a `--client all` install, or two reconciler passes over two clients that
share a directory.

## Decision {#decision}

**The evidence gate matches the bytes against the set of digests the ledger
recorded for that destination** {#digests-are-per-path}, across every client's
record, rather than against the one record the candidate loop is carrying.

- **A digest is a fact about a path.** "HypAware wrote these bytes here" does
  not become a different claim depending on which client's row happens to carry
  it. Which row does is an artifact of the `(client, dest)` key that
  #prune-on-materialize needs for *candidacy*, and candidacy is a separate
  question from evidence: the four conditions still decide whether this client
  may act, and only the fourth changes what counts as proof.

- **No new evidence, and none re-recorded.** The widened set is read out of the
  ledger the prune already read. Nothing is written, no record is refreshed, and
  no digest is inferred from disk: the alternative fixes weighed for this window
  were refreshing a carried record's digest (which re-records evidence for a copy
  that client never made) and re-keying the ledger on `dest` alone (a format
  change to a file older versions read), and neither is needed to close it.

- **Absence of evidence is unchanged.** A destination no digest was ever
  recorded for still fails the gate and still takes the report exit with "has no
  recorded content digest, so nothing proves the bytes are ours". That keeps the
  attach marker demoted to a reporting source (#marker-is-evidence): the marker
  names paths and never bytes, so a marker-only candidate at a path no ledger
  row records has an empty digest set and cannot be removed on the marker's
  word. Where a ledger row does record the path, a marker-only candidate can be
  removed - but on that row's digest, never on the marker, which is the same
  evidence any other candidate needs.

- **The user's edit still outranks the retirement.** A file the user took over
  matches no recorded digest for its path, so it is still named and left in
  place. The widening can only ever move a candidate from "reported" to
  "removed" when the bytes on disk are bytes HypAware itself wrote.

## Consequences {#consequences}

- A shared destination that one client rewrote and another client's record went
  stale on is removed when it is retired everywhere, instead of surviving behind
  a warning that misattributes the rewrite.
- The stale record itself is left alone. It is dropped on the next pass that
  reaches it, by the ordinary "already gone" exit, so nothing has to reconcile
  the two rows.
- The prune holds one small map per run, built from the ledger it already read.
- The gate is now non-local: a record's own digest is no longer the whole of the
  evidence about its path. That is the point, and it is why the map is built
  once next to the keep-set rather than looked up per record.

## Open questions {#open-questions}

- **A kept destination is still not refreshed by the run that keeps it.** A
  client-scoped run that keeps a shared destination because another client still
  contributes it does not copy the current bytes there, so the copy ages while
  its source moves on. That is a question about what a scoped run *is* (making it
  copy every destination it keeps would have `hyp client attach claude` install
  contributions nobody asked it to install), not about what the ledger proves,
  and it is untouched here. The manual refresh exists: `hyp client skills install`
  defaults to `--client all`, and an explicit attach of the contributing client
  plans the destination.

- **A scoped run still judges candidacy on its own share of the plan.**
  `keepAll` is the whole run's plan, and a `--client claude` run's plan does not
  contain what `claude-desktop` contributes, so a shared destination only
  `claude-desktop` still contributes is a candidate under `claude`'s stale
  record. That predates this decision: with no intervening rewrite the digests
  agree and the copy is removed today. What changes is that an intervening
  rewrite no longer accidentally saves it, because the mismatch it used to
  produce was never evidence about the bytes in the first place. The fix belongs
  to candidacy, not to evidence: `keepAll` would have to be asked of every
  client's contributions rather than of the scoped plan, which is the same
  question as the open question above and is not settled here.

  **Superseded-by: LLP 0288** (#candidacy-is-asked-of-every-client): settled
  there. `keepAll` is re-planned with `clients: 'all'`, so candidacy asks
  every client's contributions and a scoped run no longer reads another
  client's live contribution as retired.
