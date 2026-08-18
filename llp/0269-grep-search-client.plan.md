# LLP 0269: Grep Search on the Client (Implementation Plan)

**Type:** Plan
**Status:** Accepted
**Systems:** Query, Cache, CLI, MCP
**Author:** Brendan / Claude
**Date:** 2026-08-18
**Related:** LLP 0264 (the decision this sequences), LLP 0105, LLP 0104, LLP 0209, LLP 0222; hypaware-server LLP 0127, LLP 0128, LLP 0130, LLP 0136, LLP 0157, LLP 0158 (mechanism authority, out of tree)

> Turns [LLP 0264](./0264-grep-search-mirrors-the-server.decision.md) into
> ordered work. The client gains `hyp query grep`: a read-class verb whose
> tool is the server's existing `grep_search`, a two-tier local search
> service (scan the mutable tier, hypgrep-index the immutable tier), and a
> maintenance-time sidecar build. Also resolves LLP 0264 #open: the
> server-side PR pair is sequenced here.

## Scope and package map

| Part | Package | Where |
|------|---------|-------|
| T1 shared modules | `hypaware` core | new `src/core/search/` (allowlist, matcher, snippet, hit shapes), exported for the server |
| T2 dependency | `hypaware` root | `package.json`: `hypgrep` + `overrides` |
| T3 grep service | `hypaware` core | new `src/core/search/grep_service.js` |
| T4 verb + registry | `hypaware` core | new `src/core/search/grep_verb.js`; `src/core/cli/core_verbs.js`; `src/core/registry/verbs.js`; `src/core/commands/query.js` |
| T5 index build | `hypaware` core | `src/core/cache/maintenance.js` + new `src/core/search/index_build.js` |
| T6 docs + smokes | `hypaware` | both `hypaware-query` SKILL.md copies; `hypaware-core/smoke/flows/` |
| server pair | `hypaware-server` | import swap onto T1 modules; `grep_search` register-and-replace in `src/daemon.js` |

hypaware-server LLPs 0127/0130/0136/0157/0158 are the mechanism authority:
where this plan says "as the server does", the server's shipped code in
`src/search/` is the reference implementation, not a fresh design.

## Phases

### T1: Hoist the shared modules (no behavior change)

- New `src/core/search/searchable_columns.js`: the LLP 0157 allowlist and
  brute-scan projection set, moved verbatim from the server's
  `src/search/searchable-columns.js`, with its `@ref` retargeted to
  hypaware-server LLP 0157.
- New `src/core/search/matcher.js`: literal/regex compile,
  `test`/`locate`/`rowTest`, snippet window constants, extracted from the
  server's `grep-search.js`.
- Hit shapes (`GrepSearchHit`, `GrepSearchResult`, `GrepSearchMatcher`) in
  `src/core/search/types.d.ts`; export the set from `hypaware/core`.
- Tests: port the server's matcher and allowlist assertions so the moved
  code is pinned before anything consumes it.
- The server-side import swap is a **server PR staged now, merged on its
  next `hypaware` dep bump** (see Sequencing).

### T2: Dependency plumbing

