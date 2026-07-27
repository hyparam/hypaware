# LLP 0138: skills and subagents are one thing (client assets), installed by one command

**Type:** Decision
**Status:** Active
**Systems:** Onboarding, Plugins, CLI
**Author:** Kenny / Claude
**Date:** 2026-07-26
**Related:** LLP 0011, LLP 0044, LLP 0045, LLP 0100, LLP 0107

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
  re-copying after a local edit, without re-attaching.
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
  to drop.

## Consequences

- `ActionHandler.reverse(requestKey, ctx, marker?)` gains a third parameter.
  Backfill (run-once, no reverse) is unaffected; attach is the only implementor.
- `ActionContext` / `ReconcileInput` carry the skill and agent registries,
  threaded by the daemon from `boot.runtime`. Absent on a CLI boot, so the
  install half of attach is inert by construction, like the rest of the client
  seam ([LLP 0045 §Part 1](./0045-client-attach.design.md)).
- A pre-0138 attach marker has no `installed_assets`, so a leave that reverses
  it removes nothing - the same outcome as a manual install. Self-healing: the
  next attach records the field.
- The finale keeps emitting one `skills.install` span covering both kinds
  (the release smoke battery asserts it); `agents.install` is gone.
- Behavior gained on the way: a contribution naming the literal client `all`
  now expands to every targeted client instead of warning about a client named
  `all`, and a client with no directory for an asset kind (Codex has skills but
  no subagents) is a silent skip rather than a warning no one can act on.
