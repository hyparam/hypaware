# LLP 0623: Turning the folder ask on keeps the folders already recorded

**Type:** Decision
**Status:** Draft
**Systems:** Usage-Policy, Onboarding, CLI
**Author:** Phil / Claude
**Date:** 2026-11-24
**Extended-by:** [LLP 0626](./0626-an-older-ask-is-adopted-once.decision.md) (#only-on-transition: an `ask` an older version wrote counts as a transition too, and the daemon makes it once at start)
**Related:** LLP 0622 (the rule this softens at the moment of switching), LLP 0200 (the folder-ask preference and its two writers), LLP 0103 (the explicit `full` entry), LLP 0070 (#enforce: the export seam), LLP 0100 (the enrollment privacy review)

> When a machine switches from `sync` to `ask`, the folders it has already
> been recording are marked `sync` at that moment. The ask then applies to
> folders the machine has not seen, which is what "ask me about new folders"
> says.
>
> @ref LLP 0622 [constrained-by] - without this, #rule stops collection in every folder the user already works in.

## Context {#context}

Under [LLP 0622 #rule](./0622-ask-mode-collects-nothing-from-an-unmarked-folder.decision.md#rule),
a folder nobody has marked is not collected while the ask is on. On a
machine that has run in the default `sync` mode, almost no folder is marked:
that is what the default means
([LLP 0200 #consequences](./0200-folder-ask-is-a-preference.decision.md#consequences),
"a machine on the default accumulates none").

So without a rule for the switch, turning the ask on would stop collection
in every folder the user works in, in every client, and stop the rows
already cached from those folders from exporting
([LLP 0070 #enforce](./0070-local-only-export-seam.decision.md#enforce)). Only
Claude Code would ask about each one. Everywhere else the data would simply
stop, and the user chose a setting labelled as being about *new* folders.

## Options {#options}

1. **Do nothing.** Every existing folder goes dark until marked. Simple, and
   a surprise that looks like a broken install.
2. **Show the list and ask about each folder at the switch.** Most control,
   and it is the enrollment privacy review
   ([LLP 0100](./0100-enrollment-privacy-review.spec.md)) again, forced on a
   user who asked for one setting.
3. **Mark the folders already recorded as `sync`** (chosen). They were
   already being collected and synced, so the marking records what was true
   and changes nothing about them.

## Decision {#decision}

<a id="rule"></a>**On the transition from `sync` to `ask`, every folder that
has recorded rows and no governing source gets an explicit `full` entry**
in the machine-local store
([LLP 0103](./0103-machine-local-policy-classes.decision.md)). Both writers
of the preference do it: the wizard's new-folder step and
`hyp privacy folders ask`.

<a id="only-on-transition"></a>**Only the transition does it.** Setting
`ask` on a machine already on `ask` writes nothing. A folder first seen
after the switch is new, and waits for an answer like any other.

<a id="explicit-wins"></a>**Folders with a marking are left alone.** A
folder governed by a `.hypignore` file or an existing machine-local entry
keeps its class. Nothing `local-only` or `ignore` becomes `sync`.

<a id="not-home"></a>**The home directory and anything above it are not
marked.** An entry governs everything beneath it. A session once run from
the home directory would otherwise mark home as `sync`, and that one entry
would answer for every folder the user ever creates. Those folders stay
unanswered, so the ask keeps its meaning. The same reasoning drops a folder
whose ancestor is already being marked: one entry per tree.

<a id="said"></a>**The switch says what it did.** It prints how many folders
it marked and how to review them (`hyp privacy list`), and `--json` carries
the count. A user who wanted option 2 can prune the list with
`hyp privacy unset <path>`.

<a id="fail-closed"></a>**If the folders cannot be listed or the entries
cannot be written, the mode does not change.** The switch fails and names
the reason. A half-applied switch would be option 1 by accident.

## Consequences {#consequences}

- After the switch, nothing the user already works in stops. `ask` means
  what its label says.
- The machine-local list grows by one entry per recorded folder, once. It
  is bounded by the number of distinct folders in the cache.
- The marking is a statement that the folder syncs. It was true by default
  the moment before, so no folder gains reach it did not have.
- Switching back to `sync` removes nothing. The entries stay, harmless,
  because `sync` is what they say.
- CPU and memory: one read of the distinct recorded folders and one write
  of the list, at the moment a person changes a setting. Nothing is added
  to capture or export.

## References

- LLP 0070, LLP 0100, LLP 0103, LLP 0200, LLP 0622
- `src/core/usage-policy/folder_ask.js` (the preference),
  `src/core/usage-policy/local_only.js` (the machine-local list),
  `src/core/cli/wizard/folder_ask.js` (the wizard step),
  `src/core/commands/policy.js` (`hyp privacy folders`)
