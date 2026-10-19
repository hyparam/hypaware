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
LLP 0063, LLP 0065, LLP 0298, LLP 0025, Linear HYP-264, HYP-267

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

No new command, flag or config key. The supported setup for a collector,
on an automation host or in a container, is:

```sh
export HYP_HOME=/srv/hypaware-collector   # its own state root, never a person's
install -d -m 700 "$HYP_HOME"
printf '%s' "$HYP_SERVICE_TOKEN" | hyp join https://api.hypaware.ai - --no-daemon
hyp daemon install    # or, under the host's own supervisor: hyp daemon run
```

- **The token arrives on stdin** (`-` as the token, or no token with a
  piped stdin; `hyp join --help` lists both). Nothing but the kept record
  (D2) holds it on disk, and it never lands in shell history or argv.
- **If a token file is needed** (a secret mount, say), create it private
  from the first byte rather than tightening it afterwards:
  `(umask 077; printf '%s' "$HYP_SERVICE_TOKEN" > "$HYP_HOME/.service-token")`,
  then `hyp join https://api.hypaware.ai --token-file
  "$HYP_HOME/.service-token" --no-daemon`. `hyp join` reads it and does not
  keep or modify it; the operator may delete it after the join, since the
  kept record (D2) is what re-enrollment reads. On an existing file `>`
  truncates and keeps that file's old mode, so the docs say to `rm -f` it
  first when its mode is not already `0600`.
- **The commands are the shipped ones.** `hyp join <url> [token]
  [--token-file <path>] [--no-daemon]` (`runJoin`); `hyp daemon install`
  installs and starts the launchd or systemd service; `hyp daemon run
  [--config <path>]` is the foreground daemon for a host that brings its
  own supervisor (a container entrypoint, a CI job). `hyp daemon start`
  starts an already installed service and is not the foreground path.
- **Where things land.** The state root is `<HYP_HOME>/hypaware`. The
  central sink's identity and the kept record default to
  `<HYP_HOME>/hypaware/plugins/@hypaware/central/` (`identity.json` and
  `service-token`), or the directory of the sink's
  `identity.persisted_path` when the config names one.
- A separate `HYP_HOME` keeps the service gateway off any person's machine
  identity, local capture config and query credentials. On a person's own
  machine the same command would replace that machine's enrollment, so the
  docs and the hypscope copy (UX-264) say to use a dedicated environment.
