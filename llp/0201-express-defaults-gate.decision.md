# LLP 0201: One question up front accepts every default the wizard would ask for

**Type:** Decision
**Status:** Draft
**Systems:** Onboarding, CLI
**Author:** Brendan / Claude
**Date:** 2026-08-07
**Related:** LLP 0190 (#pick-gate, #sync-gate: the per-lane defaults gates this collapses), LLP 0188 (#never-silent: the floor this must not breach), LLP 0200 (#wizard: the third lane it answers), LLP 0135 (#progress, #orchestration), LLP 0131 (#attended-only), LLP 0129 (#fork), LLP 0191 (#back-edges)

> Extends [LLP 0190](./0190-wizard-defaults-gate.decision.md). Each lane
> keeps its gate, its statement, and its default. What changes is that the
> user can accept all of them at once, before the first one, instead of
> pressing enter through a sequence whose answers were knowable in advance.

## Context {#context}

[LLP 0190](./0190-wizard-defaults-gate.decision.md) gave the pick and sync
lanes a defaults gate each, so the common run became "enter, enter,
finale". [LLP 0200 #wizard](./0200-folder-ask-is-a-preference.decision.md#wizard)
adds a third question with its own default. Three screens, three defaults,
and on the common path three keypresses that all mean the same thing:
yes, do the obvious.

The obvious answer is knowable before the first screen. Detection already
seeds the pick lane, everything configured already syncs by default
([LLP 0188 #rule](./0188-enrolled-default-sync-with-client-optout.decision.md#rule)),
and new folders already sync (LLP 0200 #default). A user who wants that
whole package has no way to say so once; a user who wants to inspect it
has no way to know, at the first screen, how many more are coming.

What must not be lost is the never-silent floor: LLP 0188 #never-silent
requires the wizard to say what will ship before anything ships, and
LLP 0190's gates are where it says it.

## Decision {#decision}

<a id="gate"></a>**One express gate precedes the question lanes and can
answer all of them.** On an attended run, after the fork (and the join, on
the team pathway) and before the pick lane, the wizard lists what it found
and offers two rows:

```
HypAware found these on this machine:
  Claude Code · managed by your fleet
  Codex

> Record and sync all of these
    Configures each to record through HypAware; new folders sync too.
  Let me choose
```

**The list is the explanation.** An earlier draft asked "Set up with
defaults?" over four lines paraphrasing what the defaults were, and read as
policy text: the user had to decode a summary to find out what would happen
to their machine. The rows say it directly, so the accept label can name
the act on the things above it ("all of these") and the alternative can be
the two words it always was.

The rows are the pick lane's own default rows, from one computation
(`resolvePickSeeding` + `defaultRowLabels`, shared with
[LLP 0190 #pick-gate](./0190-wizard-defaults-gate.decision.md#pick-gate)),
with the same fleet suffix on locked rows. Two derivations of "the
defaults" could disagree, and the screen that accepts them all at once is
the worst place for that. Detection runs once per wizard run and is shared
with the lane for the same reason.

`sync` is claimed only on an enrolled run - on a solo machine nothing
forwards, so the label drops to "Record all of these". The accept row keeps
a single line of consequence: what accepting does to the machine (the
disclosure [LLP 0190 #pick-gate](./0190-wizard-defaults-gate.decision.md#pick-gate)
put on the happy-path row) plus the new-folder policy that rides with it.
The alternative row carries no gloss; "Let me choose" needs none.

Declining runs the lanes exactly as they run today, gates and all.

<a id="narrate"></a>**Accepting skips the prompts, never the statements.**
Each lane still runs; it prints the title and items its gate would have
shown and proceeds with the default instead of waiting for an answer. So
the express path and the step-by-step path print the same rows, in the same
order, and differ only by the keypresses. This is what keeps the fast path
inside LLP 0188 #never-silent: the floor binds the statement, not the
question. Concretely, the pick lane narrates "HypAware will record:" with
its rows (locked ones still fleet-suffixed), the sync lane narrates "These
will sync to your server:" with the split it would have shown, and the
new-folder lane narrates its question and records the default answer.

**The narration is blocked, not streamed.** Each statement is led by a
blank line and its detail is indented under a title, because on this path
the prompts that used to separate the statements are exactly what was
removed: without the spacing the run reads as one paragraph of mixed
subjects. A lane whose answer is a single fact prints it as one more
indented line of its own block rather than as a second flush-left sentence
repeating the subject ("New folders you work in:" / "  Syncing them all;
change later with `hyp policy folders ask`"). The one block that follows
the welcome banner suppresses its leading blank, since the banner already
supplied one.

<a id="no-default-no-accept"></a>**Nothing found means no gate.** With
nothing detected and nothing locked there is no list to show and nothing to
accept: "record all of these" over an empty list would be a question about
nothing, and accepting it would mean "record nothing". The orchestrator
skips the gate entirely and the pick lane opens its menu, exactly as it
does today when its own gate has no rows.

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
differently. Non-interactive runs (`--yes`, presets, `--from-file`) never
see it: they already take every default without prompting (LLP 0131
#attended-only).

Rejected: making express the *only* path (the step-by-step lanes are how a
user with an unusual machine says no, and LLP 0011 #autodetect-vs-default
holds that detection seeds and never forces). Also rejected: silently
auto-accepting a lane whose gate had exactly one obvious answer (the same
never-silent objection LLP 0190 raised against skipping the sync step).

## Consequences {#consequences}

- The attended happy path is: fork, express gate, narration, finale. Two
  questions, where it was four (five on the team pathway), and the second
  one names the tools it is about to configure.
- The pick lane's pre-question seeding is now a named, exported step
  (`resolvePickSeeding`). Any future default that a gate would state has
  one place to be computed.
- Every lane grows an `autoAccept` seam. A lane that later adds a question
  must decide what accepting it means, which is the right place for that
  decision to be forced.
- A user who accepts express and later wants to change any of it uses the
  same standing controls as everyone else: `hyp policy client`,
  `hyp policy folders`, `hyp policy set`, and re-running `hyp init`.
- The step counter now describes only the step-by-step path. That is
  honest, not a regression: an express run has no steps to count.

## References

- LLP 0190, LLP 0188, LLP 0200, LLP 0135, LLP 0131, LLP 0129, LLP 0191
- `src/core/cli/wizard/express.js` (the gate and the shared narration),
  `src/core/cli/wizard/index.js` (orchestration, the run-once detector),
  `src/core/cli/wizard/pick.js` (`resolvePickSeeding`, `defaultRowLabels`),
  `src/core/cli/wizard/sync_scope.js`,
  `src/core/cli/wizard/folder_ask.js` (the `autoAccept` arms)
