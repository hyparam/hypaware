# LLP 0200: New folders sync by default; the per-folder ask is opt-in

**Type:** Decision
**Status:** Draft
**Systems:** Onboarding, Usage-Policy, CLI
**Author:** Brendan / Claude
**Date:** 2026-08-07
**Related:** LLP 0106 (the session-start classification hook this makes opt-in), LLP 0103 (the machine-local class store, untouched), LLP 0105 (#unknown: the query-seam backstop, untouched), LLP 0111 (the `policy` verb surface this extends), LLP 0113 (the ask's menu presentation), LLP 0188 (#opt-out: the sibling per-client preference), LLP 0190 (#sync-gate: the neighbouring wizard step), LLP 0201 (the express gate that can answer this step)

> Extends [LLP 0106](./0106-session-start-classification-hook.decision.md).
> The hook, its copy, its enrolled-and-interactive gating, and the store its
> answers land in are unchanged. What changes is that the ask is no longer
> unconditional: a machine-local preference decides whether it happens, its
> default is "no", and the wizard asks for that preference in a step of its
> own.

## Context {#context}

[LLP 0106](./0106-session-start-classification-hook.decision.md) makes
coverage, not fallback, the answer to "unknown context": on an enrolled
machine, an interactive session in an unclassified folder is asked to
classify it before work proceeds. Every folder therefore gets an affirmed
class, and the affirmation costs one question.

That trade is right for a user who wants the control and wrong for a user
who does not. Dogfooding surfaced the second population immediately: an
engineer who works across many repos on one enrolled machine, whose answer
is "sync" every time, meets the question at the start of session after
session. The prompt is injected as `additionalContext`, so it also spends
the opening turn of each of those sessions on a decision the user already
made in general.

LLP 0106 anticipated exactly one exit: answer the question, and the folder
is never asked about again. It has no notion of answering it *standing*.
And the surface that annoys is the one surface that never mentions a way
out, so a user who wants the questions to stop has nowhere to learn that
they can.

The population that wants per-folder control is real too, and the hook
exists for them. So this is a preference with two answers, not a reversal
of the hook.

## Decision {#decision}

<a id="store"></a>**One machine-local preference decides whether the ask
happens.** `<state>/usage-policy/folder-ask.json`
(`{ version: 1, mode: 'ask' | 'sync' }`) records it. `ask` is
[LLP 0106](./0106-session-start-classification-hook.decision.md) exactly as
it shipped: one session-start question per unclassified folder. `sync`
means unclassified folders keep the implicit `full` default they already
had, and the hook stays quiet. File absence means the default below.

<a id="default"></a>**The default is `sync`: new folders sync, and nobody
is interrupted.** The ask is the opt-in half of the pair. The hook's
premise was that an unclassified folder is a question worth stopping for,
and dogfooding says it usually is not: on an enrolled machine every
configured source already syncs by default ([LLP 0188 #rule](./0188-enrolled-default-sync-with-client-optout.decision.md#rule)),
so the per-folder prompt asks the user to re-affirm, folder by folder, a
policy they accepted once at setup. Making it opt-in aligns the two: one
default, stated once, with per-folder marking available whenever it
matters.

This is a real change of default, not only a new setting: an enrolled
machine that upgrades and never touches the preference stops being asked.
The consent that fact rests on is the wizard's new-folder step
(#wizard) for machines that run setup again, plus everything that did not
move - the enrollment privacy review
([LLP 0100](./0100-enrollment-privacy-review.spec.md)), the first-sync hold
([LLP 0101](./0101-first-sync-review-window.decision.md)), `hyp policy set`,
`.hypignore`, and the export seam. What the ask ever added was a prompt,
never an enforcement.

<a id="machine-local"></a>**It is machine-local, never layered or central.**
The file sits beside `local-only.json` ([LLP 0103](./0103-machine-local-policy-classes.decision.md))
and `client-sync.json` ([LLP 0188](./0188-enrolled-default-sync-with-client-optout.decision.md#opt-out)),
survives cache rebuilds and `hyp leave`, and is never a repo dotfile. How
often a person wants to be interrupted is not an org policy, and an org that
could set it could silence a consent prompt on someone else's machine. The
org's real lever is unchanged and stronger: what the central layer carries
always syncs regardless of any of this (LLP 0188 #locked).

<a id="suppression"></a>**The preference gates the question, never a
class.** `sync` suppresses the ask; it changes no resolved class, writes no
directory entry, and moves nothing at the export or query seams. A folder
marked `local-only` or `ignore` stays so, `.hypignore` dotfiles are
untouched, and [LLP 0105 #unknown](./0105-query-seam-local-only-visibility.decision.md#unknown)'s
exclude-on-unknown backstop still governs contexts that slip through. The
one thing `sync` costs is coverage: unclassified folders stay unclassified
rather than becoming affirmed, which is precisely what the answer means.
In the hook's decision the mode is read immediately after the enrolled
check and before every per-folder reason, because it settles every folder
at once; it never outranks the enrolled check, which is what makes the
hook exist at all.

<a id="wizard"></a>**The wizard asks for it in a step of its own, after
the sync lane.** Not as a row on the sync gate: that gate answers "which
of my adapters ship" ([LLP 0188](./0188-enrolled-default-sync-with-client-optout.decision.md),
[LLP 0190 #sync-gate](./0190-wizard-defaults-gate.decision.md#sync-gate)),
and this answers "what happens the next time I work somewhere new". They
are different axes, and folding the second into the first let a
per-adapter checklist silently decide a per-folder policy. So the enrolled
itinerary gains a fourth counted lane, `folders`, between `sync` and
`finale`, on the same enrolled-only condition as the sync lane (LLP 0106
#enrolled-only: nothing forwards from a solo machine, so neither question
has stakes there).

The step offers two rows, `Sync them all` first and default, and `Ask me
about each new folder`. The answer is written either way, even when it
matches the default: the user answered a question, and a recorded answer
is what `hyp status`, `hyp policy list`, and a later re-run read back. A
re-run defaults to the standing answer, so re-entering the wizard
round-trips the preference instead of resetting it. A failed write warns
and leaves the previous mode standing; onboarding has done its
load-bearing work by then and `hyp policy folders` can set it later.
Escape steps back to the sync lane, cancel ends the run at 130 like any
other lane, and a non-interactive run never reaches it (LLP 0131
#attended-only), taking the default.

<a id="cli"></a>**`hyp policy folders [ask|sync] [--json]` is the standing
control**, the sibling of `hyp policy client` ([LLP 0188 #opt-out](./0188-enrolled-default-sync-with-client-optout.decision.md#opt-out)):
bare it reports, with a token it writes, idempotent either way. `hyp policy
list` names the mode only when it is not the default, since that output
exists to show what the user changed. `hyp status` names it either way on
an enrolled machine, because the default is the mode with data
consequences and is therefore exactly the one that must not be silent;
a solo machine, where the hook is inert, gets no line. Setting `sync`
prints what did *not* change with it, so "I stopped being asked" can never
be read as "everything now syncs".

<a id="escape-hatch"></a>**The prompt names its own off switch.** The
classification copy ([LLP 0106](./0106-session-start-classification-hook.decision.md),
presented per [LLP 0113](./0113-classification-ask-menu-presentation.decision.md))
gains a closing line teaching `hyp policy folders sync` and its reversal.
This is an addition to pinned consent copy, made deliberately: the whole
failure was that the annoying surface offered no way out, and a user who
says "stop asking me this" mid-session should be answerable there, by the
agent already holding the prompt, rather than sent to find a setting.

<a id="fail-safe"></a>**An unreadable preference resolves toward asking.**
The hook's reader never throws; a *present* file it cannot parse reads as
`ask`, not as the default. A file that exists is a preference someone set,
and the only wrong guess that costs anything is guessing "sync" for a user
who deliberately asked to be asked. One extra question is the cheap
failure. The CLI surfaces instead fail loudly and name the repair, the
same split [LLP 0049 #fail-safe](./0049-hypignore-usage-policy.spec.md#fail-safe)
uses for the stores this one neighbours.

## Consequences {#consequences}

- An enrolled machine that upgrades and never re-runs setup stops being
  asked about new folders. Nothing else about it changes: no class moves,
  nothing new syncs that was not already syncing by default, and
  `hyp status` says so on every run.
- The enrolled wizard is one step longer (pick, sync, folders, finale) and
  the express gate ([LLP 0201](./0201-express-defaults-gate.decision.md))
  can answer all three in one keypress.
- A machine on `ask` accumulates affirmed classes exactly as LLP 0106
  intended; a machine on the default accumulates none, which is the stated
  trade. The enrollment privacy review and `hyp policy set` remain the ways
  to classify anything that matters.
- `hyp policy list --json` gains a `folders` object beside `clients`, and
  `hyp status --json` a `folder_ask` field beside the withholding count.
  The byte-compatibility guarantee binds `policy show --json`
  ([LLP 0111 #show](./0111-hyp-policy-verb.design.md#show)), not these.
- Both client hooks honor the preference without either one knowing about
  it: the decision lives in the shared core module they already call, which
  is what LLP 0106 built it for.

## References

- LLP 0106, LLP 0103, LLP 0105, LLP 0111, LLP 0113, LLP 0188, LLP 0190, LLP 0201
- `src/core/usage-policy/folder_ask.js` (store),
  `src/core/usage-policy/classification.js` (the gated decision and the
  prompt copy), `src/core/cli/wizard/folder_ask.js` (the wizard step),
  `src/core/cli/wizard/steps.js` (the itinerary),
  `src/core/commands/policy.js` (`hyp policy folders`, `hyp policy list`),
  `src/core/daemon/status.js` + `src/core/commands/status.js` (the status line)
