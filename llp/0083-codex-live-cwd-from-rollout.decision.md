# LLP 0083: Codex live cwd is enriched from the session rollout

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Gateway, Sources
**Author:** Phil / Claude
**Date:** 2026-07-07
**Related:** LLP 0030, LLP 0032, LLP 0049, LLP 0050, LLP 0150, LLP 0151

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
has no such field, and a turn whose request kind carries no turn metadata sends
no `x-codex-turn-metadata` and therefore no `workspaces`. (This paragraph
previously said `codex-tui` never sends that header and that it is Codex Desktop
behavior. That is false: Codex's `compatibility_headers` emits it for every turn
regardless of client. See
[LLP 0151](./0151-codex-lineage-from-body-client-metadata.decision.md#context).)
So "cwd is always available at projection time" was really "cwd is available when
the client volunteers it" - and for an entire first-class traffic class, it
often did not:

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
- **An unusable in-band `cwd` is a miss, not a path.** A relative or blank
  in-band value is refused before the gate sees it: the matcher would resolve it
  against the **daemon's** own process cwd and return a confident verdict for an
  unrelated directory (#471). The rollout fallback then still gets its turn, and
  when nothing usable is found the row records `cwd = NULL` exactly as before, so
  refusing does not make this path fail closed. The rollout-stated `cwd` is held
  to the same two checks, by a different owner: core's `sessionMetaCwd` refuses a
  blank or relative `session_meta.cwd`
  ([LLP 0150 §usable-cwd](./0150-one-reader-for-codex-session-meta.decision.md#usable-cwd)),
  and `rollout-cwd.js` reads through it, so a refused in-band value falls through
  to an already-predicated source. That predicate is **not** borrowed for the
  in-band value, and this bullet is not a consequence of LLP 0150: 0150 scopes the
  in-band path out of its own mandate, because in-band is a separate source with
  its own trust story whose value is also stamped on the row for workspace/git
  enrichment. So the two checks are restated locally, in `usableInBandCwd`. One
  limit of the rule, stated rather than implied: on the Codex route the value the
  predicate sees is usually not the request's `cwd` but the workspace key
  `selectCodexWorkspace` selected for it, which substitutes the first workspace
  when none matches, so an absolute-but-unrelated directory can still reach the
  gate (#476).
- **Keyed on the codex session id.** The live path already resolves it: the
  body's `client_metadata.session_id`, else the turn-metadata blob
  ([LLP 0151](./0151-codex-lineage-from-body-client-metadata.decision.md#body-is-authority);
  it was never a `session-id` header, a name Codex does not emit). The rollout
  filename embeds it, matched via the `sessionIdFromPath` helper shared with the
  backfill. Only a real Codex session has a rollout, so non-codex traffic never
  scans.
- **First line only, cached per session id.** The rollout is written at session
  start, so it exists before the first exchange projects (earlier and more
  reliably than Claude's sidecar, which has a known session-start race). Reading a
  bounded prefix and caching per session id — including misses — keeps the capture
  hot path free of unbounded fs work ([LLP 0049 R6](./0049-hypignore-usage-policy.spec.md#requirements)).
- **One resolved `cwd`, used twice.** The same value feeds the `.hypignore` drop
  and the row's stamped `cwd`, so live rows now carry the cwd the backfill reads
  and the two halves of the policy agree (closes the live/backfill inconsistency).

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
