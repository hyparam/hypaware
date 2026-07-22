# LLP 0129: The init wizard forks first, joins before picking, and re-runs scoped

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, CLI, Config
**Author:** Phil / Claude
**Date:** 2026-07-22
**Related:** LLP 0011, LLP 0031, LLP 0058, LLP 0063, LLP 0128

> Spawned by [LLP 0128](./0128-install-experience-overhaul.rfc.md) on
> acceptance. Amends [LLP 0011](./0011-setup-and-onboarding.decision.md):
> the first-run walkthrough gains a top-level pathway fork, and the
> returning-install gate's "managed installs drop Reconfigure" rule is
> revised.

## Decision

<a id="fork"></a>**The wizard's first question is the pathway fork**:
"Join a team" or "Local install and configuration". Both paths converge on
pick, configure, finale. An enrolled machine never sees the fork.

<a id="join-before-picker"></a>**The team path enrolls, then waits for the
org's config, then shows the picker.** The enrollment seed names only
`@hypaware/central`; the org's real config (pinned values, centrally named
clients) arrives with the daemon's first pull. The wizard narrates a
bounded wait (reusing the reconcile wait `runRemoteLogin` already
performs) and only then composes the picker, rendering central-named
entries checked and locked ("managed by your fleet",
[LLP 0031](./0031-layered-config.decision.md#status-provenance)
provenance vocabulary). On timeout or the no-org-config 404 steady state,
the wizard says so and shows an unlocked picker; nothing is pinned, so
free composition is correct. Showing the picker immediately after
enrollment was rejected: the picker would ask questions the org config is
about to override.

<a id="failed-join-returns-to-fork"></a>**A failed or abandoned join
returns to the fork.** Abandoning the browser flow is the decline
([LLP 0063 D3](./0063-login-auto-provision-forward-sink.decision.md#d3));
nothing is provisioned at that point. The wizard prints the failure with
its explained meaning (`no_membership` / `org_not_permitted` per LLP 0058
D7, vs a transient error) and re-presents the fork; the user decides
whether to retry, go local, or quit. Auto-degrading to the local path was
rejected: the wizard never switches pathway on the user's behalf.

<a id="returning-gate"></a>**The returning-install gate is amended.**
LLP 0011's "a centrally-managed install drops Reconfigure" predates
meaningful local additions
([LLP 0132](./0132-managed-local-additions-local-only.decision.md)). Now:

- **Managed machine**: the gate offers a scoped "adjust what this machine
  collects" entry: the picker with org rows locked and additions editable,
  plus configure for newly picked needs-setup items. No fork; the
  enrollment exit is `hyp leave`, never a wizard toggle (the LLP 0063
  connection ladder).
- **Solo machine**: Reconfigure re-enters the full wizard including the
  fork, because "my org adopted HypAware, join now" is the likeliest
  reason a working solo install re-runs `hyp init`.

Quit stays the default on a bare enter (0011's never-reconfigure-by-
accident rule, untouched).

## Consequences

- The join-before-picker wait is seconds to a minute and is narrated; it
  is what makes locked-row rendering truthful rather than aspirational.
- LLP 0011's prose is rewritten with the implementation (forward-pointer
  added now, per the LLP 0031 precedent).
