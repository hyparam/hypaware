# LLP 0050: ignore is enforced in the client adapters, not the gateway

**Type:** Decision
**Status:** Accepted
**Systems:** Gateway, Plugins, Core
**Author:** Phil / Claude
**Date:** 2026-06-29
**Related:** LLP 0012, LLP 0016, LLP 0049, LLP 0066, LLP 0083

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
(`claude/src/projector.js`). (**Extended-by:
[LLP 0083](./0083-codex-live-cwd-from-rollout.decision.md)** — the Codex live
projector had no equivalent `cwd` source on the ChatGPT-subscription route, so it
now enriches `cwd` from the session rollout the same way; the drop mechanics here
are unchanged.) It runs **before** the cache write: the gateway
source does `projectExchange(row)` → `if (messageRows.length > 0) appendRows(...)`
(`ai-gateway/src/source.js`). So an ignored exchange is dropped by having the
projector **return `[]`** — the existing write guard then persists nothing. **No
gateway change is required.** The response has already been streamed to the
client by this point, so the live call is untouched
([LLP 0049](./0049-hypignore-usage-policy.spec.md#requirements) R2).

This is purely a projection-time decision; settlement (`claude/src/settle.js`,
[LLP 0027](./0027-cache-settlement.decision.md)) only upgrades the identity of
already-written rows and is irrelevant to ignore. (**Extended-by:
[LLP 0085](./0085-settlement-may-drop-late-ignore.decision.md)** — this holds for
the *common* case, where the projector resolved `cwd` and applied the drop. But
when `cwd` was *unknown at projection* (the Claude session-start race: the
`session-context.jsonl` record had not landed, so the row was written with
`cwd = null` and the check was skipped, failing **open**), settlement is **no
longer** irrelevant: it re-resolves the now-known `cwd` at flush and **drops** the
row when it resolves to `ignore`. The `ignore` guarantee is thus the capture seam
**or** a flush-time settlement-drop when cwd was unknown at capture; the drop
still happens before partition write and before export.)

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

## What "the same directory" means to the shared matcher {#canonicalization}

The matcher compares directory *paths*, and a directory has more than one path.
Until this section existed, the matcher used `path.resolve` on both sides, which
is purely **lexical**: it normalizes `.`/`..` and makes a path absolute but
follows no symlinks. So the ancestor walk from a symlinked `cwd` climbed the
*link's* parents and never met the `.hypignore` governing the real directory: a
user's `.hypignore` was silently not in force for a project reached through a
symlink, which on macOS is ordinary (`/tmp` to `/private/tmp`, Homebrew
prefixes, iCloud-backed `~/Documents`). Because this is the *single shared*
matcher, every consumer inherited the hole: all four adapter capture seams,
`hyp purge`, the query-seam visibility filter (LLP 0105), `hyp ignore --check` /
`policy show`, and the machine-local list membership test.

**Decision: a directory is matched over the *set* of path spellings that denote
it, and the most restrictive verdict any spelling produces wins.** The set is
the as-given (lexical) spelling plus the canonical, symlink-resolved spelling
when it differs, computed by `src/core/usage-policy/canonical.js`. Both sides of
every comparison get this treatment: the incoming `cwd`, and every stored
machine-local entry's `dir`.

Resolving over the *set* rather than switching to the canonical form alone is
the load-bearing part, and it is a privacy argument rather than a tidiness one.
Canonicalizing only the incoming `cwd` does close the capture leak, but the
machine-local store keeps whatever path the user supplied (LLP 0071, LLP 0103),
so an entry the user marked by its symlink spelling stops governing: the class
drops from `local-only` to `full` and that directory **starts forwarding**. That
trades a capture leak for a forwarding leak. Taking the most restrictive verdict
across both spellings closes the first without opening the second, and makes the
fail-safe structural rather than a special case: a `realpath` that fails removes
a *candidate* spelling, never a verdict some other spelling already produced, so
canonicalization can only ever move the gate toward more restrictive, never
toward `full`.

Three consequences worth stating outright, because they are what a reader of the
privacy gate will ask:

- **A declaration stays authoritative as written.** Stored entries keep their
  as-declared `dir` on disk; nothing is rewritten. An entry governs both its
  declared spelling and, when resolvable, the canonical spelling of what it
  points at. If the declared path's target changes or disappears, the
  declaration still governs the declared spelling, so **no stored entry ever
  silently loses its class**; it merely stops governing the canonical form of a
  target it no longer names. A filesystem change never revokes a user's
  declaration.
- **Migration is canonicalize-on-read, additively.** There is no on-disk
  migration and no version bump: entries written before this decision gain
  canonical reach the moment it ships. Writes still store the caller-resolved
  path, so `policy show` and `--check` echo the spelling the user typed. The one
  write-side change is *upsert identity*: re-marking a directory through a
  different spelling replaces the existing entry rather than appending a second
  governor for the same directory (which would let the nearest-governs
  tie-break, not the user, decide the class).
- **`realpath` is not free, so it rides the existing cache.** The per-`cwd`
  memoization is keyed on the lexical path and consulted *before*
  canonicalization, so the cost is one `realpath` per distinct `cwd` per TTL
  window - the identical bound [LLP 0049](./0049-hypignore-usage-policy.spec.md#requirements)
  R6 already sets for the ancestor walk - and **zero** syscalls on a cache hit,
  which is the per-exchange hot path. Entry spellings are computed once per list
  parse, inside the same TTL. `hyp purge`'s subtree predicate runs per row, so it
  memoizes the verdict per distinct row `cwd` for the life of one purge run.

A canonicalization that does not fully resolve is reported as a structured
`usage_policy.canonicalize_failed` event carrying `error_kind:
path_canonicalize_failed`, the `errno`, how far it got, and a **hashed** path -
never a raw local path, the same discipline the `usage_policy.export_drop`
aggregate uses. `ENOENT` is routine (a deleted `cwd`, a not-yet-created
directory), so it logs at `debug`; only a wholly unresolvable path escalates to
`warn`. `realpath` is all-or-nothing, so rather than discard a failure entirely
the canonicalizer resolves the deepest existing ancestor and rejoins the
unresolved tail: with `/tmp` a symlink, `/tmp/proj/not-created-yet` still
canonicalizes usefully, which matters because the symlink is almost always an
*ancestor*, not the leaf.

`isEqualOrDescendant` stays lexical and pure, for callers comparing two strings
that are already canonical and must not touch the filesystem. The
spelling-agnostic predicate a CLI verb wants when it asks "which stored entry
governs this directory?" is `scopeGoverns`, which has to be the same predicate
`resolve` used, or `policy show` names a governor the gate did not use and
`policy unset` refuses to remove an entry the gate is enforcing.

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
- Every consumer of the shared matcher inherits
  [§canonicalization](#canonicalization) for free; no adapter, `hyp purge`, or
  query-seam change is needed to gain it, which is the same argument that put the
  matcher in core in the first place.
- The gateway source and recorder are not modified.
- A future caller-supplied `cwd` for raw-proxy traffic would add a *new* call
  site that reuses the same core matcher — no change to this decision.
- The ephemeral per-session opt-out ([LLP 0066](./0066-session-opt-out.spec.md))
  reuses this same adapter drop with a *different key*: it matches on the
  `session_id` the adapter resolves instead of on `cwd`, and returns the same
  `USAGE_POLICY_DROP` sentinel. That mechanism adds a gateway *control route* and
  an in-memory set of opaque `session_id` strings, but the gateway still performs
  no drop and interprets no identity, so this decision holds unchanged.
