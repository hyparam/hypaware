# `@hypaware/central` ⇄ `@hypaware/server` wire contract

The central HypAware server is implemented in a separate package
(`@hypaware/server`, post-V1 Phase 10). Both packages compile against
the TypeScript types in [`src/types.d.ts`](./src/types.d.ts); this
document is the wire-level reference.

The contract has three surfaces: identity (bootstrap + refresh), config
pull (operator-defined config delivered to gateways), and ingest (cache
partitions forwarded as NDJSON, per signal).

All endpoints are HTTPS in production. Bodies are UTF-8 JSON unless
explicitly NDJSON (`application/x-ndjson`). Errors return a JSON object
with at least `{ "error": "<kind>" }`; `<kind>` is a short snake_case
tag the client uses for diagnostics — humans read the HTTP status.

## Versioning

All paths are versioned with a leading `/v1/`. Backwards-incompatible
shape changes go to `/v2/` and both versions stay live until the kernel
release that drops `/v1/` ships. Clients send no version header.

## Identity

The gateway holds one long-lived JWT issued by the central server. The
JWT's `sub` is the gateway id; the kernel persists `{ jwt, expires_at,
gateway_id }` to `<plugin.stateDir>/identity.json` (mode 0600,
atomic tmp+rename).

### POST `/v1/identity/bootstrap`

Exchange an operator-issued bootstrap token for a long-lived JWT.
Bootstrap tokens are **policy tokens** (server LLP 0008): multi-use, so
one token can be deployed fleet-wide via MDM, and every token references
a config at mint (see "Config pull" below).

Request:

```json
{ "bootstrap_token": "<opaque>" }
```

Response 200:

```json
{ "jwt": "<base64url.signed.jwt>", "expires_at": 1814400000 }
```

`expires_at` is a Unix epoch second.

Response 401 / 4xx: `{ "error": "<kind>" }`. Gateway aborts; operator
must issue a new bootstrap token.

### POST `/v1/identity/refresh`

Bearer-authenticated. Exchanges the current JWT for a fresh one.

Request body: none. Authorization: `Bearer <current jwt>`.

Response 200: same shape as bootstrap.

Response 401: JWT invalid or revoked. Gateway must re-bootstrap.

### Refresh window

Gateways refresh eagerly when the remaining lifetime falls inside 24h.
A 401 on any other endpoint triggers a one-shot refresh + retry; a
second 401 escalates as an auth failure.

## Config pull

### GET `/v1/config`

Bearer-authenticated. Returns the current operator-defined HypAware v2
config for the calling gateway. Supports ETags via `If-None-Match`.

Headers (request):

- `Authorization: Bearer <jwt>`
- `If-None-Match: <etag>` (optional)

`If-None-Match` reflects the **running** config, never a
downloaded-but-not-yet-applied one. The server reads this header to
track fleet convergence, so a gateway mid-install/mid-apply keeps
presenting its old etag until the new config has taken effect
(LLP 0023).

Response 200:

```json
{
  "version": 2,
  "plugins": [ ... ],
  "sinks": { ... },
  "query": { ... }
}
```

The body is a full HypAware v2 config and replaces the gateway's
operative config wholesale. Plugin entries are pinned by **version +
artifact content hash**; the gateway verifies the artifact hash on
install and treats a mismatch as an apply failure (LLP 0023).

`ETag: <hex>` accompanies every 200 response. Clients persist the etag
in a sidecar (`<plugin.stateDir>/config-etag.json`) so a restart
short-circuits to 304 instead of re-pulling and re-validating.

Response 304: no body. The gateway keeps its current config.

Response 404: legacy-only branch — every token now references a config
at mint (server LLP 0009), so gateways enrolled under that flow always
resolve. Kept for conformance against older servers: back off to
5 minutes and log once until the state clears.

Response 401: see "Refresh window" above.

Response 429 / 503: client honors `Retry-After` if present; otherwise
backs off linearly (30s → 60s → 120s → 300s).

## Ingest

### POST `/v1/ingest/{signal}`

Bearer-authenticated. Body is NDJSON (one row per line, terminated by
`\n`). One request carries one signal; the kernel groups partitions by
the dataset's `sourceSignal` (defaulting to the dataset name) before
posting.

`{signal}` is one of:

| Signal    | Source                                            |
|-----------|---------------------------------------------------|
| `logs`    | `@hypaware/otel` (OTLP log records)               |
| `traces`  | `@hypaware/otel` (OTLP spans)                     |
| `metrics` | `@hypaware/otel` (OTLP metric points)             |
| `proxy`   | `@hypaware/ai-gateway` (`ai_gateway_messages`)    |

Headers (request):

- `Authorization: Bearer <jwt>`
- `Content-Type: application/x-ndjson`

Response 202: batch accepted for processing. Body is empty.

Response 401: see "Refresh window".

Response 400 / 422 (4xx that is not 401 or 429): the batch is poison —
the server saw the request but cannot store it. The gateway drops the
batch from its outbox and counts it as a permanent failure rather than
retrying forever.

Response 429 / 503: server is rate-limiting or temporarily unavailable.
Client retries the same batch. `Retry-After` (seconds or HTTP date) is
honored when present.

Response 5xx (other): transient transport failure. Client retries with
exponential backoff capped at 5 minutes.

### Batch boundaries

The kernel sink driver decides batch boundaries by cron schedule and
partition discovery. The central plugin does not split, merge, or
reorder partitions inside a batch — each partition's rows are
serialized in dataset-iteration order, one JSON document per line.

### Row shape

The body of each NDJSON line is the row as materialized in the local
Iceberg cache. The server is expected to reconcile dataset schemas by
name (`logs`, `traces`, …); the gateway does not annotate rows with a
dataset header. When two datasets map to the same signal (uncommon —
the canonical mapping is 1:1), the gateway sends one POST per dataset.

`dev_run_id` is preserved end-to-end as a payload attribute so smoke
tests can correlate ingested rows with the run that produced them.
