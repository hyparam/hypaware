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
> failure, so the wizard invites a retry that fails identically forever and the
> CLI advises a static token against a server-version fault. A
> sign-in that *succeeded* but whose delivery the client could not read is
> reported as a timeout, because the single delivery is already spent. Both
> were found reviewing PR #1152, both reproduce on `origin/master` today, and
> neither has a fix inside the decisions that produced them: the first is
> foreclosed by LLP 0179's classification rule and LLP 0342 D3's promise that
> the outcome codes are untouched, the second by LLP 0342 D3's single delivery,
> which LLP 0342 D4 leans on for its security argument. This document states
> both gaps, carries the reproductions, and lays out the option space. It
> decides nothing.

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

That chain has exactly one channel for "terminal, but not a server refusal",
and it is the one LLP 0179 deliberately closed: `callbackError` is the D7 code,
and the `default` arm reads an unmodeled code as retriable on purpose, because
"telling a user to stop trying over a code we cannot interpret is the worse
error" (`test/core/remote-login-command.test.js`). Both problems below are
outcomes that need to travel that chain and cannot.

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
   screen.

Nothing is lost or unsafe: no state is written, no code is minted, and the
correct message prints on every attempt. This is interactive UX fidelity.

**Why it is not a patch.** The obvious fix, a `'no_poll_endpoint'` reason
threaded through `loginFailureReason` and classified `'failed'`, edits what two
Accepted decisions settled. LLP 0179#outcome enumerates the reason vocabulary,
and its Decision states the classification rule as a closed set: "exactly the
three refusals are `'failed'`; everything else non-zero stays `'abandoned'`".
LLP 0342 D3 then promises, as part of the poll lane's contract, that
"`loginFailureReason` / `explainLoginError` and the LLP 0179 outcome codes are
untouched", and its Consequences repeat it. `classifyLoginFailure` carries the
invariant as an `@ref`: "the three definitive reasons are the D7 refusal codes
verbatim, so the split is the server's taxonomy and not a wizard-local one".
Adding a non-D7 code to the definitive set is precisely the thing that
annotation says the split is not.

### Options {#stale-server-options}

**A. A new outcome reason, classified definitive.** `'no_poll_endpoint'`
joins the LLP 0179 vocabulary; the poller tags its error so
`loginFailureReason` can see it; `classifyLoginFailure` adds it to the
`'failed'` set. Costs: it breaks the "definitive means D7" invariant, so the
`@ref` and LLP 0179's closed-set sentence both need superseding, and the split
becomes "server refusals plus one client-side judgment". It also needs a
channel from the poller that is not `callbackError`, since `callbackError`'s
whole meaning is "this is a D7 code" (a distinct error property, or an error
subclass). And it needs a third branch in `printJoinFailure`
(`wizard/index.js:1048-1058`), which today has only `org_selection_required`
and the fallback "Joining failed: an admin needs to grant this account access
before this machine can enroll." Without that branch, classifying
`'no_poll_endpoint'` as `'failed'` sends a stale-server user to an admin for
access they already have, which is worse than the text it replaces. Buys: the
wizard says what actually happened instead of inviting a retry, and the
`!callbackError` gate stops covering two unrelated cases. It does not remove
the retry from the fork; nothing in the wizard's control flow can, because
LLP 0129 re-presents the fork on both statuses.

**B. Reframe the definitive set as "retrying this cannot help", not "D7".**
Same code change as A, but the decision being made is about the *predicate*
rather than about one new member: `classifyLoginFailure` asks whether a bare
retry has any chance, and the three D7 refusals are simply its current members.
Costs: a wider rule invites future arguments about membership that the current
narrow rule settles by construction, and it inherits A's `printJoinFailure`
branch and its plumbing unchanged. Buys: the invariant that gets superseded is
replaced by one that generalizes, so the next terminal non-D7 outcome (a
server that removes the endpoint, say) needs no third decision.

