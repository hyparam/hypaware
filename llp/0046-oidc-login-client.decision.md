# LLP 0046: Multi-tenant OIDC login on the client

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Onboarding, Query, MCP
**Author:** Kenny / Claude
**Date:** 2026-06-29
**Related:** LLP 0009, LLP 0011, LLP 0033, LLP 0044

> The server side of multi-tenant OIDC login already shipped: hypaware-server is
> a rendezvous that runs the OIDC flow against a configurable provider and mints
> its own revocable refresh token plus a short org-scoped access JWT. This is the
> client half: teaching `hyp` to run the browser flow, store the refresh token in
> the existing 0600 credential store, and refresh silently on the query path.
> Grilled against the corpus on 2026-06-29; the decisions below are the
> client-local forks resolved in that session.

## Summary

This is **chunk 2** of the multi-tenant OAuth login program. The architecture was
decided server-side and lives in the hypaware-server repo:
`../hypaware-server/llp/0017-multi-tenant-oauth-login.decision.md` (the decision),
`0018-oidc-login-server.design.md` (the server design), and
`0019-oidc-login-server.plan.md` (the shipped server plan). That work added the
login endpoints, claimed-domain to org resolution, and the token endpoint.

This document does **not** re-decide that architecture. It records only the
**client-local** choices. Everything cross-cutting (why hypaware-server owns `org`,
why it mints its own refresh token, the forge-proof org boundary) defers up to
server LLP 0017.

## Context: what exists today

The client already has a per-target remote credential path, and chunk 2 extends it
rather than inventing a parallel one:

- **Credential store** (`src/core/remote/credentials.js`): a single `0600` file at
  `<stateDir>/remote-credentials.json` (HYP_HOME-overridable), per-target shape
  `{ "<target>": { "token": "..." } }`, written atomically (tmp + rename + chmod).
  `writeToken`, `readCredentials`, `removeToken`, `resolveToken` (env then file).
  This is LLP 0033's query-scoped store.
- **Command** (`src/core/cli/remote_commands.js`): `hyp remote login <name>` reads a
  token from `--token-file <path>` or stdin and calls `writeToken`. Siblings: `remote
  add` (writes `query.remotes.<name> = { url }`), `remote list`, `remote remove`.
- **Query attach** (`src/core/mcp/remote_verb.js`, `client.js`): `resolveToken` reads
  the token, `createHttpMcpClient({ url, token })` sets `Authorization: Bearer`, and a
  401/403 throws `remote rejected the credential ... re-run 'hyp remote login'`.
- **Net-new for chunk 2:** there is no browser-open, loopback listener, PKCE, or
  refresh-token handling anywhere in the client today.

## Decisions

### D1: Login is a browser mode of `hyp remote login <target>`

<a id="d1"></a> 
Server LLP 0017 named the client command `hypaware login`. The client's entire remote
model is per-target under `hyp remote ...`, and the credential store is keyed by
target; a separate top-level `hyp login` would create a second credential path for the
same servers. **Decision:** `hyp remote login <target>` gains an interactive browser
mode, selected when no static token is supplied (or forced with `--browser`), and still
falls back to `--token-file`/stdin for static tokens. One command, one store, one more
way to populate it. The server prose should treat `hypaware login` as the intent and
`hyp remote login` as the realized spelling, not silently diverge.

### D2: Ephemeral loopback redirect on 127.0.0.1 (RFC 8252)

<a id="d2"></a> 
The client starts a single-shot HTTP listener on `127.0.0.1` at an OS-assigned port,
serving one path (`/callback`), and uses `http://127.0.0.1:<port>/callback` as the
`redirect_uri`. The server already restricts `redirect_uri` to loopback hosts, so this
matches. Rejected a fixed port (collisions, and the server would have to allowlist it).
The listener is bound for one login, with a short timeout, then closed.

### D3: The client owns the downstream PKCE leg

<a id="d3"></a> 
There are two PKCE legs. The client is the OAuth app talking to hypaware-server (the
downstream leg): it generates a verifier and an S256 challenge, sends the challenge to
`/login/start`, and holds the verifier to present at `/identity/token`. The upstream leg
(hypaware-server to the IdP) is entirely server-internal; the client never sees it. The
verifier lives in memory for one flow, is never logged, never persisted.

### D4: The session is a discriminated record in the same credential file

<a id="d4"></a> 
Each per-target record carries `kind: 'static' | 'oidc'`. A `static` record is the
LLP 0033 `{ token }`; an `oidc` record carries `{ refreshToken, accessJwt, expiresAt,
org }`. **Migration is read-implicit:** a legacy record with a `token` and no `kind` is
treated as `kind: 'static'` on read, so existing files keep working without a rewrite;
writes stamp `kind`. One file, one resolve path, one remove path. Rejected a separate
sessions file (two resolve/remove paths for the same per-target secret). Rejected silent
additive fields without a discriminator (the explicit `kind` makes "is this an OIDC
session" a property of the record, not an inference from which fields are present).

### D5: Silent refresh and re-login live on the attach path

<a id="d5"></a> 
When the query attach path needs a token for an `oidc` target, a session-aware resolver
checks `expiresAt`; if it is within a skew window of expiry, it POSTs the refresh grant
to the token endpoint, persists the new JWT, and proceeds. If a live request still
returns 401, the attach path refreshes once and retries before surfacing an error. A
refresh that fails with 401 `invalid_grant` (the refresh row was revoked or expired)
surfaces the existing "re-run `hyp remote login`" guidance, now meaning re-run the
browser flow. Rejected refreshing eagerly on every call (needless token-endpoint
traffic). The per-target env override (`HYP_REMOTE_TOKEN_<TARGET>`) still wins for CI.

Because the `0600` store is shared by concurrent `hyp` processes (a second MCP client,
or a verb call beside a running proxy), refreshing a one-time-use refresh token is
**single-flight under the write lock**, not an optimistic race. A resolver that finds a
stale (or force-refreshed) JWT takes the cross-process lock, re-reads the store, and then
either adopts a sibling's session if one was minted while it waited (a different,
still-fresh JWT, with no token-endpoint call) or performs the refresh and commits, all
inside the one lock hold. Only one process ever calls the token endpoint for a given
store at a time, so the lost-refresh-race case disappears at the source: a sibling never
sees `invalid_grant` from contention because it never refreshes concurrently. An
`invalid_grant` observed under the lock is therefore an unambiguous revocation and
surfaces the "re-run `hyp remote login`" guidance. **Rejected** the optimistic
compare-and-swap (refresh outside the lock, commit only if the stored token still
matched): its "unchanged token means revoked" test had a race window, because a loser
could re-read before the winner committed and then wrongly force a re-login.

