# LLP 0060: Multi-tenant OIDC login on the client, plan

**Type:** plan
**Status:** Implemented
**Systems:** CLI, Onboarding, Query, MCP, Config
**Author:** Kenny / Claude
**Date:** 2026-06-29
**Related:** LLP 0033, LLP 0058, LLP 0059
**Generated-by:** LLP 0059: multi-tenant OIDC login on the client, implementation design

> [LLP 0059](./0059-oidc-login-client.design.md) named the modules and the wire
> contract. This plan turns them into a task graph of independently-mergeable PRs, with
> the dependency edges that let the local primitives land in parallel before the command
> and attach-path wiring that consume them.

## Sequencing at a glance

```
M1 local primitives (parallel)            M2 command           M3 attach          M4 smoke
  T1 pkce.js ............................\
  T2 loopback.js .......................  \
  T3 identity_client.js ................   >--> T6 runRemoteLogin --> T7 resolveAccessJwt --> T8 hermetic
  T4 credentials kind + writeSession ...  /        browser mode          on attach path        smoke
  T5 oidc_login.js (needs T1,T2,T3) ..../
```

Each task is a PR with its own unit tests, lands green under `npm test`, and carries the
`@ref` annotations LLP 0059 lists. Follow the same discipline the server used in its LLP
0019: typecheck and tests gate every merge; the LLP edit lands with its code.

## Milestone 1: local primitives

No command wiring, no network beyond injected fetch; each is unit-testable in isolation.

- **T1 `pkce.js`.** `createPkcePair()`. Test: challenge is the base64url SHA-256 of the
  verifier; two pairs differ. (`@ref LLP 0058#d3`)
- **T2 `loopback.js`.** `startLoopbackReceiver({ state, timeoutMs })`. Test (injected
  requests against the real bound port): matching `state` resolves `{ code }`; mismatch,
  `error=`, and timeout reject; the listener closes after one request. (`@ref LLP 0058#d2`)
- **T3 `identity_client.js`.** `exchangeCode`, `refreshSession` over an injected
  `fetchImpl`. Test: correct request body and parsed response; a 401 surfaces a typed
  `invalid_grant`.
- **T4 `credentials.js` discriminated `kind`.** Add `writeSession`, the read-normalizing
  of legacy `token`-only records to `static`, and a `RemoteCredentialRecord` interface in
  the sibling `.d.ts`. Test: `oidc` record round-trips; legacy record reads as `static`;
  `removeToken` still clears both. (`@ref LLP 0058#d4`, `@ref LLP 0033#credentials`)
- **T5 `oidc_login.js`.** `loginWithBrowser(...)`, composing T1+T2+T3 plus
  `open_browser.js`. Depends on T1, T2, T3. Test: a scripted loopback + stub identity
  server drives a full code-to-session exchange; `--no-browser` prints the URL.

T1 to T4 are mutually independent and parallelize; T5 joins them.

## Milestone 2: command flow

- **T6 `runRemoteLogin` browser mode.** Flag parsing (`--browser` / `--no-browser` /
  `--org` / `--token-file`), origin-derive the identity base from the target's `url`, run
  `loginWithBrowser`, persist with `writeSession`, print the resolved org. Translate
  callback `error` codes into clear messages (D7). Static `--token-file`/stdin path
  unchanged. Depends on M1. (`@ref LLP 0058#d1`, `#d6`, `#d7`)
  Test: `--org` forwarded; each error code maps to its message; static path untouched.

## Milestone 3: attach-path integration

- **T7 silent refresh + 401 retry.** Swap the attach path (`remote_verb.js`) to
  `resolveAccessJwt`; add the one-shot refresh-and-retry on a live 401 in `client.js`;
  keep the env override winning. A failed refresh surfaces the re-login message. Depends
  on T4 (and benefits from T6 existing for end-to-end manual check). (`@ref LLP 0058#d5`)
  Test: a stale stored JWT is refreshed and persisted before the call; a 401 mid-flight
  triggers exactly one refresh+retry; `invalid_grant` maps to re-login guidance.

## Milestone 4: hermetic smoke

- **T8 `remote_oidc_login` smoke.** A stub identity server (signing real tokens) plus a
  scripted loopback in a temp HYP_HOME: login, session stored as `kind: 'oidc'`, query
  attaches the access JWT, a forced expiry drives a silent refresh, a revoked refresh row
  drives the re-login message. Assert both the user-visible result and the telemetry
  `smoke_step` markers per the repo's log-driven-development guidance.

## Cross-doc follow-ups (land with the code, not before)

- **Edit LLP 0033.** Its credential-store and 401 sections now have an OIDC variant.
  When T4/T7 land, update 0033 to reference the `kind` discriminator and the
  refresh-then-retry behavior, so 0033 stays the honest source for the attach path.
- **Promote 0046/0047/0048.** Move them Draft → Accepted/Active as the design is approved,
  and to Implemented when the milestones land (the server-side 0015/0016 precedent).
- **Decide the `Identity` System tag** (LLP 0058 open question) before tagging the code;
  if adopted, update LLP 0000's vocabulary in the same change.
- **Run `/ref-check`** after each milestone so no `@ref` dangles and every `#anchor`
  resolves.

## Out of scope (tracked elsewhere)

- hyperparam.app minimal OIDC provider (server chunk 3).
- Login-minted gateway enrollment (server chunk 4); keep the D4 record shape open to a
  future gateway-token field.
- Self-serve DNS-TXT domain claiming (server chunk 5).
- OS keychain for the refresh token (LLP 0033 follow-up).
- Path-prefixed identity hosting / explicit `identityUrl` (LLP 0058 D6 caveat).

## References

- [LLP 0058](./0058-oidc-login-client.decision.md) (decisions), [LLP 0059](./0059-oidc-login-client.design.md) (design)
- [LLP 0033](./0033-remote-query-attach.spec.md) (credential store + attach), [LLP 0009](./0009-cli-registry.spec.md) (command registry), [LLP 0011](./0011-setup-and-onboarding.decision.md) (onboarding)
- `../hypaware-server/llp/0019-oidc-login-server.plan.md` (the server-side plan this mirrors)
