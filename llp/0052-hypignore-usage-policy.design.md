# LLP 0052: hypignore usage policy — technical design

**Type:** design
**Status:** Active
**Systems:** Sources, Gateway, CLI, Core
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-06-29
**Related:** LLP 0049, LLP 0050, LLP 0051, LLP 0009, LLP 0012

> Buildable design for the `.hypignore` folder-scoped usage policy.
> `@ref LLP 0049 [implements]` — realizes the hypignore-usage-policy spec (scope→class,
> the `ignore` class, the `hyp ignore`/`unignore` CLI).
> `@ref LLP 0050 [constrained-by]` — enforcement lives in the client adapters; the
> shared matcher lives in `src/core/usage-policy/`; the gateway stays `cwd`-blind.
> `@ref LLP 0051 [constrained-by]` — `local-only` and the session opt-out are deferred;
> the file format and matcher stay forward-compatible with them.

## Overview

One new core module (`src/core/usage-policy/`) plus four small adapter drop-sites and
two CLI verbs. Nothing touches the cache schema, the export driver, or the gateway —
V1 enforces only the **capture seam** ([LLP 0049](./0049-hypignore-usage-policy.spec.md#enforcement),
[LLP 0050](./0050-ignore-enforced-in-adapters.decision.md)).

## Core module: `src/core/usage-policy/` {#module}

A `cwd`-agnostic unit of path logic, imported by the adapters exactly as they import
`src/core/observability` (LLP 0050 §Shared matcher in core). Core gains a reusable
matcher and **no** `cwd` concept — only an adapter knows which row field is the `cwd`.

```
src/core/usage-policy/
  index.js      // public API (barrel)
  format.js     // parse a .hypignore body -> UsageClass (+ fail-safe)
  matcher.js    // resolveUsageClass(cwd) — ancestor walk + per-cwd cache
  types.d.ts    // UsageClass, UsagePolicyResolver, ResolveResult
```

### Types (`types.d.ts`)

```js
// V1 ships `ignore`; `local-only`/`full` are reserved/implicit (LLP 0049 §classes, LLP 0051).
export type UsageClass = 'ignore' | 'local-only' | 'full'

export interface ResolveResult {
  class: UsageClass            // the resolved, implemented class ('full' when nothing governs)
  governedBy: string | null    // absolute path of the nearest governing .hypignore, or null
  declared: string | null      // the raw token read (e.g. 'local-only'), before fail-safe
}

export interface UsagePolicyResolver {
  resolve(cwd: string): ResolveResult
  isIgnored(cwd: string): boolean   // resolve(cwd).class === 'ignore'
}
```

### `format.js` — parse a `.hypignore` body {#format}

Pure, fs-free; unit-tested in isolation. Implements the file format and the privacy
fail-safe ([LLP 0049](./0049-hypignore-usage-policy.spec.md#file-format), [#fail-safe](./0049-hypignore-usage-policy.spec.md#fail-safe)).

```js
// `@ref LLP 0049#file-format [implements]`
// `@ref LLP 0049#fail-safe [implements]` — unknown/unimplemented class => 'ignore'
const IMPLEMENTED = new Set(['ignore']) // V1; grows additively when local-only ships

/** @returns {{ class: UsageClass, declared: string|null, warn?: string }} */
export function parseHypignore(body) { /* ... */ }
```

Rules: strip `#` comments and blank lines; the first remaining non-empty line is the
**class token**. Empty/comment-only ⇒ `ignore` (preserves the skill notes' promise).
A token not in `IMPLEMENTED` ⇒ resolve to `ignore` and surface a `warn` string (the
caller logs it). Reserved in-file path patterns are parsed-but-ignored in V1.

### `matcher.js` — `resolveUsageClass` {#matcher}

```js
// `@ref LLP 0050 [implements]` — the single shared matcher; no per-adapter copies.
// `@ref LLP 0049#scope [implements]` — gitignore-style ancestor walk, nearest wins.
export function createUsagePolicyResolver({ readFileSync, existsSync } = nodeFs) { /* ... */ }
```

- `resolve(cwd)`: from `cwd`, walk parent directories to filesystem root; the **nearest**
  ancestor containing a `.hypignore` governs. Found ⇒ `parseHypignore(read)`; none ⇒
  `{ class: 'full', governedBy: null }`. Because V1 has no un-ignore directive, "any
  ancestor `.hypignore` ⇒ ignored" (LLP 0049 §scope).
- **Per-`cwd` cache with a short TTL** (LLP 0049 R6): memoize `resolve` by absolute `cwd`
  so the capture hot path does at most one ancestor walk per `cwd` per TTL window, not one
  per exchange. Entries carry an expiry (`CACHE_TTL_MS`, 5s); a resolver instance is held
  per daemon/backfill run, and `--check` constructs a fresh resolver so it always reflects
  disk immediately.
  - **Why TTL, not process-lifetime.** A process-lifetime cache made `hyp ignore` silently
    ineffective on a running daemon: a `cwd` already resolved+cached as `full` by the live
    projector kept recording after the user wrote a `.hypignore`, until the daemon
    restarted, a silent leak window against R1 (raised by both reviewers on PR #211). A
    bounded TTL re-walks once an entry expires, so a `.hypignore` written (or removed)
    mid-run is honored within the window. Not "don't cache `full`": that reintroduces the
    per-exchange walk R6 forbids. The TTL is the interim leak bound.
  - **Future enhancement (not V1):** `hyp ignore` / `hyp unignore` signal the running
    daemon to invalidate and prime the affected `cwd`'s cache entry, collapsing apply
    latency from "within the TTL" to zero. The CLI writes a forward-note pointing here.
- fs and the clock (`now`) are injected for tests; default to `node:fs` and `Date.now`.

## Enforcement: four adapter drop-sites {#enforcement}

Per [LLP 0050](./0050-ignore-enforced-in-adapters.decision.md) the adapters are the only
places that resolve a `cwd`. Each constructs/holds one resolver and drops ignored work.

| | Claude | Codex |
|---|---|---|
| **Live** | `claude/src/projector.js` `createClaudeExchangeProjector` | `codex/src/exchange-projector.js` `createCodexExchangeProjector` |
| **Backfill** | `claude/src/backfill.js` | `codex/src/backfill.js` |

### Live — projector returns `[]` {#live}

The live projector already reads `session-context.jsonl` and resolves `cwd`/`repo_root`
per exchange. The gateway source's write guard is
`const messageRows = await projector.projectExchange(row); if (messageRows.length > 0) appendRows(...)`
(`ai-gateway/src/source.js:117`). So an ignored exchange is dropped by having the
projector **return `[]` early** — before building rows, after `cwd` is known. **No
gateway change** (LLP 0050 §Live); the response is already streamed, so the live call is
untouched ([LLP 0049](./0049-hypignore-usage-policy.spec.md#requirements) R2).

```js
// in createClaudeExchangeProjector, once cwd is resolved for the exchange:
// @ref LLP 0050 [implements] — capture-seam drop, projector returns no rows
if (resolver.isIgnored(cwd)) { logIgnored({ component: 'claude', cwd, governedBy }); return [] }
```

### Backfill — skip ignored sessions {#backfill}

`hyp backfill` reads local transcripts carrying `cwd`/`repo_root` per session; each
provider filters ignored sessions **before** projecting/writing, else a backfill silently
re-imports the exact sessions ignored live (LLP 0050 §Backfill, [LLP 0049](./0049-hypignore-usage-policy.spec.md#requirements) R1).
Same `// @ref LLP 0050 [implements]` drop, keyed on the session's `cwd`.

Settlement (`claude/src/settle.js`, LLP 0027) is untouched — it only upgrades identity of
already-written rows and never sees an ignored exchange.

## CLI: `hyp ignore` / `hyp unignore` {#cli}

A kernel verb pair ([LLP 0009](./0009-cli-registry.spec.md)) registered alongside the
existing core verbs (`src/core/cli/core_commands.js` / `core_verbs.js`).

- `hyp ignore [path]` — write a self-documenting `.hypignore` (comment header + `ignore`
  token) at the git **repo root** when `path`/cwd is in a repo, else at cwd; explicit
  `path` overrides. Idempotent (LLP 0049 R5).
- `hyp unignore [path]` — remove the governing `.hypignore`. Idempotent (no-op when none).
- `hyp ignore --check [path]` — report whether `path` is ignored, which `.hypignore`
  governs, and the **residual count** of already-cached rows from the scope
  ([LLP 0049](./0049-hypignore-usage-policy.spec.md#prospective-only) — prospective-only,
  no purge). The residual count is a cache query over rows whose `cwd`/`repo_root` is under
  the scope; debuggable per the repo's log-driven ethos.

Path/repo-root resolution reuses the existing repo-root helper the adapters already use to
stamp `repo_root`.

## Telemetry {#telemetry}

Log-driven (CLAUDE.md): on each drop emit a structured event —
`component` (`claude`/`codex`), `operation: 'usage_policy_drop'`, `class`, `governedBy`
(path), `cwd` (hashed/redacted, never raw customer paths in dev telemetry). On fail-safe,
warn with the `declared` token and the governing path. `--check` emits the resolved class
+ residual count.

## Test plan {#tests}

Traditional tests (deterministic, the bulk):
- `format.js`: empty ⇒ ignore; comment-only ⇒ ignore; `ignore` token; unknown token ⇒
  ignore + warn (fail-safe); `local-only` ⇒ ignore + warn in V1.
- `matcher.js`: nearest-ancestor wins; no `.hypignore` ⇒ full; deep walk to root; cache
  returns a stable result; injected fs.
- adapter drops: a projector/backfill given an ignored `cwd` returns `[]`/skips; a
  non-ignored `cwd` is unaffected (R2 — live call untouched).
- CLI: `ignore`/`unignore` idempotency (R5); `--check` reports governor + residual count.

Hermetic smoke: `hypignore_capture_drop` — start the daemon, drive one exchange from a
`.hypignore`'d cwd and one from a clean cwd, assert only the clean row lands in the cache
and the drop event is emitted.

## Out of scope (V1) {#out-of-scope}

Carried verbatim from [LLP 0049 §non-goals](./0049-hypignore-usage-policy.spec.md#non-goals):
raw-proxy/OTEL folder-blindness (structural — no `cwd`); prospective-only (no retroactive
purge); no central/layered-config interaction; no ephemeral session opt-out. The
`local-only` class and session opt-out are [LLP 0051](./0051-usage-policy-future-extensions.decision.md);
the file-format fail-safe and single shared matcher are the forward-compat hooks that keep
them additive.

## Annotation map (for the implementing change set)

| Site | Annotation |
|------|-----------|
| `src/core/usage-policy/matcher.js` | `@ref LLP 0050 [implements]`, `@ref LLP 0049#scope [implements]` |
| `src/core/usage-policy/format.js` | `@ref LLP 0049#file-format [implements]`, `@ref LLP 0049#fail-safe [implements]` |
| claude/codex live projector drop | `@ref LLP 0050 [implements]` |
| claude/codex backfill skip | `@ref LLP 0050 [implements]` |
| `hyp ignore`/`unignore` verb | `@ref LLP 0049#cli [implements]` |
