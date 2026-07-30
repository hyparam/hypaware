# LLP 0083: Codex live cwd is enriched from the session rollout

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Gateway, Sources
**Author:** Phil / Claude
**Date:** 2026-07-07
**Related:** LLP 0030, LLP 0032, LLP 0049, LLP 0050

> The `@hypaware/codex` **live** exchange projector resolves an exchange's `cwd`
> from the session's local rollout (`session_meta.cwd`) when the request carries
> none — the same source the codex backfill already reads. This makes
> `.hypignore` folder coverage ([LLP 0049](./0049-hypignore-usage-policy.spec.md))
> client-independent for Codex and stamps a non-null `cwd` on subscription-route
> rows.

## Context

`.hypignore` enforcement matches an exchange to a scope by its `cwd`
([LLP 0049](./0049-hypignore-usage-policy.spec.md#scope)), and the drop lives in
the client adapter — the only place that resolves a `cwd`
([LLP 0050](./0050-ignore-enforced-in-adapters.decision.md)). The Codex live
projector resolved `cwd` **only** from the request in flight: the
`x-codex-turn-metadata` header, then the body `cwd` / `metadata.cwd` /
`metadata.user_id.cwd`. When none was present it skipped the check (`if (cwd)`),
failing **open**.

That was a latent assumption. The **API-key** route (Responses API) happens to
carry `cwd` in-band in `metadata`, so no enrichment was ever built. The
**ChatGPT-subscription** route (`provider='chatgpt'`, `/backend-api/codex/*`)
has no such field, and `codex-tui` does not send the `x-codex-turn-metadata`
header on it (that is Codex Desktop behavior). So "cwd is always available at
projection time" was really "cwd is available when the client volunteers it" —
and for an entire first-class traffic class, it never did:

- `.hypignore` was a silent **no-op** for subscription-mode Codex — the same gap
  class as raw-proxy/OTEL ([LLP 0049 §non-goals](./0049-hypignore-usage-policy.spec.md#non-goals)),
  except this *is* a supported Codex adapter pathway, not a folder-blind source.
- The subscription-route rows recorded `cwd = NULL`, so they also escaped the
  ephemeral session opt-out's sibling cwd story and lost the graph's File/Repo
  scoping.
- It diverged from **backfill**: the codex backfill reads `session_meta.cwd` from
  the rollout and *does* skip an ignored session, so the two halves of one policy
  treated the same session oppositely — recorded live, skipped on backfill.

The `cwd` was available locally the whole time: Codex writes `session_meta.cwd`
into its rollout (`<sessionsDir>/…/rollout-<ts>-<session_id>.jsonl`, line 1) at
session start, for both auth modes. The live projector just never read it.

## Decision

**When the request carries no in-band `cwd`, the Codex live projector falls back
to the session rollout's `session_meta.cwd`, keyed on the session id the adapter
already resolves.** Contrast the `@hypaware/claude` projector, which — because
Anthropic requests never carry `cwd` — *had* to build enrichment (the
hook-written `session-context.jsonl` sidecar) and therefore works on every route.
Codex now has the symmetric fallback.

- **In-band stays the fast path.** A fresh in-band `cwd` short-circuits before any
  filesystem work; the rollout is consulted **only** on a miss.
- **Keyed on the codex session id.** The live path already resolves it
  (`session-id` header / turn metadata); the rollout filename embeds it, matched
  via the `sessionIdFromPath` helper shared with the backfill. Only a real Codex
  session has a rollout, so non-codex traffic never scans.
- **First line only, cached per session id.** The rollout is written at session
  start, so it exists before the first exchange projects (earlier and more
  reliably than Claude's sidecar, which has a known session-start race). Reading a
  bounded prefix and caching per session id — including misses — keeps the capture
  hot path free of unbounded fs work ([LLP 0049 R6](./0049-hypignore-usage-policy.spec.md#requirements)).
- **One resolved `cwd`, used twice.** The same value feeds the `.hypignore` drop
  and the row's stamped `cwd`, so live rows now carry the cwd the backfill reads
  and the two halves of the policy agree (closes the live/backfill inconsistency).
- **A substituted workspace key never decides the verdict** (amended, #476). The
  Codex projector picks a `workspaces` turn-metadata key for enrichment, falling
  back to the *first* key when none matches the request's `cwd`. That substituted
  key is a guess about a directory the session may never have run in, so it does
  not supply the one resolved `cwd`: an explicit in-band `cwd` outranks it for
  both the gate and the stamp, and the refusal is reported as
  `plugin.codex.usage_policy_workspace_cwd_refused`
  (`error_kind: workspace_cwd_mismatch`, paths hashed). The key keeps its
  enrichment role (`attributes.codex.workspace`, `git_remote`, `git_commit`,
  `has_changes`) and still supplies the `cwd` on the subscription route, where
  the request states none and the key is the only in-band source there is.
  Consequence: for a session running in a *subdirectory* of its workspace the
  row now stamps the subdirectory rather than the workspace root, which is the
  directory the policy is actually scoped to.
  Three limits, stated rather than implied, and each one filed so it does not
  live only here. The key still outranks the **rollout** fallback (it resolves
  before the `??`), so a subscription-route session that declares a `workspaces`
  map never consults `session_meta.cwd` and a first-key guess can still decide
  its verdict (#480). That one is pre-existing, verified byte-identical before
  and after this amendment; ranking the guess below the rollout is a separate
  call, not taken in the lines PRs #467/#474 rewrite. Because the key keeps
  enriching, a row recorded where it used to drop (clean in-band `cwd`, ignored
  declared workspace) carries that workspace's identity even though the
  directory it names is `.hypignore`-ignored: the gate is scoped by `cwd`
  ([LLP 0049](./0049-hypignore-usage-policy.spec.md#scope)), not by enrichment
  source (#481). And the gate does not canonicalize paths, so *which spelling*
  reaches it decides the verdict: a symlinked spelling of an ignored directory
  escapes its `.hypignore`, because the ancestor walk climbs the symlink's own
  parents and never meets the governing file. That is a property of the shared
  matcher rather than of this amendment (#479, and it is also why `pathsEqual`
  misses symlinked spellings here). What this amendment changes is which of two
  symmetric spellings trips it, by taking the client's honest `cwd` over the
  key's: it closes the case where the *key* held the non-canonical spelling and
  opens the case where the *request* does. The widest case is untouched, a
  declared symlinked key on a subscription-route request that states no `cwd` at
  all, which leaks the same before and after. Canonicalizing belongs in the
  shared matcher ([LLP 0050](./0050-ignore-enforced-in-adapters.decision.md)),
  where it must also canonicalize the `local-only` list entries or it un-governs
  an entry a user marked by its symlink spelling.

## Why not the alternatives

- **Wait for the client to volunteer `cwd`** (an `x-codex-turn-metadata` on the
  subscription route, or a caller-supplied `X-Hyp-Cwd` header — the future hook
  [LLP 0049 non-goal 1](./0049-hypignore-usage-policy.spec.md#non-goals) leaves
  open). This keeps a privacy control's coverage hostage to client behavior we do
  not own, indefinitely. The rollout makes coverage **client-independent** today;
  if a future client *does* send the header, the adapter already parses it
  route-agnostically and coverage simply resumes via the fast path — no conflict.
- **Accept it as structural folder-blindness** like raw-proxy/OTEL. Those paths
  have no adapter and no local `cwd`; Codex has both. Treating a recoverable leak
  as structural would be a privacy regression dressed as a non-goal.
- **Make the projector async / read the whole rollout.** Unnecessary: only line 1
  (`session_meta`) is needed, so a bounded synchronous prefix read keeps the
  projector on its existing synchronous seam (the usage-policy resolver it already
  uses is synchronous too).

## Consequences

- Code that lands this carries `@ref LLP 0083 [implements]` on the new
  `codex/src/rollout-cwd.js` resolver, the projector's cwd fallback and
  `resolveRecordedContext`, and the `index.js` wiring.
- This **amends the [LLP 0049](./0049-hypignore-usage-policy.spec.md) /
  [LLP 0050](./0050-ignore-enforced-in-adapters.decision.md) enforcement story**
  for Codex: subscription-mode Codex is no longer in the folder-blind non-goal
  set, and R1 coverage becomes client-independent for it. Those docs carry a
  forward-ref to this one; nothing they *decided* changes.
- No cache schema, export driver, or gateway change: purely a projection-time cwd
  source, exactly like the existing Codex/Claude adapter drops
  ([LLP 0050](./0050-ignore-enforced-in-adapters.decision.md)).
- **Prospective only.** Like the rest of [LLP 0049](./0049-hypignore-usage-policy.spec.md#prospective-only),
  this gates *future* live recording; rows already written with `cwd = NULL` are
  untouched (a `hyp backfill` re-import, which reads the rollout, is the path to
  re-apply the policy to historical subscription sessions).
