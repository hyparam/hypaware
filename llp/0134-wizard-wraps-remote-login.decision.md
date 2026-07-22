# LLP 0134: The wizard's team path wraps `hyp remote login`; the token join never surfaces

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, CLI
**Author:** Phil / Claude
**Date:** 2026-07-22
**Related:** LLP 0025, LLP 0058, LLP 0062, LLP 0063, LLP 0100, LLP 0128

> Spawned by [LLP 0128](./0128-install-experience-overhaul.rfc.md) on
> acceptance.

## Decision

<a id="login-lane"></a>**"Join a team" is the login lane.** The wizard's
team path invokes the machinery of `hyp remote login` against the
built-in default remote
([LLP 0062](./0062-builtin-default-remote.decision.md)), inheriting
everything [LLP 0063](./0063-login-auto-provision-forward-sink.decision.md)
already decided: sink auto-provisioning, the login-minted gateway
credential, daemon install, the attach cascade, the one-enrollment-per-
machine gate, and the pre-auth consent notice. The wizard adds narration
and sequencing ([LLP 0129](./0129-init-wizard-fork.decision.md)), not a
second enrollment mechanism. The first-sync privacy hold and review
window ([LLP 0100](./0100-enrollment-privacy-review.spec.md)) ride
unchanged; the wizard surfaces the deadline and skill hint in its
narration.

<a id="no-token-join"></a>**The token join never surfaces in the
wizard.** `hyp join <url> <token>` stays script/MDM territory
([LLP 0025](./0025-remote-config-join-flow.spec.md#seed-config-mode)),
permanently: the wizard never asks anyone to paste a token (a fleet-wide
multi-use credential does not belong in an attended first-run prompt, and
the attended case is exactly what the login lane exists for).

<a id="custom-url-deferred"></a>**Custom server address is a deferred
follow-up.** Wizard v1 joins the default server only; self-hosted teams
use `hyp remote login <name>` by hand until a "my team runs its own
server, enter its address" prompt is added (the login machinery is
already server-agnostic, LLP 0058).

## Consequences

- The wizard contains no enrollment logic of its own; fixes and policy in
  the login lane (LLP 0063 and its server half) apply to the wizard for
  free.
- Zero typing on the happy path: the fork choice is the only input the
  team join needs before the browser opens.
