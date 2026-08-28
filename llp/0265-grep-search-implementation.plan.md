# LLP 0265: `hyp query grep` implementation plan

**Type:** Plan
**Status:** Active
**Systems:** Query, Cache, CLI, MCP
**Author:** Brendan / Claude
**Date:** 2026-08-18
**Extended-by:** LLP 0302 (#build-site: T6's build site and gate as shipped; #residuals records the T6 test still owed)
**Related:** LLP 0264 (the decision this executes), LLP 0105 (the visibility wrapper T4 reuses), LLP 0222 (the hyparquet floor T1 must hold), LLP 0034 (the verb surface T5 lands on), LLP 0209 (the compaction pass T6 hooks); hypaware-server LLP 0178 / PR #364 (the server half, already open and inert)

> Turns [LLP 0264](./0264-grep-search-mirrors-the-server.decision.md) into
> seven tasks. The decision is Accepted; the server-side displacement fix
> (hypaware-server #364) is open and mergeable independently.

## Sequencing principle {#sequencing}

**Every wave leaves a shippable tree, and search works before any index
exists.** The scan tier alone is a complete, correct `hyp query grep`
(slower on deep history, never wrong), and `--remote` reaches the server's
archive-backed search from the moment the verb lands, because the server's
`grep_search` tool exists today. So the verb (T5) ships on the scan tier,
and the sidecar build (T6) lands behind it as pure acceleration, exactly
the property server LLP 0130 designed for ("index presence is purely a
performance property").

**Cross-repo order, resolving LLP 0264 #open.** hypaware-server #364
(displace the kernel twin) is inert against today's kernel and merges
first, any time. This repo then implements T1-T7 and releases.
hypaware-server bumps its `hypaware` dependency **last**, after #364 is in,
and follows with its import-swap PR onto the T3 exports. The only forbidden
order is a server dependency bump before #364.

## What was verified against the tree {#verified}

Checked 2026-08-18, each load-bearing for a task below:

- **The server's `grep_search` contract is live** (hypaware-server
  `src/daemon.js`): params `query`, `regex`, `session_id`, `chain_id`,
  `from`, `to`, `limit`; hits carry `date`, `sessionId`, `agentId`,
  `conversationId`, `partId`, `messageId`, `messageCreatedAt`,
  `matches: [{column, snippet}]`. T5's schema must be wire-compatible:
  `--remote` sends the verb's params to the remote tool verbatim.
- **Neither kernel registry supports removal.** `VerbRegistry` is
  register/get/getByTool/list (`src/core/registry/verbs.js`), and the
  command registry has no removal either; `registerVerb` also projects a
  CLI command immediately. hypaware-server #364 calls
  `verbs.unregister(name)` behind a feature guard, so T2 owes exactly that
  shape, and it must retract the projected command too.
- **The exports map has `./core/query` but nothing search-shaped**, so T3
  adds a `./core/search` entry (types via the `types/` tree like its
  siblings).
- **`withLocalOnlyVisibility` wraps any `AsyncDataSource`**
  (`src/core/query/visibility.js`), and `storage.dataSourceForTable`
  returns the icebird source with position deletes applied (LLP 0104
  annotation in `ai-gateway/src/dataset.js`), so T4 gets purge-correct,
  visibility-correct rows without reimplementing either.
- **Compaction finalizes immutable files in `compactGeneration`**
  (`src/core/cache/maintenance.js`), and the orphan sweep and retention
  delete recursively, so a `data/`-adjacent sidecar dies with its file.
  T6 builds there and pins the GC with a test rather than writing any.
- **hypgrep 0.5.1 pins hyparquet 1.27.1**, below the exact 1.28.2 floor
  ([LLP 0222 #hyparquet-floor](./0222-one-pushdown-converter.decision.md#hyparquet-floor)),
  and needs `hyparquet-writer` only for `createIndex`; the root already
  carries the writer as an optionalDependency on the cache write path.
- **The server's build hardening is directly portable**: worker-thread
  handle (`hypaware-server/src/search/index-worker.js`, 149 lines),
  three-attempt poison bound (server LLP 0158), sidecar existence as the
  idempotency marker (server LLP 0128).

Not verified, and therefore not assumed: whether the verb codec's argv
flag spelling for underscore param names (`--session_id`) is acceptable
CLI ergonomics or T5 needs a codec alias; and the walk cost of a 90-day
cache under the narrow projection (T4 measures it, T6 is sized by it).

## The task graph {#tasks}

### Wave 1 (deps `[]`), three-wide

- **T1, hypgrep dependency + overrides.** `hypgrep` into `dependencies`;
  `overrides` pinning its `hyparquet` to 1.28.2 and `hyparquet-writer` to
  0.16.6, beside the icebird override. Verify one deduped hyparquet copy
  (`npm ls hyparquet`) and that `npm pack --dry-run` stays sane.
  Complexity 1.
- **T2, `unregister(name)` on the verb registry.** Removes the verb from
  both maps and retracts the projected CLI command, which needs a matching
  removal on the command registry (including alias cleanup). This is the
  affordance hypaware-server #364 already guards on; its contract is
  by-name, idempotent, and safe on an unknown name. Complexity 2.
- **T3, hoist the shared search modules.** `src/core/search/`: the
  searchable-column allowlist and brute-scan projection (server
  `searchable-columns.js`, imported semantics unchanged), the matcher
  (literal/regex compile, `test`/`locate`/`rowTest`) and snippet-window
  constants, and the hit shapes as a `.d.ts`. New `./core/search` export.
  The server's import swap is server-repo work after this publishes, not
  part of this plan. Complexity 2.

### Wave 2 (deps `[T1, T3]`)

- **T4, the local grep service.** `src/core/search/grep_service.js`: flush
  the spool first (the query seam's freshness move), walk cache partitions
  newest-day-first, per-partition source from `storage.dataSourceForTable`
  wrapped in `withLocalOnlyVisibility` with the caller's `cwd`, files
  processed sequentially with the narrow projection for unindexed files
  and `parquetFind` through the sidecar for indexed ones, stop at the
  limit, report `truncated`/`exhausted` like the server. The indexed path
  is dormant until T6 but is exercised in tests with a hand-built sidecar.
  Complexity 3.

### Wave 3 (deps `[T2, T4]`)

- **T5, the verb.** `src/core/search/grep_verb.js` registered in
  `CORE_VERBS`: `name: 'query grep'`, `tool: 'grep_search'`, read-class,
  wire-compatible schema (T5 verifies the argv spelling question above),
  the server's coverage clause in the summary, `--include-local-only`
  with LLP 0105 #override semantics, rg-style snippet render honoring
  LLP 0225 (table escapes, `--format json` does not). After this task
  `hyp query grep` works locally (scan tier) and `--remote <target>`
  works against any current server. Complexity 2.

### Wave 4 (deps `[T1, T3]`, parallel to T4/T5)

- **T6, sidecar build at maintenance.** Port the server's worker handle
  and poison bound; `compactGeneration` queues an index build for each
  finalized data file over the allowlist columns; sidecar existence is
  the marker, no ledger; a test pins that orphan sweep and retention
  delete sidecars with their files, and that an unindexed or quarantined
  file is served by the scan tier. Complexity 3.

  **Extended-by:** [LLP 0302 #build-site](./0302-grep-search-integration-divergences.decision.md#build-site).
  As shipped the pass hangs off `maintainCache`'s partition loop rather than
  `compactGeneration`, and its gate is missing coverage under the tick's
  budget rather than a committed rewrite, because the compaction-only gate
  never indexes a partition already at the compaction floor. The retention
  half of the test above is still owed; see #residuals there.

### Wave 5 (deps `[T5, T6]`)

- **T7, surfaces and proof.** `hyp query status` gains an index-coverage
  line; `hypaware-query` SKILL.md adds grep (fixing "these are the only
  subcommands"), the sub-`ngramLength` literal cliff, and the coverage
  caveat; a hermetic smoke (`query_grep_roundtrip`) asserts a scan-tier
  hit, a sidecar-tier hit, a purged row absent, and a `local-only` row
  withheld from a `full`-class caller and present with the override.
  Complexity 2.

## Out of scope {#out-of-scope}

- The server's import swap and dependency bump (hypaware-server repo,
  after T3 publishes and #364 merges).
- Any config knob for indexed columns or index cadence: the allowlist is
  the shared constant by decision (LLP 0264 #shared), and cadence is
  compaction's.
- Remote-side behavior changes: `--remote` intentionally hits the
  server's existing service unchanged.
