# LLP 0547: A service-account token enrolls a collector and buys query access

**Type:** Decision
**Status:** Draft
**Systems:** CLI, Onboarding, Query, MCP
**Author:** neutral
**Date:** 2026-10-19
**Extends:** LLP 0031 (#physical-layout: a service secret outlives seed
retirement in its own file), LLP 0058 (#d4: a third credential kind,
`service`; #d5: its exchange shares the single-flight refresh)
**Related:** hypaware-server LLP 0620 (Draft, the server contract), LLP 0061,
LLP 0065, LLP 0298, LLP 0025, Linear HYP-264, HYP-267

## Why {#why}

hypaware-server LLP 0620 adds org service accounts. An admin mints a named
token for an account and gets one secret, `hsa_<16 hex id>_<43 base64url>`,
shown once and valid until revoked. The same secret does two jobs on the
server:

- `POST /v1/identity/bootstrap` with it returns an ordinary gateway JWT
  for the token's one gateway (0620#gateway-credential), so a collector
  uploads as the service account;
- `POST /v1/identity/token` with `grant_type: service_token` returns a
  one-hour `read` access JWT (0620#read-credential), so a script queries
  the org as the service account.

The client already has both seams: `hyp join <url> --token-file <path>`
writes a seed whose `identity.bootstrap_token` the central sink exchanges,
and `hyp remote login <name> --token-file <path>` stores a credential the
query path reads. Two things stop the secret from working through them
unchanged:

1. **Seed retirement drops the secret.** The first successful apply removes
   the seed (LLP 0031#physical-layout), and the served config carries no
   bootstrap token. From then on the collector lives on its gateway JWT and
   refresh. A collector that is offline past the JWT lifetime, or whose
   `identity.json` is lost, has nothing left to re-enroll with, though the
   operator's secret is still live. A human gateway fixes that with a new
   `hyp join`; an unattended collector cannot.
2. **A static remote record sends the secret as a bearer.** `--token-file`
   stores `kind: 'static'` and sends the file's bytes on every query. The
   secret is not a JWT, so every query would 401, and a long-lived secret
   would ride every request instead of a one-hour JWT.

This is its own Draft LLP rather than a section in the server doc because
it changes a settled client behavior (what survives seed retirement) and
adds a credential kind to the store LLP 0058 defines.

## Decisions {#decisions}

### D1: Provisioning is `hyp join` in a separate environment {#provision}

No new command and no new flag. The supported setup for a collector, on
an automation host or in a container, is:

```sh
export HYP_HOME=/srv/hypaware-collector   # its own state root, never a person's
printf '%s' "$HYP_SERVICE_TOKEN" > "$HYP_HOME/.service-token"   # or any 0600 path
chmod 600 "$HYP_HOME/.service-token"
hyp join https://api.hypaware.ai --token-file "$HYP_HOME/.service-token" --no-daemon
hyp daemon install    # or run `hyp daemon start --foreground` under the host's supervisor
```

- `--token-file` or stdin, as `hyp join --help` already advises; the
  positional form works but lands in shell history.
- A separate `HYP_HOME` keeps the service gateway off any person's machine
  identity, local capture config and query credentials. On a person's own
  machine the same command would replace that machine's enrollment, so the
  docs and the hypscope copy (UX-264) say to use a dedicated environment.
- What the collector captures is whatever that environment runs (for
  example a CI job's agent sessions pointed at it, or an OTLP source). The
  gateway's attribution to the account is server-side (0620#attribution);
  the client sends no account field.

### D2: An `hsa_` seed token is kept beside the identity {#secret-file}

When `hyp join` is given a token that starts with `hsa_`, it also writes
the token, atomically and at mode 0600, to `service-token` in the same
directory as the central sink's persisted identity (`identity.json`,
default `<HYP_HOME>/plugins/@hypaware/central/`). The path is derived
from the existing `identity.persisted_path`; no config key is added.

- Seed retirement is unchanged: the seed still goes after the first apply,
  and the served config still carries no token.
- A non-`hsa_` token behaves exactly as today (no file).
- The prefix is a routing hint, not trust: the server decides what the
  secret is. A mistyped prefix only means a file is kept or not.
- `hyp leave` unlinks `service-token` beside every identity path it already
  removes (step 4 of `runLeave`), and reports a failure the same way.

### D3: The central sink re-enrolls from the kept secret, once {#rebootstrap}

`IdentityClient` reads its bootstrap token as: the configured
`identity.bootstrap_token` if set, else the `service-token` file beside
`persistedPath` if present. Everything else keys off that one value, so
the existing `mintChanged` fingerprint check covers a re-join with a new
secret (new fingerprint, one re-bootstrap) and a steady boot (same
fingerprint, load).

- **Expired or lost identity.** When `refresh()` gets `401`, or
  `identity.json` is missing, and a kept secret exists, the client calls
  `bootstrap()` once. Success persists a JWT for the same gateway (the
  server binds one gateway per token, 0620#token), so the gateway id does
  not change and nothing is re-attributed. A second `401` in a row is the
  ordinary error path.
- **Revoked or disabled stops, it does not loop.** A `403` with
  `error: 'service_token_revoked'` or `'service_account_disabled'` from
  bootstrap, refresh or upload raises a `ServiceCredentialStopped` error
  carrying that code. The sink stops sending for that sink and does not
  retry until the daemon restarts or the kept secret's fingerprint changes
  (a new `hyp join`). Rows already captured stay in the local spool under
  its existing bounds; nothing is dropped by the stop itself.
- The sink handles `401` today (`sink.js` upload and refresh paths) and has
  no `403` branch; this adds the one branch above and nothing for other
  `403` bodies, which keep today's behavior.
- **Status says why.** `hyp status` shows the central line as
  `stopped: service token revoked` or `stopped: service account disabled`,
  with the remedy "create a new token in HypAware and run `hyp join` again".

Bounded cost: one file read at sink start and on a re-bootstrap, one
extra request per expiry, zero requests after a stop.

### D4: `hyp remote login --token-file` stores an `hsa_` secret as `kind: 'service'` {#remote-login}

`hyp remote add <name> <url>` then `hyp remote login <name> --token-file
<path>` (or stdin), the same commands as today. When the token starts
with `hsa_`, login stores:

```ts
// RemoteServiceRecord, a third arm of RemoteCredentialRecord (LLP 0058#d4)
interface RemoteServiceRecord {
  kind: 'service'
  secret: string        // the hsa_ secret, 0600 store only
  accessJwt: string     // cached; '' until the first exchange
  expiresAt: string     // ISO, of accessJwt
  org: string           // from the exchange response
}
```

- Login exchanges once before writing, so a revoked or mistyped secret
  fails at login with the server's code, not at the first query.
- `resolveAccessJwt` for `kind: 'service'`: a fresh cached JWT is returned
  with no lock and no request; otherwise it posts `{grant_type:
  'service_token', service_token}` to the derived identity base, under
  `withCredentialsLock` with the compare-and-swap commit of LLP 0065#d1,
  so concurrent `hyp` processes make one exchange. `forceRefresh` (the
  401 retry-once in `attachWithRefresh`) re-exchanges.
- `401 invalid_grant` or `403 service_token_revoked` /
  `service_account_disabled` returns `{ ok: false }` with the code and the
  remedy; there is no retry beyond the existing one.
- An older `hyp` reading a `kind: 'service'` record finds no `token` and no
  `refreshToken`, so `normalizeRecord` returns `null` and the target reads
  as logged out: it fails closed and never sends the secret.
- `hyp remote mint` refuses a service record locally (the server refuses it
  too: minting needs a session, 0620#matrix).

### D5: The env override stays a static bearer, and refuses a raw secret {#env}

`HYP_REMOTE_TOKEN_<TARGET>` keeps meaning "send these bytes as the
bearer". If its value starts with `hsa_`, `resolveAccessJwt` returns
`{ ok: false }` with "`HYP_REMOTE_TOKEN_<TARGET>` holds a service token;
store it with `hyp remote login <name> --token-file <path>`" rather than
sending a long-lived secret on every request.

### D6: Observability and secrecy {#observability}

- Spans and logs on `identity.bootstrap`, `identity.refresh` and the
  service exchange carry `component: 'central'` or `'remote'`,
  `credential_kind: 'service_token'`, `status`, and `error_kind` (the
  server's code), plus the secret's existing `fingerprintToken` value
  where identity matters. Never the secret, the JWT or the hash.
- `hyp doctor`/`status` never print the kept file's contents, only that it
  exists.

## Verification {#verification}

- Traditional tests: prefix detection; `service-token` path derivation
  from `persisted_path`; `normalizeRecord` round trip for `kind: 'service'`
  and the older-reader `null`; the env refusal; the 403 codes mapping to
  `ServiceCredentialStopped`.
- Hermetic smoke `central_service_token_collector` (stable `DEV_RUN_ID`,
  `smoke_step` per step) against a fake central: join with an `hsa_`
  secret, upload a row, expire the JWT and see one re-bootstrap from the
  kept file with the same gateway id, answer `403 service_token_revoked`
  and assert no further requests within the poll window, `hyp leave`
  removes `service-token`. A second flow: `remote login --token-file`,
  query, revoke, the error names the code.
- The real-server proof is HYP-109's dogfood run (two tokens, revoke,
  disable) in a disposable org; seats hold no credentials, so a person runs
  it.

## Rejected {#rejected}

- **Keep the seed for `hsa_` joins.** Retirement removes the policy token
  from disk on purpose (LLP 0031#physical-layout); keeping the whole seed
  also keeps a stale central layer as a fallback. One secret file is
  smaller.
- **A config key for the secret path.** The path derives from
  `persisted_path`; a key adds a place to get it wrong.
- **A `hyp service` command.** `join` and `remote login` already take a
  token file; a new verb would duplicate both.
- **Exchange the env override's secret.** The env override is documented
  as a static bearer; changing its meaning by prefix surprises existing
  scripts, and the store path already does the exchange.
