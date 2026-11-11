# LLP 0596: `hyp sync --yes` ends the first-sync review window

**Type:** Decision
**Status:** Accepted
**Systems:** Sinks, CLI, Onboarding
**Author:** Brendan / Claude
**Date:** 2026-11-11
**Related:** LLP 0100, LLP 0101, LLP 0203, LLP 0345

> While the first-sync review window is open, `hyp sync --yes` used to refuse:
> only a `y` typed at a terminal could end the window early. An agent running
> setup for a person has no terminal to type into, so it could ask "upload now?"
> and then had no command that acted on the answer. `--yes` now releases the
> hold exactly as a typed `y` does.
>
> @ref LLP 0101#no-release [constrained-by] - replaces the `--yes` refusal; the rest of the release rule stands.

## Decision

<a id="yes-releases"></a>**An unscoped `hyp sync --yes` releases the hold.** It
prints the same plan, clears the marker, and exports, as the attended prompt
does on `y`. `--yes` means one thing whether or not a window is open: the caller
has already confirmed.

This supersedes the `--yes` bullet of
[LLP 0101 #no-release](./0101-first-sync-review-window.decision.md#no-release)
and the matching clause of [LLP 0100](./0100-enrollment-privacy-review.spec.md)
R2. Their reason was that a provisioning script is not a person. That stays
true, but the refusal also stopped the agent-assisted setup, where a person did
answer and the agent is only the hands. The CLI cannot tell those two callers
apart, and the hold is written only by an attended browser sign-in
(LLP 0101 `#which`), so a fully unattended fleet install never has a window to
release in the first place.

<a id="unchanged"></a>**What does not change.**

- A named instance (`hyp sync <instance>`) still refuses while the hold is
  live, with or without `--yes`: the hold is driver-wide and that plan is not.
- `hyp sync --history <client>` still cannot release or bypass the hold
  ([LLP 0345](./0345-explicit-client-history-replay.decision.md)).
- A non-interactive `hyp sync` without `--yes` still refuses.
- The daemon still never releases on its own, apart from the organization
  setting of [LLP 0578](./0578-org-controls-first-sync-hold.decision.md).

<a id="guide"></a>**The setup guide asks, then runs it.** The last step of
`hyp setup --guide` is a multiple-choice question: upload now, or wait for the
deadline (with or without a review). Choosing "Upload now" is the person's
permission, and only then does the agent run `hyp sync --yes`. The answer is
the consent; the flag carries it.

## Consequences

- Any script or agent that runs `hyp sync --yes` on a machine inside its window
  ends the window. Documentation that suggests `hyp sync --yes` as a routine
  flush (the Cursor Cloud collector hint, for one) now has that effect on a
  newly enrolled machine.
- The `sync.first_sync_hold_released` log line carries `hyp_confirmed_by`
  (`prompt` or `yes-flag`), so a release by flag stays distinguishable after the
  marker is gone.
- The held no-destinations message gives every caller the same advice, since
  the plain rerun now works with `--yes` too.
