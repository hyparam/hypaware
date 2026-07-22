# LLP 0131: The configure phase drops on failure, resumes by re-run, and is attended-only

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, CLI
**Author:** Phil / Claude
**Date:** 2026-07-22
**Related:** LLP 0011, LLP 0025, LLP 0115, LLP 0128, LLP 0130

> Spawned by [LLP 0128](./0128-install-experience-overhaul.rfc.md) on
> acceptance. The wizard's configure phase runs each picked `needs_setup`
> entry's `configure_command`
> ([LLP 0130](./0130-declarative-picker-descriptors.decision.md)) after
> the picker and before the finale.

## Decision

<a id="drop-on-failure"></a>**Failure never strands the install; it
narrows it and names the catch-up command.** Steps are narrated one at a
time. A failed or cancelled configure drops that source from this run
with a printed escape hatch ("finish later with `hyp claude-desktop
install`"); the wizard continues with the rest.

<a id="idempotent-rerun"></a>**Configure commands are idempotent and
re-runnable.** Re-running skips already-done work, so bailing at a
privileged prompt and re-running later converges. This, not step
bookkeeping, is the resume mechanism. A `--print-commands` mode prints
the privileged commands for the user (or an MDM author) to run
themselves.

<a id="verify-is-a-hint"></a>**Verification that needs the user acting
inside an app** (Desktop: send a message to prove the route) is a
post-wizard hint, never a blocking step.

<a id="attended-only"></a>**The wizard is the attended lane; unattended
is MDM's.** Scripted installs stay presets / `--from-file` / `hyp join`
([LLP 0011](./0011-setup-and-onboarding.decision.md#non-interactive-entry),
[LLP 0025](./0025-remote-config-join-flow.spec.md#seed-config-mode)) and
never run configure commands: needs-setup surfaces on unattended fleets
are handled by MDM placement
([LLP 0115](./0115-claude-desktop-managed-config-attach.decision.md))
plus the per-user standalone command when a human is present. The wizard
gains no robot mode.

## Consequences

- One failure rule everywhere (the fork, the configure phase): the user
  always walks away with a working, possibly narrower, install and a
  named command to finish.
- Idempotency is a hard requirement on every `configure_command`, testable
  standalone.
