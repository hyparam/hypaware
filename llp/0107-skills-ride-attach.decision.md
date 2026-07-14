# LLP 0107: client skills are materialized by attach, owned by the reconciler

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, Plugins, CLI
**Author:** Phil / Claude
**Date:** 2026-07-13
**Related:** LLP 0011, LLP 0044, LLP 0045, LLP 0063, LLP 0100, LLP 0106

> Attaching a client installs that client's registered skills (and hooks),
> whoever triggered the attach: manual `hyp attach` and the org-driven
> [LLP 0044](./0044-client-attach-on-join.decision.md) reconciler alike. The
> reconciler re-materializes when the plugin or client set changes, and
> org-driven installs reverse on `hyp leave` under the existing marker
> discipline. This is what makes "`hyp remote login` installs the skills"
> true without a login one-shot.
>
> @ref LLP 0044 [constrained-by] - org-driven skill arrival lives inside the same consent-and-reversal perimeter as the settings edits attach already makes.

## Context

Skills are plugin-contributed (`ctx.skills.register`, per-client) and
materialized today only by `hyp skills install` or the first-run walkthrough
finale ([LLP 0011](./0011-setup-and-onboarding.decision.md)). The org-driven
attach cascade an enrolling login triggers installs hooks but not skills, so
a login-enrolled machine gets capture without the helper skills, including
the `hypaware-privacy` skill the review flow depends on
([LLP 0100](./0100-enrollment-privacy-review.spec.md)).

## Decision

**Skill materialization is part of attach, and the attach reconciler owns
keeping it current.**

- **Every attach installs** {#every-attach}: manual `hyp attach <client>` and
  the reconciler both materialize the client's registered skills and hooks.
  Attach means "wire this client into HypAware"; the walkthrough already
  treats attach-plus-skills as one unit, and manual attach skipping skills
  was the inconsistency, not the norm. No server contact is involved either
  way: skill bytes come from locally installed plugin packages, never from
  org config, so a manual attach on a never-enrolled box copies exactly what
  `hyp skills install` would.
- **Reconciler-owned currency** {#currency}: the reconciler re-runs
  materialization when the pulled config changes the plugin or client set,
  so a plugin the org adds months later lands its skills without anyone
  re-running login. A login one-shot was rejected for exactly this: it
  covers only the enrollment instant.
- **Org influence is plugin-granular, and that is the consent boundary**
  {#consent}: central config can name plugins (pinned versions), and plugins
  carry skills, so an org can cause new skills to appear over time. That
  rides the existing [LLP 0044](./0044-client-attach-on-join.decision.md) /
  [LLP 0036](./0036-central-config-driven-client-actions.decision.md)
  perimeter for org-driven installs; no new channel is created (org config
  still cannot author or modify skill bytes). The
  [LLP 0063 D3](./0063-login-auto-provision-forward-sink.decision.md#d3)
  pre-auth notice copy should name helper skills among the dotfile touches.
- **Reversal** {#reversal}: org-driven attaches record markers; `hyp leave`
  removes the skills they installed, exactly as it reverses settings edits.
  Manually attached skills carry no marker and stay. `hyp skills install`
  remains the standalone manual path, unchanged.
- **Enrolled-ness gates behavior, not presence** {#gating}: the
  `hypaware-privacy` skill and the classification hook are installed
  wherever their client attaches; the hook is inert unenrolled
  ([LLP 0106 #enrolled-only](./0106-session-start-classification-hook.decision.md#enrolled-only))
  and the skill's deadline framing simply does not arise without a pending
  first sync. Skills like `hypaware-ignore` are useful unenrolled, and one
  install rule beats per-skill carve-outs.

## Consequences

- "Login installs all the skills" becomes emergent: login provisions, the
  daemon pulls config, the reconciler attaches and materializes. Clients
  added later inherit the same treatment.
- The `hypaware-privacy` skill registers for **both** Claude and Codex in
  their respective client plugins, sharing one skill source; Codex users get
  the same review flow.
- Detach's manual form should leave manually installed skills alone;
  reversal is strictly marker-driven, or user-installed skills would vanish
  surprisingly.
