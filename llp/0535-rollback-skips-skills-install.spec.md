# LLP 0535: Rollback skips skills install

**Type:** Spec
**Status:** Accepted
**Systems:** Daemon, CLI, Plugins
**Author:** Phil / HypForge
**Date:** 2026-10-18
**Extends:** LLP 0457 #update-installs, LLP 0458 #attached-only
**Related:** LLP 0365, LLP 0534

## Request {#request}

LLP 0457 runs the installed package's `skills install` after every package
install that passes preflight, and LLP 0458 makes that `skills install
--attached`. The boot-failure rollback reuses the same `applySelfUpdate` path to
reinstall the replaced (older) package, and it skips that step. The skip was
recorded only in code annotations; this document records it as a decided,
permanent exception (issue #2426, decided 2026-10-06).

## Rollback skip {#rollback-skip}

When the rollback lane reinstalls the previous package, `applySelfUpdate`
restores and preflights it and then returns without running any skills install.
It logs `self_update.skills_install_skipped` with `reason: rollback`, and that
event is the whole explanation. No version cutoff, no probe of the older CLI's
flags, and no managed-asset refresh are attempted.

- Rollback runs only because boots are already failing. Adding a helper step
  there can only add a failure, and an older release may refuse `--attached`
  outright (it is the newer package's flag, LLP 0458), so the lane would report
  its own argument list as a failed step.
- The narrower exception is the whole of it. Ordinary successful upgrades keep
  `skills install --attached`, and explicit `hyp skills install` and attach keep
  their behavior.
- A capability or version gate on the skip (issue #2425) was declined.

## Cost {#cost}

Managed skills and agents written by the newer package can stay on disk while
the older code runs. The held version bounds which version is held, not how
long the mismatch lasts: it persists until an operator runs `hyp skills install`
or a later applicable upgrade installs again. Automatic refresh also stays
limited to attached clients, so clients without an attach marker need the
explicit command anyway; LLP 0534's status notice names those.

## Validation and cost {#validation}

The existing rollback test asserts the skip event, that the lane never asks for
`--attached`, and that no install failure is reported. No new runtime work: the
skip removes a child process from the rollback lane.
