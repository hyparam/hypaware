# LLP 0483: The Replica Lease Renews Only on the Active Generation

**Type:** Decision
**Status:** Superseded
**Superseded-by:** [LLP 0491](./0491-team-history-uses-remote-graph-and-agent-guidance.spec.md) (client replication and its commands; shared kernel utilities remain)
**Systems:** Graph, Daemon, Privacy
**Author:** HypForge designer
**Date:** 2026-10-09
**Extends:** [LLP 0480#sync](./0480-fastask.design.md#sync) (when the lease renews, and what a credential change forces) and [LLP 0480#replica](./0480-fastask.design.md#replica) (the replica key)
**Related:** LLP 0481 (plan; tasks T5 and T12), LLP 0482; server LLP 0554#lease, server LLP 0560

> Two rulings on LLP 0481 T5's replica sync (implementer-3, branch
> `codex/fastask/T5` at `03e0db39`). The lease renews only when the server
> confirms the generation the client is serving, or when a new one is
> activated. A changed credential forces one unconditional manifest check.
> Both keep a stale or foreign replica from being renewed indefinitely.

## Decision {#decision}

### When the lease renews {#lease-renewal}

The lease (`hyp-snapshot-lease`, server LLP 0554#lease) renews only on:

- `304` for the active generation;
- `200` whose manifest names the active generation;
- successful activation of a new generation (verified, indexed and swapped
  in, LLP 0480#sync steps 4 to 6).

A `200` announcing a different generation that the client cannot activate
does **not** renew the lease. That covers a format the client does not
support (unknown `schema_version`, `id_recipe` or column list, server
LLP 0560 item 6), a download that fails verification, and a build that fails
or is refused (`replica_too_large`). Transient failures are retried on the
normal backoff; if activation succeeds before the lease ends, the lease
renews then. Otherwise the old generation is served, with state `stale`
(failed download or build) or `unsupported` (format), only until the lease
from the last renewing answer ends, and then it expires. `400
unsupported_protocol` likewise does not renew.

The reason: LLP 0480's table renewed the lease on every authorized `200`. A
client that can never activate the server's current generation would then
serve its old generation for ever, and rows the server withdrew or purged in
newer generations would never leave the replica. The lease means "this
replica reflects the server's current generation, recently confirmed". The
UX guardian's line "unsupported, upgrade hypaware; still using data as of X
until Y" (LLP 0480#status-line) now has a fixed Y.

### A changed credential forces an unconditional check {#credential-change}

Static and environment-token logins carry no org until the first manifest
answers, so their replica key is the origin plus an empty org, and the org is
learned from `manifest.org` (T5's reading, accepted). Generation ids are
unique only per org, so after a token swap to another org a conditional check
could match the old generation id and answer `304`, renewing the previous
org's replica.

So `replica.json` records a fingerprint of the credential that last renewed
the lease: the first 16 hex characters of the SHA-256 of the token (for OIDC
logins, of the refresh-session identity), never the token itself. When the
current credential's fingerprint differs, the next check is sent without
`If-None-Match`. If its `200` names the recorded org and the active
generation, nothing else changes. If the org differs, the change is handled
as a key change (LLP 0480#replica: the old replica is deleted, the new one
synced). OIDC records already carry their org and keep the existing key rule;
the fingerprint check applies to them too, and costs one full manifest
response after a re-login.

## Accepted as implementation freedom {#accepted}

T5's other readings, one line each:

- Only `403 snapshot_access_withdrawn` deletes the replica; any other `403`
  (for example `org_mismatch`) is `stale` with reason `credential`.
- Withdrawal and expiry delete generations and staging but keep a data-less
  `replica.json` (state, org, watermark) for the status line; records of
  non-current keys are deleted at each pass so they cannot accumulate.
- The per-line column check is the index builder's (T6), and activation stays
  gated on that build succeeding over every line, so a column mismatch leaves
  the old generation active (server LLP 0560 item 10).

## Consequences {#consequences}

- T5 implements both rulings, with tests: an unsupported `200`, a failing
  download and a refused build each leave the lease unrenewed and expire the
  old generation at the old lease end; a token swap to another org sends an
  unconditional check and replaces the replica; a token rotation within the
  same org keeps it without a download.
- T12's lifecycle tests include the token-swap case.
- CPU and memory: one hash per credential change and one short string in
  `replica.json`. No concern.
