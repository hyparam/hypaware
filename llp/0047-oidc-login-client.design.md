# LLP 0047: Multi-tenant OIDC login on the client, implementation design

**Type:** design
**Status:** Accepted
**Systems:** CLI, Onboarding, Query, MCP, Config
**Author:** Kenny / Claude
**Date:** 2026-06-29
**Related:** LLP 0009, LLP 0011, LLP 0033, LLP 0046
**Decided-by:** LLP 0046: multi-tenant OIDC login on the client

> [LLP 0046](./0046-oidc-login-client.decision.md) grilled and decided the client-local
> shape of chunk 2: a browser mode on `hyp remote login`, an ephemeral loopback
> redirect, the downstream PKCE leg, a discriminated `kind` record in the existing 0600
> store, origin-derived identity endpoints, and silent refresh on the attach path. This
> document is the implementation design: the modules and functions to add, the exact
> wire contract with hypaware-server, and the test plan.

## Summary

Chunk 2 adds a browser authorization-code flow to the client and a silent-refresh hook
to the query path, against the login surface hypaware-server shipped in its LLP 0019.
The new code is small, dependency-free (Node stdlib `crypto`, `http`, and a platform
opener), and isolated under `src/core/remote/`. The credential store and the `hyp remote
login` command are extended, not replaced.

## The server contract (what the client speaks)

All paths are under the identity base `<origin-of-target-url>/v1/identity` (LLP 0046 D6).

**Start (browser navigates here):** `GET /login/start` with query params:

| param | value |
|-------|-------|
| `redirect_uri` | `http://127.0.0.1:<port>/callback` (loopback http only) |
| `code_challenge` | base64url SHA-256 of the client verifier |
| `code_challenge_method` | `S256` |
| `state` | client CSRF token, echoed back on the loopback callback |
| `org` | optional org selector (`--org`) |

The server parks a flight and 302s the browser to the upstream provider. After the
provider returns, the server resolves the org and 302s the browser to the client's
`redirect_uri`.

**Loopback callback (the client's listener catches this):**
`GET /callback?code=<code>&state=<state>` on success, or
`GET /callback?error=<error>&state=<state>` on failure. The `state` must equal the one
the client sent; `error` is a provider error or a resolution error (`access_denied`,
`no_membership`, `org_selection_required`, `org_not_permitted`).

**Token endpoint:** `POST /token`, JSON body, two grants:

- `{ "grant_type": "authorization_code", "code": "...", "code_verifier": "..." }`
  → `200 { session_id, refresh_token, access_jwt, expires_at, org }`
- `{ "grant_type": "refresh_token", "refresh_token": "..." }`
  → `200 { access_jwt, expires_at, org }` or `401 { error: "invalid_grant" }`

Note the response field is `access_jwt` (not `access_token`) and `expires_at` is an ISO
timestamp. This is hypaware-server's own token, verified by its own resource path; there
is no external JWKS on the client.

## Modules to add (under `src/core/remote/`)

### `pkce.js`
`createPkcePair()` → `{ verifier, challenge }`. Verifier is 32 random bytes base64url;
challenge is base64url SHA-256 of the verifier. Pure, synchronous, stdlib `crypto`.
Realizes LLP 0046 D3.

### `loopback.js`
`startLoopbackReceiver({ state, timeoutMs })` → `{ redirectUri, waitForCode() }`. Binds
`http://127.0.0.1:0` (OS-assigned port) and returns `redirectUri` so the caller can build
the start URL before opening the browser. `waitForCode()` resolves `{ code }` when
`/callback` arrives with a matching `state`; rejects on `error=`, `state` mismatch, or
timeout. Serves a minimal "login complete, you can close this tab" page, then closes.
Single-shot. Realizes LLP 0046 D2.

### `open_browser.js`
`openBrowser(url)` spawns the platform opener (`open` darwin, `xdg-open` linux, `start`
win32) detached; returns whether an opener was found. `--no-browser` skips it and prints
the URL. Realizes LLP 0046 D8.

### `identity_client.js`
Plain JSON over an injectable `fetchImpl`, distinct from the MCP JSON-RPC `client.js`:
- `exchangeCode({ identityBase, code, codeVerifier, fetchImpl })`
  → `{ refreshToken, accessJwt, expiresAt, org }`
- `refreshSession({ identityBase, refreshToken, fetchImpl })`
  → `{ accessJwt, expiresAt, org }`, or throws a typed `invalid_grant` error the attach
  path turns into re-login guidance.

### `oidc_login.js`
`loginWithBrowser({ identityBase, org, openBrowser, now })` orchestrates D2/D3:
generate PKCE + a random `state`, start the loopback receiver, build the start URL, open
the browser (or print it), await the code, exchange it, and return the session
`{ refreshToken, accessJwt, expiresAt, org }`. No persistence here; the caller stores it.

## Modules to extend

### `credentials.js` (LLP 0046 D4)
Records gain a discriminator `kind: 'static' | 'oidc'`. Additions:
- `writeSession(stateDir, target, { refreshToken, accessJwt, expiresAt, org })` writes a
  `kind: 'oidc'` record through the same atomic 0600 path as `writeToken`.
- a normalizing read: a legacy record with `token` and no `kind` is read as
  `kind: 'static'`, so existing files keep working without a rewrite.
- `resolveAccessJwt({ target, env, stateDir, identityBase, now, fetchImpl })`: the
  session-aware resolver for the attach path. For a `static` record (or env override) it
  returns the token as today. For an `oidc` record it returns a fresh access JWT, calling
  `refreshSession` and persisting the new JWT/expiry when the stored one is within a skew
  window of expiry. The env override `HYP_REMOTE_TOKEN_<TARGET>` still wins.
- `removeToken` already drops the whole per-target record, so it covers both kinds.

### `remote_commands.js` (LLP 0046 D1, D7, D8)
`runRemoteLogin` gains browser mode: parse `--browser` / `--no-browser` / `--org <name>`
/ `--token-file <path>`. With a token file or piped stdin, behave exactly as today
(`kind: 'static'`). Otherwise run `loginWithBrowser` against the target's identity base,
then `writeSession`. Print the resolved org on success. Translate a callback `error` into
a clear message per D7.

### `remote_verb.js` and `client.js` (LLP 0046 D5)
The attach path calls `resolveAccessJwt` instead of `resolveToken`. On a live 401/403
from `client.js`, the attach path refreshes once and retries before surfacing the error;
a refresh that fails with `invalid_grant` surfaces the existing re-login message (now:
re-run the browser flow).

## Security notes

- `state` is a random per-login CSRF token; a callback whose `state` does not match is
  rejected without reading `code`.
- The loopback listener binds only `127.0.0.1`, is single-shot, and times out.
- The PKCE verifier lives in memory for one flow, is never logged, never persisted.
- The refresh token and access JWT inherit the 0600 atomic-write store; neither is ever
  written to config or logs.
- The token endpoint is reached over the target's own origin (https in any real
  deployment); the access JWT is hypaware-server's own credential, so there is no
  external JWKS trust on the client.

