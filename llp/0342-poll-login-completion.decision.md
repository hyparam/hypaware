# LLP 0342: Poll-based login completion replaces the loopback redirect

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Onboarding, Query, MCP
**Author:** Kenny / Claude
**Date:** 2026-08-31
**Related:** LLP 0058 (extends D2, D8), LLP 0059, LLP 0061, LLP 0063, LLP 0134, LLP 0179
**Extends:** LLP 0058
**Extended-by:** LLP 0357 (the request covering two outcomes the poll lane misreports: #d2's loud stale-server failure, which reaches the wizard as retriable, and #d3's single delivery, which strands a successful sign-in when the client cannot read the response that carried it)

> `hyp remote login` on an SSH session is broken by design: the browser flow
> hands the IdP a `redirect_uri` of `http://127.0.0.1:<port>/callback`, but the
> browser runs on the user's laptop, so the redirect lands on the wrong
> machine's loopback. The user authenticates successfully and the CLI sits in
> its five-minute timeout. LLP 0058 D8 saw the case and punted on scoping
> grounds ("would require new server work"); the server work is now in scope.
> Grilled against the corpus on 2026-08-30/31; server half in
> `../hypaware-server/llp/0325-poll-login-completion-server.decision.md`.

## Context

The auth code today is *pushed* to the client: the server 302s the browser to
an ephemeral single-shot listener the client binds on `127.0.0.1`
(LLP 0058 D2, `src/core/remote/loopback.js`). That delivery only works when
the browser and the CLI share a loopback interface. Everything else about the
flow (PKCE, the parked server flight, the token exchange, gateway minting)
is delivery-agnostic.

## Decisions

### D1: The client polls the server for the code; no listener, no redirect

<a id="d1"></a>
The client *pulls* the outcome instead: it prints/opens the `/login/start` URL
as today, then polls a server endpoint keyed by its own `state` until the
upstream leg finishes, and receives the one-time auth code (or a D7 refusal)
in the poll response. The Tailscale/fly.io pattern.

**Rejected: an RFC 8628 device authorization grant.** The typed user code
exists for devices with no channel to put a URL in front of the user (TVs);
the CLI always has one (the printed URL), so the code adds friction without
security. 8628 would also add a new grant type, a verification page, and drop
PKCE (the device code becomes the only secret). Poll-based completion adds one
endpoint and keeps PKCE.

**Rejected: coexistence with the loopback flow behind an SSH heuristic**
(`SSH_CONNECTION` sniffing). The heuristic misfires (tmux, X forwarding,
containers), and once the poll flow exists the desktop UX is equivalent, so
the second flow buys nothing.

### D2: Hard replacement on the client; the server keeps its redirect lane

<a id="d2"></a>
The client deletes the loopback receiver outright: `loopback.js` is removed,
no `redirect_uri` is sent, and there is no fallback lane or flow-selection
logic. This is safe because there is exactly one deployed hypaware-server and
we run it; the server half ships and deploys **before** the client release.

The *server's* loopback-`redirect_uri` support is not deleted: released `hyp`
versions in the wild still speak the redirect flow until they age out, and the
web-app origin lane (server LLP 0175) uses the redirect machinery too. The
server side carries a deprecation note keyed to old-client age-out, not a
removal.

A new client against a stale server fails loudly, not by timeout: the first
poll answers with the server's generic `unknown_path` 404 rather than the
poll contract's structured shape, and the client reports "this server does
not support poll login yet - upgrade hypaware-server" instead of spinning.

### D3: The wire contract

<a id="d3"></a>
**Start** is `GET /v1/identity/login/start` with `code_challenge`,
`code_challenge_method=S256`, `state`, and optional `org`, exactly as
LLP 0059 specifies, minus `redirect_uri`: **absence of `redirect_uri` selects
poll delivery** (presence-activated, matching the config idiom; the redirect
lanes still pass one). The server parks the flight as today and, at the end of
the upstream leg, holds the outcome on the flight instead of redirecting.

**Poll** is one new endpoint, `GET /v1/identity/login/poll?state=<state_c>`:

| response | meaning |
|----------|---------|
| `200 { "status": "pending" }` | upstream leg not finished |
| `200 { "status": "complete", "code": "<code_s>" }` | success; **single delivery**, the flight is consumed |
| `200 { "status": "failed", "error": "<code>" }` | a D7 refusal (`no_membership`, `org_selection_required`, `org_not_permitted`, `access_denied`); also consumed |
| `404 { "error": "unknown_state" }` | expired, already consumed, or not started yet; the client keeps polling |

`unknown_state` is NOT terminal for the client: the flight parks only when
the *browser* opens the start URL, and the client begins polling as soon as
it prints it, so every poll before the human clicks legitimately lands
there. What the client treats as terminal on a 404 is the generic
`unknown_path` shape (D2's stale-server detection), which a poll-capable
server never returns on this path.

The D7 taxonomy (LLP 0058 D7) is unchanged in vocabulary and client-side
explanation; only its channel moves from the redirect's `error=` param to the
poll body. `loginFailureReason` / `explainLoginError` and the LLP 0179
outcome codes are untouched.

**Token** is byte-identical to today: the polled code redeems via the
`authorization_code` grant with the PKCE verifier and the advisory `host`
label, and the response carries the `gateway_*` fields. LLP 0061 (gateway
seeding) and everything downstream of `exchangeCode()` (enrollment, consent
notice ordering, first-sync hold) are untouched.

**Cadence:** the client polls every 2s with the existing 5-minute overall
timeout (today's `DEFAULT_TIMEOUT_MS`, moving from the listener to the
poller); the server flight TTL stays 10 minutes. Plain interval polling, no
long-poll: interactive human flow, hand-rolled server.

### D4: PKCE stays; no poll secret

<a id="d4"></a>
The `state` printed inside the start URL lands in browser history and proxy
logs, and the poll endpoint hands `code_s` to whoever presents that `state`
first. That is acceptable because the code is unredeemable without the PKCE
verifier, which lives only in the initiating process's memory and is never
printed or persisted (LLP 0058 D3). A second poll-binding secret would
duplicate what PKCE already guarantees at redemption; rejected. Single
delivery (D3) closes the replay window after pickup. The server rate-limits
the poll endpoint; `state` stays 16 random bytes.

The residual risk shared by every flow in this class (an attacker sends their
own login URL to a victim who completes it) is not mitigated by typed user
codes either; the mitigations are the server's consent page naming what is
being authorized and the bounded flight TTL.

### D5: The browser's terminal pages render server-side

<a id="d5"></a>
With no loopback listener there is nothing local to serve the "login
complete" or refusal pages, so the server renders them at the end of the
upstream leg (ported from `loopback.js`'s `LANDING_PAGE` / `refusalPage`).
The client-side `managedContactUrl` logic retires with them: the server knows
its own support contact and renders its own link, ending the arrangement
where the client decided whether the deployment was managed enough to show
one.

### D6: CLI surface unchanged; static tokens stay the headless fallback

<a id="d6"></a>
No new flags. `--no-browser` keeps its natural meaning, now fully orthogonal:
skip the opener, print the URL, and (new) the poll still completes the login
no matter where that URL is opened, which is what "open elsewhere" always
promised and the loopback could not deliver. `--browser`, `--org`, `--host`,
`--token-file`, and the static-token path are untouched: LLP 0058 D8's
static fallback stands for truly unattended cases (CI, no human anywhere);
only its "no device-code flow" clause is overtaken, by a flow that is not
RFC 8628 (D1).

## Consequences

- `hyp remote login` works over SSH, in containers, and on headless boxes
  with a browser anywhere, with no flags and no environment sniffing.
- The client sheds its only listening socket: no macOS firewall prompt, no
  ephemeral-port hardening, no stray-request/keep-alive handling.
  `loopback.js` (~350 lines) and its tests are deleted, replaced by a small
  poller with the same `waitForCode()` seam.
- The wizard (LLP 0134) and the `LoginOutcome` contract (LLP 0179) are
  unaffected: the poller reports through the same `login()` seam and reason
  codes.
- Release coupling: the client release notes must state the minimum
  hypaware-server deploy; the D2 first-poll error covers the miss.

## Implementation surface

- **delete** `src/core/remote/loopback.js`, `test/core/remote-loopback.test.js`
- **new** poller (in `src/core/remote/oidc_login.js` or a sibling
  `login_poll.js`): same `{ waitForCode, close }` shape the receiver exposed
- **edit** `src/core/remote/oidc_login.js`: drop the receiver and
  `redirect_uri`, start the poller, keep opener/print behavior
- **edit** `hypaware-core/smoke/flows/remote_oidc_login.js` (and the stub
  identity server it drives, plus `join_flow_remote_config.js` if it logs in):
  stub gains the poll endpoint; the smoke drives the poll lane
- **unchanged** `identity_client.js` `exchangeCode`, `credentials.js`,
  `remote_commands.js` messages, `gateway_seed.js`

## Tests

- Poller unit tests (injected fetch + clock): `pending` then `complete`
  resolves `{ code }` once; `unknown_state` keeps polling to the outcome;
  `failed` rejects with the D7 `callbackError`; `unknown_path` 404 rejects
  with the upgrade message; a 429 sleeps for `retry-after`; timeout rejects;
  `close()` rejects an in-flight wait.
- `remote-oidc-login.test.js`: start URL carries no `redirect_uri`; the D7
  poll errors surface through `explainLoginError` unchanged.
- Smoke `remote_oidc_login` proves the full poll lane against the stub.

## @refs to add when the code lands

- the poller: `@ref LLP 0342#d3 [implements]` (poll contract, single
  delivery, cadence) and `@ref LLP 0342#d4 [constrained-by]` (no poll
  secret; PKCE is the redemption gate)
- `oidc_login.js` orchestration: `@ref LLP 0342#d1 [implements]` (pull, not
  push); the existing `@ref LLP 0058#d3` (PKCE) stays
- the first-poll 404 explanation: `@ref LLP 0342#d2 [implements]`
- deleted with `loopback.js`: its `@ref LLP 0058#d2` annotations

## References

- Server half: `../hypaware-server/llp/0325-poll-login-completion-server.decision.md`
- [LLP 0058](./0058-oidc-login-client.decision.md) (D2 superseded, D8
  extended, D3/D7 unchanged), [LLP 0059](./0059-oidc-login-client.design.md)
  (the wire contract this amends)
- [LLP 0061](./0061-login-minted-gateway-client.decision.md) (unaffected:
  gateway rides the unchanged token exchange)
- [LLP 0179](./0179-login-lane-returns-its-outcome.decision.md) (reason
  codes the poll lane reports through)
- OAuth for native apps (RFC 8252); PKCE (RFC 7636); RFC 8628 (rejected, D1)
