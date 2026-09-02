# LLP 0353: `grep_search` injected backend, technical design

**Type:** design
**Status:** Active
**Systems:** Query, MCP, Plugins
**Generated-by:** neutral
**Related:** LLP 0314, LLP 0264, LLP 0105, LLP 0302, LLP 0303, LLP 0034;
hypaware-server LLP 0129, LLP 0178, LLP 0184 (out of tree, the consuming
host)

> Technical design for LLP 0314: `VerbOperationContext` gains an optional
> `search` backend and `queryGrepVerb` uses it when the host supplies one,
> so the process holds exactly one `grep_search` registration, always the
> kernel's. This document settles what the RFC left open: the seam's exact
> type and placement, how the kernel's default backend is resolved, what a
> supplied backend must honor and refuse, what happens to `unregister`,
> and the summary-drift question the RFC named as the implementation's
> first task.

Coverage anchor:

`@ref LLP 0314 - one grep_search registration with the data plane injected through ctx.search; this document is the implementation design`

## 0. Scope {#scope}

LLP 0314 (Accepted) is the request. This design binds it to the tree at
`c6f11b07`. It changes the seam and the verb only; the registry, the CLI
router, the render path, the grep service, and every in-tree host are
deliberately untouched, and section 8 names each non-change with the code
fact that makes it safe. The server-side consumption (supplying the
backend from `buildMcpAssembly`, dropping its own registration, retiring
`src/search/verb-slot.js`) is out of tree and out of scope here; LLP
0314#sequencing governs when it can begin.

## 1. The seam: where `search` sits and its type {#seam}

`VerbOperationContext` lives in `hypaware-plugin-kernel-types.d.ts` with
seven required fields (`query`, `storage`, `config`, `env`, `log`,
`refresh`, `callerCwd`). It gains one optional field, last:

```
/**
 * Host-supplied grep-search data plane (LLP 0314). When present,
 * queryGrepVerb calls it instead of the local cache service, so a host
 * owning a different data plane answers grep_search without registering
 * a second verb. Absent on every in-tree host: buildOperationContext
 * never sets it, and the verb then runs executeGrepSearch over
 * ctx.storage as before.
 */
search?: GrepSearchBackend
```

`GrepSearchBackend` is defined in `src/core/search/types.d.ts`, beside
`GrepSearchParams` and `GrepSearchResult`, because it is the same kind of
thing those are: a wire-adjacent shape both sides of LLP 0264 must agree
on. That file is already published as `hypaware/core/search/types.js` in
the package export map, so the server can import the type it must
implement without reaching into unexported internals. The kernel types
file imports it the way it already imports `CachePartitioningDeclaration`
and `UsagePolicyDrop`: a top-level `import type { GrepSearchBackend } from
'./src/core/search/types.d.ts'`. No `@typedef`, no inline `import('...')`
type, per repo convention.

