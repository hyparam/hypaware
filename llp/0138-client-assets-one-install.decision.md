# LLP 0138: skills and subagents are one thing (client assets), installed by one command

**Type:** Decision
**Status:** Active
**Systems:** Onboarding, Plugins, CLI
**Author:** Kenny / Claude
**Date:** 2026-07-26
**Related:** LLP 0011, LLP 0044, LLP 0045, LLP 0100, LLP 0107
**Extended-by:** LLP 0219 (the same materializer also removes what this version no longer contributes; #marker-undo's "manual copies record no marker" is answered with an install ledger)

> Extends [LLP 0107](./0107-skills-ride-attach.decision.md), which decided
> skills ride attach but named only skills and was never implemented.
> Subagents are the same kind of thing as skills - a plugin-contributed file
> tree copied into a client's config directory - so they ride attach too, both
> materialize through one routine, and `hyp agents install` is removed in
> favour of `hyp skills install` doing both.
>
> @ref LLP 0107 [constrained-by] - the every-attach, reversal, and consent
> rules carry over unchanged; this doc widens what they apply to and lands them.

## Context

Three facts, discovered together:

1. **LLP 0107 was accepted and never implemented.** `runAttach` dispatches to
   the adapter's `attach()` and never touches skills; the reconciler's attach
   action had no notion of them. The only path that materialized anything was
   the wizard finale. So a machine enrolled by `hyp remote login`, or a client
   wired by a hand-run `hyp attach claude`, got capture and no helper skills,
   which is exactly the gap
   [LLP 0100](./0100-enrollment-privacy-review.spec.md)'s privacy-review flow
   depends on not existing.
2. **Subagents shipped as a parallel universe.** `ctx.agents.register`,
   `hyp agents install`, and an `agent_dir` manifest key arrived as a copy of
   the skill machinery. The two differ in the copy (a directory tree vs a
   single markdown file) and in which manifest key names the destination.
   Nothing else.
3. **The copy loop existed four times** - the two CLI commands and two more
   inline in the wizard finale - and had already drifted: the CLI tolerated a
   failed copy and warned, the finale threw; the CLI warned about a client with
   no directory for the asset kind, the finale skipped silently.

The user-visible question "why are these two commands?" has no answer that
survives contact with the code. The split is an implementation shape.

## Decision

**Skills and subagents are two shapes of one concept, a *client asset*, and
every path that installs one installs the other, through one routine.**

- **One materializer** {#one-materializer}: `materializeClientAssets` in
  `src/core/runtime/client_assets.js` owns which clients are targeted,
  containment, idempotent replace, tolerance of a bad contribution, and what
  gets reported. Only the copy itself branches on kind. Every caller routes
  through it: `hyp skills install`, the wizard finale, manual `hyp attach`, and
  the reconciler's attach action. Four loops that could drift became one that
  cannot.
- **One command** {#one-command}: `hyp skills install` installs both kinds.
  `hyp agents install` is **removed**, not aliased: a hidden second spelling
  preserves the confusion it was introduced to fix, and the command is recent
  enough that no muscle memory is worth the ambiguity. The registries stay two
  (`ctx.skills` / `ctx.agents`) because plugins register two shapes; only the
  *user-facing* surface unifies.
- **Attach installs, as LLP 0107 said** {#attach-installs}: manual
  `hyp attach <client>` and the reconciler's attach both materialize the
  client's assets, so "`hyp remote login` installs the skills" is finally true
  without a login one-shot. The standalone command remains the manual path for
  re-copying after a local edit, without re-attaching. *Every* attach exit
  materializes, including the one with nothing left to wire: on a
  daemon-managed install a client already attached at the live port
  short-circuits its settings write, and stopping there would mean
  `hyp attach` installs nothing on the install shape it is most often run on.
  The copy is idempotent, so the no-op attach costs a stat pass.
- **Currency is the asset set, not the endpoint** {#currency}: a `done` attach
  marker also records a digest of the assets that attach would copy, and a pass
  whose live registries produce a different digest treats the marker as stale,
  exactly as [LLP 0086](./0086-attach-tracks-ephemeral-port.decision.md) treats
  one recorded at a moved endpoint. Without it
  [LLP 0107 §currency](./0107-skills-ride-attach.decision.md#currency) does not
  hold: adding a plugin to central config restarts the daemon but returns a
  pinned (or LLP 0114 well-known) port unchanged, so an endpoint-only check
  calls every marker current forever and the org's later plugin never lands its
  skills on an already-enrolled machine. That is the scenario a login one-shot
  was rejected for. The digest is taken over the *plan* (kind, name, client,
  destination), sorted, so plugin load order cannot fake a change and a copy
  that failed does not re-attach every pass (#failure-is-not-fatal). It is
  derived from the same loop that does the copying, never from a second
  reimplementation of it (#one-materializer).
- **Install failure never fails the attach** {#failure-is-not-fatal}: the
  settings write applied; a copy that fails is a degraded install, warned in
  the daemon log. Marking the action `failed` would re-attach on every pass
  over a problem re-attaching cannot fix.
- **The marker is the undo record** {#marker-undo}: an org-driven attach records
  the destination paths it wrote as `installed_assets` on its action marker, and
  `reverse()` removes exactly those. This is what makes
  [LLP 0107 §reversal](./0107-skills-ride-attach.decision.md#reversal)
  implementable: reversal cannot be re-derived from the live registries (they
  describe what the plugin set contributes *now*, not what this attach copied),
  and it must not touch a user's own `hyp skills install` copies, which record
  no marker. `ActionHandler.reverse()` therefore receives the marker it is about
  to drop. The rule is "read the assets before dropping the marker", not "the
  reconciler reads the assets": the CLI drops the same markers outside the
  reconciler, so the read-then-remove lives in the one core undo
  (`detachClientViaCore`) next to the clear, not in a caller. `hyp detach` and
  `hyp leave` therefore both remove before they clear, both read the field
  through the same accessor (which lives with the marker store, since not every
  dropper is a handler), and both resolve the client's directories from the same
  home-directory fallback the reconciler's `reverse()` uses. And a `perform()`
  that fails after an earlier one succeeded carries `installed_assets` into the
  `failed` rewrite: the copies are still on disk, so the record of them has to
  outlive the status change, and it has to survive a *`done`* rewrite too: a
  re-`perform()` reports what that pass applied, which is a shorter list than
  the key's history the moment the desired set shrinks, so the marker unions
  rather than replaces. Which is also why the reconciler's reverse gap reverses
  such a marker rather than dropping it: `failed` normally means nothing was
  applied, and `installed_assets` is the evidence that something was.

  Closing that gap re-opens the retained-forever case it was left open for, and
  that is the accepted trade rather than an oversight. An `attach` reverse fails
  deterministically when the descriptor is gone or declares no `attachProbe`
  (#212), so a `failed` marker carrying assets for such a client now retries
  every pass instead of being dropped once. A retained `failed` marker is
  visible and harmless (only a `done` one blocks re-attach, #217); dropping it
  destroys the only record of files that are really there.

  **A removal that failed and one that was refused are different outcomes**
  {#refusal-is-not-failure}. Keep the marker for the first: an `fs.rm` that hit
  a lock or a permission may succeed next run, and dropping the record would
  strand files with nothing naming them. Do not keep it for the second: a
  containment refusal is pure string math over a recorded path and a fixed set
  of directories, so it re-refuses identically forever. A marker kept for it is
  an undo that can never finish, and a `done` attach marker whose settings
  effect is already reversed is the stale marker that blocks a later re-attach
  (#217). So the rule degrades to naming rather than to retention: print the
  paths for a human, then let the marker go. `hyp leave` on a client whose
  plugin is gone reaches the same place from the other direction (no descriptor,
  hence no directories to bound a recursive delete). Only the asset half
  degrades this way. A settings reversal cannot: nothing else on disk would own
  what it left written, so it keeps its marker even when it can never succeed.

  And because `installed_assets` is persisted JSON driving a recursive delete,
  both readers re-check each recorded path against the client's own asset
  directories first: the write side validates containment even though
  registration validated the name, and the delete side has the weaker input of
  the two. A client that resolves *no* asset directories refuses every recorded
  path, and says so as that rather than as a containment failure.

## Consequences

- `ActionHandler.reverse(requestKey, ctx, marker?)` gains a third parameter.
  Backfill (run-once, no reverse) is unaffected; attach is the only implementor.
- `ActionContext` / `ReconcileInput` carry the skill and agent registries,
  threaded by the daemon from `boot.runtime`. Absent on a CLI boot, so the
  install half of attach is inert by construction, like the rest of the client
  seam ([LLP 0045 §Part 1](./0045-client-attach.design.md)).
- A pre-0138 attach marker has no `installed_assets`, so a leave that reverses
  it removes nothing - the same outcome as a manual install. Self-healing: the
  next attach records the field. It has no `assets_key` either, which reads as
  stale and re-attaches it exactly once, recording both.
- The digest covers the asset *set*, not the asset *bytes*: a pinned-version
  bump that rewrites an existing skill in place without adding or removing one
  produces the same key, so the reconciler will not re-copy it. Covering bytes
  would mean hashing every contributed file inside a freshness predicate that
  must stay synchronous and disk-free. `hyp skills install` remains the way to
  force a re-copy, which is the role
  [LLP 0107 §every-attach](./0107-skills-ride-attach.decision.md#every-attach)
  already gives it.
- `ActionMarker` gains `assets_key`, and `isCurrent` now has two staleness axes
  rather than one. Re-attaching on either is safe because both halves of
  `perform()` are idempotent, but it does mean a plugin-set change costs one
  extra `attach()` call per affected client on the pass that notices.
- The finale keeps emitting one `skills.install` span covering both kinds
  (the release smoke battery asserts it); `agents.install` is gone.
- Behavior gained on the way: a contribution naming the literal client `all`
  now expands to every targeted client instead of warning about a client named
  `all`, and a client with no directory for an asset kind (Codex has skills but
  no subagents) is a silent skip rather than a warning no one can act on.