## Telemetry (log-driven development)

Emit structured logs around: login start (target, has-org), loopback bind (port),
browser open (opener found or printed), code receipt (success or error kind), token
exchange, and refresh (refreshed or invalid_grant). Attributes use `component:
'remote-oidc'`, an `operation`, and a `status`; never log the verifier, code, refresh
token, or access JWT (hash or redact if identity matters). Give the smoke a stable
`smoke_step` per phase.

## Tests

Traditional unit tests (deterministic; injected clock, fetch, and http):
- `pkce`: challenge is the base64url SHA-256 of the verifier; pairs differ.
- `loopback`: a matching `state` resolves `{ code }`; a mismatched `state`, an `error=`,
  and a timeout each reject; the listener closes after one request.
- `identity_client`: `exchangeCode` and `refreshSession` post the right body and parse
  the response; a 401 surfaces a typed `invalid_grant`.
- `credentials`: an `oidc` record round-trips; a legacy `token`-only record reads as
  `static`; `resolveAccessJwt` refreshes a stale JWT and persists it, returns a fresh one
  untouched, falls back to a static token, and honors the env override; a refresh failure
  propagates.
- `remote_commands`: `--org` is forwarded; a callback `error` maps to the right message;
  the static `--token-file` path is unchanged.

Hermetic smoke `remote_oidc_login` (a stub identity server signing real tokens, temp
HYP_HOME): browser flow (loopback driven by a scripted client), session stored, query
attaches the access JWT, a forced expiry triggers a silent refresh, a revoked refresh row
triggers the re-login message.

## @refs to add when the code lands

- `oidc_login.js`: `@ref LLP 0046#d3 [implements]` (downstream PKCE leg owned by client)
- `loopback.js`: `@ref LLP 0046#d2 [implements]` (ephemeral 127.0.0.1 redirect, RFC 8252)
- `credentials.js` session additions: `@ref LLP 0046#d4 [implements]` (discriminated
  `kind` record), and `@ref LLP 0033#credentials [constrained-by]`
- `resolveAccessJwt` / attach path: `@ref LLP 0046#d5 [implements]` (silent refresh and
  401 re-login on the attach path)
- `runRemoteLogin` browser mode: `@ref LLP 0046#d1 [implements]` (browser mode of `hyp
  remote login`)

## References

- `../hypaware-server/llp/0018-oidc-login-server.design.md` (the server side of this contract)
- [LLP 0046](./0046-oidc-login-client.decision.md) (decisions), [LLP 0033](./0033-remote-query-attach.spec.md) (credential store + attach), [LLP 0009](./0009-cli-registry.spec.md) (command registry)
- Sequenced in [LLP 0048](./0048-oidc-login-client.plan.md)
