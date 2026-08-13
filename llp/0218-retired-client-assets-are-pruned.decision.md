# LLP 0218: a retired client asset comes off the machine, on our own record of installing it

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
  and all four must hold: we recorded writing the path; the current plan does
  not contain it; it sits strictly inside that client's own asset directories
  (re-checked by `removeClientAssets`, whose input is persisted JSON either
  way); and the digest still matches.

  **The client scope is what landed, not what was asked for.** A run that copied
  nothing for a client cannot tell "these were retired" from "this boot never
  saw them" (a broken plugin set, a config activating nothing, a `--client`
  filter matching no contribution), and acting on the second reading would empty
  a working install. So a client with no successful copy this pass is not
  pruned at all. This is the guard that makes the whole mechanism fail safe.

- **An asset the user changed is no longer ours to delete**
  {#edited-assets-are-not-ours}: a digest mismatch stops the removal and turns
  it into a report naming the path on stderr and in the log. This is also the
  answer to "should the user own a HypAware-installed name they have since taken
  over?" - yes, and taking it over is exactly what the digest measures.

  The asymmetry with the copy is deliberate. Overwriting a *contributed* asset's
  hand edits is documented behaviour (`hyp skills install` is an idempotent
  replace, and the source is right there to re-copy from). A retired asset has
  no source left, so deleting an edited one is unrecoverable. Different
  recoverability, different rule.

- **Pruning is automatic, not confirmed** {#automatic-not-gated}: no prompt.
  Removing a byte-identical copy of a file HypAware itself wrote destroys
  nothing the user authored, and everything the user did author is already
  excluded by #edited-assets-are-not-ours, so there is no question left for a
  prompt to ask. It is also the only option that works: three of the four
  callers (the wizard finale, the reconciler's attach, an org-driven install)
  have nobody at a terminal, and a confirmation those paths must skip is a rule
  that holds on one call site out of four, which is the drift LLP 0138 collapsed
  four loops to prevent.

  **Automatic is not silent.** Every removal prints the kind, name, and path on
  stdout and emits `client_assets.pruned`; every withheld one prints and emits
  `client_assets.prune_withheld`. That is the reporting half
  [#660](https://github.com/hyparam/hypaware/issues/660) asked for ("deleting
  files a user can see, without saying so, is its own surprise").

- **The attach marker is a second evidence source, and it reaches backwards**
  {#marker-is-evidence}: `installed_assets` on a client's attach marker names
  destinations an org-driven attach wrote, unions them across every marker
  rewrite, and already drives a recursive delete on detach. A retired one of
  those is removable on exactly the evidence `hyp detach` removes it on. This is
  the only source that covers installs made by versions predating the ledger,
  which is why it is worth a second reader.

  It is **trustworthy but not complete**: manual `hyp skills install` and the
  wizard finale write no marker, which is the hole #ledger fills. A
  marker-sourced candidate carries no digest, so #edited-assets-are-not-ours
  cannot protect it; that is the same exposure detach has always had on the same
  paths, not a new one.

## Consequences {#consequences}

- **An org that withdraws a plugin now has its skills removed at the next
  attach**, where before they sat on disk until a detach. The marker keeps
  naming them (harmless: removal is forced and idempotent), so LLP 0138
  #marker-undo's union is unchanged and still load-bearing for the cases pruning
  cannot act on. `test/core/attach-endpoint-drift.test.js` asserted the old
  leave-behind and now asserts the removal.
- **Machines that installed a retired asset manually before this shipped keep
  it.** There is no ledger entry and no marker for those, and the only remaining
  criteria would be name-shaped guesses ("it starts with `hypaware-`"), which is
  precisely the evidence #660 ruled insufficient. Fleet machines self-heal
  through #marker-is-evidence; a stand-alone machine needs either one more
  install cycle (after which the ledger covers everything currently contributed,
  so every *future* retirement prunes) or a one-time migration keyed on digests
  of what we historically shipped. That migration is **not decided here**: it
  needs a shipped record of historical content digests, which is a real design
  question and a maintenance burden, and inventing it under a bugfix would be
  the heuristic this document exists to refuse.
- The install now hashes what it copied, once per copy. Skill trees are a few
  kilobytes; this is not on any hot path.
- A ledger that cannot be read or written costs a later prune, never an install.
  Unreadable reads as empty, which can only ever remove less.
