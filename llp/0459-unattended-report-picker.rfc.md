# LLP 0459: The unattended report and recommendation pickers need a stated outcome

**Type:** RFC
**Status:** Draft
**Systems:** CLI, Reports
**Author:** Neutral / Claude
**Date:** 2026-09-30
**Extends:** LLP 0414 (#listing-is-the-picker: "a piped run with no id is a usage error naming the listing, not a guess" settles the run that cannot prompt; this RFC asks what the run that can prompt but is unattended does)
**Related:** LLP 0456 (the sibling question on the same commands: which client is first when no picker runs), LLP 0198 (#real-launch: the launched client takes the terminal and edits a repository), issue #2400, issue #2373, PR #2399, PR #2387

> `hyp report fix` with no recommendation id opens two listing pickers,
> "Which report?" and "Which recommendation should be fixed?". Both sit
> behind the tty gate that issue #2373 showed lies under `docker run -t`,
> a tty-allocating CI runner, tmux and expect, and neither carries the
> deadline PR #2399 put on the client pickers, so an unattended run
> draws a picker and blocks until something kills it. Unlike the client
> pickers, these two have no defined fallback to time out into: the
> command starts an agent that edits the repository, so an auto-pick
> would begin unrequested work on an arbitrary target. This RFC records
> the evidence, lays out the candidate outcomes with their costs, and
> asks for a decision. It changes no behavior by itself.

## Context {#context}

`runReportFix` (`src/core/cli/report_commands.js`) resolves its
recommendation in two ways. Given an id, it validates and fetches it.
Given none, it forks on one flag:

```js
const interactive = isTty(ctx.stdout) && isTty(ctx.stdin) && ctx.env.HYP_NO_TUI !== '1'
```

A run that fails this gate exits 2 with a usage line naming the `<id>`
argument, per LLP 0414 #listing-is-the-picker: a run that cannot prompt
must be told what to fix, never guessed for. A run that passes it
fetches the listing and asks twice, first `ask({ box: true, title:
'Which report?', ... })`, then `ask({ box: true, title: 'Which
recommendation should be fixed?', allowBack: true, ... })`, with back on
the second returning to the first. Neither call spreads a `signal`.

Issue #2373 established that this gate lies: a pty with nothing typed
into it (`docker run -t`, a tty-allocating CI runner, tmux, expect)
answers `isTTY` exactly as a human's terminal does. PR #2387 answered
that for `hyp ask`'s client picker with a deadline
(`PICK_DEADLINE_MS`, 10s, lifted by the first keypress), and PR #2399
carried the same deadline to the client pickers of `hyp report
generate` and `hyp report fix` through the shared `pickClient` helper.
Both landed as fixes without an LLP because they were
behavior-preserving in the sense that matters: an expired deadline
falls through to `launchers[0]`, the client every run that cannot
prompt already starts, so the deadline moved when an existing rule
applies and not what it is.

## Problem {#problem}

The report and recommendation pickers have no such rule to fall through
to. There is no "first recommendation" a non-interactive run takes
today; the non-interactive leg is an exit 2. And the stakes are higher
than a client pick: `hyp report fix` launches an agent that edits the
repository (LLP 0198 #real-launch, LLP 0414 #run-where-typed), so
timing out into an auto-selected report or recommendation would begin
unrequested work on a target nobody chose. Copying PR #2399's expiry
leg here is therefore not a transfer of an existing pattern but a new
rule, and each candidate below changes what some existing run observes,
which is what makes this a decision and not a patch.

Until one is chosen, `hyp report fix` with no id under an unattended
tty draws the report picker and blocks until the run is killed, the
exact shape #2373 named.

## Candidate outcomes {#candidates}

None of these is decided here.

<a id="fail-fast"></a>**1. Expiry is a usage error.** Bound the wait
with the existing deadline and, on expiry, print the same usage line
the non-interactive guard prints, naming the `<id>` argument and `hyp
report list`, and exit 2. This treats an unanswered picker as evidence
the gate misread the terminal, and converges the two legs: every run
nobody is answering ends the same way, with the same repair. Cost: an
attended user who reads the listing for the full deadline without a
keypress is handed an error for a command that did nothing wrong, and
exit 2 in a script that allocated a tty may fail a pipeline where a
quiet no-op would not.

<a id="expiry-as-cancel"></a>**2. Expiry is a cancel.** Bound the wait
and, on expiry, take the path escape already takes on both pickers:
`Nothing started.`, exit 0. Cheapest to explain (silence declines, as a
person's escape does) and harmless to rerun. Cost: it reads an absence
as a decline, which PR #2399's own rationale rejected for the client
picker ("an expired deadline is answered apart from a cancel because
it is not one"), and exit 0 tells a script that expected a fix to
start that nothing is wrong. It also needs a scope rule the
single-picker deadline never did: whether the 10s covers each ask or
the report-and-recommendation pair together, and whether a keypress on
the first picker lifts the deadline for the second.

<a id="leave-unbounded"></a>**3. Leave them unbounded and say so.**
Document that `hyp report fix` without an id requires an answering
terminal, and point unattended callers at the id form the command
already prefers. No behavior changes and no deadline semantics are
invented for a two-picker loop. Cost: the #2373 hang stays reachable on
two pickers in the release surface, the acceptance condition on issue
#2400 (bounded termination) is declined rather than met, and the
documentation carries the burden the gate cannot.

Any deadline chosen under candidates 1 or 2 inherits the two known
residuals of the PR #2387 pattern that issues #2391 and #2392 record.

## Decision requested {#decision-requested}

Which outcome an expired wait on the report and recommendation pickers
produces: the usage error the non-interactive leg already prints (exit
2), the cancel the escape legs already print (exit 0), or the status
quo, documented. If a deadline lands, its scope across the two chained
pickers should be stated where the rule is recorded.

## Open questions {#open-questions}

- Does the exit code follow the guard (2, "this run could not be told
  what to fix") or the cancel (0, "nothing was declined and nothing
  started")? The two legs exist today and disagree.
- Should the same rule cover any future listing picker with no
  fallback, so the next one does not reopen this fork?
- Does the resolution fold into the rework of the tty gate itself that
  issue #2373's body suggests, which would retire the question for all
  pickers at once?

## References

- [LLP 0414](./0414-a-recommendation-is-a-verb.decision.md) #listing-is-the-picker, #run-where-typed
- [LLP 0456](./0456-non-interactive-client-pick.rfc.md)
- [LLP 0198](./0198-setup-ends-on-a-question.decision.md) #real-launch
- Issue #2400; issue #2373; issues #2391 and #2392 (the deadline pattern's recorded residuals); PR #2399; PR #2387
