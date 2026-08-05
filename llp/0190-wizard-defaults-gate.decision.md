# LLP 0190: The wizard states its defaults and confirms; the sync menu checks what syncs

**Type:** Decision
**Status:** Draft
**Systems:** Onboarding, CLI
**Author:** Brendan / Claude
**Date:** 2026-08-04
**Related:** LLP 0188 (#never-silent: the sync-scope step this reshapes), LLP 0135 (#pick: the pick lane this reshapes), LLP 0129 (fork/join/pick order, unchanged), LLP 0011 (autodetect seeds the default), LLP 0130 (picker descriptors)

> Extends [LLP 0188 §never-silent](./0188-enrolled-default-sync-with-client-optout.decision.md#never-silent)
> and the prompt flow of [LLP 0135 §pick](./0135-install-experience-overhaul.design.md).
> The policy (default-sync, per-client opt-out, the `client-sync.json`
> store, seam enforcement) is untouched; what changes is how the two
> wizard lanes ask.

## Context {#context}

Dogfooding the wizard surfaced two prompt-shape problems.

First, the sync-scope step's multiselect was inverted: "All of these
will sync to your server - check any to keep local-only" renders checked
boxes on the sources being *withheld*. Users read a checked box next to
"Hermes Agent" as "Hermes will sync", which is exactly backwards. A
checkbox list titled "choose what syncs" must check what syncs.

Second, both interactive lanes (pick and sync-scope) forced the full
menu even when the wizard already knew a good answer: detection plus the
org's locked set for the pick lane, and "everything syncs" for the sync
lane. The common path - accept what was detected, sync everything -
cost a menu walk on every run.

## Decision {#decision}

<a id="pick-gate"></a>**The pick lane opens with a defaults gate.** When
detection or the org's locked set yields a non-empty default, the lane
first states it - the title "HypAware will record:" over one source per
line (locked rows keep their "· managed by your fleet" suffix) - and asks
a two-option select: "Record all" (the default, one keypress) or "Select
what to record", which opens the unchanged multiselect. The list rides
the prompt's `items` chrome, not the title: a comma-joined title was
unreadable past a few sources, and rendering the lines inside the frame
means `clearOnResolve` erases them with the prompt. The options carry
bare labels, no summaries: the title and list already name everything
the choice covers. With nothing detected
and nothing locked there is nothing worth confirming, so the menu shows
directly. The gate is a statement of the same rows the menu would
pre-check (LLP 0011 #autodetect-vs-default still holds: detection seeds,
never forces - the menu remains one keypress away).

<a id="sync-gate"></a>**The sync lane opens with a defaults gate, and its
menu checks what syncs.** The gate states the split as a list - "These
will sync to your server:" over one source per line, with a re-entry's
standing opt-outs under a second "Staying local-only:" header - and
accepts on a bare enter ("Sync all", or "Keep this" on a re-entry),
which round-trips the store unchanged. The sync list is the *whole*
picture: the org's locked sources always sync (LLP 0188 #locked), so
they lead it, fleet-suffixed, and lead the menu as checked, disabled
rows - the same read-only rendering the picker gives them. LLP 0188 kept
locked sources out of the step entirely; a "these will sync" statement
that omits sources that do sync understates what the server sees, so
they are now shown but remain uneditable, and they never enter the
opt-out computation.
"Select what to sync" opens the multiselect, now titled "Choose what syncs - unchecked sources stay on this machine":
every candidate renders checked by default (default-sync is the point),
a previously opted-out source arrives unchecked, and the opt-out set is
the candidates left unchecked at confirm. The numbered non-TTY fallback
keeps parity with that meaning: the sync menu sets `enterKeepsChecked`
on the question, so the fallback renders each row's checked state
(`[x]`/`[ ]`) and a bare enter keeps it, where the fallback's historical
enter-selects-none would have opted every candidate out - the exact
inverse of the TUI default, with the defaults invisible. Other numbered
questions (the pick menus, `runPickerWalkthrough`) keep the historical
semantics untouched. This flips the polarity of the
prompt LLP 0188 #never-silent quoted ("check any to keep local-only");
everything behind the prompt - the store schema, editor semantics over
shown candidates, seam enforcement, corrupt-store fail-closed - is
LLP 0188's and is unchanged.

<a id="prompt-shape"></a>**One gate prompt shape for both lanes.** The
gate is a `ConfirmSelectQuestion` asked through
`defaultConfirmSelectPromptFactory`: a TUI select on a real TTY, a
numbered readline fallback elsewhere, a bare enter taking the stated
default on both paths, and cancel behaving like any other wizard prompt
(exit 130). Both wizard steps take an injectable `confirm` seam beside
the existing `prompt` seam, threaded from `runInitWizard` like the other
prompt seams.

<a id="fork-disconnect"></a>**A managed machine choosing the local
pathway is asked, once, whether it means it.** Under LLP 0182 a managed
machine's fork shows the same "Local install and configuration" row as
everyone else's, and choosing it kept the fleet connection - correct for
the common case (adjusting local additions beside the org's config) but
a silent surprise for the user who meant "switch this machine to
local-only". Both intents are real, so the wizard now asks at the moment
of intent: on a managed machine, choosing local raises one yes/no -
"This machine syncs to your team server. Disconnect and go local-only?"
with "No, stay connected" as the default (a bare enter never
disconnects). Yes runs the real `hyp leave` (LLP 0063: central-layer
removal, org-attach reversal, identity drop) and the run continues as a
true solo install - no locked rows, no sync lane, the local 120-day
retention default. No keeps today's behavior: the org's rows stay
locked, the machine stays enrolled, and the run continues down the local
pathway. Escape and ctrl+c also leave the machine connected, and take
their ordinary wizard meanings at this prompt like any other - escape
steps back to the fork, ctrl+c cancels the run
([LLP 0191 §esc-back](./0191-wizard-back-navigation.decision.md#esc-back));
neither is a third answer to the disconnect question. A failed
`hyp leave` returns to the fork with the connection intact, never
half-left.
Rejected: making the local choice disconnect implicitly (the routine
"add OpenClaw on a managed machine" run would silently tear down
enrollment an admin may have to re-admit), and a separate fourth fork
row (the fork stays a pathway question; disconnection is a consequence
worth its own question, not its own row).

<a id="abort-narration"></a>**An abandoned enrolled run narrates instead
of prompting.** The join lane's enrollment is a completed transaction the
moment the sign-in finishes (LLP 0063 D3: the sign-in is the accepting
act; `hyp leave` is the exit). A later abort - the pick prompt cancelled,
the overwrite declined, the sync-scope prompt cancelled - cannot roll it
back, and until now the wizard exited as if it had: enrolled, existing
config still collecting, everything default-syncing once the first-sync
hold lapses, and none of it said. On any team-pathway abort after a
successful join, the wizard now prints the state the machine is actually
in (enrolled; configured sources sync by default), the standing control
(`hyp policy client <name> local-only`), and the first-sync deadline
narration when a hold is live. Never another prompt: a cancel means "get
me out", and re-prompting an abandoning user was rejected for the same
reason LLP 0129 rejected auto-degrading pathways - the wizard does not
answer its own questions. This extends to attended aborts the same
never-silent floor LLP 0188 already grants the scripted path
(default-sync is the outcome; `hyp policy client` is the control).

<a id="commit-point"></a>**The config write commits after the last
question, not inside the pick lane.** The pick lane used to compose and
write the config in one motion, so on a reconfigure run the overwrite
confirm ("Overwrite existing config (a backup is kept)?") interrupted the
questions - after "what to record", before "what syncs" - and a cancel at
the sync lane left the config already replaced. The wizard now runs pick
with `deferWrite`: the lane returns the composed config with
`configPending` set, and the orchestrator commits it
(`commitWizardPickedConfig`: guard, backup notice, write) after the sync
lane and before the acting phases, which is as late as it can go - the
configure phase and the finale read and edit the file on disk. Order:
pick questions, sync questions, overwrite confirm + write, configure,
finale. A refusal keeps pick's old exit-1 (not cancelled) shape and, on
the team pathway, narrates the enrolled state per #abort-narration. The
sync lane's `client-sync.json` write still precedes the commit; a store
entry for a source whose config never lands is inert and errs toward
under-sync, which LLP 0188 #migration already names as the safe
direction. On a scripted run (`--yes`, presets) no lane runs between pick
and the commit, so its ordering is unchanged; direct `runWizardPick`
callers without `deferWrite` keep the inline write.

Rejected: folding the "accept defaults" row into the multiselect itself
(a pseudo-row is not a selection, and enter-confirms-current-state
already exists; the confusion was about what the checkboxes mean, which
a pseudo-row does not fix). Also rejected: auto-skipping the sync step
entirely when nothing is opted out - LLP 0188 #never-silent requires the
step to say what will ship before anything ships; the gate keeps the
statement while removing the menu walk.

## Consequences {#consequences}

- The happy path through an enrolled wizard run is now: enter (collect
  the detected defaults), enter (sync everything), finale. Each gate
  still names exactly what it is accepting, so nothing ships silently.
- The retired inverted wording ("check any to keep local-only") no
  longer appears anywhere; `hyp policy client` remains the standing
  post-onboarding control and is named on the "Keeping local-only" line
  after an opt-out.
- Non-interactive runs (`--yes`, `--dry-run`, presets, `--from-file`)
  are untouched: they skip prompting entirely and default-sync remains
  the scripted outcome.
- The legacy `runPickerWalkthrough` is untouched; only the wizard lanes
  gained the gate.

## References

- LLP 0188, LLP 0135, LLP 0129, LLP 0011, LLP 0130
- `src/core/cli/wizard/pick.js` (pick gate),
  `src/core/cli/wizard/sync_scope.js` (sync gate + flipped menu),
  `src/core/cli/wizard/index.js` (abort narration),
  `src/core/cli/walkthrough.js` (`defaultConfirmSelectPromptFactory`),
  `src/core/cli/types.d.ts` (`ConfirmSelectQuestion`)
