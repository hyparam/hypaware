# LLP 0179: The login lane returns its outcome; the wizard stops reading its prose

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Onboarding
**Author:** Phil / Claude
**Date:** 2026-08-03
**Related:** LLP 0058 (the D7 taxonomy), LLP 0134 (the wizard wraps the login lane), LLP 0135 (`classifyLoginFailure`), LLP 0129 (a failed join returns to the fork)

> The wizard classifies a failed join by substring-matching three
> exported English sentences out of the login lane's captured stderr.
> The login lane knows the refusal code exactly; it just throws it away
> at the command boundary. Return it instead.

## Context

[LLP 0134](./0134-wizard-wraps-remote-login.decision.md#login-lane) made
the wizard's team path *be* the login lane rather than a second
enrollment mechanism, and [LLP 0135](./0135-install-experience-overhaul.design.md)
gave it `classifyLoginFailure`, mapping the
[LLP 0058 D7](./0058-oidc-login-client.decision.md#d7) taxonomy to
`'failed' | 'abandoned'` for the fork prompt
([LLP 0129](./0129-init-wizard-fork.decision.md#failed-join-returns-to-fork)).

Both decisions were about *which mechanism enrolls*. Neither said how
the wizard should learn the outcome, and the implementation took the only
channel the mechanism offered. `runRemoteLogin` is written as a CLI
command: it returns a number and says everything else in prose. So the
wizard tees the login lane's stderr, and `classifyLoginFailure`
substring-matches three exported constants
(`LOGIN_NO_MEMBERSHIP_MESSAGE` and friends) against the captured text.

That makes user-facing English load-bearing. The sentences cannot be
reworded, localized, or wrapped without silently changing which fork the
wizard offers, and nothing in the type system says so. The information
being reconstructed is not lost or ambiguous: the loopback receiver
attaches the server's exact refusal code to the error as `callbackError`,
`explainLoginError` switches on it one frame below, and then the frame
above collapses it to an exit code.

## Decision

<a id="outcome"></a>**The login lane returns a structured outcome.**
`remoteLogin(argv, ctx, deps)` in `remote_commands.js` returns
`{ exitCode, reason }`, where `reason` is a `LoginOutcomeReason` code, not
a message: `'ok'`, the three D7 refusals (`'no_membership'`,
`'org_not_permitted'`, `'org_selection_required'`), `'denied'` for a
provider denial, `'login_failed'` for a transient or local failure
(timeout, network, an abandoned browser flow), `'usage'` for an argument
or unconfigured-target error, `'connected_elsewhere'` for the LLP 0063 D4
exclusivity gate, and `'store_failed'` / `'seed_failed'` /
`'enroll_failed'` / `'daemon_incomplete'` for the post-auth steps. Every
`return` in the browser and static paths names one.

<a id="cli-adapter"></a>**`runRemoteLogin` stays a `Promise<number>`.**
It is now a one-line adapter over `remoteLogin`. The CLI dispatch table
is uniform over commands that return an exit code, and a command surface
is exactly the place where an outcome *should* collapse to a number; the
seam moves inward rather than up.

<a id="no-prose-control-flow"></a>**Prose is for humans, codes are for
control flow.** `classifyLoginFailure` switches on `reason`. The three
message constants stop being exported API and go back to being strings
`explainLoginError` prints. The wizard keeps teeing stderr, because
`WizardJoinResult.detail` echoes the lane's own explanation to the user
([LLP 0135](./0135-install-experience-overhaul.design.md#join)) - that
use is narration, which is what captured prose is good for.

The classification is unchanged: exactly the three refusals are
`'failed'`; everything else non-zero stays `'abandoned'`. A provider
denial and a timeout remain retriable on purpose - the user can just try
again - so `'denied'` does not join the definitive set.

## Alternatives considered

**Extract a pure `enrollWithLogin()` core and reduce the command to
printing.** The tempting shape, and rejected for now: the login lane's
output is interleaved with its work by design, not by accident. The
consent notice must print *before* the browser opens
([LLP 0063 D3](./0063-login-auto-provision-forward-sink.decision.md)),
the first-sync hold message must print after the marker is on disk and
ahead of three different exits ([LLP 0101](./0101-first-sync-review-window.decision.md)),
and the forwarding line's wording is pinned by
[LLP 0100 R1a](./0100-enrollment-privacy-review.spec.md#requirements).
Hoisting all of it into a caller means re-deriving that ordering from a
result object, and the regression it risks is silent. The outcome return
solves the actual problem (a typed answer for the one caller that needs
one) without touching a single message.

**Have the wizard call `loginWithBrowser` directly.** It returns a
session and `callbackError` already, so no scraping - but it performs
none of the enrollment (session write, gateway seed, sink provisioning,
daemon install, attach wait). Using it would rebuild that in the wizard,
which is the second enrollment mechanism LLP 0134 forbids.

## Consequences

- Rewording a login message can no longer change wizard control flow.
  The three constants are internal again, so a reviewer no longer has to
  know that user-facing English is API.
- `LoginLaneResult` carries `reason` alongside `exitCode` and `stderr`.
  Test doubles that fabricate a lane result now name a reason instead of
  embedding a sentence in a fake stderr.
- `reason` is a wider vocabulary than the wizard consumes today
  (`'seed_failed'`, `'daemon_incomplete'`, ...). That is deliberate: the
  distinctions already exist as separate exits and separate messages, and
  naming them costs nothing where they are already branched.
- The command's own contract is unchanged: same exit codes, same output,
  byte for byte. This refactor is invisible from the terminal.

## References

- LLP 0058#d7 (the refusal taxonomy this stops re-deriving)
- LLP 0134#login-lane, LLP 0135#join (what the wizard is allowed to be)
