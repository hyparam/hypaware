# LLP 0498: Onboarding proceeds without waiting for org configuration

**Type:** Spec
**Status:** Active
**Systems:** Onboarding, CLI, Config
**Author:** Phil / Codex
**Date:** 2026-10-15
**Related:** LLP 0129, LLP 0223, LLP 0063

## Request

Remove the org-configuration waiting step from onboarding and greatly reduce
the client-attachment wait. Local sandbox measurements found a healthy join
took 4.41 seconds, an org with no clients took 32.32 seconds, and a config
server returning HTTP 500 took 92.31 seconds. The latter two spent their full
wait budgets after the daemon had already observed the relevant state.

## Org config

<!-- @ref LLP 0129#join-before-picker: replaces the requirement to wait before showing the picker -->
<!-- @ref LLP 0223: retains the applied-slot signal while removing the waiting requirement -->
After login, inspect the applied org-config state once. Do not poll, display
an applying-config spinner, or print a config-timeout message. If an applied
slot exists, preserve the existing central-owned picker locks and managed
annotation. A seed alone is still not an applied configuration.

Reuse the convergence helper with a zero timeout so an unreadable pointer
still emits its existing diagnostic. Keep the join span's `converged` and
`wait_ms` attributes for the single check.

This supersedes the waiting requirement in LLP 0129#join-before-picker and
LLP 0223, while retaining LLP 0223's applied-slot definition. A delayed org
config may override choices shown in the initial picker when it arrives;
that tradeoff is accepted to keep onboarding responsive. The daemon's pull,
apply, and central-over-local precedence remain unchanged.

## Client attach

<!-- @ref LLP 0063#login-config-pull: limits the existing best-effort attachment observation to three seconds -->
The login attachment wait, shared by onboarding and standalone remote login,
has a three-second default budget instead of thirty seconds. Keep the early
return when an attachment appears, the one-second polling interval, and the
standalone timeout hint. The daemon continues reconciliation after the CLI
stops waiting, and onboarding's finale still performs its own attachments.

This extends LLP 0063#login-config-pull. Gateway-bind waits for explicit client
attachment retain their existing budget because those callers require a live
endpoint before writing settings.
