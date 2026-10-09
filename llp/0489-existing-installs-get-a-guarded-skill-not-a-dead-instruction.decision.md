# LLP 0489: Existing Installs Get a Guarded Skill, Not a Dead Instruction

**Type:** Decision
**Status:** Accepted
**Systems:** Clients, Plugins, Onboarding
**Author:** HypForge designer
**Date:** 2026-10-09
**Extends:** [LLP 0480#enablement](./0480-fastask.design.md#enablement) (what enabling the plugin does for existing installs) and [LLP 0480#skill](./0480-fastask.design.md#skill) (the routing paragraph's guard); [LLP 0481](./0481-fastask.plan.md) task T14
**Related:** LLP 0479#req-skill (fall back to existing remote tools), LLP 0487, LLP 0488 (the shipped surface), LLP 0213 (graph guidance rides the query skill), LLP 0415 (grep's targeted config migration was not a general rule)

> LLP 0480#enablement said final enablement removes `@hypaware/fastask` from
> `V1_EXCLUDED_FROM_DEFAULT`. That activates nothing on an existing install:
> boot activates only the plugins the user's config lists. The same release
> updates the `hypaware-query` skill for every client, so an existing install
> would be taught `hyp query team-graph` while the command is unknown there,
> which is the half-working state LLP 0480 rules out.

## Decision {#decision}

- **The routing paragraph carries an availability guard.** In both
  `hypaware-query` copies, the team-history guidance says, in substance: if
  `hyp query team-graph` is not a known command on this machine, team-graph
  exploration is not enabled here; use the existing remote tools instead
  (`hyp query grep`, `hyp query sql` and `hyp query graph neighbors` with
  `--remote`; `hyp query evidence` belongs to the same plugin, so it is absent
  too), and tell the user once that
  rerunning `hyp setup` enables team-graph exploration. This is LLP
  0479#req-skill's own fallback for "no usable replica", so an existing
  install gets working tools and one clear enable hint, never a dead
  instruction.
- **The agent never runs `hyp setup` itself.** Setup is interactive and
  rewrites the user's install and client attachments; enabling a plugin is the
  user's choice. The skill only tells the user.
- **One deterministic check (T14).** A skill-content test asserts that both
  copies carry the guard, that the guard names only commands that exist without
  the plugin, and that no skill text tells the agent to run `hyp setup`. T13's
  chat matrix ran with the plugin enabled; the guard needs no new chat matrix.

## New installs {#new-installs}

New installs get the plugin through `compose_with` on `@hypaware/ai-gateway`
(the LLP 0213 route), which covers both the Claude and the Codex picks in the
`hyp setup` picker; the Claude client also has a literal init preset that
includes it. There is no separate Codex preset to change.
Release notes and user help tell existing installs to rerun `hyp setup` to
enable team-graph exploration.

## Deferred {#deferred}

**A targeted config migration** that adds the plugin to existing installs'
config (generalized from grep's migration) is a follow-up for the successor:
LLP 0415 records that grep's migration was not meant as a general rule, so
generalizing it needs its own decision and task. It is not built under the
HypForge drain.

## Consequences {#consequences}

- T14 (implementer-4): the guard in both skill copies, the guard test above,
  `compose_with` and the Claude init preset, and the release-note and help text.
- Corrected 2026-10-09 ~15:08Z with T14's implementer: the guard no longer
  names `query evidence` (a plugin verb), and only Claude has a preset.
- CPU and memory: none; skill text and configuration only.
