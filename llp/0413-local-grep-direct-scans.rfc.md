# LLP 0413: Local grep is a plugin using direct scans

**Type:** RFC
**Status:** Accepted
**Systems:** Query, Cache, Plugins, MCP
**Author:** Phil / Codex
**Date:** 2026-09-16
**Supersedes:** LLP 0264#decision, LLP 0264#verb, LLP 0264#lifecycle, LLP 0264#dependency (local implementation only); LLP 0314#decision and LLP 0353#registry (automatic core registration only)
**Related:** LLP 0003, LLP 0005, LLP 0105, LLP 0302, LLP 0303, LLP 0304
**Extended-by:** LLP 0415 (supersedes manual activation in #plugin)

## Direct local scans {#scans}

Local history does not justify the CPU, memory, disk space, and maintenance
complexity of building hypgrep indexes. Search all live local data files through
the existing direct scan path. Remove the local hypgrep dependency, index
worker, build pass, and index coverage reporting.

Preserve projected range reads, one row group at a time, and a hit buffer
trimmed at twice the requested limit. Preserve date pruning, newest-first
ordering, cancellation, freshness, position deletes, and local-only visibility.
Search CPU now scales with the projected rows in the selected date window;
there is no background indexing or index buffer residency.

Existing sidecars are ignored. Existing cache file accounting and cleanup keep
treating legacy sidecars as index bytes and reclaim them with their data files.
No cache schema, cursor, or recorded data migration is needed.

## Ordinary plugin ownership {#plugin}

`@hypaware/grep` owns the local service and the `hyp query grep` / `grep_search`
verb registration. Core contributes SQL only. The bundled plugin has no
background source, capability, configuration section, or runtime dependency.
Its `compose_with: ["@hypaware/ai-gateway"]` includes it in newly composed
capture configurations. Existing configurations enable it by adding
`{"name":"@hypaware/grep"}` to `plugins[]`; normal disabled-plugin semantics
apply. Boot does not silently add it to an existing host.

## Server boundary {#server}

The server owns its hypgrep dependency, archive indexes, search service, and
boot selection. None changes here. Core no longer claims `grep_search` ahead
of a server registering its own tool, and the local plugin is not implicitly
activated in server boot.

Keep the shared `hypaware/core/search` exports, allowlist, matcher, wire types,
and `VerbOperationContext.search` backend seam. The plugin verb retains that
seam for hosts that explicitly activate it and supply their backend. Keep
remote routing, parameters, hit shape, and completeness flags unchanged.

## Verification {#verification}

Traditional tests cover scans, privacy, purge, ordering, legacy sidecar
independence, maintenance without indexes, plugin activation, and the host's
ability to register `grep_search`. The hermetic `query_grep_roundtrip` smoke
checks matching CLI results before and after compaction, no generated index,
and search spans that report scans only. The shared server exports stay intact.
