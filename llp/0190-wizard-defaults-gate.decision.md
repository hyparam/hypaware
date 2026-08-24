# LLP 0190: The wizard states its defaults and confirms; the sync menu checks what syncs

**Type:** Decision
**Status:** Draft
**Systems:** Onboarding, CLI
**Author:** Brendan / Claude
**Date:** 2026-08-04
**Related:** LLP 0188 (#never-silent: the sync-scope step this reshapes), LLP 0135 (#pick: the pick lane this reshapes), LLP 0129 (fork/join/pick order, unchanged), LLP 0011 (autodetect seeds the default), LLP 0130 (picker descriptors)
**Extended-by:** [LLP 0201](./0201-express-defaults-gate.decision.md) (one express gate now precedes the lanes and can accept every gate below at once; each lane keeps its gate, its statement, and its default, and an auto-accepted gate prints its statement instead of prompting)
**Extended-by:** [LLP 0274](./0274-pick-menu-keeps-its-checked-state.decision.md) (#sync-gate below: the `enterKeepsChecked` opt-in widens from "the sync menu" to any menu that arrives with a checked state, so the wizard pick menu sets it too; that section's line "the pick menus keep the historical semantics untouched" is corrected for that menu, and `runPickerWalkthrough` is untouched)

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
means `clearOnResolve` erases them with the prompt. The gate's rows carry
bare labels - the title and list already name everything the choice
covers - but the accept option carries a one-line summary disclosing
that accepting *configures* the listed tools: the gate is the happy path
(enter, enter, finale), so it is the one screen guaranteed to be seen,
and the side-effect disclosure otherwise lives only on menu rows the
happy path never shows. The per-row specifics (attach, config writes,
helper skills, the OTLP receiver) stay on the menu rows' summaries.
With nothing detected
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
semantics untouched. An answer that names no row ("y", "0", an
out-of-range index) is a typo rather than a selection, so the opted-in
question prints what did not match and asks once more, and "none",
named in its prompt line rather than only in that message, is the word
for a deliberate empty selection. The re-ask rides the same opt-in
because the danger is specific to this menu's inverse default:
questions without the flag never re-ask, and their prompt bytes and
answers are unchanged. Two bounds hold it, both owed to a first attempt
that shipped an ungated `while (true)` over the shared factory and was
reverted (issue #634): the fallback asks a fixed number of times - one
ask plus one re-ask - so no input can hold a scripted run at the
prompt; and readline's `close` resolves the pending ask instead of
leaving it unsettled, which is the EOF hang `rl.question` has always
had and the loop turned into a crash.

> **Corrected by [LLP 0274](./0274-pick-menu-keeps-its-checked-state.decision.md):**
> "the pick menus keep the historical semantics untouched" holds for
> `runPickerWalkthrough`, and held for the wizard pick menu when this was
> written, where the boxes were a detection hint. LLP 0183 later made them
> the read-back of the config on disk, so a bare enter discarded the user's
> own recorded answer and the run rewrote the config from it: the same
> invisible-default defect this paragraph is about. That menu now sets the
> flag whenever a box is checked, and only then.

Where the fallback lands when it runs out of answers is the question's
*stated* default, never a different one. A spent budget takes what a
bare enter takes - the checked rows here, the empty selection elsewhere
- and says which, because falling through to an empty selection would
opt every candidate out one answer later, silently: issue #634 again,
inside the loop that exists to close it. A closed stdin takes that same
default where enter has one. Where it does not (every question without
the opt-in) it is a cancel rather than an answer: an empty selection
there is indistinguishable from "the user picked nothing", so a dropped
terminal would carry the wizard on into the daemon install with no
sources. Cancel is the signal the TUI already raises on ctrl+c and
every caller already handles (exit 130), so a dropped terminal aborts
the run the way it always did, without the unsettled-await crash it
used to abort with.

Because readline emits every line of a chunk synchronously, the
fallback also queues answer lines from the moment the interface opens
rather than listening per question, so a correction arriving in the
same pipe write as the typo is still read; and because readline
registers its `end` listener at construction, an interface built over
an already-ended stream never emits `close` at all, so the asker seeds
its spent flag from the stream's own `readableEnded` and a second
question on a spent stdin settles like the first. This covers the
numbered prompt. The file's other readline prompts (the overwrite
confirm, the gate's numbered fallback, the backfill consent) called
`rl.question` directly and hung at EOF; they now read through the same
asker, coalescing its EOF `null` into the empty line rather than
branching on it, so each lands on the default its own question prints
and no EOF answer can drift from the advertised one. The wizard's fork
screen (`src/core/cli/wizard/fork.js`) is the one prompt outside this
file still asking through `rl.question`, and closing that is a separate
change.
This flips the polarity of the
prompt LLP 0188 #never-silent quoted ("check any to keep local-only");
everything behind the prompt - the store schema, editor semantics over
shown candidates, seam enforcement, corrupt-store fail-closed - is
LLP 0188's and is unchanged.

<a id="eof-everywhere"></a>**The EOF rule is the tree's, not this
lane's, and the asker that implements it is shared.** The defect is
`node:readline`'s, so it is at every readline prompt HypAware has, and
the rule above answers all of them: **a stdin that can no longer answer
takes the default the prompt printed; a prompt whose enter has no
default settles as a cancel or a failure instead, never as an invented
answer.** ([LLP 0299](./0299-confirm-prompts-default-to-yes.decision.md)
§eof-declines narrows the first clause wherever a printed default would
*proceed*: that is not what a spent stdin takes, because EOF is the
proof nobody is there to want it. `askYesNo` applies this to every
`[Y/n]` confirm; the select factory applies it only where a question
names an `eofValue`, which today is the disconnect gate of
§fork-disconnect. Every other default named below still declines to
act, so the answers this section gives are unchanged.) `queuedLineAsker` moves out of `walkthrough.js` into
`src/core/cli/line_asker.js`, beside `stdio.js` and `flush-streams.js`,
where a plugin workspace can import it too; `askLineOnce` joins it for
the prompts that ask once on an interface that may be a real terminal,
keeping `rl.question` as the thing that writes the query (readline
redraws a terminal line from its own bookkeeping, so a query it never
saw is a query it cannot redraw) and replacing only its promise.

Applied outward, the rule settles the exit code the class kept raising.
The wizard's fork menu prints `default 3`, and LLP 0129 #fork already
settled that the default is Quit, so EOF there is Quit and the wizard
exits 0 having written nothing: the same result the fork's TUI path
already returns for a real ctrl+c at that screen. 130 is not the answer
for a dropped terminal at a prompt that advertised a default, because a
prompt with a default cannot tell a dropped terminal from a bare enter
and should not pretend to; 130 stays where LLP 0135's cancel put it, at
the prompts whose enter answers nothing. The two `[y/N]` confirms
(`src/core/cli/confirm.js`, `src/core/plugin_install/confirm.js`) take
their printed no, which is the safe direction for the irreversible verbs
behind them, and their callers' exit codes are unchanged: an EOF decline
is reported exactly as a typed `n` is. (`confirm.js` since grew `[Y/n]`
prompts; per LLP 0299 §eof-declines those decline at EOF too, so the
answer this paragraph gives is unchanged - only its derivation is.) The one prompt with no default is
`claude-account login`'s `Code: ` paste, and it does not invent one: with
no loopback listener left to finish the sign-in, EOF is a failure that
says so, and with a listener up the paste lane stays pending rather than
losing a race the browser may still win.

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
with "Yes, disconnect" as the default
([LLP 0299](./0299-confirm-prompts-default-to-yes.decision.md):
disconnecting destroys nothing, so yes leads). It is the one gate here
whose default *acts*, so it is also the one that names an `eofValue`: a
stdin that can no longer answer stays connected rather than taking the
printed default, because §eof-everywhere's rule is about what the person
at the terminal wants and EOF proves there is none. Yes runs the real `hyp leave` (LLP 0063: central-layer
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
