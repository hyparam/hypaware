# LLP 0298: CI enrollment by user-minted token, one shared gateway

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Onboarding, Sinks, Gateway
**Author:** Kenny / Claude
**Date:** 2026-08-20
**Related:** LLP 0025, LLP 0033, LLP 0058, LLP 0061, LLP 0063, LLP 0065, LLP 0101

> HypAware has no way to capture and forward from a CI session: the two
> enrollment paths are attended OIDC login (LLP 0058) and operator-distributed
> bootstrap tokens for MDM fleets (LLP 0063 D6), and neither fits a developer
> pointing their own CI pipeline at their own org. Grilled against the corpus
> on 2026-08-20; the decisions below are the client-local forks resolved in
> that session. The server half (the mint endpoint, token semantics, JWT
> concurrency) is decided in the hypaware-server repo and is a prerequisite.

## Decisions

### D1: CI is the join path, not a new credential kind {#join-path}

A CI virtual machine enrolls with `hyp join <url> <token>`, exactly as an MDM
fleet machine does. The only novelty is who minted the token: the user, for
themselves, instead of an operator distributing one. No new credential kind,
no parallel CI code path on the client. The first-sync review window does not
apply, by LLP 0101 #which: a bootstrap-token join forwards immediately, and a
user who minted the token chose enrollment as deliberately as an operator.

**Rejected:** a distinct CI token kind with its own store and verbs. It would
duplicate the per-target credential model of LLP 0033/0058 for no behavioral
difference.

### D2: All runs of a pipeline share one gateway {#shared-gateway}

The minted token is bound to **one gateway row**, created once at mint time.
Every CI run that joins with it exchanges the token for its own short-lived
gateway JWT against that same gateway, via the existing
`IdentityClient.bootstrap()` exchange (one HTTP round trip per run, then the
JWT is cached in the run's `identity.json` for its lifetime).

- The shared secret **never rotates**. Rotation of a shared credential across
  concurrent VMs would recreate the refresh double-spend race that LLP 0065
  solved with a machine-local lock, and that lock cannot span VMs.
- Server prerequisite: the bootstrap endpoint must accept a user-minted token
  bound to an existing gateway (re-minting a JWT for it instead of creating a
  row), and multiple JWTs for one gateway must be valid concurrently.

**Rejected:** one gateway per run (the user wants runs grouped under one
gateway, and rows would pile up server-side). **Rejected:** using the minted
token directly as the bearer on every request (a long-lived secret on every
request, and a new non-JWT path through the sink's 401-refresh loop on the
client and the ingest validator on the server).

### D3: Minting is a CLI verb with a 365-day default expiry {#mint}

`hyp remote mint <target>` runs on the user's own logged-in machine, uses
their OIDC credential (LLP 0058) to call the server's mint endpoint, and
prints the token **once** for pasting into CI secrets. Tokens expire; the
default is **365 days**, overridable by flag. The verb lives in the
`hyp remote` family because that is the per-target credential surface. On the
wire it is `POST <identity-base>/mint` (the sibling of `/token` and
`/refresh`), bearer = the session's access JWT, response
`{ token, gateway_id, expires_at }`.

### D4: The CI recipe is explicit setup and teardown steps {#recipe}

The documented recipe is three existing commands, run by the user's CI
config:

1. **Setup:** `hyp join <url> <token> --no-daemon`, then
   `hyp daemon run --foreground` backgrounded by the CI shell. The
   `--no-daemon` fork avoids launchd/systemd, which container runners lack.
2. The job's agent steps run unchanged.
3. **Teardown:** `hyp sync --yes`. Sinks export on a schedule, and the most
   valuable rows land when the agent session ends, seconds before the VM
   dies, so no cadence can be trusted to drain the tail. The flush must be an
   explicit final step.

**Rejected:** a wrapper verb (`hyp run -- <cmd>`) that joins, captures,
runs, and drains in one line: awkward to compose with real CI steps.
**Rejected:** eager export cadence instead of a flush: it still loses the
tail of the final session.

### D5: Per-run attribution is deferred {#attribution}

Runs sharing one gateway are distinguishable only by session id, cwd, and
time. Capturing the CI run id (for example `GITHUB_RUN_ID`) into rows is
deliberately **not** built now; it is filed as a GitHub issue instead, per
the smallest-change rule.
