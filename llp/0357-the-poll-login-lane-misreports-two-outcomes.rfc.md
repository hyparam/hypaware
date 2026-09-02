# LLP 0357: The poll login lane misreports two outcomes

**Type:** RFC
**Status:** Draft
**Systems:** CLI, Onboarding
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-09-02
**Related:** [LLP 0342](./0342-poll-login-completion.decision.md)
(#d2 the loud stale-server failure, #d3 the wire contract and its single
delivery, #d4 the security argument that rests on it),
[LLP 0179](./0179-login-lane-returns-its-outcome.decision.md)
(#outcome the reason vocabulary, #no-prose-control-flow the classification
rule), [LLP 0058](./0058-oidc-login-client.decision.md) (#d7 the refusal
taxonomy), [LLP 0129](./0129-init-wizard-fork.decision.md)
(#failed-join-returns-to-fork the fork this classification drives);
hyparam/hypaware#1165, PR #1152, hyparam/hypaware-server#402

> The poll login lane reports two outcomes that are not what happened. A
> server too old to have the poll endpoint is reported as a retriable local
> failure, so the wizard prints its try-again sentence over a fault no retry
> can clear and the CLI advises a static token against a server-version fault.
> A settled flight whose delivery the client could not read is reported as a
> timeout, because the single delivery is already spent: that loses a
> successful sign-in, and loses a real D7 refusal the same way. Both were found
> reviewing PR #1152, both reproduce on `origin/master` today, and neither has
> a fix inside the decisions that produced them: the first is foreclosed by
> LLP 0179's outcome vocabulary and LLP 0342 D3's promise that those codes are
> untouched, the second by LLP 0342 D3's single delivery, which LLP 0342 D4
> leans on for its security argument. This document states both gaps, carries
> the reproductions, and lays out the option space. It decides nothing.

## Context {#context}

[LLP 0342](./0342-poll-login-completion.decision.md) replaced the loopback
redirect with a poller: `src/core/remote/login_poll.js` polls
`GET /v1/identity/login/poll?state=` until the flight settles, behind the same
`{ waitForCode, close }` seam the receiver exposed. Everything the poller
learns leaves it as a thrown `Error`, optionally carrying a `callbackError`
property. One frame up, `remoteLogin` (`src/core/cli/remote_commands.js`)
turns that into the [LLP 0179](./0179-login-lane-returns-its-outcome.decision.md)
outcome: `loginFailureReason(callbackError)` maps the D7 refusal codes to
their own reasons and everything else to `'login_failed'`. One frame further,
`classifyLoginFailure` (`src/core/cli/wizard/join.js`) maps exactly the three
definitive refusals to `'failed'` and everything else to `'abandoned'`. Both
re-present the fork: `wizard/index.js:451` is
`if (join.status !== 'ok') { printJoinFailure(opts, join); continue }`, and
[LLP 0129](./0129-init-wizard-fork.decision.md#failed-join-returns-to-fork)
opens "A failed or abandoned join returns to the fork." What the
classification selects is the sentence `printJoinFailure` prints and the span
`ERROR_KIND` (`join.js:93`), not whether a retry is on offer.

That chain has exactly one typed channel for "terminal, but not a server
refusal", and its meaning is already spoken for: `callbackError` *is* the D7
code, so `loginFailureReason`'s `default` arm reads anything else as retriable
on purpose, because "telling a user to stop trying over a code we cannot
interpret is the worse error" (`test/core/remote-login-command.test.js`). Both
problems below are outcomes that need to travel that chain and cannot.

## Problem 1: a stale server reads as retriable {#stale-server}

LLP 0342 [D2](./0342-poll-login-completion.decision.md#d2) states the intended
behavior in one sentence: "A new client against a stale server fails loudly,
not by timeout." The loud half works; the *fails* half does not survive the
trip to the wizard.

`login_poll.js:183` throws the stale-server error with no `callbackError`,
because a `callbackError` means a D7 refusal and this is not one. Reproduced
against `origin/master` at `c0daf4e2`, driving the real poller with a fetch
stub that answers the server's generic `unknown_path` 404, then handing the
resulting error to the real `remoteLogin` and the real `classifyLoginFailure`:

```
poller message      : this server does not support poll login yet - upgrade hypaware-server
poller callbackError: undefined
remoteLogin outcome : {"exitCode":1,"reason":"login_failed"}
wizard classify     : abandoned
stderr:
  | hyp remote login: this server does not support poll login yet - upgrade hypaware-server
  |   (on a machine with no browser, pass a static token with --token-file <path> or pipe it on stdin; --no-browser prints the URL to open elsewhere)
```

Two things are wrong in that transcript, and they are separable:

1. `'abandoned'` selects the wizard's retriable sentence, "Sign-in did not
   complete. You can try again, or set up locally for now."
   (`wizard/index.js:1050`). Retrying polls the same stale server and
   lands on the same 404, so the wizard is inviting an action it could know
   cannot work. Note what this is *not*: the fork itself is re-presented for
   `'failed'` too (LLP 0129#failed-join-returns-to-fork), so the retry never
   disappears from the menu. The defect is the sentence, not the menu.
2. The headless hint prints because `remote_commands.js:736` gates it on
   `!callbackError`, reading "no server code" as "local failure, most likely a
   timeout on a box with no browser" (LLP 0058 D8). Here it advises a
   `--token-file` static token as the way around a server that is too old,
   which is unrelated to the fault and is the loudest actionable line on
   screen. LLP 0342 already retired the premise underneath that gate: its
   forward-ref on D8 says "The 'no reachable loopback' premise is retired
   along with the loopback itself" (`0058:190-194`). So the hint is stale on
   *every* poll-lane failure, not only this one; the stale server is just
   where it reads most absurdly.

Nothing is lost or unsafe: no state is written, no code is minted, and the
correct message prints on every attempt. This is interactive UX fidelity.

**Why it is not a patch.** The obvious fix, a `'no_poll_endpoint'` reason
threaded through `loginFailureReason` and classified `'failed'`, edits what two
Accepted decisions settled, in two separable places. *Adding the reason* touches
LLP 0179#outcome, which enumerates the vocabulary, and LLP 0342 D3, which
promises as part of the poll lane's contract that "`loginFailureReason` /
`explainLoginError` and the LLP 0179 outcome codes are untouched" (its
Consequences repeat it). That is the cheaper half: LLP 0179's own Consequences
already say `reason` is "a wider vocabulary than the wizard consumes today
(`'seed_failed'`, `'daemon_incomplete'`, ...)" and that this is "deliberate", so
a member the wizard does not classify on is the shape that decision anticipated.
*Classifying it definitive* is the expensive half. LLP 0179#no-prose-control-flow
states the rule as a closed set, "exactly the three refusals are `'failed'`;
everything else non-zero stays `'abandoned'`", and `classifyLoginFailure` carries
the invariant as an `@ref`: "the three definitive reasons are the D7 refusal
codes verbatim, so the split is the server's taxonomy and not a wizard-local
one". Adding a non-D7 code to the definitive set is precisely the thing that
annotation says the split is not. The options below are ordered by which of
those two halves they pay for.

### Options {#stale-server-options}

**A. A new outcome reason, classified definitive.** `'no_poll_endpoint'`
joins the LLP 0179 vocabulary; the poller tags its error so
`loginFailureReason` can see it; `classifyLoginFailure` adds it to the
`'failed'` set. Costs: it breaks the "definitive means D7" invariant, so the
`@ref` and LLP 0179's closed-set sentence both need superseding, and the split
becomes "server refusals plus one client-side judgment". It needs a channel
from the poller that is not `callbackError`, since `callbackError`'s whole
meaning is "this is a D7 code" - though that channel is nearly free: `fail()`
(`:100-112`) already takes the value as its `kind` argument and `:183` already
passes `'no_poll_endpoint'`, so it is one `Object.assign` beside the
`callbackError` one at `:110`, and the reason name this option proposes is the
string the poller already uses for this error. The real cost is the third
branch it needs in `printJoinFailure`
(`wizard/index.js:1048-1058`), which today has only `org_selection_required`
and the fallback "Joining failed: an admin needs to grant this account access
before this machine can enroll." Without that branch, classifying
`'no_poll_endpoint'` as `'failed'` sends a stale-server user to an admin for
access they already have, which is worse than the text it replaces. Buys: the
wizard names the fault instead of printing "Sign-in did not complete. You can
try again", and the `!callbackError` gate stops covering two unrelated cases.
It does not remove the retry from the fork; nothing in the wizard's control
flow can, because LLP 0129 re-presents the fork on both statuses.

**B. Reframe the definitive set as "retrying this cannot help", not "D7".**
Same code change as A, but the decision being made is about the *predicate*
rather than about one new member: `classifyLoginFailure` asks whether a bare
retry has any chance, and the three D7 refusals are simply its current members.
Costs: a wider rule invites future arguments about membership that the current
narrow rule settles by construction, and it inherits A's `printJoinFailure`
branch and its plumbing unchanged. Buys: the invariant that gets superseded is
replaced by one that generalizes, so the next terminal non-D7 outcome (a
server that removes the endpoint, say) needs no third decision.

**C. A new reason the wizard does not reclassify.** Pay only the cheaper half:
`'no_poll_endpoint'` joins the vocabulary exactly as in A, but
`classifyLoginFailure` is untouched, the outcome stays `'abandoned'`, and
`printJoinFailure`'s existing non-`'failed'` arm switches on `join.reason`
instead of printing one sentence for every retriable failure. The wiring is
already there: `join.js:94` returns `reason` on both statuses, and
`WizardJoinResult.reason` is documented as "the login lane's reason code, which
is what `printJoinFailure` branches on to name the wizard-level consequence"
(`wizard/types.d.ts:415-418`). Costs: it still needs A's (nearly free)
channel out of the poller, and it still reopens LLP 0179#outcome's enumeration
and LLP 0342 D3's "untouched" promise, so it is not a patch either; the span
`ERROR_KIND`
(`join.js:93`) keeps saying `login_abandoned` for a fault nobody abandoned;
and the definitive/retriable split stays a name that no longer describes what
the wizard does with it, since the fork returns either way. Buys: the same
wizard sentence A buys, without superseding the closed-set rule, the `@ref`
invariant, or the D7 split, and without A's `printJoinFailure` fallback
regression to repair. This is what the fork note in Problem 1 opens up: once
the classification selects only a sentence, the sentence can be selected
directly.

**D. Fix only the misleading hint.** Leave the vocabulary and the
classification alone; make the headless hint conditional on something narrower
than `!callbackError`, so a stale server does not get told to try a static
token. Costs: still needs the poller channel (A's `kind`), and the wizard keeps
printing its retriable sentence over a fault that is not retriable, so it fixes
the CLI surface and leaves the wizard one alone. It also has to be weighed
against LLP 0342's Implementation surface line, which lists
`remote_commands.js` messages as unchanged (`0342:178`). Buys: the smallest
change that removes the actively wrong advice where it is loudest, it needs no
`printJoinFailure` branch, it touches no Accepted decision's settled text (both
LLP 0179#no-prose-control-flow and LLP 0342's own retirement note on LLP 0058
D8 put this text outside the contract), and it is the one option that also
helps the timeout case, where the same stale hint prints.

**E. Nothing.** Costs: the deployment where this fires is exactly the one
LLP 0342 D2 anticipated and wrote a message for, so the tool is at its least
helpful in the case its design predicted. Buys: no decision is reopened, and
there is exactly one deployed hypaware-server (D2), which we upgrade, so the
window in which this can fire is bounded by our own deploy order.

## Problem 2: an unreadable settled response strands the login {#lost-delivery}

`login_poll.js:142` reads the body inside the `try`:

```js
response = await doFetch(pollUrl.toString(), { headers: ..., signal: controller.signal })
body = JSON.parse(await response.text())
```

The `catch` treats everything in that block as transient, which is right for a
network error and wrong for the two responses the server has already committed
to. LLP 0342 D3's table consumes the flight on both:
`200 { "status": "complete" }` is "success; **single delivery**, the flight is
consumed", and `200 { "status": "failed" }` is "a D7 refusal ...; also
consumed". So once either leaves the server it is spent whether or not the
client read it. The per-poll abort (`:136`) or a dropped socket during the body
rejects `text()`, the poller keeps polling, every later poll answers
`404 unknown_state`, and the wait ends at `:199-200` with "timed out waiting
for the browser login to complete". The sign-in succeeded; the outcome says it
did not.

Reproduced against `origin/master` at `c0daf4e2` with a fetch stub whose first
poll answers `200 complete` with a rejecting `text()` and whose later polls
answer `404 unknown_state`, exactly as a real server would after consuming the
flight:

```
poller message      : timed out waiting for the browser login to complete
remoteLogin outcome : {"exitCode":1,"reason":"login_failed"}   (the sign-in actually succeeded)
```

Nothing is leaked or corrupted: the one-time code goes unredeemed, the PKCE
verifier never leaves client memory, no token is minted, no session is written,
and re-running `hyp remote login` with a fresh flight works.

**The refusal body has the same fault, and it lands harder.** The `try` does
not distinguish the two consumed shapes, so an aborted or dropped body on a
`200 failed` loses a real D7 refusal the same way. A genuine `no_membership`
or `org_not_permitted` then reaches the wizard as "timed out waiting for the
browser login to complete", so `login_failed`, so `'abandoned'`, so "Sign-in
did not complete. You can try again." That is Problem 1's defect arriving by
Problem 2's mechanism, and it lands harder: this outcome really is definitive
under LLP 0179, and re-running cannot fix a membership the server refused. It
also constrains the options below, since A keeps a *code* redeemable and a
refusal carries no code.

### The window is wider than "a tiny JSON body takes 10 seconds" {#deadline-clamp}

The per-poll budget is not `POLL_REQUEST_TIMEOUT_MS`; it is clamped to what is
left of the overall deadline (`:135`), so the abort fires progressively sooner
as the five-minute budget runs out. A poll issued with less budget than a
round trip still reaches the server, and the server still consumes the flight
to answer it. Reproduced with a stub that hands the code over on arrival and
takes 40ms on the wire, against a poller with 15ms of budget left:

```
server deliveries consumed: 1
client outcome           : timed out waiting for the browser login to complete
```

**How wide, exactly.** Instrumenting `perPollMs` across a full run at the
shipped 2s cadence, with the wire cost held at zero, gives 151 polls, the last
six budgeted `10000, 8000, 6000, 4000, 2000, 1` ms. The final 1ms is not an
artifact of that idealization: `:204` caps the inter-poll sleep at `remaining`,
so the loop always wakes exactly on the deadline and the last poll is clamped
to the 1ms floor on every run whatever the latency. Adding a per-poll wire cost
only shifts the tail's phase, and can put the penultimate poll under a round
trip too (at 40ms per poll: 149 polls, tail `..., 2160, 120, 1`). So one poll
per login is below a plausible round trip by construction, occasionally two:
the last one is the 1ms poll #1165 recorded as harmless residue. It covers the
last ~2s of the 300s budget, which is the window a human must finish signing in
inside for this to fire, so the rate is low; what the clamp establishes is that
the condition is not only a wire fluke, because the client's own deadline
arithmetic manufactures it on every run that reaches the deadline. Readers
weighing the client-only option against the server-side ones should price it as
a narrow but systematic window, not a common one.

**Why it is not a patch.** The code is gone from the client's reach the moment
the server answers; no client-side retry can recover it, because the flight is
consumed by construction. The fix is a change to the wire contract in
LLP 0342 D3, implemented in hypaware-server (the endpoint landed in
hyparam/hypaware-server#402). D3's single delivery is also load-bearing for
D4's security argument: "Single delivery (D3) closes the replay window after
pickup", the reason no second poll secret was needed. Any option that keeps a
delivered code redeemable has to say what closes that window instead.

### Options {#lost-delivery-options}

**A. Redeemable until the code is exchanged.** The flight keeps answering
`complete` with the same `code_s` until the code is redeemed at the token
endpoint (or the flight TTL expires), instead of being consumed by the first
poll that carries it. Costs: reopens D4's replay window for the flight's
lifetime, so the argument has to move onto PKCE alone, which D4 already says
is what makes the code unredeemable ("the code is unredeemable without the
PKCE verifier, which lives only in the initiating process's memory"). The
window is then "an attacker holding `state` learns a code they cannot spend",
which is what D4 says is already true before pickup; the delta is that it stays
true for longer. Server work only.

**B. Client acknowledges the pickup.** Delivery is consumed by an explicit
ack rather than by the response that carried it. Costs: a second endpoint or a
parameter on the existing one, so it widens the surface LLP 0342 D3 kept to
exactly one endpoint; and an ack can be lost too, though when it is, the code
is already in client memory and the login proceeds, which is the fault
disappearing rather than moving. Server and client work, plus a contract
change.

**C. Stop the client aborting a body the server has committed to.** The
per-poll timer is cleared in the `finally` (`:149`), so it stays armed across
`await response.text()` and can cut a body whose headers already arrived.
Clearing it the moment `doFetch` resolves closes that half outright, with no
invented constant and no server work. Costs: half a fix, since a dropped socket
mid-body and an abort before the headers both remain; and it leaves the body
read unbounded unless it gets a bound of its own. Buys: the cheapest change on
the list, it covers the refusal half as well as the success half, and it
removes the amplifier in #deadline-clamp without having to know what a round
trip costs.

**D. Bound the client's own contribution.** Stop issuing a poll whose budget
is shorter than a plausible round trip (skip straight to the timeout instead),
and stop letting the deadline clamp shrink a poll that may already have
consumed a delivery. Costs: does not fix the race, only the amplifier in
#deadline-clamp; picks a "plausible round trip" number out of the air; the
window it closes is narrow (#deadline-clamp measures one sub-round-trip poll
per login, occasionally two); and C reaches the same amplifier more cheaply.
Buys: client-only, needs no server deploy, and unlike C it also covers a poll
whose budget expires before the headers arrive.

**E. Report it honestly.** Remember that a `200` was received and unreadable,
and end the wait with a message saying the sign-in may have completed and to
re-run, rather than a flat timeout. Costs: cosmetic in the sense that the login
still fails; a new reason code would drag in Problem 1's whole question. Buys:
the user stops being told something false about what happened, for a few lines
in one file.

**F. Nothing.** Costs: a successful sign-in occasionally reports as a failure,
and a real refusal occasionally reports as a timeout, most likely for the
slowest users. Buys: re-running recovers both (a fresh flight, and the refusal
stated properly the second time), and the failure is safe in every respect that
matters.

## What this does not cover {#not-covered}

**The two residues PR #1152's review recorded as non-findings.** The last loop
iteration can issue one 1ms-budget poll that aborts immediately before the
`remaining <= 0` throw, and `defaultSleep`'s timer survives a `close()`
mid-sleep through the `Promise.race`. Both are noted at #1165, and the second
changes nothing (no production caller closes mid-sleep). The first is the poll
#deadline-clamp measures: harmless on its own, but it is the one poll per login
that can consume a delivery it cannot read, so it is not a separate residue and
an answer at #deadline-clamp absorbs it.

**The D7 taxonomy.** Untouched. Problem 1 is about an outcome that is not a D7
refusal, and the question there is whether the chain that carries D7 codes
should also carry something else. Problem 2 does reach D7 refusals, but by
losing one in transit rather than by disputing the vocabulary: what a recovered
refusal would say is exactly what LLP 0058 D7 says today.
