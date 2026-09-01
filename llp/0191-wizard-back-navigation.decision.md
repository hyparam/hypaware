# LLP 0191: The wizard steps back; escape means back where back exists

**Type:** Decision
**Status:** Draft
**Systems:** Onboarding, CLI
**Author:** Brendan / Claude
**Date:** 2026-08-04
**Related:** LLP 0135 (#orchestration, #progress: the wizard this adds navigation to), LLP 0190 (#pick-gate, #sync-gate, #commit-point: the gate/menu screens and the boundary back cannot cross), LLP 0129 (#failed-join-returns-to-fork: the pre-existing fork re-entry), LLP 0063 (D3: the sign-in is the accepting act), LLP 0011 (autodetect seeds, never forces)
**Extended-by:** [LLP 0200](./0200-folder-ask-is-a-preference.decision.md) (a fourth enrolled lane, `folders`, joins the chain after `sync` and backs into it), [LLP 0201](./0201-express-defaults-gate.decision.md) (#edges: the express gate joins the chain between the fork and the pick lane - it backs to the fork, and the pick lane backs to it whenever it was shown)

> Extends the prompt flow of [LLP 0135](./0135-install-experience-overhaul.design.md)
> and the gate screens of [LLP 0190](./0190-wizard-defaults-gate.decision.md).
> What the lanes ask and write is untouched; what changes is that an
> attended run can move backwards through the questions before anything
> commits.

## Context {#context}

The wizard's question lanes ran strictly forward: gate, fork, join,
pick, sync, commit. A user who answered the picker and then saw the
sync screen state something they wanted to change had exactly one
control - escape - and it cancelled the whole run, forcing a re-entry
from `hyp init` and a full re-answer. Dogfooding kept surfacing the
same reflex: people press escape expecting "one screen back", not
"abandon setup".

## Decision {#decision}

<a id="esc-back"></a>**Escape steps back one screen; ctrl+c stays the
cancel.** Back is opt-in per prompt (`allowBack` on the prompt chrome):
a prompt whose caller declared a screen behind it settles as `backed`
on escape (the runtime throws `PromptBackRequestedError`, the sibling
of the cancel signal), and its default hint honestly reads `esc back`
instead of `esc cancel`. Every prompt without the flag - including all
of them outside the wizard - keeps escape as cancel, byte-identically.
Ctrl+C cancels regardless of the flag, so "get me out" never needs the
mouse-path through N back-steps. The readline fallbacks accept `b` as
the same signal and say so in their prompt line, so a `HYP_NO_TUI=1`
run can navigate too. A back with no target is never offered: the flag
is what the hint, the key, and the fallback all key off.

<a id="back-edges"></a>**Back edges mirror the forward edges, one step
at a time.** The orchestrator's lanes form a loop rather than a
fall-through: sync backs to pick, pick backs to the express gate when it
was shown and otherwise the fork (LLP 0201 #edges), and the fork
backs to the returning gate - the last only on a reconfigure run,
because a first run has no gate screen to return to (the gate then
falls through without asking anything). The join lane has no back of
its own: it is a browser sign-in, not a screen, and an incomplete join
already returns to the fork (LLP 0129 #failed-join-returns-to-fork).
The position lines (LLP 0135 #progress) resolve per pass: a back
through the fork that lands on the other pathway simply starts that
pathway's count, exactly as a failed join's retry always has.

<a id="lane-loops"></a>**Each lane is one screen.** (Revised by
[LLP 0201 #decline](./0201-express-defaults-gate.decision.md#decline):
this section originally looped each lane's menu back to its own defaults
gate; those gates are retired, so there is no lane-internal loop left.)
The pick and sync lanes each render a single menu, which propagates
`back` out to the orchestrator - and only when the orchestrator said
there is a previous step (`allowBack` on the lane's options). Toggles
made on a menu that is then escaped are discarded, like any dialog
dismissed without confirming; the re-presented screen re-states the
standing answer.

<a id="re-entry-seeding"></a>**Stepping back into pick shows the answer
previously confirmed.** The orchestrator remembers the last selection
the pick lane confirmed and re-seeds the lane with it (`initialSelection`),
skipping detection entirely on re-entry: re-detecting would overwrite
an answer the user already gave, and LLP 0011's rule that detection
only ever *seeds* cuts both ways. The `· detected` suffix stays tied to
real detection, so re-entry rows carry none; locked rows stay checked
and disabled either way. The sync lane needs no equivalent: its store
is only written at confirm, so a back before the write leaves the
standing entries to re-render, and its gate re-states them.

<a id="join-not-undone"></a>**Back changes the pathway, never the
enrollment.** A completed join is a completed transaction the moment
the sign-in finishes (LLP 0063 D3); stepping back past it cannot roll
it back and must not pretend to. The orchestrator remembers the join:
choosing "Join a team" again prints "Already signed in - continuing."
instead of re-opening the login, and choosing "Local" keeps the org's
locked rows and the managed sync lane, exactly like a managed machine
reconfiguring down the local path (LLP 0182). Every enrolled-state
narration (the abort narration of LLP 0190 #abort-narration, the
closing privacy narration) keys on the remembered join rather than the
final pathway, so a join-back-local run still hears what its enrollment
means. The one true exit remains the fork's explicit disconnect
(LLP 0190 #fork-disconnect), which runs `hyp leave` and therefore also
clears the remembered join.

**Back-navigation ends at the commit point.** Once the last question
lane confirms, the wizard commits the config (LLP 0190 #commit-point)
and everything after it - configure, finale, first look - acts rather
than asks. Those steps run commands and edit files; a "back" there
would be an undo feature wearing a navigation key, so it is not
offered. The finale's own prompts (attach, backfill consent) keep their
existing cancel semantics.

Rejected: making escape mean back globally (outside the wizard escape
has always meant cancel, and silently changing that in every prompt
would turn a habit into data loss); a visible "Back" row in the menus
(a navigation control is chrome, not a choice - it would compete with
the real options and break the bare-enter defaults of LLP 0190);
preserving half-toggled menu state across a back (a dismissed dialog
that half-applies is worse than one that predictably discards).

## Consequences {#consequences}

- The wizard is explorable: a user can open the sync screen, back up,
  change what is collected, and return, without abandoning the run or
  re-answering from scratch.
- Non-interactive runs (`--yes`, `--dry-run`, presets, `--from-file`)
  are untouched: back-navigation requires a keypress by construction,
  and no `allowBack` is threaded when `picks` is set.
- `runPickerWalkthrough` and every prompt outside the wizard render and
  behave byte-identically: `allowBack` is opt-in and nothing outside
  the wizard sets it.
- A cancelled run still exits 130 with the same narrations; escape
  simply stops being the only way to express "not this screen".

## References

- LLP 0135, LLP 0190, LLP 0129, LLP 0063, LLP 0182, LLP 0011
- `src/core/cli/tui/keypress.js` (escape splits on `allowBack`),
  `src/core/cli/tui/runtime.js` (`PromptBackRequestedError`),
  `src/core/cli/tui/render.js` (`esc back` hints),
  `src/core/cli/walkthrough.js` (factory pass-through, readline `b`),
  `src/core/cli/wizard/fork.js` (`'back'` choice),
  `src/core/cli/wizard/pick.js` (lane loop, re-entry seeding),
  `src/core/cli/wizard/sync_scope.js` (lane loop),
  `src/core/cli/wizard/index.js` (back edges, remembered join)
