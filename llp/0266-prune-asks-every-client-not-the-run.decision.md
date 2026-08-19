# LLP 0266: the prune's plan check is asked of every client's contributions, not of the run

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, Plugins, CLI
**Author:** Claude
**Date:** 2026-08-19
**Related:** LLP 0219 (#prune-on-materialize: the condition this widens), LLP 0226
(#only-direct-children: the earlier narrowing of the same condition), LLP 0138
(#one-materializer: the module the condition lives in)

> One widening of [LLP 0219](./0219-retired-client-assets-are-pruned.decision.md),
> found by [#884](https://github.com/hyparam/hypaware/issues/884): the prune's
> second condition, and the carry-forward that asks the same question, are asked
> of what **every client contributes**, not of what **this run planned**.
>
> @ref LLP 0219#prune-on-materialize [constrained-by]: widens the plan check
>   and the carry from "the whole run's plan" to every client's contributions;
>   see #contributions-not-the-run.

## Context {#context}

LLP 0219 #prune-on-materialize gates a removal on four conditions, of which the
second is "the whole run's plan does not contain it", and says why it is asked
of the whole run rather than of one client's share:

> a destination is a physical path and two clients can declare the same asset
> directory (`claude` and `claude-desktop` both declare `.claude/skills`).
> Asked per client, a path one client is contributing *in this very run* reads
> as another client's retired copy, and the run deletes the copy it just made.

The invariant is right. The scope it names is not, because it assumes a run can
hold more than one client's share, and in practice a run never does. Every path
into `materializeClientAssets` is client-scoped: `hyp attach` and the daemon
reconciler pass a single client name, the wizard finale passes the clients the
picker selected. `planClientAssets` filters by that list, so "the whole run's
plan" is by construction the plan for the clients this run was scoped to and
contains no other client's contributions at all. The property LLP 0219 wanted
therefore held only under `--client all`.

The failure it leaves is the exact one LLP 0219 quotes, one run later rather
than in the same run. A skill declared by both `claude` and `claude-desktop`
whose `clients` narrows to `claude-desktop` alone still lands at
`~/.claude/skills/<name>`, but the next `claude`-scoped attach plans nothing for
that path, reads it as retired, and deletes it. Nothing puts it back: the
reconciler never attaches a probe-less client like `claude-desktop`.

The carry-forward has the same shape and the same reason. LLP 0219 settled that
it "is asked of the whole run's plan too" so that a dest which changed hands
between two clients sharing a directory is neither dropped from the ledger nor
left unaccounted for on disk; asked of a run that only ever holds one client,
it cannot do that.

## Decision {#decision}

**The plan check, and the carry-forward that asks the same question, are asked
of every client's live contributions** {#contributions-not-the-run}. The
keep-set is re-planned with `clients: 'all'` and the answer to "is this path
still contributed?" comes from that, not from the run's own plan.

- **Contributions, not clients in scope.** The question the condition asks is
  about a physical path, so it has to be asked of every client that could name
  that path, which is every client this machine has a descriptor for. Which
  clients the run was *asked to install for* is a separate fact and stays where
  LLP 0219 put it: it still decides which client's ledger records are eligible
  to be pruned, and #prune-on-materialize's "the client scope is what landed,
  not what was asked for" is untouched.

- **Re-planned, never re-derived.** The widened set comes from a second call to
  `planClientAssets` over the same live registries, not from a second loop that
  walks the contributions itself. A parallel reimplementation of that loop is
  the drift LLP 0138 #one-materializer collapsed four copies to prevent, and it
  would be that drift on a delete path. `planClientAssets` is documented
  side-effect free apart from the warnings it writes, so calling it twice costs
  a walk of the registries and nothing else. A run already scoped `'all'` reuses
  its own plan rather than planning twice.

- **The widened pass is silent.** It is planned without a `stderr`.
  `planClientAssets` already documents that an explicit client list "never warns
  about what it excluded", and this pass exists precisely to ask about the
  excluded clients: given a `stderr`, `hyp attach claude` would start printing
  warnings about a `claude-desktop` contribution nobody asked it to install.
  Those warnings belong to a run scoped to those clients, and `--client all`
  still surfaces every one of them.

- **Scoped runs still prune.** This widens what counts as contributed; it does
  not stand the prune down on scoped runs. A path no client's contributions name
  any more is still retired, and is still removed under `--client <one>`, on the
  same four conditions. Pinned by a test so that a later reading of "ask every
  client" cannot quietly become "never prune unless the run is `all`".

## Consequences {#consequences}

- A skill or subagent whose `clients` narrows to a client that shares its asset
  directory with another survives the next scoped attach, where before it was
  deleted by it and never re-installed.
- The keep-set no longer depends on which clients a run was scoped to, so
  `hyp attach claude`, the reconciler's attach, the wizard finale, and
  `hyp skills install --client all` all reach the same verdict about the same
  path. That is what makes the outcome independent of the order attaches happen
  in.
- The carry-forward keeps a record under a client that no longer contributes the
  dest while another client still does, which is two records for one path, which
  LLP 0219 already priced: candidates are keyed by dest per client, `fs.rm` is
  forced and idempotent, and the ledger dedupes on `(client, dest)`.
- Every install path plans the contributions twice. It is one more pass over
  in-memory registries per materialize, on a path that is already doing file
  copies and digests.

## Open questions {#open-questions}

- **A carried record's digest is never refreshed** {#open-stale-carried-digest}.
  A record carried forward for a client that no longer contributes a dest keeps
  the digest recorded when *that* client last wrote it, while the client that
  still contributes it rewrites the bytes on its own next install. When the
  asset is finally retired everywhere, the stale record's digest no longer
  matches disk, so #edited-assets-are-not-ours withholds the removal and reports
  "changed since HypAware installed it" about a rewrite HypAware made itself:
  the asset stays on disk and the message blames the user.

  The window predates this document (it is reachable on the pre-widening code
  whenever two scoped runs write the same shared dest in turn), and this
  widening makes it reachable by one more route. It is not closed here because
  both candidate fixes change what the ledger *is*: refreshing a carried
  record's digest re-records evidence for a copy this client did not make, which
  is close enough to the move #open-marker-self-heal explicitly rejects to need
  its own weighing, and keying the ledger on `dest` with a set of contributing
  clients is a format change to a file older versions read. Recorded here so
  that work starts from this paragraph rather than from a fresh diagnosis.
