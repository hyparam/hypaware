# LLP 0274: The pick menu keeps its checked state on a bare enter

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, CLI
**Author:** Brendan / Claude
**Date:** 2026-08-19
**Related:** LLP 0190 (#sync-gate: the `enterKeepsChecked` opt-in this widens, and the line it corrects; #eof-everywhere: the dropped-terminal rule this keeps), LLP 0183 (#seed-from-config: what put a checked state on this menu in the first place), LLP 0191 (#re-entry-seeding: the other seed tier), LLP 0011 (#autodetect-vs-default: detection seeds the boxes on a first run)

> Extends [LLP 0190 §sync-gate](./0190-wizard-defaults-gate.decision.md#sync-gate)
> from "the sync menu sets `enterKeepsChecked`" to "a menu that arrives
> with a checked state sets it", and corrects that section's line
> "Other numbered questions (the pick menus, `runPickerWalkthrough`)
> keep the historical semantics untouched" for the wizard's pick menu.
> `runPickerWalkthrough` is untouched.

## The problem {#problem}

The wizard pick lane's menu asked without `enterKeepsChecked`, so on the
non-TTY path (`HYP_NO_TUI=1`, a pipe, no TTY) `legacyNumberedPromptFactory`
neither rendered the boxes nor kept them: bare labels, and a bare enter
returning the empty selection.

```
What do you want to collect?
  1) Claude Code
  2) Codex
  3) OpenTelemetry
select (e.g. 1,3, "all", or b to go back):
```

That was harmless while the checked state was only a detection hint on a
first run: a first run's enter selecting nothing collects nothing, which is
what it says. It stopped being harmless when
[LLP 0183 §seed-from-config](./0183-reconfigure-starts-from-the-config-on-disk.decision.md#seed-from-config)
made the boxes a read-back of the config on disk. From then on, the state a
bare enter discarded was **the user's own recorded answer**, and the run
that discarded it went on to rewrite the config from the empty selection,
past an overwrite confirm that deliberately defaults to yes (it lands after
every question was answered, LLP 0190 #commit-point).

The reachable sequence on an already-configured machine: `HYP_NO_TUI=1
hyp init`, reconfigure, fork, the defaults gate, `2` ("Select what to
record"), enter. Six keystrokes of accepting what the screen appears to
offer, and the machine stops collecting. The TUI path never showed it -
the multiselect renders and keeps `checked` on its own - so the defect
lived entirely on the terminal least able to see it coming.

## Decision {#pick-menu}

**A menu that arrives with a checked state says so, and a bare enter keeps
it.** The pick lane builds its options first and sets
`enterKeepsChecked` when any of them is checked, so the numbered fallback
renders `[x]`/`[ ]`, keeps the checked rows on a bare enter, takes "none"
as the word for a deliberate empty selection, and spends one re-ask on an
answer that names no row - the same four behaviours the sync menu already
gets from the flag, for the same reason: the invisible default was the
inverse of the visible one.

**And only where it has one.** With nothing checked the flag is not set,
which is not a nicety about empty boxes. `enterKeepsChecked` also decides
what a closed stdin means (LLP 0190 #eof-everywhere: a stdin that can no
longer answer takes the default the prompt printed; a prompt whose enter
has no default cancels instead). A menu with nothing checked prints no
default, so setting the flag there would turn a dropped terminal into "the
user picked nothing" and carry the wizard into the daemon install
collecting nothing - the exact failure this doc closes, re-entered through
the other door. Unset, it stays the cancel LLP 0190 put there.

The condition is read off the rendered rows rather than off `hasGate`.
The two agree by construction today (`defaultRows` and `buildPickOption`
apply the same locked-or-seeded predicate to the same `visibleList`), and
that is precisely why the flag must not be derived from the gate: a later
change to what the gate states would silently change what a bare enter
keeps, and the one screen where the boxes and the enter can disagree is
the one nobody sees on a TTY.

## Consequences {#consequences}

- The three seed tiers all reach the non-TTY menu intact: a reconfigure's
  config on disk (LLP 0183), a re-entry's confirmed selection (LLP 0191
  #re-entry-seeding), and a first run's detection (LLP 0011). A first run
  with nothing detected is the no-checked case and is unchanged.
- Locked rows render `[x] ... (locked)` and ride a bare enter like any
  other checked row; the composition filter drops them downstream
  regardless (LLP 0129 #join-before-picker), so keeping them here changes
  no config.
- `runPickerWalkthrough` (the legacy picker, `src/core/cli/walkthrough.js`)
  keeps its historical semantics: it has no config read-back seeding its
  boxes, and its dropped-terminal cancel is pinned by its own test.
- The shared `legacyNumberedPromptFactory` is unchanged. This is one more
  question opting into an existing contract, not a new one.

## References

- LLP 0190, LLP 0183, LLP 0191, LLP 0011, LLP 0129
- `src/core/cli/wizard/pick.js` (`promptPickSelection`, `buildPickOption`),
  `src/core/cli/walkthrough.js` (`legacyNumberedPromptFactory`),
  `src/core/cli/types.d.ts` (`WalkthroughQuestion.enterKeepsChecked`)