- `hypgrep` into root `dependencies` (LLP 0264 #dependency).
- `overrides`: pin hypgrep's `hyparquet` to 1.28.2 and `hyparquet-writer`
  to 0.16.6, beside the icebird override. This is correctness, not
  hygiene: below 1.28.2 `matchFilter` leaks NULL rows
  ([LLP 0222](./0222-one-pushdown-converter.decision.md#hyparquet-floor)).
- `npm pack --dry-run` check that nothing new leaks into the file set.

### T3: The grep service (correct before fast)

- New `src/core/search/grep_service.js`, the one module that owns query
  execution; every surface is a thin wrapper (the server's LLP 0129 shape).
- Walk: flush the spool first (the query seam's debounce rule), then
  partitions newest-first, files sequentially; memory bound is one file
  plus its index. Budget/limit/abort as the server does.
- Tier rule per file: a sidecar present and readable serves the file via
  hypgrep `parquetFind`; otherwise brute-scan decoding only the
  `SCAN_COLUMNS` projection. Index state is never a correctness input
  (server LLP 0130 invariant).
- Visibility: wrap each partition source in the existing
  `withLocalOnlyVisibility` with the caller's `cwd`
  ([LLP 0105](./0105-query-seam-local-only-visibility.decision.md#surfaces));
  `--include-local-only` keeps its #override semantics. Purged rows: reads
  go through the icebird source, which applies position deletes (LLP 0104).
- Ships **before T5**: everything works unindexed, just slower. This is
  the de-risk split; T5 never blocks the feature.

### T4: The verb and the registry affordance

- `query grep` verb in `CORE_VERBS`: `tool: 'grep_search'`, read-class,
  `inputSchema` compatible with the server's (`query`, `regex`,
  `session_id`, `chain_id`, `from`, `to`, `limit`), summary carrying the
  server's coverage clause verbatim (zero hits is not absence outside the
  allowlist).
- Render: rg-style snippet lines through the LLP 0225 escaping path;
  `--json` returns the structured result unescaped.
- `VerbRegistry.unregister(name)` (or `register` with `replace: true`):
  the affordance the server's daemon needs to win the `grep_search` tool
  name back from the kernel (LLP 0264 #verb). Small, tested, lands here so
  the server PR is trivial.
- `hyp query status`: an index-coverage line (indexed/total files per
  dataset).

### T5: Sidecar build at maintenance

- Build `<uuid>.index.parquet` beside each compacted data file, in
  `compactGeneration`'s pass, on the server's proven shape: worker thread
  (server LLP 0136), per-file retry bound with quarantine (server LLP
  0158), sidecar existence as the idempotency marker (server LLP 0128),
  `hyparquet-writer` via lazy import as the cache write path does.
- Column set: the T1 allowlist intersected with the file's string columns.
- GC: orphan sweep and retention already delete recursively; add tests
  pinning that a sidecar dies with its file and that a stale sidecar
  (file gone) is swept.

### T6: Docs and smokes

- Both `hypaware-query` SKILL.md copies (claude, codex): `grep` joins the
  subcommand list; note the sub-`ngramLength` literal cliff and the
  allowlist boundary.
- Smoke `query_grep_two_tier`: capture rows, grep before compaction
  (brute tier), run maintenance, grep after (indexed tier), assert same
  hits; a purged row absent; a `local-only` row withheld from a `full`
  caller and present with `--include-local-only`.

## Sequencing (resolves LLP 0264 #open)

1. T1..T4 merge and release on the client. A current server serves
   `--remote` unchanged; nothing waits.
2. The server pair (T1 import swap + `grep_search` register-and-replace
   using T4's affordance) merges in hypaware-server **before** that repo
   bumps its `hypaware` dependency past T4. The bump PR must contain or
   follow the pair; a bump without it silently swaps the server's
   archive-backed tool for the kernel's local one (LLP 0264 #verb).
3. T5 lands client-side in its own PR, any time after T3.

## `@ref` map (annotations to add when the code lands)

- `grep_service.js` walk: LLP 0264 #decision; visibility wrap: LLP 0105
  #surfaces; tier rule: hypaware-server LLP 0130 #decision.
- Verb registration: LLP 0264 #grep; the coverage-clause summary:
  hypaware-server LLP 0157 #decision.
- `unregister`/replace affordance: LLP 0264 #verb [constrained-by].
- `overrides` entry: LLP 0222 #hyparquet-floor [constrained-by].
- Sidecar build: LLP 0264 #lifecycle; retry bound: hypaware-server
  LLP 0158.

## Test ownership

- Traditional (`test/core/search-*.test.js`): matcher, allowlist,
  projection, service walk over fixture partitions, visibility, verb
  schema/render, registry replace, sidecar GC.
- Smoke: `query_grep_two_tier` (T6).
- Acceptance: none new; `--remote` against a real server is covered by the
  existing remote-attach procedures.
