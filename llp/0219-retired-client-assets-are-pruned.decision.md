# LLP 0219: a retired client asset comes off the machine, on our own record of installing it

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, Plugins, CLI
**Author:** Claude
**Date:** 2026-08-13
**Related:** LLP 0138 (#one-materializer, #marker-undo: the module this extends and the half-record it left), LLP 0107 (#currency, #reversal: why attach re-runs and what reversal may touch), LLP 0142 (the retirement that is still installed), LLP 0212 (the retirement that motivated #726), LLP 0215 (#not-in-scope: named this gap and deferred it)

> Extends [LLP 0138](./0138-client-assets-one-install.decision.md), which made
> one routine own copying client assets and recorded, on the org-driven half
> only, which destinations it wrote. Copying turns out to be half of
> materialization: a version that stops contributing a skill deletes the source
> and leaves the installed copy running. This decides what evidence makes that
> copy safe to remove, and what happens when the evidence says it is no longer
> ours.

## Context {#context}

`materializeClientAssets` copies every registered skill and subagent into a
client's asset directories and has no removal step. Retirement therefore removes
the source and not the surface:

- `hypaware-sensitive-scan` was retired by
  [LLP 0142](./0142-privacy-surface-and-skill-discoverability.decision.md) on
  2026-07-29 and was still installed, still model-invocable, and still
  contradicting `hypaware-privacy` a week later
  ([#660](https://github.com/hyparam/hypaware/issues/660)).
- [LLP 0212](./0212-session-opt-out-is-a-cli-verb.decision.md) retired
  `hypaware-ignore` / `hypaware-unignore` / `hypaware-report`, and
  [LLP 0215](./0215-graph-always-active-and-merged.plan.md) retired
  `hypaware-graph`, adding five more cases
  ([#726](https://github.com/hyparam/hypaware/issues/726)). The installed
  `hypaware-ignore` still carries the stale `8787` port fallback and the missing
  LLP 0066 R9 caveat that were the stated reasons for retiring it.

**The hard part is never the delete; it is the evidence.** "No plugin declares
this name" is not evidence of ownership: a skill the user wrote by hand is
absent from the live registries in exactly the same way a retired one is. And
`~/.claude/skills/<name>` carries no provenance of its own. LLP 0138
#marker-undo already settled this for the org-driven half (the attach marker
records `installed_assets`) and said in the same sentence why the manual half
was out of reach: `hyp skills install` copies "record no marker".

## Decision {#decision}

**A client asset is removable only on HypAware's own record that it wrote that
path, and only while the bytes there are still the bytes it wrote.**

- **The materializer keeps an install ledger** {#ledger}: every path
  `materializeClientAssets` copies is recorded in
  `<HYP_HOME>/hypaware/client-assets.json` as `{kind, name, client, dest,
  digest}`, by every install path (`hyp skills install`, the wizard finale,
  manual `hyp attach`, the reconciler's attach action). This is the record
  LLP 0138 #marker-undo lacked for the manual half, and it lives with the one
  materializer for the same reason the copy does: a second writer of the same
  record is a second chance to disagree about what is ours.

  The ledger is **anchored on the home directory the assets went to**
  (`HYP_HOME`, else `<homeDir>/.hyp`), not on `os.homedir()`. Its entire content
  is paths under that home, so a run installing into one home must not resolve
  the record belonging to another.

- **Pruning happens where the copying happens** {#prune-on-materialize}: after
  the copy loop, any recorded destination for a client this run installed for,
  which this run's plan does not contain, is removed. Four conditions gate it,
  and all four must hold: we recorded writing the path; **the whole run's plan**
  does not contain it; it sits strictly inside that client's own asset
  directories (re-checked by `removeClientAssets`, whose input is persisted JSON
  either way); and a digest we recorded for it still matches what is on disk.

  The plan check is over the whole run, not over the one client's share of it,
  because a destination is a physical path and two clients can declare the same
  asset directory (`claude` and `claude-desktop` both declare `.claude/skills`).
  Asked per client, a path one client is contributing *in this very run* reads
  as another client's retired copy, and the run deletes the copy it just made.

  **The client scope is what landed, not what was asked for.** A run that copied
  nothing for a client cannot tell "these were retired" from "this boot never
  saw them" (an empty registry, a config activating nothing, a `--client` filter
  matching no contribution), and acting on the second reading would empty a
  working install. So a client with no successful copy this pass is not pruned
  at all.

- **An incomplete activation prunes nothing**
  {#incomplete-activation-prunes-nothing}: the scope guard above catches
  *total* failure, and total failure is not what the loader produces.
  `activatePlugins` catches per plugin, logs `plugin.activate_failed`, and
  continues; `bootKernel` counts the failures and returns normally. So the
  realistic fault is partial: one plugin activates, another throws, the client
  stays in scope, and the failed plugin's assets are missing from the plan in
  exactly the way a retired asset is. Nothing in the plan, the registries, or
  the ledger distinguishes them.

  So the materializer is told, and stands down: `failedPlugins` non-empty means
  copy as planned, remove nothing. Coarse on purpose. The finer rule (record
  the owning plugin per ledger entry and skip only that plugin's candidates)
  buys a partial prune on a broken boot, which is worth nothing next to being
  wrong on a delete path. Together with the scope guard, this is what makes the
  mechanism fail safe: every way a boot can come up short of its plugin set
  ends in "prune nothing", never in "prune everything it cannot see".

- **An asset the user changed is no longer ours to delete**
  {#edited-assets-are-not-ours}: the removal proceeds only on a digest we
  recorded that still matches. A mismatch stops it and turns it into a report
  naming the path on stderr and in the log. This is also the answer to "should
  the user own a HypAware-installed name they have since taken over?" - yes, and
  taking it over is exactly what the digest measures.

  **No recorded digest is not a match.** A candidate we have no digest for is a
  candidate we have no evidence about, and absence of evidence never reads as
  the evidence we wanted: it takes the same exit as a mismatch, a report. This
  covers the marker-sourced candidate (#marker-is-evidence), the record written
  by a copy whose digest failed transiently, and the record whose digest field
  is corrupt. A ledger entry whose `digest` is present but unreadable is dropped
  whole rather than kept digest-less, so corruption cannot even manufacture a
  candidate.

  The asymmetry with the copy is deliberate. Overwriting a *contributed* asset's
  hand edits is documented behaviour (`hyp skills install` is an idempotent
  replace, and the source is right there to re-copy from). A retired asset has
  no source left, so deleting an edited one is unrecoverable. Different
  recoverability, different rule.

- **Pruning is automatic, not confirmed** {#automatic-not-gated}: no prompt.
  What gets removed is a byte-identical copy of a file HypAware itself wrote,
  proven byte-identical against a digest HypAware itself recorded at the moment
  it wrote it. That destroys nothing the user authored - not because authored
  files are recognised and skipped, but because a file the user authored or
  edited cannot reach the removal at all: it has no matching recorded digest,
  and #edited-assets-are-not-ours turns every such candidate into a report. So
  there is no question left for a prompt to ask. It is also the only option that
  works: three of the four callers (the wizard finale, the reconciler's attach,
  an org-driven install) have nobody at a terminal, and a confirmation those
  paths must skip is a rule that holds on one call site out of four, which is
  the drift LLP 0138 collapsed four loops to prevent.

  **Automatic is not silent.** Every removal prints the kind, name, and path on
  stdout and emits `client_assets.pruned`; every withheld one prints and emits
  `client_assets.prune_withheld`; a candidate refused for sitting outside the
  client's asset directories prints and emits `client_assets.prune_refused`,
  because a record naming `/` or `$HOME` is the loudest evidence available that
  the install record is corrupt and swallowing it helps nobody. That is the
  reporting half [#660](https://github.com/hyparam/hypaware/issues/660) asked
  for ("deleting files a user can see, without saying so, is its own surprise").

- **The attach marker is a second evidence source, and it reports rather than
  deletes** {#marker-is-evidence}: `installed_assets` on a client's attach
  marker names destinations an org-driven attach wrote, and it is the only
  source that reaches installs made by versions predating the ledger. It names
  **paths, never bytes**, so a marker-sourced candidate has no digest and
  #edited-assets-are-not-ours withholds every one of them: the marker widens
  what gets *named*, never what gets *deleted*.

  That is not a limitation to route around; it is the only safe reading of what
  the marker is. LLP 0138 #marker-undo unions `installed_assets` across every
  rewrite and never shrinks it, so a path that appears there once is a candidate
  on every later attach and install, forever - including long after HypAware
  removed it, and long after the user wrote something of their own under that
  name. Detach may act on the same list destructively because a human asked for
  exactly that, once, now; a prune runs unattended, repeatedly, and would be
  acting on a name rather than on a file it can account for.

  The marker is also **not complete**: manual `hyp skills install` and the
  wizard finale write no marker, which is the hole #ledger fills.

## Consequences {#consequences}

- **An org that withdraws a plugin now has its skills removed at the next
  attach**, where before they sat on disk until a detach - for the assets the
  ledger recorded, which after this ships is every asset an attach installs. The
  marker keeps naming them (harmless: removal is forced and idempotent), so
  LLP 0138 #marker-undo's union is unchanged and still load-bearing for the
  cases pruning cannot act on. `test/core/attach-endpoint-drift.test.js`
  asserted the old leave-behind and now asserts the removal, on the ledger's
  evidence.
- **Anything installed before this shipped keeps its copy** - manual and
  org-driven alike. There is no ledger entry for those, and the marker, which is
  the only record that reaches them, cannot say whether the bytes at the path
  are still the ones we wrote (#marker-is-evidence). What those machines get is
  the *report*: the path is named on every install until someone acts on it. The
  remaining criteria for deleting it would be name-shaped guesses ("it starts
  with `hypaware-`"), which is precisely the evidence #660 ruled insufficient.
  Every machine needs either one more install cycle (after which the ledger
  covers everything currently contributed, so every *future* retirement prunes)
  or a one-time migration keyed on digests of what we historically shipped. That
  migration is **not decided here**: it needs a shipped record of historical
  content digests, which is a real design question and a maintenance burden, and
  inventing it under a bugfix would be the heuristic this document exists to
  refuse.
- **A boot that lost a plugin does less, never more.** A partial activation
  copies what activated and prunes nothing at all
  (#incomplete-activation-prunes-nothing), so a retirement that coincides with a
  broken plugin is simply deferred to the next clean boot.
- The install now hashes what it copied, once per copy. Skill trees are a few
  kilobytes; this is not on any hot path.
- A ledger that cannot be read or written costs a later prune, never an install.
  Unreadable reads as empty, and an unreadable record is dropped rather than
  kept without its digest, so both directions can only ever remove less.

## Open questions {#open-questions}

- **Can a fleet machine self-heal a pre-ledger install?** {#open-marker-self-heal}
  Not under this decision. #marker-is-evidence demotes the marker to a reporting
  source, so an asset installed before the ledger existed is named on every
  attach and removed by none of them. Restoring a self-heal needs the marker's
  `installed_assets` to *shrink* on a successful prune, so that a path leaves
  the candidate set once it has been acted on and cannot come back to condemn
  whatever the user later writes under that name. LLP 0138 #marker-undo settled
  that the list is a union that never shrinks, and it settled it for the undo
  path, which reads the same field. Changing it is a change to what LLP 0138
  decided and needs its own document, weighing what a shrinking
  `installed_assets` does to `hyp detach`'s completeness. **Not attempted here.**

  Recording a digest for a marker path on first sight and pruning on the next
  run is **not** the answer, and is explicitly rejected: run 1 records the
  digest of whatever is at the path, including a file the user authored, and run
  2 finds it unchanged and deletes it. It converts "we have no evidence" into
  "we have evidence", which is the one move this document exists to refuse.