The lock is held across the bounded (token-endpoint timeout) refresh call, so it is a
real mutex, not a millisecond commit latch. **Decision:** the lock file records the
holder's `{host, pid}`, and a contender steals it only when that holder is confirmed dead
(a same-host liveness probe), not by a fixed age guess; the steal is an atomic rename so
two contenders can never both adopt the same abandoned lock, and a holder only ever
removes a lock that is still its own. A long age threshold remains a backstop for a
holder on another machine (a shared `HOME`) or an unparseable lock. **Rejected** stealing
purely by lock-file age: a fixed age cannot tell a crashed holder from a merely slow
refresh, so it both wedged longer than needed on crashes and let two live writers clobber
each other (the later rename dropping the other's just-rotated refresh token).

### D6: Identity endpoints derive from the configured remote URL origin

<a id="d6"></a> 
A target is configured as `query.remotes.<name> = { url }`, the MCP endpoint. The login
and token endpoints live on the same server under `/v1/identity/...`. **Decision:** the
client derives the identity base as `<origin-of-url>/v1/identity`, so no second URL is
configured. **Caveat (open question):** this assumes identity is mounted at the origin
root; a deployment hosted under a path prefix (`host/hypaware/mcp`) is not covered by the
MVP. If that case arises, an optional explicit `identityUrl` on the target is the
additive fix, defaulting to origin-derive. We do not build server-advertised discovery
in this chunk.

### D7: Org selection is a `--org` selector; surfaced errors are explained

<a id="d7"></a> 
`hyp remote login <target> --org acme` passes `org` to `/login/start` as a selector
only; the server resolves the real org and may bounce `no_membership`,
`org_selection_required`, or `org_not_permitted` to the loopback as an `error`. The
command translates each into a clear message. The client never sees the user's org list,
so on `org_selection_required` it instructs the user to re-run with `--org <name>` rather
than enumerating. The client never asserts the org; it only selects.

### D8: Static tokens remain the headless escape hatch; no device-code flow

<a id="d8"></a> 
When there is no display or browser (`--no-browser`, or no opener found), the client
prints the authorize URL for manual open while the loopback still waits. For a truly
headless host with no reachable loopback (a remote SSH shell), the browser flow is not
usable; the existing `--token-file`/stdin static-token path stays as the documented
fallback. We do **not** build a device-code flow: hypaware-server's chunk-1 token
endpoint exposes only the `authorization_code` and `refresh_token` grants, so a device
flow would require new server work and is out of scope.

## Consequences

- One command, one store, one resolve path: OIDC sessions and static tokens coexist,
  distinguished by `kind`.
- The client gains its first browser-open, loopback-listener, and PKCE code; small,
  dependency-free, isolated under `src/core/remote/`.
- The IdP stays out of the steady-state path: only login and refresh-expiry touch the
  network beyond normal queries.
- LLP 0033's credential-store and 401 contracts are now extended; 0033 needs a
  follow-up edit when the code lands (noted in the plan), not a rewrite here.
- Out of scope (server chunks 3 to 5): the hyperparam.app OIDC provider, login-minted
  gateway enrollment, and self-serve DNS-TXT domain claiming. The client change is
  provider-agnostic and works against any hypaware-server with login configured.

## Open questions

- **System vocabulary.** Login/credentials is arguably a new subsystem. This doc tags
  the existing `CLI, Onboarding, Query, MCP`. Should LLP 0000 gain an `Identity` (or
  `Auth`) System tag, and should LLP 0033's credential store move under it?
- **Path-prefixed identity hosting.** D6 derives from the origin; an explicit
  `identityUrl` override is the additive fix if a real deployment needs it.
- **OS keychain.** The refresh token lands in the `0600` file, consistent with LLP 0033;
  the keychain remains the named follow-up there, not this chunk.
- **Gateway provisioning.** Server chunk 4 may have `hyp remote login` also receive a
  gateway token for unattended ingest. Deferred; the D4 record shape should not preclude
  adding a gateway-token field later.

## References

- `../hypaware-server/llp/0017-multi-tenant-oauth-login.decision.md` (architecture)
- `../hypaware-server/llp/0018-oidc-login-server.design.md` (server design)
- `../hypaware-server/llp/0019-oidc-login-server.plan.md` (shipped server plan)
- [LLP 0009](./0009-cli-registry.spec.md), [LLP 0011](./0011-setup-and-onboarding.decision.md), [LLP 0033](./0033-remote-query-attach.spec.md)
- Designed in [LLP 0047](./0047-oidc-login-client.design.md); sequenced in [LLP 0048](./0048-oidc-login-client.plan.md)
