# LLP 0354: `grep_search` injected backend, implementation plan

**Type:** plan
**Status:** Active
**Related:** LLP 0353, LLP 0314
**Generated-by:** neutral

> [LLP 0353](./0353-grep-search-injected-backend.design.md) is the technical
> design for LLP 0314 (Accepted): `VerbOperationContext` gains an optional
> `search` backend and `queryGrepVerb` uses it when the host supplies one,
> so the process holds exactly one `grep_search` registration, always the
> kernel's. The design already settled the seam's type and placement, the
> default-resolution adapter, the refusal channel, the summary-drift
> answer, and the registry non-change; this plan turns those settlements
> into four tasks with real code-dependency edges. The server-side
> consumption (supplying the backend from `buildMcpAssembly`, dropping its
> own registration) is out of tree and out of scope, per LLP
> 0353#scope and the LLP 0314#sequencing gate.

## How this refines the design {#refinement}

The design's section 7 file list maps onto tasks almost one to one. Two
grouping choices and one verified-fact note:

- **The verb change and its tests are one task (T3), not two.** LLP
  0353#tests drives `queryGrepVerb.operation` directly with a stubbed
  context, and every one of its five cases proves a property of the exact
  seam T3 builds (the argument shape, the never-consulted local plane, the
  appended clamp fact, the error translation, the untouched default path).
  A seam landed without them is mergeable but unproven against precisely
  the silent failure modes the design names, and a test task landed
  separately could only re-derive T3's shape from prose. One task keeps
  the proof beside the thing it proves.
- **The gloss-only edits are their own task (T4) with no deps.** LLP
  0353#registry changes no behavior in `src/core/registry/verbs.js` or
  `src/core/cli/verb_command.js`; the extended `@ref LLP 0264#verb`
  glosses (noting the displacement rule is the LLP 0314#sequencing bridge,
  transitional rather than retired) are true today, before any seam
  exists, so T4 can merge first, last, or in parallel.
- **Verified against the tree at `e1a3d274`: the zero-hits guard already
  tolerates an injected backend.** The "nothing is recorded on this
  machine yet" line in `grep_verb.js` fires only on
  `r.indexedFiles === 0 && r.scannedFiles === 0` (strict equality), and an
  injected backend's bare `GrepSearchResult` leaves both `undefined`, so
  the line correctly stays silent with no code change. LLP 0353#tests
  case 3 is therefore a pin on existing behavior, not a fix; T3's brief
  says so, so an implementer does not "fix" a guard that is already right.

Also verified, each load-bearing for a task brief below:

- `VerbOperationContext` sits at `hypaware-plugin-kernel-types.d.ts` line
  1809 with seven required fields, and the file already imports types
  top-level from `./src/core/iceberg/types.d.ts` and
  `./src/core/usage-policy/types.d.ts` (lines 15-16), the exact pattern
  T2 follows for `./src/core/search/types.d.ts`.
- `src/core/search/types.d.ts` holds `GrepSearchParams` (line 13) and
  `GrepSearchResult` (line 52), the shapes `GrepSearchBackendArgs`
  extends and returns; the file is published via the `./core/search`
  export map entry, so a server host can import the type it must
  implement.
- In `grep_verb.js` the `await import('./grep_service.js')` currently
  runs BEFORE the `from`/`to` day-shape and inverted-window refusals.
  Moving it into the fallback branch (LLP 0353#default-resolution) also
  moves it after those refusals; that is a pure improvement (a usage
  refusal no longer loads hypgrep), and the load-order comment above the
  import must move with it and stay honest.
- The `@ref LLP 0264#verb` glosses T4 extends sit at
  `src/core/registry/verbs.js` line 55 (on `unregister`) and
  `src/core/cli/verb_command.js` line 101 (on `isVerbProjection`).
- The existing `test/core/query-grep-verb.test.js` harness goes through
  `verbToCommand(queryGrepVerb)` and a real temp-dir storage service;
  `buildOperationContext` never sets `search`, so that whole suite is the
  design's proof that the default path is unchanged (LLP 0353#tests case
  5) and T3 must leave it byte-identical in intent: no existing case is
  edited, only new direct-`operation` cases are added.

