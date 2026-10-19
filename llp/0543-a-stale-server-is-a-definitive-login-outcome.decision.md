# LLP 0543: A stale server is a definitive login outcome; a lost pickup is re-served

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Onboarding
**Author:** neutral
**Date:** 2026-10-18
**Extends:** LLP 0179 (#outcome: one more reason; #no-prose-control-flow: one
more definitive member), LLP 0342 (#d2: the stale-server failure now reaches
the wizard as definitive; #d3 and #d4: the delivery contract moved to repeat
pickup on the server)
**Related:** issue #1165, issue #1223, RFC [LLP 0357](./0357-the-poll-login-lane-misreports-two-outcomes.rfc.md)
(its Problem 1 option A, and its lost-delivery option A as the server built
it), LLP 0058 (#d7 the refusal taxonomy, D8 the static-token fallback),
LLP 0129 (#failed-join-returns-to-fork), hypaware-server LLP 0505 (#pickup,
extending hypaware-server LLP 0325 D2), hyparam/hypaware-server#1323 and
#1327

> A server too old to have the poll endpoint used to reach the wizard as a
> retriable `login_failed`, so the wizard said "try again" over a fault no
> retry clears and the CLI advised a static token. It now travels as its own
> typed reason, `no_poll_endpoint`, which the wizard classifies definitive and
> explains with an upgrade sentence. The lost-delivery half of RFC 0357 was
> fixed on the server: a settled outcome is re-served until redemption or
> expiry, so the client needs no change for it.

## Context {#context}

RFC [0357](./0357-the-poll-login-lane-misreports-two-outcomes.rfc.md) laid out
two outcomes the poll lane misreports. Problem 1 is the stale server: the
poller already failed loudly on the server's generic `unknown_path` 404
([LLP 0342#d2](./0342-poll-login-completion.decision.md#d2)), but the only
typed channel out of the poller was `callbackError`, which means "a D7 code",
so the outcome fell to `login_failed` and the wizard's retriable sentence.
Problem 2 is lost delivery: a settled `complete` or `failed` response whose
body the client could not read was spent on the server, so the client timed
out over a sign-in that succeeded.

## The outcome is typed {#typed}

`'no_poll_endpoint'` joins the
[LLP 0179#outcome](./0179-login-lane-returns-its-outcome.decision.md) vocabulary.
The poller's rejections carry a `kind` property: the D7 code for a server
refusal, `no_poll_endpoint` for a stale server, `timeout` when the budget runs
out. `remoteLogin` maps a rejection with no `callbackError` and
`kind === 'no_poll_endpoint'` to that reason; everything else keeps its
existing mapping.

It is typed rather than carried two other ways:

- **Not `callbackError`.** That property's whole meaning is "the server
  refused, and this is its D7 code". A stale server refused nothing, and
  putting a non-D7 value there would make `loginFailureReason`'s unknown-code
  arm the only thing between it and a misread. `callbackError` is consulted
  first, so a server code can never become `no_poll_endpoint` either.
- **Not the message's English.** LLP 0179#no-prose-control-flow forbids it, and
  the sentence is narration that should be free to change.

## It is definitive {#failed}

`classifyLoginFailure` returns `'failed'` for `no_poll_endpoint`. This extends
LLP 0179#no-prose-control-flow's closed set: the definitive reasons are the
three D7 refusals plus this one, the single member that is not a server
refusal. Retrying polls the same server and lands on the same 404, so the
retriable sentence was a promise the wizard could know it would break.

Everything else stays `'abandoned'`: `login_failed` (a timeout, a network
error, a proxy's HTML 404 or its own JSON `{"message":"Not Found"}` 404,
which are transient and keep polling), `denied`, and the post-auth failures.
An unknown server code still maps to `login_failed`, retriable by default:
telling a user to stop over a code we cannot interpret is the worse error.

## Its own sentence {#sentence}

`printJoinFailure` names the upgrade: "Joining failed: this server needs an
upgrade before it supports browser sign-in. Set up locally for now, or try
again once the server is upgraded." It never prints the membership or admin
sentence, which would send the user to an admin for access they already have.
The fork is re-presented as for every failed join
([LLP 0129#failed-join-returns-to-fork](./0129-init-wizard-fork.decision.md#failed-join-returns-to-fork)),
so local setup and a retry both stay on offer.

## Telemetry tells the truth {#telemetry}

The `wizard.join` span's `error_kind` is `no_poll_endpoint` for this outcome,
not `login_rejected` (nothing was rejected) or `login_abandoned` (nobody
abandoned anything). The other kinds are unchanged. The poller's own
`remote.login_poll_error` log already named `no_poll_endpoint`. Product
telemetry reports the exit-code outcome only, so its contract does not change.

## No headless hint on poll-lane failures {#no-headless-hint}

A browser login that fails no longer appends "on a machine with no browser,
pass a static token with --token-file ...". That hint was gated on "no server
code", read as "probably a timeout on a box with no browser" (LLP 0058 D8). The
poll lane retired that premise: the URL is printed to open from any machine
before the wait starts, so the hint was wrong on every poll-lane failure and
absurd on a stale server. `--no-browser` and `--token-file` stay in help and in
[LLP 0342#d6](./0342-poll-login-completion.decision.md#d6). This overrides
LLP 0342's Implementation surface line that lists the login messages as
unchanged, for this one line only.

## Lost delivery: repeat pickup on the server {#pickup}

RFC 0357's lost-delivery problem took its option A, built server-side:
hypaware-server LLP 0505 #pickup (extending hypaware-server LLP 0325 D2),
implemented by hyparam/hypaware-server#1327, merged 2026-10-06. A poll reads a
settled outcome without consuming it:

- `complete` is re-served with the same `code_s` until that code is redeemed,
  burned, expired, or evicted.
- `failed` is re-served with the same reason until the outcome's original TTL
  (issue #1223's case). A lost refusal is no longer reported as a timeout.
- No poll renews anything; expiry is measured from the callback.

There is no client change: the poller already treats a body read that fails
as transient and polls again, and its next poll now collects the result. No
acknowledgment endpoint, no lifetime change; PKCE and single-use redemption
are unchanged.

### Against LLP 0342 D3: repeat pickup {#repeat-pickup}

[LLP 0342#d3](./0342-poll-login-completion.decision.md#d3)'s table marks both
settled shapes "single delivery, the flight is consumed". That is superseded
by #pickup: both are served again until the code is gone or the outcome's TTL
passes, and only then does the poll answer `404 unknown_state`. The wire shapes,
the cadence, the 5-minute client budget, and the token exchange are unchanged.

### Against LLP 0342 D4: the replay argument {#replay}

[LLP 0342#d4](./0342-poll-login-completion.decision.md#d4) leaned on single
delivery to close "the replay window after pickup". The argument still holds
without it: a repeat pickup returns the same `code_s`, not a new one, and that
code is single-use and redeems only with the PKCE verifier held in the
initiating process's memory. A party holding `state` learns a code it cannot
spend, which D4 already accepted before pickup. The residual is the one
hypaware-server LLP 0325 D4 accepts: such a party can burn the code with a bad
redemption, denying that one login.
