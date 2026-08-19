# LLP 0279: The wizard's question lanes record with the config, and accepting a default never retires a standing answer

**Type:** Decision
**Status:** Accepted
**Systems:** Onboarding, CLI, Privacy
**Author:** Brendan / Claude
**Date:** 2026-08-19
**Related:** LLP 0190 (#commit-point: the commit point this completes, and the exception it carved out), LLP 0188 (#never-silent, #opt-out, #migration: the store this writes and what its absence means), LLP 0200 (#wizard, #default: the new-folder lane), LLP 0201 (#gate, #narrate: the express gate whose accept this pins), LLP 0191 (#back-edges: the re-answering this has to survive)

> Extends [LLP 0190 §commit-point](./0190-wizard-defaults-gate.decision.md#commit-point).
> The commit point is unchanged; what changes is that the sync lane's
> `client-sync.json` write and the new-folder lane's preference write ride
> it too, instead of landing the moment their lane is answered. Also pins
> what LLP 0201's express accept means for a lane whose default is a
> standing answer.

## The problem {#problem}

[LLP 0190 §commit-point](./0190-wizard-defaults-gate.decision.md#commit-point)
moved the config write past the question lanes so that "a cancel at the
sync lane leaves the existing config untouched". It carved out one
exception, in a single line: "The sync lane's `client-sync.json` write
still precedes the commit; a store entry for a source whose config never
lands is inert and errs toward under-sync."

That reasoning holds for exactly one direction of one lane. Three things
it does not cover:

1. **The store is an editor, not an append log.** On a re-run the sync
   menu can *un*-check nothing and *check* a source that was opted out
   before, which removes a `local-only` entry. Decline the overwrite
   confirm that follows and the machine is left syncing a source the user
   never got to keep off, told only "keeping existing config at ...". That
   is the over-sync direction, and LLP 0188 #migration's "safe direction"
   argument does not reach it.
2. **Absence is a signal.** `readClientSyncEntries` returns `null` for a
   missing file and `[]` for an empty one, because absence is LLP 0188
   #migration's marker for a machine that predates default-sync. So even
   the "inert" write is a state change: it stamps the machine.
3. **The new-folder lane was never considered.** LLP 0200's lane
   (`writeFolderAskMode`) landed after LLP 0190 and inherited the same
   write-on-answer shape without the sentence that justified it. It is a
   per-folder question policy, not an opt-out list, and nothing about it
   errs toward under-sync.

A second defect sits in the same pair of lanes. The express gate
([LLP 0201 §gate](./0201-express-defaults-gate.decision.md#gate)) "accepts
every lane's stated default". The sync lane's auto-accept arm honors that:
it returns the opt-outs already standing. The new-folder lane's arm
recorded `DEFAULT_FOLDER_ASK_MODE` instead, so a user who had set
`hyp policy folders ask`, re-ran `hyp init`, and took the express gate had
their per-folder question turned off - by a screen offering to accept the
defaults, on a lane whose own asked screen deliberately defaults to the
standing answer.

## Decision {#decision}

<a id="one-commit-point"></a>**A run's answers are recorded together or
not at all.** The sync lane and the new-folder lane take a `deferWrite`
flag, exactly as the pick lane does: they answer, they state their answer
on screen, and they hand their write back to the orchestrator as a
`commit`. The orchestrator runs both immediately after
`commitWizardPickedConfig` succeeds, and runs neither when it does not.
Order: pick questions, sync questions, new-folder question, overwrite
confirm, config write, `client-sync.json`, `folder-ask.json`, configure,
finale.

The **statement** stays with the lane that produced it. Only the write
moves. The lanes' statements are the never-silent floor
([LLP 0188 §never-silent](./0188-enrolled-default-sync-with-client-optout.decision.md#never-silent))
and, on the express path,
[LLP 0201 §narrate](./0201-express-defaults-gate.decision.md#narrate) binds
each one to its own block ("Syncing them all" is one more indented line
under "When you start a session in a new folder:"). Deferring the printing
too would have floated those lines out from under their titles and behind
the overwrite confirm.

That leaves a refusal with two statements on screen that no longer
describe the machine, so **a refusal says what else it dropped**: after
the "keeping existing config at ..." line, the wizard names the held
answers it did not record ("the sync and new-folder answers from this run
were not recorded either"), listing only the lanes that actually asked -
a sync lane that rendered a statement rather than a question had no answer
to lose.

The held writes are **re-assigned, never accumulated**. Back navigation
(LLP 0191 #back-edges) re-runs the lanes, and only the last answer is the
one to write; a pass that never reaches the lanes clears them, so a back
through the fork onto a solo local run cannot carry an earlier pass's
answers forward.

A deferred write that *fails* warns and leaves the previous state
standing. For the new-folder lane that is exactly what the inline write
did, and its `commit` resolves to the mode actually left in force, which
is what the run's finish log records. The sync lane's deferred `commit`
takes the same contract even though its inline write throws: by the time
it runs, the config is on disk and the run still owes the new-folder
lane's write, the configure phase, and the finale, so a throw there would
abandon the run half-done. The inline write runs before anything has been
committed and keeps throwing.

<a id="standing-answer"></a>**Accepting a default never retires a standing
answer.** LLP 0201's accept takes each lane's *stated* default. For the
new-folder lane that is `before`, the mode already in force - the same
value its asked screen puts on `default:`, for the reason its comment
gives: "a re-run defaults to the standing answer, so re-entering the
wizard round-trips the preference instead of resetting it". The
auto-accept arm now records `before` rather than
`DEFAULT_FOLDER_ASK_MODE`, which changes nothing on a first run (where
`before` *is* the shipped default) and stops the express gate from being
the one screen that silently reverses a privacy-adjacent preference.

The gate's own line follows the answer. The accept row's single line of
consequence is the one thing the fast path is guaranteed to read, so it
states the standing answer: "new folders keep asking" on a machine set to
`ask`, "new folders sync too" otherwise. The orchestrator reads the mode
once, before the gate, through the safe read.

Rejected: leaving the express arm on the shipped default and instead
warning that it overrode a standing preference (the wizard does not
answer its own questions, and a gate labelled "accept the defaults" that
changes an existing answer is not accepting anything). Also rejected:
moving the lanes' statements to commit time so the write and its receipt
stay adjacent (it breaks LLP 0201 #narrate's blocks and puts a lane's
answer under the overwrite confirm, where it reads as a consequence of
the confirm).

## Consequences {#consequences}

- A declined overwrite is now a true no-op: config, `client-sync.json`,
  and `folder-ask.json` are all as the run found them, and the run says
  so.
- `client-sync.json` absence keeps meaning what LLP 0188 #migration says
  it means. An abandoned run no longer stamps a machine as migrated.
- Direct callers of either lane without `deferWrite` keep the inline
  write, so the lanes stay usable on their own exactly as `runWizardPick`
  does.
- A machine with `hyp policy folders ask` can re-run `hyp init` and take
  the express gate without losing the per-folder question.
- The finish log's `folder_ask` attribute is now read from the committed
  write rather than the answer, so a failed write is visible in telemetry
  as the mode that stands.

## References

- LLP 0190, LLP 0188, LLP 0200, LLP 0201, LLP 0191
- `src/core/cli/wizard/index.js` (the commit point and the held writes),
  `src/core/cli/wizard/sync_scope.js`, `src/core/cli/wizard/folder_ask.js`,
  `src/core/cli/wizard/express.js` (the accept row's line),
  `src/core/cli/wizard/types.d.ts`
