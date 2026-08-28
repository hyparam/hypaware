# LLP 0321: Automatic refresh serves the confirmed cache on flush failure

**Type:** Decision
**Status:** Accepted
**Systems:** Cache, Query
**Author:** Phil / Codex
**Date:** 2026-08-28
**Related:** LLP 0013, LLP 0015, LLP 0311
**Extended-by:** LLP 0322 (#stamp-the-failure: the automatic degrade is paced by a failure stamp and the retry stops rotating a new spool file each time; #degrade-reaches-the-signals carries the degrade into the span status code and the `queryRunsTotal` dimension)

> A query using automatic refresh still reads the last confirmed cache when
> moving waiting spool rows into that cache fails. It gives one clear warning
> and records the failed refresh. A query using forced refresh preserves the
> original error.

## Context {#context}

SQL and grep share one freshness step before reading the cache. That step may
move waiting spool rows into the hot cache so a query includes newly captured
data. During the 1.27 to 1.28 cache transition, the write can reject a cache
whose recorded partition layout differs from the layout the running code
expects. The reproduced error was:

```text
cache-iceberg: partition field "session_id" is new - adding a partition field is spec evolution and requires an explicit migration
```

The waiting rows remain durable in the spool and the previously committed
cache remains readable. Letting the write error end the whole query therefore
hides confirmed data because newer data could not be added. The text search,
SQL scan, and grep sidecars are not the failing parts.

LLP 0311 makes the supported session-to-date repartition writable and migrates
it during maintenance. This decision is a narrow safety net for a failed
automatic freshness move. It does not replace that migration and does not
claim an unreadable committed cache can be queried.

## Decision {#decision}

The shared query freshness step treats refresh modes differently:

- `auto` is best effort. If inspecting or flushing pending spool data throws,
  the query continues against the last confirmed cache. It emits one warning
  that newer waiting rows may be missing.
- `always` is strict. Any refresh failure preserves the original error because
  the caller explicitly required the newest data.
- `never` keeps its existing behavior.

An automatic failure is handled per stream. The helper continues attempting
other referenced streams instead of letting one blocked stream suppress their
fresh rows. Repeated failures in one query produce one user warning, not one
line per stream.

The spool owns durability on the failure path. This mitigation does not delete,
rewrite, or acknowledge waiting rows. A later daemon flush or query retry may
commit them after the cache problem is repaired.

## Observability {#observability}

Every failed automatic attempt emits a structured
`query.cache_refresh_failed` warning with the operation, refresh mode, safe
error kind, and bounded error message. The active SQL or grep span is marked
`status=degraded`, carries `cache_refresh_failed=true`, and receives one event
per failed stream. The user sees one warning even when telemetry records
several failures.

## Consequences {#consequences}

- Ordinary SQL and grep remain useful during a spool-to-cache compatibility
  failure, but never claim the result is current.
- Operators and agents that require current data use `--refresh always` and
  still get a nonzero result with the original diagnosis.
- A committed-cache read failure still fails the query at the read step. This
  decision narrows only the automatic freshness boundary.
- No cache schema, partition layout, spool format, sidecar format, config key,
  or runtime dependency changes.

## Alternatives considered {#alternatives}

### Fail every query when automatic refresh fails

Rejected. It turns an append compatibility problem into loss of access to
already confirmed data.

### Swallow forced-refresh failures too

Rejected. `--refresh always` is an explicit correctness requirement. Returning
older data would violate it even with a warning.

### Add a grep-only fallback

Rejected. SQL and grep share the same freshness move, so they must share the
same failure rule.

## Tests {#tests}

Traditional tests pin the shared mode split, warning de-duplication, per-stream
continuation, degraded span signal, preserved forced-refresh error, retained
spool rows, and an end-to-end grep over confirmed rows using the exact 1.27
partition error.
