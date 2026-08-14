# LLP 0219: a retired client asset comes off the machine, on our own record of installing it

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, Plugins, CLI
**Author:** Claude
**Date:** 2026-08-13
**Related:** LLP 0138 (#one-materializer, #marker-undo: the module this extends and the half-record it left), LLP 0107 (#currency, #reversal: why attach re-runs and what reversal may touch), LLP 0142 (the retirement that is still installed), LLP 0212 (the retirement that motivated #726), LLP 0215 (#not-in-scope: named this gap and deferred it)
**Extended-by:** LLP 0223 (narrows #prune-on-materialize's condition three to a direct child, and splits #edited-assets-are-not-ours's "no digest" outcome into gone vs. unreadable)

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
  does not contain it; it is a direct child of that client's own asset
  directories (re-checked by `removeClientAssets`, whose input is persisted
  JSON either way; narrowed from "sits strictly inside" by
  [LLP 0223](./0223-prune-direct-children-and-unreadable-assets.decision.md)
  #only-direct-children); and a digest we recorded for it still matches what
  is on disk.

  The plan check is over the whole run, not over the one client's share of it,
  because a destination is a physical path and two clients can declare the same
  asset directory (`claude` and `claude-desktop` both declare `.claude/skills`).
  Asked per client, a path one client is contributing *in this very run* reads
  as another client's retired copy, and the run deletes the copy it just made.

  **Carrying a record forward asks the same question of the same plan.** A dest
  in the run's plan but not in this client's share of it is no candidate (the
  plan contains it) and, asked per client, nothing carries its record either, so
  the record is dropped while the copy stays on disk: permanently unprunable and
  unreportable, which is the leave-behind this whole mechanism exists to end. It
  is reachable whenever a dest changes hands between two clients sharing a
  directory and the new client's copy fails. So the carry is asked of the whole
  run's plan too. Two records for one dest under two clients is the price, and
  it is none: candidates are keyed by dest per client, `fs.rm` is forced and
  idempotent, and the ledger dedupes on `(client, dest)`.

  **The client scope is what landed, not what was asked for.** A run that copied
  nothing for a client cannot tell "these were retired" from "this boot never
  saw them" (an empty registry, a config activating nothing, a `--client` filter
  matching no contribution), and acting on the second reading would empty a
  working install. So a client with no successful copy this pass is not pruned
  at all.

- **A candidate must be a direct child of an asset directory**: condition
  three above narrows to exactly this shape. That narrowing changes what
  condition three decided rather than merely restating it, so it is recorded
  as its own decision in
  [LLP 0223](./0223-prune-direct-children-and-unreadable-assets.decision.md)
  #only-direct-children, minted from the ship review of
  [#745](https://github.com/hyparam/hypaware/pull/745)
  ([#746](https://github.com/hyparam/hypaware/issues/746) item 1).

- **A boot that did not reach its whole plugin set prunes nothing**
  {#incomplete-activation-prunes-nothing}: the scope guard above catches *total*
  failure, and total failure is not what a boot produces. Four routes take a
  selected plugin out of this boot's plan, and only the first leaves any trace
  in the activation results:

  1. **`activate()` threw.** `activatePlugins` catches per plugin, logs
     `plugin.activate_failed`, and continues; `bootKernel` counts the failures
     and returns normally.
  2. **The dep graph eliminated it** for an unsatisfied `requires`
     (`cap_missing`, `plugin_missing`, `cycle`). It is dropped from `finalOrder`
     and `activatePlugins` is never handed it. A capability-version bump across
     an upgrade takes exactly this shape: both skill-contributing bundled
     plugins declare `requires.capabilities: { "hypaware.ai-gateway": "^2.0.0" }`.
  3. **The boot profile withheld it** although the config enables it.
     `all-available` (what `hyp init` boots) drops every opt-in bundled plugin
     whatever the config says; `config` (what `hyp attach` and
     `hyp skills install` boot) honours it. So an enabled `@hypaware/gascity`
     contributes its skill on attach and contributes nothing on the next
     `hyp init`, while the client stays in scope because the client plugin's own
     skills still land.
  4. **Its manifest did not load**, so it never entered the pool at all.

  In every one of them the client stays in scope and the missing plugin's assets
  are absent from the plan in exactly the way a retired asset is. Nothing in the
  plan, the registries, or the ledger distinguishes them.

  So `bootKernel` returns **one** list, `unavailablePlugins`, covering all four,
  and the materializer is told and stands down: non-empty means copy as planned,
  remove nothing. One list rather than a derivation per call site, because the
  derivation the CLI and the daemon each reached for (filter the activation
  results for `ok === false`) answers only the first route, and a hole the
  stand-down cannot see is a file it deletes.

  The profile term is **intersected with what the config enables**, and that
  intersection is load-bearing. Unintersected, every ordinary `config`-profile
  boot would list the whole non-config pool and the prune would stand down
  forever. Intersected, `config` yields the empty set (so a plugin the user
  genuinely removed from the config still prunes) and `all-available` yields
  exactly the config-enabled names that profile dropped.

  The config side of that intersection is **the config as it was at boot**, and
  the wizard rewrites it mid-run: a user who hand-disables an opt-in plugin,
  runs `hyp init`, and re-picks it gets that plugin's skill pruned by the finale
  (the boot's `configEnabled` did not contain it) and re-installed by the next
  config-profile attach. Transient, self-healing, and only ever HypAware-written
  bytes, so it is accepted rather than fixed by re-deriving the set after the
  wizard writes ([#746](https://github.com/hyparam/hypaware/issues/746) item 4).

  Coarse on purpose. The finer rule (record the owning plugin per ledger entry
  and skip only that plugin's candidates) buys a partial prune on a broken boot,
  which is worth nothing next to being wrong on a delete path. Together with the
  scope guard, this is what makes the mechanism fail safe: each of the four
  routes a plugin can leave a boot's plan by ends in "prune nothing", never in
  "prune everything it cannot see".

- **A plugin that is not on the machine is retired, not withheld**
  {#uninstalled-is-retired}: recorded post-acceptance
  ([#746](https://github.com/hyparam/hypaware/issues/746) item 3) for a case the
  four routes above do not cover and were never meant to. Each of them is a way
  a plugin *present on the machine* leaves a boot's plan; a config-enabled
  plugin whose directory is **wholly absent** (an uninstall, a deleted install
  tree, lost plugin state) never enters the pool, so it is in neither
  `unloadable` (nothing failed to load) nor the withheld-by-profile term
  (nothing was there to withhold), and `unavailablePlugins` does not name it.
  Its ledgered assets therefore prune.

  **That is the intended reading**, not an oversight: an uninstalled plugin is a
  retired plugin, its assets have no source left on the machine to re-copy from,
  and what the prune takes is still only a byte-identical copy of what HypAware
  itself wrote there (#edited-assets-are-not-ours is unchanged and still gates
  it). Adding `configEnabled - pool` to `unavailablePlugins` would instead make
  every uninstall stand the prune down permanently, leaving exactly the
  model-invocable leave-behind this document exists to remove. Pinned by a test
  so it cannot drift silently.

  "Absent" also covers an install tree that is transiently absent (an
  unmounted volume, an interrupted upgrade), which this reading deletes and a
  later attach restores; accepted because the alternative never prunes after
  a real uninstall.

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

  "No recorded digest" is a fact about the *record*; "could not be read" is a
  fact about the *candidate itself*, and the two are split apart in
  [LLP 0223](./0223-prune-direct-children-and-unreadable-assets.decision.md)
  #unreadable-is-not-absent.

  **The digest separates shapes, not only bytes.** A skill is a directory and a
  subagent a single file, and hashing both into one unframed stream let the two
  spaces overlap: an empty directory and an empty file were both the hash of
  nothing, and a tree holding one `SKILL.md` of `body\n` hashed exactly like a
  file whose bytes are `SKILL.md\nbody\n`. Either collision hands a file the
  user wrote a digest that was recorded for something else, which is the one
  thing a match may never mean. So the shape is seeded into the hash before any
  content, each entry in the tree walk carries its own shape ahead of its path,
  and the prune additionally refuses any candidate whose shape on disk
  contradicts the `kind` its record names.

  The asymmetry with the copy is deliberate. Overwriting a *contributed* asset's
  hand edits is documented behaviour (`hyp skills install` is an idempotent
  replace, and the source is right there to re-copy from). A retired asset has
  no source left, so deleting an edited one is unrecoverable. Different
  recoverability, different rule.

  **The gate is check-then-act, and that residual is accepted**
  ([#746](https://github.com/hyparam/hypaware/issues/746) item 5). Between
  reading the digest and calling `fs.rm` there is a window in which an edit
  would be deleted despite the rule. It is inherent to checking a filesystem
  before writing to it, it is milliseconds wide, it is open only during an
  attach or an install, and it is open only on the exact path that run has
  already established is a retired asset whose bytes are still byte-identical to
  what HypAware wrote. Closing it would mean holding a lock over a user's
  `~/.claude` for the length of a prune, which buys less than it costs. Recorded
  here so a later review reaches this line rather than re-deriving it.

- **An unreadable asset is not an absent one**: reading a candidate produces
  three outcomes, not two - a digest, a path that is not there, and a path
  that is there but could not be read - and only the first two used to be
  told apart. That distinction changes what "no digest" was read to mean
  rather than merely restating it, so it is recorded as its own decision in
  [LLP 0223](./0223-prune-direct-children-and-unreadable-assets.decision.md)
  #unreadable-is-not-absent, minted from the ship review of
  [#745](https://github.com/hyparam/hypaware/pull/745)
  ([#746](https://github.com/hyparam/hypaware/issues/746) item 2).

- **Pruning is automatic, not confirmed** {#automatic-not-gated}: no prompt.
  What gets removed is a byte-identical copy of a file HypAware itself wrote,
  proven byte-identical against a digest HypAware itself recorded at the moment
  it wrote it. That destroys nothing the user authored - not because authored
  files are recognised and skipped, but because a file the user authored or
  edited cannot reach the removal at all: it has no matching recorded digest,
  it cannot acquire one by colliding across shapes
  (#edited-assets-are-not-ours), and #edited-assets-are-not-ours turns every
  such candidate into a report. So
  there is no question left for a prompt to ask. It is also the only option that
  works: three of the four callers (the wizard finale, the reconciler's attach,
  an org-driven install) have nobody at a terminal, and a confirmation those
  paths must skip is a rule that holds on one call site out of four, which is
  the drift LLP 0138 collapsed four loops to prevent.

  **Automatic is not silent, and not silent at any call site.** Every removal
  emits `client_assets.pruned` and prints the kind, name, and path on stdout;
  every withheld one prints and emits `client_assets.prune_withheld`; a
  candidate refused for sitting outside the client's asset directories prints
  and emits `client_assets.prune_refused`, because a record naming `/` or
  `$HOME` is the loudest evidence available that the install record is corrupt
  and swallowing it helps nobody. That is the reporting half
  [#660](https://github.com/hyparam/hypaware/issues/660) asked for ("deleting
  files a user can see, without saying so, is its own surprise").

  **Removals reach a caller as data, not only down `stdout`.** The wizard finale
  withholds `stdout` on purpose - a dozen path lines would bury the one fact its
  step reports - and prints counts instead. Reporting a deletion only by writing
  to `stdout` therefore makes the *one* call site with a human at the terminal
  the *only* silent one, while the candidates it declined to delete stay visible
  on stderr, which is the inversion of what anyone wants. So
  `materializeClientAssets` returns what it pruned and what it withheld
  alongside what it installed, and the finale prints
  `removed N retired skill(s) for <client>` next to its install counts.
  **Counts on the finale, paths everywhere else**: a wizard step summary needs
  the fact of a deletion, not a roster, and the roster stays on the span and in
  `client_assets.pruned`.

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
- **A boot that lost a plugin does less, never more.** A boot missing part of
  its plugin set - by a throw, a dep-graph elimination, a profile withhold, or
  an unloadable manifest - copies what it has and prunes nothing at all
  (#incomplete-activation-prunes-nothing), so a retirement that coincides with
  one is simply deferred to the next complete boot. The cost is that a real
  retirement is not taken off the machine while an opt-in plugin the config
  enables is being dropped by `hyp init`'s profile; a later `hyp attach` or
  `hyp skills install`, which boot `config`, does it.
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