## Sequencing {#sequencing}

Every task leaves a shippable tree. T4 is independent. T1 alone adds two
exported interfaces nothing references yet. T1+T2 add an optional field
no in-tree host sets. T3 completes the seam; until a host injects, the
adapter closure reproduces today's call exactly. The forbidden order is
only the type-dependency one the `deps` edges already encode: T2 imports
T1's type, T3 reads the field T2 declares and forwards the shape T1
defines.

Cross-repo: the server's wiring-time allowlist assertion (LLP
0353#summary-drift), its backend supply, and the retirement of its
`verb-slot.js` displacement all happen in hypaware-server after this
ships and its `hypaware` floor rises. No task here may absorb any of
that, and `unregister` stays exactly as it is (LLP 0353#registry).

## Rating complexity: the hard parts, by name {#complexity}

No task earns a 5: the design resolved every open fork itself (the seam
type against the RFC's literal sketch, the adapter closure, the refusal
channel, the summary-drift answer), so nothing here is an open judgement
call.

- **T3 earns the plan's only 4** because its correctness failures are
  silent, not crashes. Leaking `storage`/`refresh`/`callerCwd` into the
  seam args would work perfectly against the local adapter and break only
  an out-of-tree host months later; loading `grep_service.js` on the
  injected path would cost an injecting host the load-time win with no
  test failure unless the throwing-proxy case is written exactly as
  specified; and a carelessly relocated load-order comment would leave
  the tree lying about a measured ~16ms property. The five test cases
  are fully specified in LLP 0353#tests, but writing them non-vacuously
  (the proxy that throws on ANY storage access, the exact-shape
  assertion on the stub's received args, the zero-hits stderr pin) is
  where the care goes.
- **T1 is a 2, not a 1**, because the doc comments are the published
  contract a server implementer reads: the four obligations of LLP
  0353#backend-contract (shape and sort, `SEARCHABLE_COLUMNS` coverage,
  refusals as `GrepQueryError` including the mandatory explicit
  `includeLocalOnly` refusal, no throw for an empty answer) must land in
  the interface docs accurately, and a wrong or missing clause misleads
  out-of-tree code no in-tree test can catch.
- **T2 and T4 are 1s**: one import plus one optional field with a doc
  comment the design already wrote, and two gloss-line extensions with no
  behavior change. Both are mechanical transcription from LLP 0353.

## Out of scope {#out-of-scope}

- Everything LLP 0353#unchanged names: `--remote` routing,
  `buildOperationContext`, `hyp mcp serve`, `grep_service.js`, the
  render path, the input schema, LLP 0264's mirror and allowlist.
- The server-side wiring assertion and backend supply (hypaware-server
  repo, after release).
- Any removal of `unregister` or its caller (ruled out of scope by LLP
  0314 itself).
- Any new summary-override or `searchableColumns` field (explicitly
  rejected, LLP 0353#summary-drift).

## Tasks

- id: T1  branch: task/grep-search-injected-backend/T1  deps: []        complexity: 2  -- src/core/search/types.d.ts: add `GrepSearchBackendArgs` (extends `GrepSearchParams` with optional `includeLocalOnly?: boolean`) and `GrepSearchBackend` ((args) => Promise<GrepSearchResult>) per LLP 0353#seam, no `signal` field. The doc comments carry the full LLP 0353#backend-contract: shared hit shape and sort, independent `truncated`/`exhausted` facts, extra fields permitted, coverage must equal the published `SEARCHABLE_COLUMNS` (asserted host-side at wiring, never overridden per LLP 0353#summary-drift), refusals raised as `GrepQueryError` including an explicit refusal of `includeLocalOnly: true` by any serving backend, and zero hits with `exhausted: true` is an answer, not a throw. Test: `npm run typecheck` passes; the interfaces are exported beside `GrepSearchParams`/`GrepSearchResult` so the existing `./core/search` export map entry publishes them with no package.json change.
- id: T2  branch: task/grep-search-injected-backend/T2  deps: [T1]      complexity: 1  -- hypaware-plugin-kernel-types.d.ts: top-level `import type { GrepSearchBackend } from './src/core/search/types.d.ts'` beside the existing iceberg/usage-policy type imports, and `search?: GrepSearchBackend` added as the LAST field of `VerbOperationContext` with the doc comment LLP 0353#seam gives (host-supplied data plane; absent on every in-tree host because `buildOperationContext` never sets it) and an `@ref LLP 0353#seam [implements]` gloss. No `@typedef`, no inline import type, per repo convention. Test: `npm run typecheck` passes with no other file edited, proving the field is additive.
- id: T3  branch: task/grep-search-injected-backend/T3  deps: [T1, T2]  complexity: 4  -- src/core/search/grep_verb.js: in `operation`, after the existing limit clamp and `from`/`to` refusals (all of which stay before the seam per LLP 0353#default-resolution), resolve `const search = ctx.search ?? (await buildLocalBackend(ctx))` with `@ref LLP 0314#decision [implements]` on the resolution, and call `search({...})` with EXACTLY the seam shape: `query`, `regex`, `sessionId`, `chainId`, `from`, `to`, clamped `limit`, `includeLocalOnly`; never `storage`/`refresh`/`callerCwd`. `buildLocalBackend` is a small function in this file (not a new module) doing the `await import('./grep_service.js')` inside the fallback branch only, returning a closure that forwards seam args into `executeGrepSearch` plus `storage: ctx.storage`, `refresh: ctx.refresh`, `callerCwd: ctx.callerCwd`; the load-order comment (hypgrep/hyparquet kept off `hyp --help`, ~16ms) moves with the import and gains the second payoff: an injecting host never loads the local search stack. The `GrepQueryError` to `VerbUsageError` translation stays in the catch and now covers both backends (LLP 0353#refusals); `limitCeilingReached` is appended to either backend's result; render, schema, and `grep_service.js` are byte-identical. Test (new cases in test/core/query-grep-verb.test.js, driving `queryGrepVerb.operation` directly with a stubbed ctx per LLP 0353#tests): (1) a stubbed `ctx.search` receives exactly the seam shape with clamped integer limit, validated from/to, `includeLocalOnly` passthrough, and no storage/refresh/callerCwd keys; (2) with `ctx.search` supplied and `ctx.storage` a Proxy that throws on any access, the operation still answers; (3) a bare `GrepSearchResult` with zero hits comes back with `limitCeilingReached` appended and the render's "nothing is recorded on this machine" line does NOT print (`indexedFiles`/`scannedFiles` undefined, not 0; this pins existing strict-equality behavior, do not change the guard); (4) a stub throwing `GrepQueryError` surfaces as `VerbUsageError`, any other throw does not; (5) the existing projected-command suite passes untouched, no existing case edited.
- id: T4  branch: task/grep-search-injected-backend/T4  deps: []        complexity: 1  -- Gloss-only `@ref` updates per LLP 0353#registry, no behavior change: extend the `@ref LLP 0264#verb` gloss on `unregister` in src/core/registry/verbs.js (line 55 region) and the related gloss on `isVerbProjection` in src/core/cli/verb_command.js (line 101 region) to note the displacement rule is the LLP 0314#sequencing bridge, transitional until the server's `hypaware` floor rises, not retired; needed because LLP 0264#verb now carries a Superseded-by paragraph and a reader landing there must learn the mechanism's status from the gloss. Test: `npm test` and `/ref-check` stay green; a diff shows comment-only changes in both files.