**C. Fix only the misleading hint.** Leave the vocabulary and the
classification alone; make the headless hint conditional on something narrower
than `!callbackError`, so a stale server does not get told to try a static
token. Costs: still needs a channel from the poller for "not a browser
problem", so it pays most of A's plumbing for half the fix, and the wizard
keeps printing its retriable sentence over a fault that is not retriable.
Buys: the smallest change that removes the actively wrong advice on the CLI
surface where it is loudest, it needs no `printJoinFailure` branch, and it
touches no Accepted decision's settled text,
since LLP 0179#no-prose-control-flow puts messages explicitly outside the
contract.

**D. Nothing.** Costs: the deployment where this fires is exactly the one
LLP 0342 D2 anticipated and wrote a message for, so the tool is at its least
helpful in the case its design predicted. Buys: no decision is reopened, and
there is exactly one deployed hypaware-server (D2), which we upgrade, so the
window in which this can fire is bounded by our own deploy order.

## Problem 2: an unreadable `200 complete` strands a successful login {#lost-delivery}

`login_poll.js:142` reads the body inside the `try`:

```js
response = await doFetch(pollUrl.toString(), { headers: ..., signal: controller.signal })
body = JSON.parse(await response.text())
```

The `catch` treats everything in that block as transient, which is right for a
network error and wrong for exactly one case: the response the server has
already committed to. The server's delivery is single-shot
(LLP 0342 D3: "success; **single delivery**, the flight is consumed"), so once
the `200 complete` leaves the server the code is spent whether or not the
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
shipped 2s cadence gives 151 polls, the last six budgeted
`10000, 8000, 6000, 4000, 2000, 1` ms. So exactly one poll per login falls
below a plausible round trip: the final one, the 1ms poll #1165 recorded as
harmless residue. It covers the last ~2s of the 300s budget, which is the
window a human must finish signing in inside for this to fire, so the rate is
low; what the clamp establishes is that the condition is not only a wire
fluke, because the client's own deadline arithmetic manufactures it on every
run that reaches the deadline. Readers weighing the client-only option against
the server-side ones should price it as a narrow but systematic window, not a
common one.

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

**C. Bound the client's own contribution.** Stop issuing a poll whose budget
is shorter than a plausible round trip (skip straight to the timeout instead),
and stop letting the deadline clamp shrink a poll that may already have
consumed a delivery. Costs: does not fix the race, only the amplifier in
#deadline-clamp; picks a "plausible round trip" number out of the air; and the
window it closes is narrow (#deadline-clamp measures one sub-round-trip poll
per login). Buys: client-only, needs no server deploy, and removes the one
end-of-budget case the client creates for itself on every run that reaches the
deadline.

**D. Report it honestly.** Remember that a `200` was received and unreadable,
and end the wait with a message saying the sign-in may have completed and to
re-run, rather than a flat timeout. Costs: cosmetic in the sense that the login
still fails; a new reason code would drag in Problem 1's whole question. Buys:
the user stops being told something false about what happened, for a few lines
in one file.

**E. Nothing.** Costs: a successful sign-in occasionally reports as a failure,
most likely for the slowest users. Buys: recourse already works, and the
failure is safe in every respect that matters.

## What this does not cover {#not-covered}

**The two residues review round 2 recorded as non-findings.** The last loop
iteration can issue one 1ms-budget poll that aborts immediately before the
`remaining <= 0` throw, and `defaultSleep`'s timer survives a `close()`
mid-sleep through the `Promise.race`. Both are noted at #1165, and the second
changes nothing (no production caller closes mid-sleep). The first is the poll
#deadline-clamp measures: harmless on its own, but it is the one poll per login
that can consume a delivery it cannot read, so it is not a separate residue and
an answer at #deadline-clamp absorbs it.

**The D7 taxonomy.** Untouched. Both problems are about outcomes that are not
D7 refusals, and the question is whether the chain that carries D7 codes should
also carry something else.