- What the collector captures is whatever that environment runs (for
  example a CI job's agent sessions pointed at it, or an OTLP source). The
  gateway's attribution to the account is server-side (0620#attribution);
  the client sends no account field.

### D2: An `hsa_` join keeps a destination-bound record beside the identity {#secret-file}

When `hyp join` is given a token that starts with `hsa_`, it keeps the
token in a **record bound to the URL it was enrolled against**, so the
binding survives the loss of `identity.json`:

```ts
// <dir of identity.json>/service-token, mode 0600
interface KeptServiceToken {
  version: 1
  secret: string          // the hsa_ secret
  central_url: string     // the join URL, canonicalized as sameCentral does
  fingerprint: string     // fingerprintToken(secret), checked on read
  written_at: string      // ISO
  stopped_code?: string   // set by D3's stop, cleared only by a new join
}
```

- **Private from creation.** Written with the existing `atomicWriteJson`
  and `{ mode: 0o600, dirMode: 0o700, fsync: true }`: the temp file is
  created at `0600` (the umask can only narrow it), chmodded to exactly
  `0600`, synced, then renamed over the target. There is no moment when
  the secret sits in a looser file.
- **An existing file is replaced, never edited.** The rename swaps in a new
  inode, so an older `service-token` with a looser mode, or one an operator
  replaced by hand, does not pass its mode on. A missing directory is
  created `0700`; an existing directory keeps its mode (the file is `0600`
  either way).
- **Which directory.** The same set of identity paths `runLeave` step 4
  sweeps: each central sink's `persistedPath` from `readCentralSinks`, or
  the default `<stateRoot>/plugins/@hypaware/central/identity.json` when
  none is named. No config key is added.
- **Order inside `hyp join`.** The kept record is written first, then the
  seed. A failed record write aborts the join before the seed is touched,
  so the previous enrollment and its record are unchanged. A failed seed
  write after it leaves a record bound to the new URL while the config
  still names the old one; D3's binding rule means neither secret reaches
  the other server, the old identity keeps working, and re-running the
  join completes it.
- Seed retirement is unchanged: the seed still goes after the first apply,
  and the served config still carries no token.
- The prefix is a routing hint, not trust: the server decides what the
  secret is. A mistyped prefix only means a record is kept or not.

**Retirement.** A kept record never outlives a change of enrollment kind:

- **`hyp join` with a token that is not `hsa_`** (a CI or enrollment
  token) unlinks `service-token` beside every identity path above
  **before** it writes the seed.
- **Login enrollment** (`seedLoginGateway`, reached from the browser
  `hyp remote login` that enrolls this machine, LLP 0063, and from the
  wizard's join lane) unlinks `service-token` beside each sink's
  `persistedPath` **before** `writeLoginSeed` writes that sink's login
  identity. A failed unlink throws out of `seedLoginGateway`, so
  `enrollCentralSink` rolls its seed back exactly as it does for any seed
  failure today.
- **`hyp leave`** unlinks `service-token` beside every identity path it
  already removes (step 4 of `runLeave`), before that path's
  `identity.json`, and reports a failure the same way (exit 1 with the
  re-run hint).
- **Failure ordering.** `ENOENT` is success. Any other unlink error aborts
  the join or the login enrollment with exit 1, the path and the errno,
  before a new identity is written (and, for `hyp join`, before the seed):
  the old service enrollment and its record stay as they were, and nothing
  new is half-installed. If a later step of the join or enrollment fails
  after the unlink succeeded, the old identity keeps working until it
  next needs recovery, then reports the ordinary error and needs a new
  `hyp join`; no secret is left on disk to reach anywhere. In `hyp
  leave` the daemon is already uninstalled by step 4, so a leftover record
  is never read; the re-run removes it.

### D3: The central sink recovers from the kept record only at its own destination {#rebootstrap}

The kept record is a **second source, never mixed with the first.**
`IdentityClient` keeps today's `bootstrapToken` (the configured
`identity.bootstrap_token`, present only while a fresh join's seed is
live) and its exact path: `mintChanged` and its fingerprint check still
decide a re-join. The kept secret is a separate field, read only when
recovery is needed. It is never assigned to `bootstrapToken` and never
reaches `mintChanged`, so the URL-changed branch of `mintChanged` can
never send it.

`acquire()` decides in this order; the first matching row wins:

| State | Action | Requests |
| --- | --- | --- |
| configured `bootstrapToken` set | today's path, unchanged (`mintChanged` then the URL-mismatch refusal) | as today |
| persisted identity, `!sameCentral(persisted.central_url, centralUrl)` | today's URL-mismatch refusal, unchanged; the kept record is not read | 0 |
| persisted identity, same destination | load, or refresh when stale | as today |
| no persisted identity | read the kept record; if `sameCentral(kept.central_url, centralUrl)` and no `stopped_code`, `bootstrap()` once with it; otherwise refuse | 1 or 0 |

`refresh()` answered `401` recovers from the kept record only when all of
these hold, otherwise it takes the ordinary error path:

- `sameCentral(kept.central_url, centralUrl)` (and the persisted identity
  already passed the same check above);
- `persisted.bootstrap_token_fp === kept.fingerprint`, so the identity
  being recovered is the one this secret enrolled;
- `persisted.origin !== 'login'`: a login identity never recovers from a
  kept secret, even if retirement were skipped;
- no `stopped_code`.

- **Same destination, lost or expired identity.** One `bootstrap()` with
  the kept secret. Success persists a JWT for the same gateway (the server
  binds one gateway per token, 0620#token) with `central_url` and
  `bootstrap_token_fp` stamped as today, so the gateway id does not change
  and nothing is re-attributed. A second `401` in a row is the ordinary
  error path.
- **Changed destination.** A config now naming server B, with a record
  bound to A, sends nothing to B, with or without `identity.json`. The
  error says the collector is enrolled with A and gives the remedy
  `hyp join <B>` with a token from B. The existing URL-mismatch refusal
  and its remedy text are not changed.
- **Unreadable record.** Any read error other than `ENOENT` (`EACCES`,
  `EISDIR`, `EIO`), bad JSON, an unknown `version`, a missing field, a
  secret that fails the `hsa_` shape, or a `fingerprint` that does not
  match the secret: no request, `error_kind: 'service_token_unreadable'`,
  and `hyp status` shows `stopped: service token file unreadable` with the
  path and the remedy "run `hyp join` again". The contents are never
  logged or printed. `ENOENT` means no record: no recovery, the ordinary
  error path.
- **Revoked or disabled stops, and stays stopped.** A `403` with
  `error: 'service_token_revoked'` or `'service_account_disabled'` from
  bootstrap, refresh or upload raises a `ServiceCredentialStopped` error
  carrying that code. The client then rewrites the kept record with
  `stopped_code` set (same atomic `0600` write), so the stop holds across
  daemon restarts and config reloads: no further bootstrap, refresh or
  upload request for that sink until a new `hyp join` replaces the record.
  If that rewrite fails, the stop still holds in memory for the process
  and the failure is logged with `error_kind`. Revocation and disable are
  permanent on the server (0620), so a stored stop is never wrong. Rows
  already captured stay in the local spool under its existing bounds;
  nothing is dropped by the stop itself.
- The sink handles `401` today (`sink.js` upload and refresh paths) and has
  no `403` branch; this adds the one branch above and nothing for other
  `403` bodies, which keep today's behavior.
- **Status says why.** `hyp status` shows the central line as
  `stopped: service token revoked` or `stopped: service account disabled`,
  with the remedy "create a new token in HypAware and run `hyp join`
  again".

Bounded cost: the steady path never reads the record. One small file read
per recovery, one bootstrap per lost or expired identity, zero requests
after a stop or a destination refusal, and one file rewrite per stop.

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
  from `persisted_path` and the default; `normalizeRecord` round trip for
  `kind: 'service'` and the older-reader `null`; the env refusal; the 403
  codes mapping to `ServiceCredentialStopped`.
- **Destination binding (fake fetch that records every request's URL and
  bearer).** A record bound to A, config naming B: with `identity.json`
  bound to A, and with no `identity.json`, zero requests reach B and none
  carries the `hsa_` secret; the error names A and the `hyp join <B>`
  remedy. The URL-mismatch refusal's message is byte-identical to today's.
  A configured `bootstrap_token` with a changed URL still takes today's
  path (the seed of a deliberate re-join), and the kept secret never
  appears in that request.
- **Same-destination recovery.** No `identity.json`, record bound to the
  configured URL: exactly one bootstrap with the kept secret, same gateway
  id persisted. Refresh `401` with a matching fingerprint: one bootstrap.
  A mismatched `bootstrap_token_fp`, or `origin: 'login'`: no bootstrap.
- **Transitions.** `hyp join` with a CI token over a service enrollment,
  and a login enrollment over one: `service-token` is gone before the seed
  or the login identity is written, and a forced refresh `401` afterwards
  makes no bootstrap with the old secret. A failing unlink (`EACCES` via an
  fs seam) exits 1 with nothing else written.
- **Failed replacement.** `hyp join` with a new `hsa_` secret where the
  record write fails: exit 1, old record and seed unchanged. Where the seed
  write fails after the record: the old identity still loads, and neither
  secret reaches the other URL.
- **Permanent refusal.** `403 service_token_revoked` from bootstrap,
  refresh and upload each: no further request in the poll window, the
  record carries `stopped_code`, and a daemon restart with the same record
  makes zero requests. A new `hyp join` clears it.
- **Unreadable record.** `EACCES`, `EISDIR`, bad JSON, unknown version,
  bad shape and fingerprint mismatch each give zero requests,
  `service_token_unreadable`, and output that does not contain the secret.
- **Private creation.** In a disposable `HOME` and `HYP_HOME` under umask
  `022`, with a fake token and a fake central, run D1's commands with
  `hyp daemon run` (never the real supervisor): `service-token` is `0600`,
  its directory is `0700` when join created it, and an existing `0644`
  `service-token` is replaced by a `0600` file (new inode). Repeat with the
  `--token-file` variant.
- Hermetic smoke `central_service_token_collector` (stable `DEV_RUN_ID`,
  `smoke_step` per step) against a fake central: join with an `hsa_`
  secret, upload a row, expire the JWT and see one re-bootstrap from the
  kept record with the same gateway id, answer `403 service_token_revoked`
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
- **Load the kept secret as the bootstrap token.** The first draft did
  this; `mintChanged` then treats a changed URL as a re-join and sends the
  old server's secret to the new one before the URL-mismatch refusal runs.
  A separate source, used only for recovery at its own destination, cannot.
- **A bare secret file.** Without its URL beside it, the binding lives only
  in `identity.json` and is gone exactly when recovery needs it.
- **A config key for the secret path.** The path derives from
  `persisted_path`; a key adds a place to get it wrong.
- **A `hyp service` command.** `join` and `remote login` already take a
  token file; a new verb would duplicate both.
- **Exchange the env override's secret.** The env override is documented
  as a static bearer; changing its meaning by prefix surprises existing
  scripts, and the store path already does the exchange.
