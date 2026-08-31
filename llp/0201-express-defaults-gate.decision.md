# LLP 0201: One question up front accepts every default; declining asks the real questions

**Type:** Decision
**Status:** Draft
**Systems:** Onboarding, CLI
**Author:** Brendan / Kenny / Claude
**Date:** 2026-08-07 (revised 2026-08-30)
**Related:** LLP 0190 (#pick-gate, #sync-gate: the per-lane defaults gates this retires; the menu semantics there are untouched), LLP 0188 (#never-silent: the floor this must not breach), LLP 0200 (#wizard: the third lane it answers), LLP 0135 (#progress, #orchestration), LLP 0131 (#attended-only), LLP 0129 (#fork), LLP 0191 (#back-edges)

> Extends [LLP 0190](./0190-wizard-defaults-gate.decision.md) and retires
> its per-lane gates. The wizard asks "accept the defaults?" exactly once,
> right after the fork (and the join, on the team pathway). Yes skips every
> remaining question; no asks the real questions, linearly, with no further
> accept-or-customize screens.

## Context {#context}

[LLP 0190](./0190-wizard-defaults-gate.decision.md) gave the pick and sync
lanes a defaults gate each, and the first revision of this document added
an express gate in front of them that could accept all of them at once,
while keeping every per-lane gate behind it.

Dogfooding that shape surfaced two failures:

- **The gate-of-gates read as the same question twice.** Declining
  "Record and sync all of these" landed immediately on the pick lane's
  "Record all" over the same rows, then the sync lane's "Sync all", then
  the folder question: up to three more accept-or-customize screens after
  the user already said "let me choose". Saying no once must mean "ask me
  the real questions now".
- **The detected list went unread.** The gate rendered the detected tools
  in the prompt's `items` chrome, above the key-hint line
  (`up/down · enter pick · esc back`). Users read the option rows, not
  the text above the chrome, so "all of these" pointed at a list nobody
  had looked at.

What must not be lost is the never-silent floor: LLP 0188 #never-silent
requires the wizard to say what will ship before anything ships.

## Decision {#decision}

<a id="gate"></a>**One express gate precedes the question lanes and is the
wizard's only accept-or-customize screen.** On an attended run, after the
fork (and the join, on the team pathway) and before the pick lane, the
wizard asks one two-row question - on every pathway, local included,
whenever seeding yields default rows:

```
Set up recording
> Record and sync everything
    Configures Claude Code and Codex to record through HypAware.
  Customize
    Choose what to record and what syncs.
```

**The rows are self-explaining; nothing load-bearing rides the items
chrome.** The first revision's "the list is the explanation" put the
detected tools above the prompt as `items`, where nobody reads. The tool
names now live in the accept row's own summary sentence, which is both the
disclosure (accepting *configures* those tools - the one-line side-effect
statement [LLP 0190 #pick-gate](./0190-wizard-defaults-gate.decision.md#pick-gate)
put on the retired pick gate's accept row) and the evidence (what was
found), in the one line the happy path is guaranteed to read. Both halves
have to stay: an express accept never opens the menu whose per-row
summaries carry the specifics, so a sentence that only named the tools
would leave "this changes your tools' configuration" stated nowhere on
the path most users take. The names are the pick lane's own default rows
from one computation (`resolvePickSeeding`, shared with the lane), joined
plainly; fleet-locked rows appear by name like any other, and the fleet
detail stays on the later screens and the accept narration, not in this
sentence.

`sync` is claimed only where accepting would in fact sync everything the
row names. On a solo machine nothing forwards, so the label drops to
"Record everything" and the Customize summary to "Choose what to record."
The same drop applies on an enrolled machine whose client-sync store
already withholds one of the named rows: an accept preserves standing
opt-outs verbatim rather than clearing them (#narrate, and
[LLP 0188 #opt-out](./0188-enrolled-default-sync-with-client-optout.decision.md#opt-out)),
so "and sync everything" would be a promise the accept does not keep -
the case the retired sync gate handled with its own "Sync all" against
"Keep this" split, which this row inherits along with the decision. The
gate reads the store the sync lane reads, and a read it cannot complete
answers "withheld": a row that cannot prove everything syncs must not say
it does. Only the claim narrows; the accept narration still states the
split in full, so nothing goes unsaid. The accept summary is the same
sentence in every case: what it discloses is the configuring, which
happens on a solo machine too. The new-folder policy that rides with an
enrolled accept is deliberately not in the row copy - it is stated by the
accept narration (#narrate) - so the row stays one readable sentence
about the tools.

<a id="decline"></a>**Declining asks the real questions, linearly.** The
per-lane defaults gates ([LLP 0190 #pick-gate](./0190-wizard-defaults-gate.decision.md#pick-gate),
[#sync-gate](./0190-wizard-defaults-gate.decision.md#sync-gate)) are
removed. Customize opens the pick multiselect directly, then - on enrolled
runs - the sync multiselect and the new-folder question, in that order,
then the finale. No later screen ever again asks "defaults or customize".

The menus still open on the same defaults the retired gates stated: the
pick menu's boxes are seeded by detection and the locked set, the sync
menu's boxes are checked for everything that syncs with locked rows
leading read-only, and a bare enter keeps the checked state
(LLP 0274). So "inspect everything and change nothing" is still one
enter per screen; what is gone is the extra screen per lane that asked
whether the user wanted to see the screen.

The menus are the never-silent statement on this path: each one names the
rows it records or ships before anything ships, which is the same
statement the retired gates carried (LLP 0188 #never-silent binds the
statement, not the prompt shape). The sync lane's no-candidate narrations
(LLP 0276 #no-candidates, LLP 0289 #ask-the-store) are unchanged: a lane
with nothing to ask still states its facts and asks nothing.

<a id="narrate"></a>**Accepting skips the prompts, never the statements.**
Each lane still runs; it prints the title and items it would have shown
and proceeds with the default instead of waiting for an answer. The pick
lane narrates "HypAware will record:" with its rows (locked ones
fleet-suffixed), the sync lane narrates "These will sync to your server:"
with the split it would have shown, and the new-folder lane narrates its
question and records its standing answer. This is what keeps the fast path
inside LLP 0188 #never-silent.

**Accepting takes each lane's standing answer, which is its default only
where the user has no standing one.** The two stores behind the gate are
read, never reset: the sync lane keeps its `local-only` entries
([LLP 0188 #opt-out](./0188-enrolled-default-sync-with-client-optout.decision.md#opt-out))
and the new-folder lane keeps its recorded mode
([LLP 0200 #wizard](./0200-folder-ask-is-a-preference.decision.md#wizard)).
"Accept the defaults" is an answer to the questions this run asks, not a
licence to discard answers a previous one recorded - and each of these
lanes narrates the value it took, so a lane that reset one would announce
the new value as though the user had just chosen it.

**The narration is blocked, not streamed.** Each statement is led by a
blank line and its detail is indented under a title, because on this path
there are no prompts to separate the statements: without the spacing the
run reads as one paragraph of mixed subjects. A lane whose answer is a
single fact prints it as one more indented line of its own block.

<a id="no-default-no-accept"></a>**Nothing found means no gate.** With
nothing detected and nothing locked there is no default worth naming and
nothing to accept: "record everything" over nothing would mean "record
nothing". The orchestrator skips the gate entirely and the pick lane opens
its menu, exactly as it does on a decline.

<a id="no-counter"></a>**The gate carries no position line, and an express
run states none.** The gate is what decides how many questions remain, so
it can no more state a total than the fork can
([LLP 0135 #progress](./0135-install-experience-overhaul.design.md#progress):
the denominator resolves once and never moves). After an accept, no lane
states a position either: a "Step 3 of 5" above a narration would count
screens nobody is answering. A declining run keeps every position exactly
as before.

<a id="edges"></a>**It behaves like any other wizard question.** Escape
steps back to the fork ([LLP 0191 #back-edges](./0191-wizard-back-navigation.decision.md#back-edges));
ctrl+c cancels the run at 130, narrating the enrolled state first when this
run has already joined. It is asked once per pass through the lanes, so a
back to the fork and forward again asks it again and may be answered
differently. With the per-lane gates gone each lane is one screen, so the
back chain is: folder question to sync menu (or past a sync lane that
asked nothing to the pick menu), sync menu to pick menu, pick menu to this
gate whenever it was shown, and this gate to the fork. On a pass where
there is nothing to accept and no gate is shown (#no-default-no-accept),
the pick menu's back edge reaches the fork directly - including the pass a
back *into* the gate opens, since the rows are the picker's own confirmed
defaults and a confirmed empty selection leaves none. Non-interactive runs
(`--yes`, presets, `--from-file`) never see the gate: they already take
every default without prompting (LLP 0131 #attended-only).

Rejected: making express the *only* path (the menus are how a user with an
unusual machine says no, and LLP 0011 #autodetect-vs-default holds that
detection seeds and never forces). Rejected: keeping the per-lane gates
behind the express gate (the first revision's shape; declining then asked
"accept defaults?" up to three more times). Rejected: showing the express
gate only on enrolled runs (the first revision's #one-lane-no-gate; with
the pick gate gone, the solo pathway needs the accept question too, and
one rule on every pathway beats two). Rejected: rendering the detected
list in the items chrome (text above the key-hint line goes unread; the
row summary is where the eyes are). Rejected: silently auto-accepting a
lane whose gate had exactly one obvious answer (the never-silent objection
LLP 0190 raised against skipping the sync step).

## Consequences {#consequences}

- The attended happy path on every pathway is: fork (plus join on team),
  express gate, narration, finale. Two questions, and the second names
  the tools it is about to configure in the row the user actually reads.
- The decline path is linear: pick menu, then on enrolled runs the sync
  menu and the folder question, then the finale. Each screen is a real
  question; none of them is a gate.
- Every lane keeps its `autoAccept` seam. A lane that later adds a
  question must decide what accepting it means.
- A user who accepts express and later wants to change any of it uses the
  same standing controls as everyone else: `hyp privacy client`,
  `hyp privacy folders`, and re-running `hyp init`.
- The step counter describes only the decline path. That is honest, not a
  regression: an express run has no steps to count.

## References

- LLP 0190, LLP 0188, LLP 0200, LLP 0135, LLP 0131, LLP 0129, LLP 0191,
  LLP 0274, LLP 0276, LLP 0289
- `src/core/cli/wizard/express.js` (the gate and the shared narration),
  `src/core/cli/wizard/index.js` (orchestration, the run-once detector),
  `src/core/cli/wizard/pick.js` (`resolvePickSeeding`, the menu-only lane),
  `src/core/cli/wizard/sync_scope.js` (the menu-only lane),
  `src/core/cli/wizard/folder_ask.js` (the `autoAccept` arms)
