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
`hyp sync` on the terminal. The sync command prints its plan (every upload target,
what is withheld), the first-sync warning (the deadline, that the send
includes imported history and cannot be undone, and how to review or exclude
something first), and asks its Y/n. Yes is the release; no is the wait.

As refined by LLP 0396#combined-selection, the accompanying file copy is not
presented as another destination on a sharing run. It still runs under the
same hold and confirmation, and failures are reported.

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
The join lane's one-line deadline stays too: it is the first moment the
deadline is true, and it is one line.

Some runs reach the step and still never see the plan: `hyp init` admits an
attended run whose stdout is a terminal and whose stdin is not
(`hyp init < file`), and nothing may prompt on a stdin like
that; a boot can fail; sync can return before rendering its plan; and an
unforeseen throw can end the step. The paragraph has already stood down by
then and nothing else on the run says any of it, so the step states the hold
itself, carrying every fact the paragraph carried rather than only the
release verb. Keeping the statement in the step rather than widening the
paragraph's gate is what keeps the two from both printing.

The question list keeps its place as the last thing on screen
([LLP 0198 #onboarding-list](./0198-setup-ends-on-a-question.decision.md#onboarding-list)):
it is output rather than a prompt, and a prompt placed after it would arrive
under a block the reader has already started scrolling past.

The step never fails a finished install, on the same terms as the first look:
every durable action succeeded minutes earlier, so a
cancelled prompt, a failed boot, or an unforeseen throw degrades to the wait
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

<a id="child-process"></a>**Sync loads the completed configuration in-process.**
The wizard's `all-available` runtime predates setup's configuration writes
and omits `@hypaware/central`. Reusing its `ctx.commands.run('sync')` would
omit the central destination from the preview. The correctness requirement
is a fresh configured runtime, not a fresh operating-system process.

Setup calls the existing `dispatch(['sync'], ...)` without an injected kernel
or registry. Dispatch reads the effective configuration from disk, activates
its configured plugins, materializes the sinks, and runs the existing sync
command. It stops boot-started sources before returning. The wizard passes
its environment and live input/output streams, after its own prompt has
resolved and restored the terminal. No output is buffered or parsed.
Stderr goes through a write-only adapter to preserve the old pipe's
non-terminal readline mode: input stays canonical, so Ctrl+C delivers SIGINT
and terminates onboarding instead of being consumed as a declined answer.
The adapter resynchronizes diagnostic coloring after the terminal echoes an
answer, whose newline does not pass through the adapter.

This replaces the subprocess implementation as of 2026-09-12. The historical
`child-process` anchor remains for existing rationale links. There is no
second Node runtime, stderr relay, pipe-close timer, or process-exit handling.

<a id="read-back"></a>**Whether it sent is read from the marker, never
inferred from the exit code.** `hyp sync` exits 0 both when it releases and
when the user reads the destination list and answers no. Setup therefore
re-reads the hold after sync returns: a marker that is gone means it sent,
and a marker still present means it did not - in which case setup says so and
restates the deadline, so a run ending on `sync cancelled` is not left
ambiguous about what still holds. An unreadable re-read is treated as "still
held", because claiming a sync happened is the one wrong answer that cannot
be corrected later.

The marker says whether it sent. It does not say why it did not, and two runs
leave it standing for opposite reasons: a user who read the destination plan
and answered no, and a `hyp sync` that found no destination and so never
rendered a plan for anyone to answer. The second exits with a code of its own
rather than 0, which is what
[LLP 0101 #no-release](./0101-first-sync-review-window.decision.md#no-release)
already requires of a release that cannot happen. Setup reads that code to pick
which closing statement to print and which outcome to report, and it reads it
before the marker, because the marker cannot contradict it: the code comes back
before sync touched an export, so nothing was sent, while an absent marker
is only weak evidence that something was ([LLP 0101](./0101-first-sync-review-window.decision.md)
makes the read fail open, so a corrupt or lapsed marker also reads as absent).
That is the same polarity as the paragraph above, not an exception to it -
"released" is the claim that has to be earned, and no other exit code earns or
forfeits it.

The no-destinations code now comes directly from the command through the
in-process dispatcher. It no longer shares a namespace with Node process
exit statuses. Boot exceptions are handled as errors; a caught command
exception returns 1. Setup therefore uses `SYNC_HELD_NO_DESTINATIONS_EXIT`
without parsing diagnostic text. The hold read-back remains conservative.

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

- A user with no privacy concern finishes setup with rows on the server by
  pressing enter, and a user who wants the window keeps it by answering `n`.
  That is the polarity of sync's own confirm
  ([LLP 0299](./0299-confirm-prompts-default-to-yes.decision.md)); the
  deleted wizard select's enter meant the opposite, and this decision no
  longer puts it in front.
- On the attended path the deadline is stated twice per run (the join
  lane's line and the sync plan's warning) and asked about once. The
  declining run still ends on a line that restates the deadline and names
  `hyp sync`, since sync's own prompt scrolls away with its answer, and
  [LLP 0101](./0101-first-sync-review-window.decision.md) requires the
  deadline surfaces to name the release verb.
- [LLP 0100 R1](./0100-enrollment-privacy-review.spec.md#requirements)'s
  review hint (the `hypaware-privacy` skill) rides the sync plan's warning on
  this path, so the warning names the skill alongside `hyp privacy set`.
- `wizard.finish` gains `sync_now` (`released`, `sync-declined`,
  `sync-failed`, `no-destinations`, `skipped`), and the step
  emits a `wizard.sync_now` span carrying the command's return code and whether
  the marker cleared. The declined/released split is the measurement that says
  whether the window's default sizing matches the people in it, which is why
  a command that returned non-zero is `sync-failed` rather than a decline: it
  never reached its plan, and counting it as one would inflate the rate this
  step exists to measure. `no-destinations` is carved out of `sync-failed`
  for the opposite reason: that run did not break, it had nowhere to send,
  and its closing statement says so rather than restating a deadline as if a
  destination existed.
