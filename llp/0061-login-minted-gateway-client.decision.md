# LLP 0061: Login-minted gateway credential on the client

**Type:** Decision
**Status:** Implemented
**Systems:** CLI, Onboarding, Sinks, Gateway
**Author:** Kenny / Claude
**Date:** 2026-07-01
**Related:** LLP 0033, LLP 0065, LLP 0058, LLP 0031

> The server side of login-minted gateway enrollment already shipped:
> hypaware-server now provisions a gateway on a successful human login and returns
> its credential (`gateway_jwt` / `gateway_expires_at` / `gateway_id`) on the same
> `POST /v1/identity/token` response. This is the client half: teaching `hyp remote
> login` to capture that credential and seed it where the `central` forward sink's
> identity client reads it, so a logged-in user can forward logs with no
> out-of-band bootstrap-token distribution. These are the client-local forks; the
> architecture is decided in the server repo.

## Summary

This is the **client half of chunk 4** (login-minted gateway enrollment). The
architecture was decided server-side and lives in the hypaware-server repo:
`../hypaware-server/llp/0020-login-minted-gateway.decision.md` (the decision),
`0021-...design.md`, and `0022-...plan.md` (the shipped server plan). That work
added `enrollLoginGateway`, minted a gateway JWT in the `authorization_code`
grant, and stamped the gateway registry with `origin: 'login'`.

This document does **not** re-decide that architecture. It records only the
**client-local** choices. Everything cross-cutting (why the server owns `org`, why
a login mints an ordinary registry row so the ingest path needs no new code, why
the host label is advisory) defers up to server LLP 0020. Server LLP 0020 D7 names
the client obligation; this doc resolves how the client meets it.

## Context: what exists today

The client already has the two credential stores this chunk bridges; it extends
them rather than inventing a third.

- **Query-scoped store** (`src/core/remote/credentials.js`): the `0600`
  `remote-credentials.json`, per-target, discriminated by `kind` (LLP 0058 D4). A
  browser login writes an `oidc` record `{ refreshToken, accessJwt, expiresAt, org }`
  via `writeSession` / `commitSession`. This is the **human query** credential.
- **Forward-scoped identity** (`hypaware-core/plugins-workspace/central/src/identity_client.js`):
  the `central` sink's `IdentityClient` holds a gateway JWT and manages its full
  lifecycle. `acquire()` loads a persisted `identity.json` (`{ jwt, expires_at,
  gateway_id, central_url, bootstrap_token_fp? }`) or, if none exists, `bootstrap()`s
  with a configured `bootstrap_token`. `doRefresh()` re-mints via `POST
  /v1/identity/refresh` (bearer = the gateway JWT), and `sink.js` `postNdjson()`
  drives the 401 → refresh → retry loop. This is the **forwarder** credential.
- **The login flow** (`src/core/cli/remote_commands.js` → `oidc_login.js` →
  `identity_client.js` `exchangeCode()`): today `exchangeCode()` reads only
  `refresh_token` / `access_jwt` / `expires_at` / `org` from the token response and
  returns an `OidcSession`. The new `gateway_*` fields land unread.
- **Net-new for this chunk:** nothing on the client captures the gateway credential,
  and nothing bridges a login into the forward-scoped identity store.

## Decisions

### D1: One login mints two credentials with two scopes and two stores

<a id="d1"></a>
A single `hyp remote login <target>` yields two independent credentials: the
**human session** (refresh token + access JWT → the query path) and the
**login-minted gateway** (`gateway_jwt` / `gateway_expires_at` / `gateway_id` → the
forward path). They differ in scope and lifetime and must not be conflated.

`exchangeCode()` captures the three `gateway_*` fields and carries them on
`OidcSession`, but they are **not** written into the query `oidc` record. The
query record stays exactly `{ kind, refreshToken, accessJwt, expiresAt, org }` (LLP
0058 D4); the gateway fields route to the forward store (D2). Keeping them out of
the query record preserves the LLP 0033 stakes argument: what lands in
`remote-credentials.json` is query-scoped only. The refresh grant
(`grant_type=refresh_token`) never carries `gateway_*` (the server mints a gateway
only on `authorization_code`), so `refreshSession()` is unchanged.

