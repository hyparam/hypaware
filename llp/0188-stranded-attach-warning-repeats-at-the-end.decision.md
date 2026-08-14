# LLP 0188: The stranded-attach warning repeats where the run ends

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, CLI, Clients
**Author:** Brendan / Claude
**Date:** 2026-08-05
**Related:** LLP 0185 (an unpicked client is named, not detached; this doc is its `Extended-by`), LLP 0135 (the wizard's closing sequence), LLP 0100/0101 (the privacy narration), LLP 0086 (the attach drift diagnostic)

> [LLP 0185](./0185-unpicked-client-stays-attached.decision.md) put the
> stranded-attach warning in the finale, before the daemon restart. It is
> still there. But `hyp init` writes about seventy more lines after the finale
> returns, so on a real terminal the warning is not on screen when the run
> ends, and the user who does not scroll back never reads it.

## Context {#context}

`runPickerFinale` prints the warning and returns. What happens next depends on
which entry point called it:

- `runPickerWalkthrough` writes its short run summary and stops. The warning
  is within a handful of lines of the last thing on screen.
- `runInitWizard` writes the run summary, then `runWizardFirstLook` (roughly
  sixty lines of real query output, by its own design in
  [LLP 0135 §first-look](./0135-install-experience-overhaul.design.md)), then
  on the team path the privacy narration. Nothing pauses between them.

So the same print is prominent on one path and buried on the other. It is
buried worst exactly where it is needed most: on a managed host,
[LLP 0185 §status-backstop](./0185-unpicked-client-stays-attached.decision.md#status-backstop)
gates the `client_attached_not_configured` diagnostic to hosts with no central
layer, so the finale's print is the *only* signal a wizard-attached client the
reconfigure run left unpicked ever gets. A joined host has no backstop to
scroll back to.

The obvious repair, echoing `finaleSummary.attachedNotConfigured` from
`writeWalkthroughRunSummary`, is wrong twice over. That function is shared by
both entry points, so `runPickerWalkthrough` would print the same warning
twice within a few lines of itself, and the wizard would still bury the echo
under the first look, which is the whole complaint.

## Decision {#decision}

<a id="repeat-at-the-end"></a>**The finale's print stays where it is, and the
caller that buries it repeats it at its own end.** LLP 0185's placement is
unchanged: the finale still names the stranded clients after the config write
and before the daemon restart. `runInitWizard` additionally writes a short
repeat after the first look and before the privacy narration, naming the same
clients and the same `hyp detach --client <name>` lines.

The repeat is the *caller's*, not the shared run summary's, because only the
caller knows whether anything came between. `runPickerWalkthrough` prints
nothing substantial after the finale, so it does not repeat, and no path
prints the warning twice on one screen.

<a id="when"></a>**The repeat is conditional on the closing sequence having
written something, and that fact is measured rather than inferred.**
`runWizardFirstLook` reports `wrote` beside `shown`, counted at the writable
the step writes through, and the wizard gates on `wrote`.

The two are different questions, and every wrong version of this gate has been
an attempt to answer the first with the second. "The first look ran" is too
wide: the step is documented to degrade rather than fail a finished install
([LLP 0135 §first-look](./0135-install-experience-overhaul.design.md)), and an
unregistered dataset, an unreadable cache or a render that throws leave an
attended run that attempted the block and printed none of it, so nothing
buried the finale's print. "The block rendered" is too narrow: an expired
deadline with nothing renderable prints two lines saying the look was skipped
and reports `shown: false`, and those lines bury the finale's print exactly as
a full render would. On a managed host that is the run where the repeat
matters most, because §status-backstop of
[LLP 0185](./0185-unpicked-client-stays-attached.decision.md#status-backstop)
gates the mirror diagnostic off there.

Measuring closes the class rather than the instance. A skip reason added later
is counted by the same writable, so it carries its own answer instead of
requiring this gate to be revisited, and a caller that wants "does the user
have their numbers" still reads `shown`.

That single condition covers the team pathway as well, because a pathway is
only ever resolved on an interactive run, so a team run that is neither
cancelled nor a dry run has already run the first look and repeats on what it
wrote. Widening the condition
to "or the pathway is `team`" on the theory that the privacy narration follows
would admit only the runs where the first look did *not* run, and those are
exactly the runs that wrote nothing between the finale and here: the repeat
would land a few lines under the print it repeats, which is the same double
print the shared run summary was rejected for.

So a scripted `--yes` or `--dry-run` wizard run stays on the single finale
print and its output is unchanged, matching the attended-only rule
([LLP 0131](./0131-configure-phase.decision.md)), and so does an interactive
run cancelled at the backfill consent, whose summary is all that follows the
finale.

<a id="shorter"></a>**The repeat is shorter than the original.** The first
print explains the consequence in full; repeating that paragraph verbatim
reads as a bug rather than a reminder. The repeat carries only what a user
acts on: the client names and one `hyp detach --client <name>` line each. Both
prints share the dry-run tag rule the rest of the finale uses.

<a id="narration-stays-last"></a>**The privacy narration is still the last
words on the team path.** The repeat goes before it, not after
([LLP 0135 §first-look](./0135-install-experience-overhaul.design.md),
LLP 0100/0101). Seven lines of narration is a reminder that survives on one
screen; sixty lines of query output is not, and that is the difference this
decision turns on.

## Consequences {#consequences}

- `writeAttachedNotConfiguredReminder` is exported from
  `src/core/cli/walkthrough.js` beside the finale's own
  `writeAttachedNotConfiguredWarning`, which stays private to the finale.
- `FirstLookResult` carries `wrote` as well as `shown`, so the first look
  answers "did this put text on the screen" for itself. It is the step's fact
  to report, not the orchestrator's to deduce.
- `writeWalkthroughRunSummary` is untouched. It still reports only what the
  finale *did*, per
  [LLP 0135](./0135-install-experience-overhaul.design.md); a warning is not
  an action taken.
- A stranded attach on an attended wizard run is printed twice in one run, in
  two places, deliberately. That is the cost of the finale's placement being
  correct for the restart and wrong for the end of the run.
- The managed-host gap LLP 0185 recorded is narrowed, not closed: status still
  says nothing on a joined host, but the run that creates the state now ends
  on the warning instead of burying it.

## References

- Issue #614 (deferred review finding from PR #608), PR #608
- `src/core/cli/walkthrough.js` (`writeAttachedNotConfiguredReminder`),
  `src/core/cli/wizard/index.js` (the closing sequence)
- LLP 0185, LLP 0135, LLP 0131, LLP 0100/0101
