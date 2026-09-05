# LLP 0203: setup offers the first sync, it does not only name it

**Type:** Decision
**Status:** Draft
**Systems:** Onboarding, CLI, Sinks, Usage-Policy
**Author:** Brendan / Claude
**Date:** 2026-08-07
**Related:** LLP 0101 (#no-release: the release verb this offers), LLP 0100 (R1/R2: the announced deadline and the one permitted early tick), LLP 0198 (#onboarding-list: the closing question list this sits in front of), LLP 0135 (#privacy: the narration this acts on)

> An enrolled attended `hyp init` now starts a real `hyp sync` for the
> user at its close, and that command's plan and confirmation are the one
> question about the first sync: yes sends, no keeps the review window.
> Nothing about the hold, the deadline, or what releasing it requires
> changes: the release still happens through the unscoped, interactive
> `hyp sync` that [LLP 0100 R2](./0100-enrollment-privacy-review.spec.md#requirements)
> permits. What changes is that setup hands the user that prompt instead of
> mentioning the command, and asks nothing of its own ahead of it.
>
> *(amended 2026-09-05: the first version put a two-row send-now/wait menu
> of the wizard's own in front of the child's prompt, and kept a privacy
> paragraph ahead of both. The attended path then stated the deadline four
> times and asked twice. The menu and the paragraph are gone from the
> attended path; the child's informed prompt is the only one.)*

## Context {#context}

[LLP 0101 #no-release](./0101-first-sync-review-window.decision.md#no-release)
already conceded the case this finishes. Its 2026-07-27 amendment recorded
that on an attended onboarding the hold "blocks the demonstration that the
product works at all, and the person running it has no way to say *I have
seen enough*", and minted `hyp sync` as the way to say it.

The amendment stopped one step short. The wizard's privacy narration names
the verb in its fifth and sixth lines - "To send it sooner, run `hyp sync`" -
and then setup moves straight on to its closing question list
([LLP 0198](./0198-setup-ends-on-a-question.decision.md)) and exits. The user
who has no privacy concern and wants their history on the server tonight has
to notice a sentence in a six-line block, remember a command, and come back to
it after setup has already ended. That is the same activation gap 0198 was
written about, one screen earlier: the information was already there, and the
action was not.

The population this matters for is not hypothetical. The review window
defaults to hours precisely because a careful reviewer needs them; a user who
enrolled a work laptop into their own team's server has nothing to review and
experiences the window as the product not working yet.

## Decision {#decision}

<a id="offer"></a>**Setup runs the release's own prompt, once.** On an
attended, non-cancelled, non-dry-run install that enrolled *and* carries a
live hold, the wizard prints one lead line after the first look and starts
`hyp sync` on the terminal. The child prints its plan (every destination,
what is withheld), the first-sync warning (the deadline, that the send
includes imported history and cannot be undone, and how to review or exclude
something first), and asks its Y/n. Yes is the release; no is the wait.

Sending is the default of that prompt
([LLP 0299](./0299-confirm-prompts-default-to-yes.decision.md): confirms
default yes unless a bare enter would destroy data, and sending is not
destruction). The user enrolled to sync, so a bare enter takes the path they
signed up for, after seeing what it sends.

The wizard's own privacy paragraph stands down on this path: with the plan
about to state the deadline, the backfill, and the review hint and then ask,
the paragraph said each of them one screen earlier. It stays on every path
the offer cannot reach at all (an abort, a non-interactive run, a dry run),
where it is the only sighting of the deadline and the way out
([LLP 0188 #never-silent](./0188-enrolled-default-sync-with-client-optout.decision.md#never-silent)).

One path is attended and still cannot be asked: `hyp init` admits a run
whose stdout is a terminal and whose stdin is not (`hyp init < file`), and
nothing may be spawned to prompt on a stdin like that. The paragraph has
already stood down by then, so the step states the hold itself, carrying
every fact the paragraph carried rather than only the release verb. Keeping
the statement in the step rather than widening the paragraph's gate is what
keeps the two from both printing.
The join lane's one-line deadline stays too: it is the first moment the
deadline is true, and it is one line.

The question list keeps its place as the last thing on screen
([LLP 0198 #onboarding-list](./0198-setup-ends-on-a-question.decision.md#onboarding-list)):
it is output rather than a prompt, and a prompt placed after it would arrive
under a block the reader has already started scrolling past.

The step never fails a finished install, on the same terms as the first look:
every durable action succeeded minutes earlier, so a
cancelled prompt, a failed spawn, or an unforeseen throw degrades to the wait
the user already had.

<a id="no-new-consent"></a>**The wizard adds no consent surface of its
own.** Only `hyp sync`'s `y`, given under its plan, clears the marker. So
[LLP 0101 #no-release](./0101-first-sync-review-window.decision.md#no-release)
and R2 hold verbatim rather than by analogy: there is still exactly one
release path in the codebase, and this decision does not add a second.

The first version of this decision put a wizard question ("send now, or
wait?") in front of the child's prompt, on the reasoning that the wizard's
question was answerable without knowing anything and the child's was the
informed one, so collapsing them would mean treating the uninformed answer
as consent or building a second plan renderer. There was a third option it
did not weigh: run the informed prompt directly and let its no be the wait.
That asks the informed question exactly once, builds nothing, and drops the
menu whose only job was to decide whether to show the real question. A user
who does not want to see the plan presses n.

<a id="child-process"></a>**The sync runs in a child process, and that is a
correctness requirement rather than a convenience.** `hyp init` boots the
`all-available` profile, which withholds `@hypaware/central` even when the
effective config names it, because a CLI boot must not acquire a server
identity while materializing a sink. The wizard's own process therefore has
no central sink handle: an in-process `ctx.commands.run('sync')` would render
a plan omitting the one destination the release exists to unblock - precisely
the misleading artifact R2 requires the plan to prevent, and the same reason
`hyp sync <instance>` refuses to release at all.

So the step spawns `bin/hypaware.js sync` with `process.execPath` and
`stdio: 'inherit'`. The child boots from the config setup just wrote and sees
the real sink set. Inheriting the terminal is safe for the reason
[LLP 0198 #real-launch](./0198-setup-ends-on-a-question.decision.md#real-launch)
establishes for `hyp ask`'s own spawn: the wizard's own prompt has resolved, so
raw mode and the cursor are restored before the child draws anything. This step
is now the only place onboarding hands the terminal to a child at all.

<a id="read-back"></a>**Whether it sent is read from the marker, never
inferred from the exit code.** `hyp sync` exits 0 both when it releases and
when the user reads the destination list and answers no. Setup therefore
re-reads the hold after the child exits: a marker that is gone means it sent,
and a marker still present means it did not - in which case setup says so and
restates the deadline, so a run ending on `sync cancelled` is not left
ambiguous about what still holds. An unreadable re-read is treated as "still
held", because claiming a sync happened is the one wrong answer that cannot
be corrected later.

## Why not {#why-not}

- **Ask before the finale, with the other questions.** Rejected: at that
  point nothing has been backfilled or captured yet, so "send now" would be a
  question about an empty cache, and the deadline the answer is relative to
  has not been printed.
- **Clear the hold directly on "send now" and let the daemon's next tick
  forward.** Rejected: it needs an amendment to R2 and 0101 #no-release, and
  it buys that by asking for consent on a screen that cannot show the
  destinations. The whole reason the release is `hyp sync`-shaped is the
  plan.
- **Frame the question the way `hyp ask`'s menu is framed
  ([LLP 0198 #frame](./0198-setup-ends-on-a-question.decision.md#frame)).**
  Rejected: the frame is not a wizard idiom. It marks the interactive menu of
  an explicit command against that same command's plain printed output, and
  onboarding draws no framed block at all. This question arrives on a screen of
  its own like every other wizard prompt, where a border separates it from
  nothing.
- **Offer it on the abort path too** (`narrateEnrolledAbort`). Rejected: an
  abort means "get me out", not "ask me differently"
  ([LLP 0190 #abort-narration](./0190-wizard-defaults-gate.decision.md#abort-narration)),
  and the narration there already names the standing control.
- **Show the offer on an unenrolled install.** Cannot arise: the offer is
  keyed on a live hold, and only an attended enrolling login writes one.

## Consequences {#consequences}

- A user with no privacy concern finishes setup with rows on the server, and
  a user who wants the window keeps it by pressing enter.
- On the attended path the deadline is stated twice per run (the join
  lane's line and the sync plan's warning) and asked about once. The
  declining run still ends on a line that restates the deadline and names
  `hyp sync`, since the child's own prompt scrolls away with its answer, and
  [LLP 0101](./0101-first-sync-review-window.decision.md) requires the
  deadline surfaces to name the release verb.
- [LLP 0100 R1](./0100-enrollment-privacy-review.spec.md#requirements)'s
  review hint (the `hypaware-privacy` skill) rides the sync plan's warning on
  this path, so the warning names the skill alongside `hyp privacy set`.
- `wizard.finish` gains `sync_now` (`released`, `sync-declined`,
  `spawn-failed`, `skipped`), and the step emits a `wizard.sync_now` span
  carrying the child's exit code and whether the marker cleared. The
  declined/released split is the measurement that says whether the window's
  default sizing matches the people in it.