### D2: The gateway credential seeds the central sink's persisted identity; the forward path is unchanged

<a id="d2"></a>
The `central` sink already loads and refreshes a persisted gateway identity. A
login-seeded credential is simply that `identity.json` pre-populated: `{ jwt:
gateway_jwt, expires_at: gateway_expires_at, gateway_id, central_url, origin:
'login' }`. With the file present, `acquire()` finds a persisted identity, skips
`bootstrap()`, and the existing `doRefresh()` / 401-retry path carries it unchanged
- because a login-minted gateway is an ordinary registry row that refreshes through
the same `POST /v1/identity/refresh` a bootstrap-minted gateway uses (server LLP
0020 D2).

**No new forward code, no gateway-specific refresh grant.** The single change on the
forward side is teaching the seed-writer to produce this file; `IdentityClient` and
`sink.js` are untouched except for widening the persisted shape.

### D3: A login seed takes precedence over bootstrap; the bootstrap seam stays for zero-touch

<a id="d3"></a>
`acquire()` bootstraps only when no persisted identity exists. Seeding the file at
login means the sink never needs a `bootstrap_token` configured: the logged-in user
is the enrollment. The `bootstrap_token` path (LLP 0033 / server LLP 0008) is
**retained unchanged** for the unattended / MDM / device-cert case that has no human
to trigger a login (server LLP 0020 D7). Login-seeded and bootstrap-seeded
identities coexist and are indistinguishable to `doRefresh()`; an `origin` marker on
the persisted record distinguishes them for the re-enrollment guard (D4) and for
diagnostics.

### D4: The seed carries `central_url` provenance so the existing re-point guards apply

<a id="d4"></a>
`acquire()`'s re-enrollment and cross-tenant guards (LLP 0031) key on `central_url`
and `bootstrap_token_fp`. A login seed **must** stamp `central_url` so that
re-pointing the sink at a different server is refused exactly as it is for a
bootstrap-minted identity: reusing the old gateway JWT against a new server would
file this server's data under the other server's `gateway_id`. A login re-seed
against the **same** central URL overwrites the persisted file; the server dedups to
the same `gateway_id` (server LLP 0020 D6), so re-login is idempotent on identity and
only advances the expiry. A login seed must not silently clobber a bootstrap identity
minted by a different token or URL - it goes through the same mint-changed path, not
around it.

### D5: `hyp remote login` writes the seed to the sink's persisted path, resolved from the target

