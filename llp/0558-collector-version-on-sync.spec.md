# LLP 0558: Report the loaded collector version on sync requests

**Type:** Spec
**Status:** Draft
**Systems:** Sinks, Identity, Observability, Privacy
**Author:** Phil / Codex
**Date:** 2026-10-26
**Related:** LLP 0025, LLP 0393, LLP 0408; hypaware-server LLP 0661

## Operational observation {#report}

Every central config GET and ingest POST carries `X-Hyp-Client-Version`, the
HypAware package version loaded by this process. Read it once through the
existing package-version constant, never from the installation on each request:
an updated CLI must not make an older daemon report the new disk version.
Retries, gzip uploads, inventory repair and no-content config responses use
the same header. No new endpoint, timer, configuration key or dependency exists.

This small authenticated protocol observation is independent of product
telemetry consent, enrollment bindings and delivery queues. It carries only
the loaded package version. The gateway identity remains the verified JWT's
subject, never a client-supplied identity or a captured row.

## Compatibility and visibility {#compatibility}

The header is optional for old clients and ignored by old servers. The server
records a valid bounded version with its own request-time clock, before config
ETag handling or ingest deduplication/backpressure. Missing or malformed
headers do not reject sync or refresh a version observation. A legacy collector
that has never reported a version remains unknown in the operational view.

The server's companion LLP 0661 defines persistence, analytics precedence and
the org-scoped `collector_status` read. A queued historical analytics event
cannot overwrite an operational observation. Existing telemetry privacy
controls and delivery behavior are unchanged.

## Verification {#verification}

Transport tests assert the loaded-version header on config polls, authenticated
retries and streamed ingest. Server tests exercise real authenticated HTTP,
including analytics disabled, 304, duplicate ingest, missing/invalid headers,
unauthorized callers, stale analytics, persistence and physical org isolation.
