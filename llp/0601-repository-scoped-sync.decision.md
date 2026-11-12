# LLP 0601: An organization can limit uploads to its own repositories

**Type:** Decision
**Status:** Accepted
**Systems:** Sinks, Usage-Policy, Config, Privacy
**Author:** Kenny / Claude
**Date:** 2026-11-11
**Related:** LLP 0031, LLP 0032, LLP 0070, LLP 0103, LLP 0105, LLP 0188, LLP 0367, LLP 0578

> On an enrolled machine everything that is not opted out is uploaded
> ([LLP 0188](./0188-enrolled-default-sync-with-client-optout.decision.md),
> [LLP 0103](./0103-machine-local-policy-classes.decision.md)). That is the
> right default for an organization that wants the whole picture, and the wrong
> one for a person who also uses the laptop for side projects: the burden is on
> them to find and mark every personal folder. A new config key, `sync_repos`,
> turns the default around for organizations that choose it. Only sessions
> recorded in the listed repositories leave the machine. Everything else is
> still recorded and stays local.
>
> @ref LLP 0070#enforce [constrained-by]: one more verdict at the shared export read, derived at export time, no cache-schema change.
> @ref LLP 0188#rule [constrained-by]: the everything-syncs default is unchanged for any machine whose config does not set the key.

## Decision

<a id="config"></a>**`sync_repos` is a top-level list of repository prefixes.**
Each entry is `host/owner` (every repository of that owner) or
`host/owner/repo` (one repository), for example
`["github.com/acme", "github.com/partner/shared"]`. Entries are lowercased.
Absent means every repository syncs, as before. An empty list is a
validation error, so a typo cannot silently stop every upload. The
organization's list wins; a local list applies only when the organization set
none, so a person with their own sink can use the same rule.

The list names owners, not just repositories, on purpose. A per-repository
list would put the name of every private repository on every enrolled laptop
and would leave a new repository unsynced until someone updated it.

<a id="rule"></a>**A row is uploaded only when its repository is under an
allowed prefix.** The check is one more per-row verdict in
`storage.readRowsSince`, beside the directory and client rules, with the same
drop-but-advance semantics. Enforcement is on the machine: rows outside the
list are never sent, so the promise does not depend on the server. A row
whose repository cannot be determined is withheld. That covers a session in
a folder that is not a repository and a repository with no `origin` remote.

<a id="evidence"></a>**The recorded remote decides first, the directory
second.** `ai_gateway_messages` already carries `git_remote`, captured by git
when the session ran ([LLP 0032](./0032-github-llm-graph-bridge.decision.md)).
When a row has it, it is the evidence. When it does not (older rows, adapters
that do not capture it), the seam reads the `origin` remote of the repository
the row's `cwd` is in, from that repository's git config, memoized per
directory. A deleted worktree still resolves through its surviving parent
clone. Only `origin` is consulted either way.

<a id="explicit-sync"></a>**An explicit `sync` marking wins.** A directory
the person marked with `hyp privacy set <dir> sync` is uploaded whatever its
repository. This is how work that lives outside a repository, or in a
repository that has not been pushed yet, is shared: the person says so. The
other direction is unchanged: `.hypignore`, `local-only`, session ignore, and
client opt-outs still withhold inside an allowed repository.

<a id="visible"></a>**The list in force is shown.** `hyp status` names the
allowed prefixes, in text and in JSON (`usage_policy.sync_repos`). The list
is the organization's to set, which means an administrator could add a
personal owner to it. Showing it on the machine is what lets a person check
the claim instead of trusting it.

<a id="query-seam"></a>**Rows the allowlist keeps local are `local-only` to
queries.** [LLP 0105](./0105-query-seam-local-only-visibility.decision.md)
lets content surface only in a context at least as non-exported as the
content, and a row withheld by this key is exactly as non-exported as a
`local-only` one. So the resolver the query seam consults is wrapped: a
directory nothing else governs, in a repository outside the list, resolves
`local-only`. The lattice is unchanged. A session in an allowed repository
is `full` and cannot read rows from outside the list into its uploaded
transcript. A session outside the list is itself `local-only`, its
transcript stays on the machine, and it reads everything. A caller with no
known directory is treated as uploaded, as before. Rows are judged by the
same evidence in the same order as at the export seam, recorded remote
first, so the two seams agree row for row; the SQL filter and the grep walk
both read `git_remote` beside `cwd` for that. `--include-local-only`
overrides, as it does for `local-only`.

## Reach {#reach}

The rule applies to rows that carry a `cwd` or a `git_remote`. A row with
neither passes through to the other seam rules, which is the same reach
`local-only` has ([LLP 0070](./0070-local-only-export-seam.decision.md)).
Datasets with no session directory (OTel logs, traces and metrics, GitHub
and Linear activity, the projected graph) are therefore not narrowed by this
key. The GitHub source narrows on its own, because its repository inventory
is built from rows the export seam would send
([LLP 0367](./0367-observed-repos-revalidate-against-withholding.decision.md)),
and the export-policy fingerprint now includes the list so that inventory is
re-derived when the list changes.

## Consequences

- A withheld row is passed for good: the sink's watermark moves across it. A
  repository that gains an allowed `origin` later uploads its sessions from
  that point on, not its history. Replaying retained history is the explicit,
  consent-gated path of
  [LLP 0345](./0345-explicit-client-history-replay.decision.md).
- A personal fork of an organization repository has a personal `origin` and
  stays local. An organization's fork of an outside project is uploaded.
- A remote written through an SSH host alias (`github-work:acme/tool`) does
  not match `github.com/acme`. The person marks the directory `sync`, or the
  organization lists the alias.
- The first-sync review, `hyp sync` previews, and the privacy skill's
  "what will ship" counts all read through the same seam, so they report the
  narrowed set without change.
- The server validates saved organization configs with this package's schema,
  so it has to depend on a release containing this key before an organization
  can save it. Deriving the list from an organization's GitHub connection is
  server work and is not part of this change.

## Not decided here {#open}

- **Datasets outside the reach above.** Narrowing them needs a join from a
  row to its session's repository, the same gap
  [LLP 0192](./0192-unattributed-rows-escape-optout.issue.md) describes for
  client opt-outs.
- **Whether this becomes the default for new organizations.**