<a id="d5"></a>
The login command and the sink run under the same `HYP_HOME`, so the login command
resolves the target's forward-identity path (the sink's `persistedPath`) and writes
the seed there directly, under the same atomic-write discipline the sink uses. This
keeps the credential where `acquire()` already reads it (server LLP 0020 D7: "writes
the returned gateway JWT where the central forward sink's identity client reads it")
rather than inventing a handoff. The exact path derivation is a design-level detail
(see open questions).

### D6: The host label defaults to the machine hostname, overridable

<a id="d6"></a>
Resolving the server's open question (server LLP 0020): `hyp remote login` sends
`host: os.hostname()` in the token exchange by default, overridable with an explicit
`--host <label>` flag. The host is advisory only - it rides the server-side dedup key and admin
attribution (server LLP 0020 D6); identity stays server-assigned, so a forged or
duplicated host never grants scope, at worst it splits or merges a user's forwarder
rows.

## Consequences

- **Log forwarding after login needs no bootstrap token.** A user who runs `hyp
  remote login` against a login-configured server can forward immediately; the
  operator no longer distributes bootstrap tokens for the attended case.
- **The forward path is unchanged.** Only the persisted-identity shape widens
  (`origin?: 'login'`) and a new seed-writer is added; `IdentityClient` refresh,
  the 401 loop, and the re-point guards are reused verbatim.
- **Backward compatible.** A server without login-gateway support omits the
  `gateway_*` fields; `exchangeCode()` captures nothing and login still completes.
  A sink with a bootstrap token and no login seed behaves exactly as before.
- **Two failure surfaces stay separate.** Revoking the gateway stops forwarding
  while the human's query session still works (server LLP 0020 D5); the client
  keeps them in separate stores, so neither revocation touches the other.

## Implementation surface (sketch; a plan can follow)

Mirrors server LLP 0022 Milestone 2 (T4/T5/T6). Named here for orientation, not as a
committed task breakdown.

- **Capture** (`src/core/remote/identity_client.js` `exchangeCode()`, `types.d.ts`
  `OidcSession`): read `gateway_jwt` / `gateway_expires_at` / `gateway_id`; send
  `host`.
- **Seed** (`src/core/cli/remote_commands.js` `runBrowserLogin`, plus the resolver
  and writer in `src/core/remote/gateway_seed.js`): resolve the sink's `persistedPath`
  for the target and write the login-origin `identity.json` seed (D2, D4, D5).
- **Consume** (`central/src/identity_client.js`, `types.d.ts` `PersistedIdentity`):
  widen the persisted shape with `origin?: 'login'`; `acquire()` already loads and
  refreshes it. Verify the re-point guard treats a login seed correctly (D4).
- **Smoke** (client end-to-end, stub IdP + stub ingest): log in, confirm the seed is
  written, forward a log line, assert the org-tagged accept; revoke and assert the
  forward 401s while the query path still works.

## Out of scope (later chunks / follow-ups)

- Our own OIDC provider (server chunk 3) and self-serve DNS-TXT domain claiming
  (server chunk 5). The client change is provider-agnostic.
- MDM zero-touch device-cert enrollment (server LLP 0017 Q9); D3 keeps the bootstrap
  seam open for it.
- A distinct login-gateway TTL policy; the client consumes whatever expiry the server
  returns.

## Open questions

- **Persisted-path derivation (D5).** *Resolved (implementation):* config-driven,
  the same derivation the sink itself uses. The login command resolves the
  effective local+central layered config (what the daemon runs) and, for each
  `@hypaware/central` sink block, takes `identity.persisted_path` when set,
  defaulting to the per-plugin state path
  `<stateRoot>/plugins/@hypaware/central/identity.json` (LLP 0004
  state-directories, mirroring the sink's `sinkCtx.paths.stateDir` default). The
  resolver and the seed writer both live in `src/core/remote/gateway_seed.js`: the
  login command is the seed's producer and the sink (`hypaware-core`) only reads and
  refreshes the file, so the writer sits on the `src` side of the package boundary
  rather than importing a sink value across it (the published declaration build
  compiles `src` alone, `rootDir: src`, so a `src` value import into `hypaware-core`
  would not resolve). The file format is the contract between the two halves; the
  sink validates it on read.
- **Multiple central targets.** *Resolved (implementation):* the mapping is by URL
  **origin**, the same derivation that maps a target to its identity endpoints
  (LLP 0058 D6). `hyp remote login <target>` seeds every `central` sink whose
  configured `url` shares the target URL's origin (persisted paths deduped) and
  never touches a sink pointed at another origin. No explicit sink naming needed;
  a login against server A cannot disturb the forwarder for server B.
- **Systems vocabulary.** This doc tags `Sinks` + `Gateway` for the forward half;
  LLP 0058 already flagged that login/credentials may deserve its own subsystem tag.

## References

- Server: [LLP 0020](../../hypaware-server/llp/0020-login-minted-gateway.decision.md)
  (D2 ordinary-row, D3 mint, D4 org, D5 revocation asymmetry, D6 dedup/host, D7
  client obligation), LLP 0021 (design), LLP 0022 (plan, Milestone 2)
- [LLP 0058](./0058-oidc-login-client.decision.md) (browser login, the `oidc`
  credential record, D4 kind-discrimination, D6 identity-base derivation)
- [LLP 0033](./0033-remote-query-attach.spec.md) (query-scoped credential store,
  credential stakes)
- [LLP 0065](./0065-remote-credentials-lock.decision.md) (single-flight write lock)
- [LLP 0031](./0031-layered-config.decision.md) (`#physical-layout`: persisted
  identity.json, re-join re-bootstrap / cross-tenant re-point guards)
