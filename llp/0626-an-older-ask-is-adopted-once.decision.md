# LLP 0626: An ask set on an older version is adopted once, keeping its recorded folders

**Type:** Decision
**Status:** Draft
**Systems:** Usage-Policy, Onboarding, CLI
**Author:** Phil / Claude
**Date:** 2026-11-24
**Extends:** LLP 0623 (#only-on-transition: what counts as the transition)
**Related:** LLP 0200 (the folder ask as older versions shipped it), LLP 0622 (the rule that changes what `ask` means), LLP 0625 (the no-folder half of that rule), LLP 0070 (#enforce: the export seam)

> A machine that chose `ask` on an older version had a question, not a
> rule. The first time this version's daemon starts there, the folders the
> machine already records are marked `sync`, once, and only then does the
> rule apply. Chosen over applying the rule at upgrade with a release note.

## Context {#context}

Released versions already offer `ask`
([LLP 0200](./0200-folder-ask-is-a-preference.decision.md)). There it only
asks: a folder nobody answered for is still collected.
[LLP 0622](./0622-ask-mode-collects-nothing-from-an-unmarked-folder.decision.md)
makes the same setting a rule. A machine already on `ask` would, on
upgrade and with no warning:

- stop collecting every folder nobody answered for, which is every folder
  used from a client that never asks, and every folder where the question
  was skipped, and
- never export the rows it had captured from those folders and not yet
  sent, because the export seam judges each row by its folder as it stands
  ([LLP 0070 #enforce](./0070-local-only-export-seam.decision.md#enforce)).

[LLP 0623](./0623-turning-the-folder-ask-on-keeps-recorded-folders.decision.md)
keeps recorded folders only on a switch from `sync`. A machine already on
`ask` never makes that switch, and running `hyp privacy folders ask` again
marked nothing. Both reviews of the change found this independently.

## Options {#options}

1. **Run the keep step once for such a machine** (chosen): folders with
   rows and no marking become `sync`, which is how they behaved.
2. **Leave it and say so in the release notes.** A privacy setting that
   silently drops data on upgrade, explained in a place most users do not
   read.
3. **Mark those folders `local-only` instead.** Nothing leaves the machine,
   and the rows not yet sent still never go after a later "sync" answer.

## Decision {#decision}

<a id="stamp"></a>**The preference says which `ask` it is.** Every `ask`
this version writes carries `enforced: true` in the preference file. The
file's version stays 1 and the stamp is one extra key, so an older build
still reads the file. The rules of LLP 0622 and LLP 0625 apply only to a
stamped `ask`. An `ask` with no stamp was written by an older version and
keeps that version's meaning: the question is asked, and folders are still
collected.

<a id="rule"></a>**The daemon adopts an unstamped `ask` when it starts.**
It runs the keep step of LLP 0623 (every folder with recorded rows and no
governing source gets an explicit `full` entry) and then writes the stamp.
`hyp privacy folders ask` and setup do the same: the transition that
triggers the keep step is "not already a stamped `ask`", which covers both
a switch from `sync` and an older `ask`.

<a id="once"></a>**The stamp is the done record.** There is no separate
marker. A stamped `ask` is never adopted again, so a later start marks
nothing, and a folder first seen after adoption waits for an answer like
any other.

<a id="fail-open-until-adopted"></a>**Nothing is enforced before the keep
step has run.** If the keep step fails (the cache cannot be listed, the
list cannot be written), the preference stays unstamped, the failure is
logged, and the next start tries again. In between the machine behaves as
it did on the older version. This is the one place the folder ask resolves
toward collecting, and it is bounded to a preference this version did not
write.

<a id="unreadable"></a>**A preference that cannot be read is not adopted.**
It already resolves as not collected
([LLP 0622 #fail-safe](./0622-ask-mode-collects-nothing-from-an-unmarked-folder.decision.md#fail-safe)),
and there is no older behavior to preserve from bytes nobody can parse.

<a id="said"></a>**`hyp status` says when adoption is pending.** Between
the upgrade and the daemon's next start, the status line reports that new
folders are asked about and still collected, not that they wait.

## Consequences {#consequences}

- Upgrading with `ask` already on changes nothing for folders the machine
  has recorded. Rows captured and not yet sent are still sent.
- The limits of the keep step carry over: the home directory and its
  ancestors are not marked
  ([LLP 0623 #not-home](./0623-turning-the-folder-ask-on-keeps-recorded-folders.decision.md#not-home)),
  and a folder whose only rows are still in the write-ahead spool at that
  moment is missed.
- A downgrade reads the stamped file as a plain `ask`.
- CPU and memory: one small file read at daemon start. The keep step runs
  once per machine.

## References

- LLP 0070, LLP 0200, LLP 0622, LLP 0623, LLP 0625
- `src/core/usage-policy/folder_ask.js` (the stamp),
  `src/core/usage-policy/classification.js` (`adoptLegacyFolderAsk`,
  `switchFolderAskMode`), `src/core/daemon/runtime.js` (the call at start),
  `src/core/query/recorded_folders.js` (the folder list)