The interface {#backend-type}:

```
export interface GrepSearchBackendArgs extends GrepSearchParams {
  /**
   * The one local-only caller parameter that rides the seam (LLP
   * 0314#backend). The local backend honors it; a serving backend MUST
   * refuse it explicitly with GrepQueryError when true, because with one
   * schema it now validates everywhere and a silent ignore would change
   * its meaning.
   */
  includeLocalOnly?: boolean
}

export interface GrepSearchBackend {
  (args: GrepSearchBackendArgs): Promise<GrepSearchResult>
}
```

**Decision: the seam carries caller intent only, not host wiring.** The
RFC's sketch (`ctx.search ?? executeGrepSearch`) would make the two
interchangeable values, which puts `storage`, `refresh`, `callerCwd`,
and `usagePolicyResolver` into the contract a server backend must accept
and ignore: a required `storage` field whose only correct server
implementation is to never touch it is a contract that lies, and it is
exactly the local-cache-shaped interface the RFC's own rejected
alternative (`ctx.storage` swapping) warns against. Instead the backend
signature is `GrepSearchParams` plus `includeLocalOnly`, and the
local-only wiring is closed over by the default adapter (section 2). A
`signal` field is deliberately absent: no caller in this tree passes one
to the verb today, a serving host's deadline lives inside its own
backend (surfacing as `exhausted: false`, which the render already
reports), and inventing a field for a future caller is the thing the
repo rules forbid.

The return type is the bare shared `GrepSearchResult`. The local service
returns a richer shape (`localOnly`, `freshnessMessages`,
`indexedFiles`, `scannedFiles`); structurally that is assignable, the
operation spreads whatever comes back, and the render already
falls back field by field when the extras are absent (LLP 0264#shared,
restated by LLP 0314#backend). Nothing narrows the extras away.

## 2. Default resolution: the local backend is an adapter closure {#default-resolution}

`queryGrepVerb.operation` in `src/core/search/grep_verb.js` currently
loads the service on demand and calls it with a mixed bag of caller
params and context wiring. It becomes:

```
const search = ctx.search ?? (await buildLocalBackend(ctx))
const result = await search({ query, regex, sessionId, chainId, from, to, limit, includeLocalOnly })
```

where `buildLocalBackend` (a small function in `grep_verb.js`, not a new
module) does the `await import('./grep_service.js')` and returns a
closure that forwards the seam args into `executeGrepSearch` together
with `storage: ctx.storage`, `refresh: ctx.refresh`, and `callerCwd:
ctx.callerCwd`, exactly the three context fields the call passes today.

**Decision: the dynamic import is correct and stays inside the fallback
branch.** The repo rule against inline `import('...')` is about TYPE
positions (JSDoc), not runtime imports; this one is runtime load-order
engineering, documented in place as keeping hypgrep, hyparquet, and the
Iceberg store out of `hyp --help` (measured ~16ms, ~10%). Moving it
behind the `ctx.search` check adds a second payoff: a host that supplies
a backend never loads the local search stack for this verb at all, which
is precisely the host whose process has no use for it.

Everything else in the operation stays where it is, on both sides of the
seam:

- The limit clamp (`DEFAULT_LIMIT`/`MAX_LIMIT`) runs BEFORE the seam.
  Those constants mirror the server's own defaults so local and remote
  page the same; clamping in the verb means both backends receive an
  identical, already-validated `limit`, and `limitCeilingReached` stays
  the verb's own fact about its own clamp, appended to either backend's
  result. A backend must not re-default an absent limit; it never sees
  one.
- The `from`/`to` day-shape refusals and the inverted-window refusal
  (LLP 0302#usage-exit) run before the seam: they are cross-field and
  value-shape rules about the caller's arguments, true for any data
  plane.
- The `GrepQueryError` to `VerbUsageError` translation in the catch
  stays and now serves both backends (section 4).

## 3. What a supplied backend must honor {#backend-contract}

Substitutability is the whole point of the seam: the verb must not learn
which host it runs on. The contract, stated on `GrepSearchBackend`'s doc
and enforced by the tests in section 7:

1. **Shape.** Accept `GrepSearchBackendArgs`, return `GrepSearchResult`:
   the shared hit shape, hits sorted as LLP 0264 fixes them, and the two
   INDEPENDENT completeness facts `truncated` and `exhausted` with the
   meanings `src/core/search/types.d.ts` documents. Extra fields are
   permitted (the local backend returns four) and the render treats each
   as optional.
2. **Coverage.** Search exactly the columns the kernel's published
   `SEARCHABLE_COLUMNS` (`hypaware/core/search`) names. Section 5 makes
   this checkable.
3. **Refusals are the backend's own, raised as `GrepQueryError`.** A
   serving host gates regex mode to the operator (hypaware-server LLP
   0127); a local one does not (LLP 0303#regex-reachability). A serving
   backend refuses `includeLocalOnly: true` explicitly, since with one
   declaration the schema no longer refuses it for free (LLP
   0314#backend). Both gates live inside the backend so the verb stays
   host-blind.
4. **No throw for an empty answer.** Zero hits with `exhausted: true` is
   an answer; the summary's coverage clause is what keeps it honest.

## 4. Refusal channel: `GrepQueryError` is the seam's error type {#refusals}

The verb already translates `GrepQueryError` to `VerbUsageError` at its
boundary, so the same refusal is exit 2 with a usage line on the CLI and
a tool error on MCP, and the shared module stays free of surface types
(LLP 0303#query-refusal-exit). **Decision: that channel is the seam's
too.** A supplied backend refusing an argument (`regex` gated,
`includeLocalOnly` unsupported, a malformed pattern) throws
`GrepQueryError`, importable from `hypaware/core/search` where it is
already published via `matcher.js`. Anything else a backend throws is a
failed search, exit 1, unchanged. No new error type, no verb change
beyond what section 2 already makes.

## 5. Summary drift: assert equality at wiring, never override {#summary-drift}

LLP 0314#open leaves one question and calls it the implementation's
first task: the verb's summary states coverage from the client's
`SEARCHABLE_COLUMNS`, and a diverged server allowlist would make the one
declaration lie to a remote agent about the exact clause that stops zero
hits reading as "not stored".

**Decision: the two allowlists are asserted equal at wiring time, and
the backend gets no summary override.** The summary is assembled once at
module load into the static `VerbRegistration`; it is the single
declaration LLP 0264#shared exists to keep single, and the MCP tool list
is served from `list()` with no per-org re-rendering hook. A
summary-override field would fork the one surface a machine caller reads
and require new registration plumbing to carry it, all to describe a
divergence that must not exist in the first place: a backend searching
different columns is not a variant, it is a contract break under
section 3.2.

Enforcement sits where the divergence would be created, in the host that
builds the backend: at wiring (the server's `buildMcpAssembly`, per LLP
0314#decision), compare the host's own allowlist against the
`SEARCHABLE_COLUMNS` it imports from `hypaware/core/search`, and fail
that wiring loudly with a message naming both sets and this section. The
kernel cannot make this check itself: injection happens in host code the
kernel never observes, and the kernel is never handed the host's set.
Making the backend declare a `searchableColumns` field just so the verb
could compare per request would move a boot-time invariant into the hot
path and add a field whose only honest value is a copy of the constant.
No new kernel helper is added for a three-line set comparison; the
export already exists and is already the thing the server must import to
comply.

For the kernel's own backend the assertion is vacuous by construction:
the summary and the service read the same constant.

## 6. The registry: one registration, and `unregister` stays {#registry}

Nothing in `src/core/registry/verbs.js` changes behavior. With one
registration there is no arbitration: a plugin registering `grep_search`
hits the registry's ordinary duplicate-tool throw at its OWN
`register` call, at kernel boot, which is the loud-and-early failure LLP
0314#consequences wants, and it needs no new code because `byTool`
already refuses duplicates.

`ctx.search` never touches the registry: a host that supplies a backend
changes what the one registered verb does, not what is registered.

**`unregister` stays, and stays annotated.** LLP 0314#sequencing keeps
the LLP 0264#verb displacement rule in force until the server's
`hypaware` floor rises, so `unregister` keeps its caller for now, and
the RFC explicitly rules its removal out of scope thereafter (published
method, idempotent, harmless). One mechanical edit lands with this
change to keep refs honest: the `@ref LLP 0264#verb` gloss on
`unregister` (and the related gloss on `isVerbProjection` in
`src/core/cli/verb_command.js`) is extended to note the rule is the LLP
0314#sequencing bridge, since 0264#verb now carries a `Superseded-by:`
paragraph and a reader landing there needs to know the mechanism is
transitional, not retired.

## 7. What changes, what proves it {#files}

Files the implementation touches:

- `src/core/search/types.d.ts`: add `GrepSearchBackendArgs` and
  `GrepSearchBackend` (section 1), with the section 3 contract in their
  doc comments.
- `hypaware-plugin-kernel-types.d.ts`: import the backend type from
  `./src/core/search/types.d.ts`; add `search?: GrepSearchBackend` to
  `VerbOperationContext` with an `@ref` to this design.
- `src/core/search/grep_verb.js`: resolve `ctx.search ?? local adapter`
  in `operation` (section 2); `@ref LLP 0314#decision [implements]` on
  the resolution line.
- `src/core/registry/verbs.js` and `src/core/cli/verb_command.js`:
  gloss-only `@ref` updates (section 6). No behavior change.
- `test/core/query-grep-verb.test.js`: the new cases below, driving
  `queryGrepVerb.operation` directly with a stubbed context (the
  existing harness goes through the projected command, whose
  `buildOperationContext` never sets `search`; those existing tests are
  the proof the default path is unchanged).

Tests {#tests}:

1. A stubbed `ctx.search` receives exactly the seam shape: clamped
   integer `limit`, validated `from`/`to`, `includeLocalOnly` passed
   through when the caller set it, and no `storage`/`refresh`/
   `callerCwd` keys.
2. With `ctx.search` supplied, the local plane is never consulted:
   `ctx.storage` is a proxy that throws on any access, and the operation
   still answers.
3. The stub's bare `GrepSearchResult` comes back with
   `limitCeilingReached` appended and renders with every local-extra
   fallback, INCLUDING the zero-hits case: `indexedFiles` and
   `scannedFiles` are `undefined`, not `0`, so the "nothing is recorded
   on this machine" line must not print for an injected backend's empty
   answer.
4. A stub throwing `GrepQueryError` surfaces as `VerbUsageError`
   (section 4); a stub throwing anything else does not.
5. Without `ctx.search`, the existing suite passes untouched.

## 8. What does not change, and why {#unchanged}

- **`--remote` routing.** `runVerbCommand` routes `--remote` to
  `runRemoteVerb` before `buildOperationContext` is ever called
  (`src/core/cli/verb_command.js`), so a remote call never meets the
  seam, the registry, or the operation. LLP 0314#decision states this;
  the code already satisfies it.
- **`buildOperationContext` and `hyp mcp serve`.** Neither sets
  `search`; the field is optional, so the CLI projection and the local
  stdio MCP host (`src/core/commands/mcp.js`) run the local backend with
  zero edits. Only a host that builds its own `VerbOperationContext`
  can inject.
- **`src/core/search/grep_service.js`.** `executeGrepSearch` keeps its
  signature; the adapter closure is caller-side. The service stays the
  client half of LLP 0264, LLP 0105 visibility included.
- **The render path and the schema.** The hit shape, the flattening, the
  completeness notices, and `inputSchema` (including
  `include-local-only` carrying no default, so `--remote` stays
  wire-clean) are byte-identical.
- **LLP 0264's mirror and allowlist.** Untouched, per LLP 0314's own
  supersession scope; 0264 already carries the `Superseded-by:` note on
  `#verb` alone.
