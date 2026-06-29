# LLP 0050: ignore is enforced in the client adapters, not the gateway

**Type:** Decision
**Status:** Draft
**Systems:** Gateway, Plugins, Core
**Author:** Phil / Claude
**Date:** 2026-06-29
**Related:** LLP 0012, LLP 0016, LLP 0049

> The `.hypignore` capture-seam drop ([LLP 0049](./0049-hypignore-usage-policy.spec.md))
> lives in the `@hypaware/claude` and `@hypaware/codex` adapters — the only
> places that resolve a `cwd` — not in `@hypaware/ai-gateway`. The shared
> matcher lives in `src/core/usage-policy/`.

## Context

`ignore` must drop a row at the **capture seam**, before it reaches the cache
([LLP 0049](./0049-hypignore-usage-policy.spec.md#enforcement)). The question is
*which component* does the drop. The obvious candidate — the AI gateway, since it
sees all live traffic — is the wrong one.

## Decision

**Enforcement lives in the client adapters; the gateway stays `cwd`-blind.**

The `@hypaware/ai-gateway` source is provider-agnostic: it proxies bytes and
writes whatever a projector returns, and it reads **no** session context — it has
no concept of `cwd`. All folder knowledge lives in the two client adapters, which
already resolve `cwd` at four call sites:

| | Claude | Codex |
|---|---|---|
| **Live** | `createClaudeExchangeProjector` (`claude/src/projector.js`) | `createCodexExchangeProjector` (`codex/src/exchange-projector.js`) |
| **Backfill** | `claude/src/backfill.js` | `codex/src/backfill.js` |

### Live: projector returns no rows

The live exchange projector already reads `session-context.jsonl` and stamps
`cwd`/`git_branch`/`git_remote`/`repo_root` onto each projected row
(`claude/src/projector.js`). It runs **before** the cache write: the gateway
source does `projectExchange(row)` → `if (messageRows.length > 0) appendRows(...)`
(`ai-gateway/src/source.js`). So an ignored exchange is dropped by having the
projector **return `[]`** — the existing write guard then persists nothing. **No
gateway change is required.** The response has already been streamed to the
client by this point, so the live call is untouched
([LLP 0049](./0049-hypignore-usage-policy.spec.md#requirements) R2).

This is purely a projection-time decision; settlement (`claude/src/settle.js`,
[LLP 0027](./0027-cache-settlement.decision.md)) only upgrades the identity of
already-written rows and is irrelevant to ignore.

### Backfill: skip ignored sessions

`hyp backfill` reads local transcripts that carry `cwd`/`repo_root` per session,
so each backfill provider filters ignored sessions out *before* projecting or
writing them. Without this, a backfill would silently re-import the exact
sessions ignored live.

### Shared matcher in core

Only the matcher — *given a `cwd`, walk ancestors → nearest `.hypignore` →
class*, with a per-`cwd` cache — is common to all four call sites. It is a small,
**`cwd`-agnostic** unit of path logic and lives in **`src/core/usage-policy/`**,
imported by both adapters exactly as they already import
`src/core/observability`. Core gains a reusable matcher; it gains **no** `cwd`
concept and does not inspect rows (only the adapter knows which field is the
`cwd`).

## Why not the gateway

- The gateway is the **provider-agnostic** proxy ([LLP 0016](./0016-ai-gateway.decision.md)).
  Teaching it about `cwd`/`.hypignore` would push client-specific domain logic
  into a component whose whole point is not to have any.
- The backfills do **not** flow through the gateway at all, so gateway-side
  enforcement could not cover them — the matcher would have to live somewhere
  shared regardless.
- It makes the [LLP 0049](./0049-hypignore-usage-policy.spec.md#non-goals)
  raw-proxy/OTEL folder-blindness a **structural consequence** (those paths have
  no adapter and no `cwd`) rather than a rule someone must remember to enforce.

## Why not duplicate the matcher per adapter

Two copies of a privacy-critical matcher drift apart. A single core module with
one test suite is the safer home; sibling-to-sibling plugin imports would be
worse coupling than both importing core.

## Consequences

- Code that lands this carries `@ref LLP 0050 [implements]` on the adapter
  projector/backfill drop sites and on the `src/core/usage-policy/` matcher.
- The gateway source and recorder are not modified.
- A future caller-supplied `cwd` for raw-proxy traffic would add a *new* call
  site that reuses the same core matcher — no change to this decision.
