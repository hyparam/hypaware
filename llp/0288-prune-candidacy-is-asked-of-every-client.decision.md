# LLP 0288: retirement is a fact about a destination, so candidacy is asked of every client

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, Plugins, CLI
**Author:** Claude
**Date:** 2026-08-19
**Related:** LLP 0284 (#open-questions: the second open question, settled here),
LLP 0219 (#prune-on-materialize: the four conditions this one changes,
#automatic-not-gated: why a silent delete is the failure mode that matters),
LLP 0138 (#one-materializer: the module the condition lives in)

> The closing half of [LLP 0284](./0284-recorded-digests-are-per-path.decision.md).
> 0284 widened the prune's **evidence** to every digest recorded for a path; this
> widens its **candidacy** to every client's contributions, so a client-scoped
> run can no longer read another client's live contribution as retired.
>
> @ref LLP 0284#open-questions [constrained-by]: settles "a scoped run still
>   judges candidacy on its own share of the plan"; see
>   #candidacy-is-asked-of-every-client.
>
> @ref LLP 0219#prune-on-materialize [constrained-by]: restates the second
>   condition as "no client contributes this path any more", which is what its
>   own prose already claimed.

## Context {#context}

LLP 0219 #prune-on-materialize states its second condition as "the path is not
in this run's plan, **for any client**", and gives the reason: destinations are
physical paths, `claude` and `claude-desktop` both declare `.claude/skills`, so
one client's live contribution must not read as another's retired copy.

The implementation asked that of `planned`, the plan of the run that is
executing. Every install path is client-scoped: the reconciler's attach always
passes `clients: [client]` (`action_attach.js` `attachedAssetOptions`), and
`hyp skills install --client <name>` does the same by hand. So "for any client"
was in practice "for any client this run was asked about", which under a scope
of one is "for this client".

That gap was survivable only by accident. A shared destination that only
`claude-desktop` still contributes was already a candidate under `claude`'s
stale record, and 0219's fourth condition was the thing that stopped the
deletion: an intervening `claude-desktop` rewrite left the two records'
digests disagreeing, and the mismatch took the report exit. LLP 0284 correctly
removed that mismatch, because it was never evidence about the bytes. What it
left behind was candidacy with nothing standing behind it:

- Install a skill for `['claude', 'claude-desktop']`; both records name
  `~/.claude/skills/<name>`.
- The skill narrows to `['claude-desktop']` and its source moves on. A
  `--client claude-desktop` run rewrites the bytes and re-records only its own
  digest.
- A `--client claude` run reaches `claude`'s record for a path
  `claude-desktop` is contributing right now. The path is absent from *this*
  run's plan, the bytes match a digest recorded for it, and the copy is
  deleted.

Two things make that worse than a wrong call. Nothing re-copies it:
`claude-desktop`'s `assets_key` did not change when the skill left `claude`'s
plan, so `isCurrent()` still reports its attach fresh and the deleted asset
stays gone. And on the reconciler path the caller threads a warning sink but no
`stdout`, so the removal line goes nowhere: the delete is silent. That is
precisely the "`hyp init` deletes a skill and says nothing" failure LLP 0219
#automatic-not-gated exists to prevent.

## Decision {#decision}

**Candidacy is asked of every client's contributions, never of the scoped run's
share of them** {#candidacy-is-asked-of-every-client}. The keep-set is built by
re-planning with `clients: 'all'` against the same live registries the scoped
plan came from, so "retired" means "no client contributes this destination any
more" rather than "this pass was not asked to install it".

- **Retirement is a property of the destination, not of the pass.** A physical
  path is contributed or it is not. Which clients one invocation was scoped to
  decides what it *copies*; it has no bearing on whether some other client still
  needs the path to exist. Scope stays exactly where it belongs: the prune still
  only ever removes under a record of the client it is walking, and still only
  on evidence about the bytes (LLP 0284 #digests-are-per-path).

- **Conservative is the right direction for a delete path.** The change can only
  ever move a destination from "removed" to "kept". The kept record is carried
  forward by the existing not-landed carry loop, so nothing becomes unprunable:
  the next pass that runs after the last contributor drops the path finds it
  absent from the `'all'` plan and prunes it then, on the ordinary route.

- **No new inputs, no disk.** `planClientAssets` is synchronous and side-effect
  free apart from the warnings it writes, and the second call drops `stderr`
  because the scoped plan already wrote whatever warnings it had. The prune
  reads the registries it was handed and nothing else, so the freshness digest
  and the copy still come from the one loop LLP 0138 #one-materializer requires.

## Consequences {#consequences}

- A `--client X` run no longer deletes a shared destination client `Y` is
  actively contributing. Before LLP 0284 a digest mismatch usually saved it and
  misattributed the rewrite; after 0284 and before this, it was deleted in
  silence.
- The stale record for the non-contributing client is carried forward rather
  than acted on, and is dropped by the ordinary "already gone" exit once the
  path is retired everywhere and removed.
- `reconcileClientAssetLedger` no longer takes `planned`: the scoped plan was
  only ever used to build the keep-set, and the keep-set is no longer scoped.
- The prune plans twice per materialize, once scoped for the copy and once over
  every client for the keep-set. Both are in-memory walks of the registries.

## Open questions {#open-questions}

- **A kept destination is still not refreshed by the run that keeps it**, which
  LLP 0284 #open-questions already recorded and this does not change. A scoped
  run that keeps a shared path because another client contributes it does not
  copy the current bytes there. Making it copy would have `hyp attach claude`
  install contributions nobody asked it to install, which is a question about
  what a scoped run is. The manual refresh is unchanged: `hyp skills install`
  defaults to `--client all`.

- **A client that is contributed to but never attached still holds a path
  open.** The keep-set is built from contributions, not from attach state, so a
  skill declaring a client the user never attached keeps its shared destination
  alive. Detach removes its own copies through the marker (LLP 0138
  #marker-undo), so the path is reachable; whether an unattached client should
  count as a contributor for the prune's purposes is not settled here.
