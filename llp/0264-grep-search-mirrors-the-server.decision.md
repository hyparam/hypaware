# LLP 0264: `hyp query grep` mirrors the server's grep search, tier for tier

**Type:** Decision
**Status:** Accepted
**Systems:** Query, Cache, CLI, MCP
**Author:** Brendan / Claude
**Date:** 2026-08-18
**Extended-by:** LLP 0265 (implementation plan; its #sequencing resolves the #open item), LLP 0302 (#visibility-predicate, #purge-by-position, #build-site: where the shipped mechanism differs from #visibility and #lifecycle)
**Related:** LLP 0003, LLP 0013, LLP 0034, LLP 0104, LLP 0105, LLP 0209, LLP 0222; hypaware-server LLP 0127, LLP 0128, LLP 0130, LLP 0136, LLP 0157, LLP 0158 (out of tree, design authority for the mechanism)

> Full-text search over recorded sessions ships as `hyp query grep`, a
> read-class verb whose tool is the server's existing `grep_search`. The
> mechanism is the server's, not a new one: mutable data answers by direct
> scan, immutable data answers through hypgrep sidecar indexes, one shared
> column allowlist bounds both, and `--remote` reaches the server's
> archive-backed service unchanged. An earlier draft under this number
> designed a `LIKE` pushdown into the scan engine; the server's shipped
> design replaces it wholesale.

## Context {#context}

Substring search over `ai_gateway_messages` has no fast local path: `LIKE`
is the one predicate the parquet pushdown cannot convert
(hypaware-server LLP 0127 measured a ~13s SQL floor server-side; LLP 0098
here records the same materialize-everything fallback locally).

The server already solved this (hypaware-server `src/search/`): a
grep-search service with **two tiers**. Cache-resident days, which mutate
every tick, are answered by a direct local scan that decodes only the
searchable columns, and are **never indexed** (server LLP 0130: "index
presence is purely a performance property"). Archived day files, which are
immutable, carry `hypgrep` `.index.parquet` sidecars and are answered
through them (server LLP 0128). One allowlist bounds both tiers (server
LLP 0157: `system_text` alone was 90.8% of decoded index-build text, so
"every string column" is refuted by production measurement). Builds run on
a worker thread (server LLP 0136) with a per-file retry bound (server
LLP 0158). The serving surfaces (`POST /v1/search`, the `grep_search` MCP
verb, the admin CLI) are thin wrappers over the one service.

## Decision {#decision}

**The client implements the same mechanism over its own tiers, and the same
tool contract, rather than a new design.** The tier rule transfers, not the
tier names: mutable is scanned, immutable is indexed.

| server | client |
|---|---|
| cache-resident days: direct scan, never indexed | spool + not-yet-compacted data files: direct scan, never indexed |
| archived day files: hypgrep sidecars | compacted cache data files: hypgrep sidecars |
| `SEARCHABLE_COLUMNS` allowlist (LLP 0157) | the same set, imported from the same module |
| `grep_search` MCP tool | the same tool name, compatible `inputSchema` and hit shape |

The client's compacted files qualify as the immutable tier because a data
file is immutable from the moment `stream_append` finalizes it
(`src/core/cache/iceberg/stream_append.js`); compaction and retention
delete whole files, never edit them. Server LLP 0128's rejection of
"index cache files at compaction" is about the *archive* rewriting rows
into different bytes than the cache holds; the client has no second tier
rewriting anything, so the objection does not transfer.

## Shared modules move to core {#shared}

The server already depends on this package (`"hypaware": "file:../hypaware"`).
The pieces both sides must agree on, byte for byte, are hoisted into
hypaware core and imported by the server in a follow-up server PR:

- the searchable-column allowlist and brute-scan projection
  (`searchable-columns.js`, server LLP 0157);
- the matcher (literal/regex compile, `test`/`locate`/`rowTest`) and the
  snippet window constants;
- the `GrepSearchHit` / `GrepSearchResult` shapes.

Sharing the allowlist is what makes "zero hits" mean the same thing locally
and remotely; two drifting copies would make the same query lie on one side.

## The verb and the tool name {#verb}

`hyp query grep` registers as a read-class **verb** in `CORE_VERBS`,
`tool: 'grep_search'`, with an `inputSchema` compatible with the server's
(`query`, `regex`, `session_id`, `chain_id`, `from`, `to`, `limit`). The
verb is what provides `--remote` (LLP 0034): `hyp query grep --remote
<target>` calls `grep_search` on the server, whose archive fan-out then
serves it with **no server-side feature work**. The verb's summary carries
the server's coverage clause verbatim: only the allowlisted columns are
searched, and zero hits is not evidence the text is absent elsewhere.

**Registration collision, load-bearing.** The server's daemon registers its
own `grep_search` and *defers if the tool already exists*
(hypaware-server `src/daemon.js`, "theirs wins"). Once the kernel ships
this verb, a server booting the new kernel would silently lose its
archive-backed implementation and serve the kernel's local-cache one. The
kernel verb and a server change (register-and-replace, or suppress the core
verb server-side) must land as a coordinated pair; shipping the kernel half
alone is a regression on every server host.

## Local visibility: the one thing the server never faced {#visibility}

`local-only` rows never reach the server (the export seam withholds them,
LLP 0070), so its scan needs no visibility logic. The client scan reads
parquet outside the SQL seam, and the verb lands on the MCP host, one of
the three surfaces [LLP 0105](./0105-query-seam-local-only-visibility.decision.md#surfaces)
names. The scan therefore wraps its per-partition source in the existing
`withLocalOnlyVisibility` wrapper (`src/core/query/visibility.js`), the
same module the SQL seam uses, with the verb's `callerCwd`; the lattice is
not reimplemented. `--include-local-only` carries the LLP 0105 #override
semantics unchanged. Purged rows are handled below the wrapper already:
the icebird source applies position deletes (LLP 0104), and the indexed
path prunes *files*, so a pruned-in row still passes through the
delete-applying read.

**Extended-by:** [LLP 0302 #visibility-predicate](./0302-grep-search-integration-divergences.decision.md#visibility-predicate)
and [#purge-by-position](./0302-grep-search-integration-divergences.decision.md#purge-by-position).
The grep walk chooses its tier per file and so reads data files directly, with
no `AsyncDataSource` to decorate: the lattice check is hoisted into a shared
predicate both read surfaces call, and position deletes are applied by the walk
from the committed delete positions. Both rules are unchanged; only where they
are enforced moved.

## Index lifecycle {#lifecycle}

Sidecars are built during **maintenance/compaction**, the moment a file
becomes immutable, on the worker-thread pattern the server proved
(server LLP 0136), with its per-file retry bound (server LLP 0158) and
sidecar-existence as the idempotency marker (server LLP 0128): no ledger,
a crashed build resumes by listing and skipping. Orphan sweep and
retention delete recursively, so a sidecar dies with its file; a test pins
that. An unindexed file (fresh, raced, or poisoned) is brute-scanned, so
index state is never a correctness input (server LLP 0130's invariant).

**Extended-by:** [LLP 0302 #build-site](./0302-grep-search-integration-divergences.decision.md#build-site).
Building only behind a committed compaction strands a partition already at the
compaction floor: it never rewrites, so its files never index. The shipped pass
runs on missing coverage instead, bounded by the maintenance tick's budget and
resumable across ticks on the existence marker this section already names.

## Dependency {#dependency}

`hypgrep` is a plain root `dependency` (the client both builds and reads
indexes). Index writes ride the existing `hyparquet-writer`
optionalDependency exactly as the cache write path does. hypgrep 0.5.1
pins hyparquet 1.27.1, below the 1.28.2 floor
[LLP 0222](./0222-one-pushdown-converter.decision.md#hyparquet-floor)
requires, so adoption includes a root `overrides` entry pinning hypgrep's
hyparquet to 1.28.2 (and its writer to 0.16.6, beside the icebird
override). Widening the range upstream in hypgrep is the durable fix.

## Superseded draft {#superseded-draft}

An earlier, never-committed draft of this decision
(`substring-pushdown-via-ngram-index`) made substring predicates
prunable inside the SQL scan via an icebird row-range hook, with a
predicate whitelist and a `textIndexColumns` registration field. It was
never implemented. The server's shipped service replaces it: same speed
win, no engine surgery, no `appliedWhere` correctness cliff, and one
mechanism across the fleet instead of two.

## Open {#open}

- Sequencing of the server-side PR pair (shared-module import, collision
  fix) relative to the client release.
