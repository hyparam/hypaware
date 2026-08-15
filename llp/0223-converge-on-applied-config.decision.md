# LLP 0223: The join converge wait polls the applied org config, not client attaches

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, CLI, Config
**Author:** Phil / Claude
**Date:** 2026-08-13
**Related:** [LLP 0129](./0129-init-wizard-fork.decision.md) (§join-before-picker: the wait this decision re-grounds), [LLP 0031](./0031-layered-config.decision.md) (§physical-layout: the active-slot/seed layout the new probe reads), [LLP 0063](./0063-login-auto-provision-forward-sink.decision.md) (the login lane whose attach wait stays as it is)

> Extends [LLP 0129 §join-before-picker](./0129-init-wizard-fork.decision.md#join-before-picker):
> the bounded wait, its budget, and the timeout-means-unlocked-picker
> fallback all stand. What changes is the convergence signal the wait
> polls.

## Context

LLP 0129 prescribes a bounded wait for the org's config between the
join lane's enrollment and the picker, so the picker can render the
org-owned rows locked. As first implemented, `waitForCentralConverge`
wrapped the login lane's `waitForClientAttach`: "converged" meant at
least one client attach marker on disk.

An attach is *sufficient* evidence the org config landed (the daemon
only attaches after pulling and applying it) but it is not *necessary*.
Two common steady states never produce an attach marker:

- an org config that pins sinks, policies, or retention but names no
  client for this machine, and
- the no-org-config 404 steady state.

In both, the wizard burned the entire 60-second budget under the
"Applying your org's configuration..." spinner - on top of the login
lane's own 30-second wait over the very same markers - before falling
through to the unlocked picker. For the first state that is worse than
slow: the config *had* converged, often within seconds, and the rows it
owns were then rendered unlocked anyway.

## Decision

**"Converged" is the fact the join phase actually consumes: the daemon's
apply engine has committed a pulled org config to disk.** The probe is
the active-slot pointer under `config-control/`
(`hasAppliedCentralConfig`, a read-only wrapper over the same
active-slot read boot resolution uses). The pointer flips only when a
pulled document is applied (LLP 0031 §physical-layout), and boot's
central-layer resolution prefers the slot over the join seed, so the
layered resolution `computeCentralLockedSources` performs immediately
after the wait reads exactly the document that satisfied it.

Two deliberate non-signals:

- **The join seed is not convergence.** It exists the instant enrollment
  writes it and names only `@hypaware/central`, so treating it as
  converged would end the wait before the org's real config arrives and
  lock nothing while claiming a managed picker.
- **Attach markers are no longer consulted here.** The login lane's own
  attach wait is untouched: it answers a different question ("what is
  being captured?") for which the attach marker is the right signal.

## Consequences

- An org config that attaches no clients on this machine converges in
  roughly one pull-and-apply cycle instead of always timing out.
- A machine whose slot is already applied (a re-run) converges on the
  first probe.
- The 404 no-org-config steady state still runs to the timeout: nothing
  lands on disk for a probe to observe. Ending that wait early would
  require the pull loop to persist its 404 outcome cross-process; out of
  scope here, and the timeout fallback (unlocked picker, narrated) is
  already the correct answer for it.
- `waitForCentralConverge` returns `{ ok }`; the attached-names list it
  used to relay was never consumed by the join phase.

## References

- [LLP 0129](./0129-init-wizard-fork.decision.md) §join-before-picker
- [LLP 0031](./0031-layered-config.decision.md) §physical-layout
- [LLP 0063](./0063-login-auto-provision-forward-sink.decision.md)
