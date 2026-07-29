# LLP 0083: Codex live cwd is enriched from the session rollout

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Gateway, Sources
**Author:** Phil / Claude
**Date:** 2026-07-07
**Related:** LLP 0030, LLP 0032, LLP 0049, LLP 0050, LLP 0066, LLP 0067

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
- **Keyed on the codex thread id, and the rollout must confirm it.** A rollout is
  one **thread's** file: its name embeds `session_meta.payload.id` (the thread),
  matched via the `sessionIdFromPath` helper shared with the backfill (a helper
  whose name predates this distinction). It does **not** embed the session
  container `payload.session_id`, which is the row's partition key and the session
  opt-out's key ([LLP 0030](./0030-session-id-partition-key.decision.md#decision)),
  so the container is not what selects a rollout. The live path resolves the
  thread from the turn metadata's `thread_id` or the `thread-id` header. Only a
  real Codex thread has a rollout, so non-codex traffic never scans. The name is a
  cheap prefilter, not the answer: the located file's `payload.id` is re-checked
  against the id asked for, read off the **raw** JSONL line so an absent field
  reads as absent, and a disagreement is a **refusal** (cwd unknown) rather than
  another thread's cwd deciding this turn. `payload.session_id` is deliberately
  not consulted here: a rollout too old to carry a container still records a
  perfectly good cwd for its thread.
- **When no thread is stated, the container is usable only for a root thread.**
  The common subscription-route request carries a `session-id` header and nothing
  else, and for a root thread that value *is* the thread id, so the fallback still
  works. It is abandoned the moment the turn announces subagent lineage
  (`thread_source = subagent`, or a `parent_thread_id`) without naming its own
  thread: that turn's rollout is not identifiable from the wire, and an unknown
  cwd (fails open per [LLP 0049](./0049-hypignore-usage-policy.spec.md), row
  records NULL) is preferred to confidently enforcing and stamping the root's
  directory. A wrong cwd is a false statement about where a turn ran; an absent
  one is true.
