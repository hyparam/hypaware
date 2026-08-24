# LLP 0203: setup offers the first sync, it does not only name it

**Type:** Decision
**Status:** Draft
**Systems:** Onboarding, CLI, Sinks, Usage-Policy
**Author:** Brendan / Claude
**Date:** 2026-08-07
**Related:** LLP 0101 (#no-release: the release verb this offers), LLP 0100 (R1/R2: the announced deadline and the one permitted early tick), LLP 0198 (#onboarding-list: the closing question list this sits in front of), LLP 0135 (#privacy: the narration this acts on)

> An enrolled attended `hyp init` now **asks** whether to send now or wait
> out the first-sync review window, and starts a real `hyp sync` for the
> user on "send now". Nothing about the hold, the deadline, or what
> releasing it requires changes: the release still happens through the
> unscoped, interactive `hyp sync` that [LLP 0100 R2](./0100-enrollment-privacy-review.spec.md#requirements)
> permits, with its own plan and its own confirmation. What changes is that
> setup hands the user that command instead of mentioning it.

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

<a id="offer"></a>**Setup asks, after it narrates.** On an attended,
non-cancelled, non-dry-run install that enrolled *and* carries a live hold,
the wizard renders a two-row question between the privacy narration and the
closing question list:

- **Send now** - "Runs `hyp sync`: it lists every destination and asks
  before sending."
- **Wait until `<deadline>`** - "Nothing leaves this machine before then."

Sending is first and is the default
([LLP 0299](./0299-confirm-prompts-default-to-yes.decision.md): confirms
default yes unless a bare enter would destroy data, and sending is not
destruction). The user enrolled to sync, so a bare enter takes the path they
signed up for; waiting stays one arrow away, and `hyp sync`'s own confirm
still stands between this answer and anything leaving the machine.

A bare enter, and nothing else: the default here *acts*, so the question
names waiting as its `eofValue`
([LLP 0299 §eof-declines](./0299-confirm-prompts-default-to-yes.decision.md#eof-declines)).
The child's confirm does not cover this case on its own, because it inherits
the terminal rather than the stream, and a ctrl+D on a real tty is a keypress
rather than a spent stream: it would ask again rather than decline, and a
terminal that gave up would end on a sync it started.

The narration keeps its place as the last
thing HypAware *says* about privacy
([LLP 0135 #privacy](./0135-install-experience-overhaul.design.md#privacy)),
because a question about sending is only answerable by someone who has just
been told what sending means. The question list keeps its place as the last thing
on screen ([LLP 0198 #onboarding-list](./0198-setup-ends-on-a-question.decision.md#onboarding-list)):
it is output rather than a prompt, and a prompt placed after it would arrive
under a block the reader has already started scrolling past.

The step never fails a finished install, on the same terms as the first look:
every durable action succeeded minutes earlier, so a
cancelled prompt, a failed spawn, or an unforeseen throw degrades to the wait
the user already had.

<a id="no-new-consent"></a>**The question is an offer, not the consent.**
"Send now" does not release anything by itself. It runs `hyp sync`, which
prints the destination plan, escalates its warning because the window is
open, and asks its own y/N - and only that `y` clears the marker. So
[LLP 0101 #no-release](./0101-first-sync-review-window.decision.md#no-release)
and R2 hold verbatim rather than by analogy: there is still exactly one
release path in the codebase, and this decision does not add a second.

Two prompts in a row is a real cost, and it is the right one. The wizard's
question is answerable without knowing anything (do you want to wait?); the
sync prompt is the one that can name the server, the local destinations, and
the directories being withheld. Collapsing them would mean either asking the
uninformed question and treating it as informed consent, or building a second
plan renderer inside the wizard.

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
- The narration keeps its `hyp sync` sentence even though the question now
  follows it. It is the standing control for the run that declines, and
  [LLP 0101](./0101-first-sync-review-window.decision.md) requires all three
  deadline surfaces to name it.
- `wizard.finish` gains `sync_now` (`released`, `declined`, `sync-declined`,
  `spawn-failed`, `skipped`), and the step emits a `wizard.sync_now` span
  carrying the choice, the child's exit code, and whether the marker cleared.
  The declined/released split is the measurement that says whether the
  window's default sizing matches the people in it; a high `sync-declined`
  rate would say the opposite - that the wizard's question is talking users
  into a screen they then back out of.