- **The lineage that guards the container fallback has to be a header, not the
  metadata blob.** {#container-fallback-gap} `thread_source` and
  `parent_thread_id` are read out of `x-codex-turn-metadata`, and that blob also
  carries `thread_id`, so a turn stating them has already been resolved by the
  thread-id key: a refusal keyed only on those can never fire. What survives a
  turn stating no thread id is the lineage `codex-rs` emits as a **direct**
  header, gated on its own value and not on the blob
  (`CodexResponsesMetadata::compatibility_headers`):
  `x-codex-parent-thread-id`, and `x-openai-subagent` (`review`, `compact`,
  `collab_spawn`, `memory_consolidation`). Both are therefore consulted, which is
  what makes the refusal reachable at all. The same source shows the two flat
  identity keys, `session_id` and `thread_id`, are also always present in the
  request **body** under `client_metadata`, which the adapter does not read
  today: reading them would replace this fallback with the turn's own thread id
  outright, and is the better long-term answer. It is not taken here because it
  would newly populate `thread_id`, hence `conversation_id`, on rows that record
  null for it today, which is a recorded-shape change needing its own decision.
- **What remains after that is bounded, and removing the fallback is worse.** A
  turn stating a container, no thread id, and no lineage of any kind is taken as
  the root thread it claims to be. That can only mis-resolve for a client that
  withholds its thread id **and** withholds every lineage signal on a subagent
  turn, and Codex withholds neither together. Dropping the fallback instead
  returns every turn that states only a container, root threads included, to
  `cwd = NULL`, failing `.hypignore` open for that whole traffic class: the
  regression this document exists to prevent. The remaining alternative, deciding
  ambiguity from disk (refuse the container key when another rollout in the tree
  declares `session_id = <container>` with a different `id`, so the container
  demonstrably holds more than one thread), is decidable locally but costs the
  newest-first short-circuit, since proving uniqueness means visiting every
  candidate rather than returning on the first name match. That trades
  [LLP 0049 R6](./0049-hypignore-usage-policy.spec.md#requirements) and is left
  open rather than taken.
- **A note on the header names, which are not all Codex's.** `codex-rs` defines
  `x-codex-turn-metadata`, `x-codex-window-id`, `x-codex-parent-thread-id` and
  `x-openai-subagent`; the bare `thread-id`, `session-id` and `parent-thread-id`
  the adapter also reads appear nowhere in it. Those reads are older than this
  document and are kept (they cost nothing and some traffic shape motivated them),
  but nothing should be *guarded* by them alone. The same reading says the premise
  in Context below, that `codex-tui` does not send `x-codex-turn-metadata`, is at
  best version-specific: the header is emitted from core for every ordinary turn
  (`request_kind = Turn`), not from Desktop specifically. Confirming the live
  header set against a real client is the open acceptance check, and it is
  [LLP 0141](./0141-codex-desktop-rides-the-codex-adapter.decision.md)'s point
  that no hermetic smoke can supply it.
- **First line only, cached per thread id.** The rollout is written at session
  start, so it exists before the first exchange projects (earlier and more
  reliably than Claude's sidecar, which has a known session-start race). Reading a
  bounded prefix and caching per thread id (including misses) keeps the capture
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

## Correction: the first cut keyed on the container (issue #459)

As first landed, the resolver was **called** with the session container
(`metadata.session_id` / the `session-id` header) while it **located** the rollout
by the thread id in the filename. The two coincide on a root thread, so every
hand-check passed; they diverge on a **subagent** thread, which inherits its
root's container and mints its own thread id. So a subagent turn on the
subscription route resolved the **root's** rollout, and the root's `cwd` then
decided the `.hypignore` outcome ([LLP 0050](./0050-ignore-enforced-in-adapters.decision.md))
and was stamped on the row.

That is a directory-scoped privacy control silently not applying: a subagent
running in an `ignore` directory whose root did not was **recorded**. (The mirror
case, an over-drop, loses data but leaks nothing.) The identifier bug is the same
root cause as [issue #453](https://github.com/hyparam/hypaware/issues/453) on the
`hyp session` resolver ([LLP 0067](./0067-session-opt-out.design.md#cli-session-id)),
on a different call path: there the container had to be read *out of* the thread's
rollout, here the thread is what selects the rollout in the first place. Both now
refuse rather than accept an id whose provenance does not check out.

The bullets above state the corrected contract. Two rules carried across from
that resolver rather than re-derived: parse the **raw** `session_meta` line (Codex
back-fills `session_id` from `id` in its own deserializer, so a struct-shaped read
cannot tell a legacy rollout from a root one), and treat an id that cannot be
confirmed as unresolvable.

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
- The identity guard's refusal is **logged** (`plugin.codex.rollout_cwd_thread_mismatch`,
  warn), because its only other trace is a row with `cwd = NULL`, which is
  indistinguishable from the ordinary not-yet-written rollout. The resolver takes
  an optional `log` and `index.js` passes `ctx.log`.
- `codex/src/rollout-cwd.js` and `ai-gateway/src/session_command.js`'s
  `readRolloutMeta` remain **two readers of the same first line** with different
  needs (a hot-path cwd lookup per thread versus a one-shot CLI scan that must
  report the container). They now agree on the discipline (raw line, `session_meta`
  type guard, absent means refuse). Folding them into one shared reader is a
  worthwhile follow-up, not a requirement of this correction.
- **One narrow live/backfill divergence the identity guard introduces.** A
  `session_meta` payload carrying a `cwd` but **no** `id` is tolerated by the
  backfill (`buildSession` falls back to the id on the filename) and now refused
  by the live resolver. That is deliberate (an unconfirmable id is unresolvable),
  and the direction is safe by [LLP 0049](./0049-hypignore-usage-policy.spec.md)'s
  fail-open rule rather than by fail-closed: refusing means `cwd` unknown, which
  means the turn is **recorded**. Codex's own `SessionMeta` always writes `id`, so
  the shape is not expected; it is named here because the parity claim above
  ("live rows carry the cwd backfill reads") now has this one exception.
- **Prospective only.** Like the rest of [LLP 0049](./0049-hypignore-usage-policy.spec.md#prospective-only),
  this gates *future* live recording; rows already written with `cwd = NULL` are
  untouched (a `hyp backfill` re-import, which reads the rollout, is the path to
  re-apply the policy to historical subscription sessions).
