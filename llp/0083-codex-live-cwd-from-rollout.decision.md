# LLP 0083: Codex live cwd is enriched from the session rollout

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Gateway, Sources
**Author:** Phil / Claude
**Date:** 2026-07-07
**Related:** LLP 0030, LLP 0032, LLP 0049, LLP 0050, LLP 0066, LLP 0067, LLP 0150, LLP 0151, LLP 0160, LLP 0350

> The `@hypaware/codex` **live** exchange projector resolves an exchange's `cwd`
> from the session's local rollout (`session_meta.cwd`) when the request carries
> none: the same source the codex backfill already reads. This makes
> `.hypignore` folder coverage ([LLP 0049](./0049-hypignore-usage-policy.spec.md))
> client-independent for Codex and stamps a non-null `cwd` on subscription-route
> rows.

## Context

`.hypignore` enforcement matches an exchange to a scope by its `cwd`
([LLP 0049](./0049-hypignore-usage-policy.spec.md#scope)), and the drop lives in
the client adapter, the only place that resolves a `cwd`
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

- `.hypignore` was a silent **no-op** for subscription-mode Codex, the same gap
  class as raw-proxy/OTEL ([LLP 0049 §non-goals](./0049-hypignore-usage-policy.spec.md#non-goals)),
  except this *is* a supported Codex adapter pathway, not a folder-blind source.
- The subscription-route rows recorded `cwd = NULL`, so they also escaped the
  ephemeral session opt-out's sibling cwd story and lost the graph's File/Repo
  scoping.
- It diverged from **backfill**: the codex backfill reads `session_meta.cwd` from
  the rollout and *does* skip an ignored session, so the two halves of one policy
  treated the same session oppositely: recorded live, skipped on backfill.

The `cwd` was available locally the whole time: Codex writes `session_meta.cwd`
into its rollout (`<sessionsDir>/…/rollout-<ts>-<thread_id>.jsonl`, line 1) at
session start, for both auth modes. The live projector just never read it.

## Decision

**When the request carries no in-band `cwd`, the Codex live projector falls back
to the thread rollout's `session_meta.cwd`, keyed on the Codex thread id the
adapter already resolves** (the thread, *not* the session container: see the
keying bullets below and the [correction for issue #459](#correction-the-first-cut-keyed-on-the-container-issue-459)).
Contrast the `@hypaware/claude` projector, which, because Anthropic requests
never carry `cwd`, *had* to build enrichment (the hook-written
`session-context.jsonl` sidecar) and therefore works on every route. Codex now
has the symmetric fallback.

- **In-band stays the fast path.** A fresh in-band `cwd` short-circuits before any
  filesystem work; the rollout is consulted **only** on a miss.
- **An unusable in-band `cwd` is a miss, not a path.** A relative or blank
  in-band value is refused before the gate sees it: the matcher would resolve it
  against the **daemon's** own process cwd and return a confident verdict for an
  unrelated directory (#471). The rollout fallback then still gets its turn, and
  when nothing usable is found the row records `cwd = NULL` exactly as before, so
  refusing does not make this path fail closed. All three cwd sources for this
  gate answer that from **one** predicate: core's `sessionMetaCwd` refuses a
  blank or relative value
  ([LLP 0150 §usable-cwd](./0150-one-reader-for-codex-session-meta.decision.md#usable-cwd)),
  `rollout-cwd.js` reads the rollout through it, and `usableInBandCwd` calls it
  for the in-band value, so a refused in-band value falls through to a source
  predicated the same way. The in-band wrapper survives only to name *which* way
  the value was unusable (`error_kind`: `cwd_blank` vs `cwd_not_absolute`), which
  a single `undefined` cannot carry. Sharing the predicate is a de-duplication
  (#478), not an invariant LLP 0150 imposed: 0150 scopes the in-band path out of
  its own mandate, because in-band is a separate source with its own trust story
  whose value is also stamped on the row for workspace/git enrichment. The first
  cut (#471) restated the two checks locally on exactly that scoping argument,
  not for want of an owner: `sessionMetaCwd` was already on `master` when that
  copy landed, and its docstring cited LLP 0150 `#usable-cwd` by anchor while
  declining to borrow it. What changed here is the weight given to drift, not
  the scoping: the two readings were behaviourally identical over every input
  that can reach the seam, so folding them together changed nothing except the
  number of places the rule can drift from. The workspace key is the third source
  with the same trust problem, and `usableInBandCwd` is applied to it too, as a
  **separate** call, because the key no longer arrives folded into the in-band
  value (#480). One limit of the rule, stated rather than implied: it bounds the
  *shape* of a value, never its provenance, so an absolute-but-unrelated
  directory (the first workspace `selectCodexWorkspace` substitutes when none
  matches) passes it. What keeps such a guess from deciding a verdict is the
  **ranking** below, not this predicate (#476).
- **Keyed on the codex thread id, and the rollout must confirm it.** A rollout is
  one **thread's** file: its name embeds `session_meta.payload.id` (the thread),
  matched via the `sessionIdFromPath` helper shared with the backfill (a helper
  whose name predates this distinction). It does **not** embed the session
  container `payload.session_id`, which is the row's partition key and the session
  opt-out's key ([LLP 0030](./0030-session-id-partition-key.decision.md#decision)),
  so the container is not what selects a rollout. The live path resolves the
  thread from the body's `client_metadata.thread_id`, else the turn-metadata blob
  ([LLP 0151](./0151-codex-lineage-from-body-client-metadata.decision.md#body-is-authority);
  it was never a `thread-id` header, a name Codex does not emit). Only a real
  Codex thread has a rollout, so non-codex traffic never scans. The name is a
  cheap prefilter, not the answer: the located file's `payload.id` is re-checked
  against the id asked for, and a disagreement is a **refusal** (cwd unknown)
  rather than another thread's cwd deciding this turn. The re-check reads through
  core's one `session_meta` reader, which takes the id off the **raw** JSONL line
  rather than through Codex's own `Deserialize`
  ([LLP 0150](./0150-one-reader-for-codex-session-meta.decision.md)), so an absent
  `payload.id` reads as absent and refuses instead of being back-filled from the
  container and matching. `payload.session_id` is deliberately not consulted here:
  a rollout too old to carry a container still records a perfectly good cwd for
  its thread.
- **When no thread is stated, the container is usable only for a root thread.**
  A turn can still state a container and no thread of its own (see the
  reachability note in the next bullet), and for a root thread the container's
  value *is* the thread id, so the fallback still works there. It is abandoned the
  moment the turn announces subagent lineage
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
  what makes the refusal reachable at all.

  **Narrowed by LLP 0151, not retired by it.** When this bullet was first written
  the adapter did not read the request body, and the note here recorded the body's
  flat `client_metadata` map (which carries `session_id` and `thread_id` on
  *every* request) as the better long-term answer, declined only because it would
  newly populate `thread_id` and hence `conversation_id` on rows. That read has
  since landed on its own terms
  ([LLP 0151](./0151-codex-lineage-from-body-client-metadata.decision.md#body-is-authority)),
  which settles the recorded-shape question there rather than here. The
  consequence for this document: a turn now reaches the container fallback at all
  only when **no surface it carries states a `thread_id`**. That is stricter than
  "carries neither surface", and the difference is the whole reachable set: a turn
  reaches the fallback only by naming a container on a Codex-owned surface while
  naming no thread on any of them.

  The invariant that makes that unreachable is not "each surface states a
  `thread_id`", which is false of the blob. It is that **on both surfaces the two
  ids are emitted as a pair, never one without the other**, so no surface can
  supply the container the fallback needs while withholding the thread that would
  pre-empt it. Verified by reading the emitting source rather than inferred
  (`openai/codex`, `codex-rs/core/src/responses_metadata.rs`, commit `1def0a8`,
  2026-07-28):

  - `CodexResponsesMetadata::client_metadata` inserts `session_id` and `thread_id`
    into the same map literal, unconditionally and ungated, from two non-`Option`
    `String` fields. Every `/responses` request carries this map
    (`client.rs`, `client_metadata: Some(responses_metadata.client_metadata())`).
  - `turn_metadata_payload` gates `session_id` and `thread_id` on the **same**
    `has_turn_identity` boolean, so the blob states both or neither.

  The blob's `has_turn_identity` is false for exactly one request kind,
  `CodexResponsesRequestKind::Memory`, and that kind still emits the lineage this
  refusal keys on (`thread_source`, `parent_thread_id`, and an
  `x-openai-subagent: memory_consolidation` header) with **no** id pair in the
  blob. So memory consolidation is the closest real Codex shape to the refusal's
  trigger, and what keeps it out is the flat body map alone, not the blob. That is
  pinned by a test rather than left as prose, because the surface doing the work
  is not the one the argument reads as naming.

  **The value-blind grain, and what it costs.** The guard refuses on any
  `x-openai-subagent` value, not only the ones that name a different workspace, so
  `review`, `compact` and `memory_consolidation` (same-workspace sub-threads,
  where the root's `cwd` is the correct answer) refuse a container that would have
  resolved correctly, and [LLP 0049](./0049-hypignore-usage-policy.spec.md) then
  fails **open** and records the turn. That is the same leak direction this
  document exists to close, and it is accepted here only because it needs the same
  unobserved request shape the fallback itself now needs: verified by executing
  the real projector over every surface combination, the refusal and the
  container fallback are entered by exactly the same shapes, so neither the
  residual nor its mirror is reachable from Codex traffic as `codex-rs` emits it.

  That last clause is a claim about a program this repo does not build, so it is
  worth being exact about its standing. It has been checked against `codex-rs`
  source directly (the pair invariant above), which is stronger than the earlier
  "documented to emit" phrasing, but it is still a **snapshot of an upstream
  `main`**, not a pinned release, and it is a claim about emitting code rather
  than about captured traffic: no hermetic smoke in this repo can supply it
  ([LLP 0141](./0141-codex-desktop-rides-the-codex-adapter.decision.md)). Re-check
  it at the two functions named above if the guard's cost ever matters. That is
  why the guard is kept rather than deleted: it is the cheap half of a trade whose
  premise is another program's source.
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
  `x-openai-subagent`, and nothing else. The bare `thread-id`, `session-id` and
  `parent-thread-id` this document once relied on appear nowhere in it; the
  audit and the removal of those reads belong to
  [LLP 0151](./0151-codex-lineage-from-body-client-metadata.decision.md), and the
  rule they leave behind is the one this bullet always wanted: nothing may be
  *guarded* by a header name Codex does not emit. The same reading corrected the
  premise in Context above, that `codex-tui` does not send
  `x-codex-turn-metadata`. Confirming the live header set against a real client
  remains the open acceptance check, and it is
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
- **A substituted workspace key never decides the verdict** (amended, #476,
  #480). {#workspace-key-ranks-last} The Codex projector picks a `workspaces`
  turn-metadata key for enrichment, falling
  back to the *first* key when none matches the request's `cwd`. That substituted
  key is a guess about a directory the session may never have run in, so it does
  not supply the one resolved `cwd` while any better-founded source exists. The
  order is **in-band, rollout, key**: an explicit in-band `cwd` outranks it for
  both the gate and the stamp, and the refusal is reported as
  `plugin.codex.usage_policy_workspace_cwd_refused`
  (`error_kind: workspace_cwd_mismatch`, paths hashed); the rollout's
  `session_meta.cwd` outranks it too, because that line is what Codex itself
  wrote at session start rather than a guess this projector made. The key keeps its
  enrichment role (`attributes.codex.workspace`, `git_remote`, `git_commit`,
  `has_changes`) and remains the **last resort** for the `cwd` on the
  subscription route: when the request states none and no rollout is found, it is
  the only source there is, and refusing it outright would remove `.hypignore`
  coverage from that whole route.
  Consequence: for a session running in a *subdirectory* of its workspace the
  row now stamps the subdirectory rather than the workspace root, which is the
  directory the policy is actually scoped to.
  The key is offered as a last-resort `cwd` **only when the request stated no
  `cwd` at all**, not merely when what it stated was unusable: a relative or
  blank in-band value is still a statement about where the session ran, and
  letting the key stand in for it is exactly the substitution this bullet
  refuses (#476 case c).
  Three limits, stated rather than implied. A key outranked by the **rollout**
  is discarded silently: `usage_policy_workspace_cwd_refused` fires only for the
  in-band contradiction, because that predicate compares the key against a value
  the request stated, and the rollout arrives after it. A naive widening would
  put a warn on every turn of an ordinary session whose `session_meta.cwd` is a
  subdirectory of its workspace, which is the frequency objection
  [LLP 0160](./0160-workspace-cwd-refusal-is-an-ancestor-test.decision.md#decision)
  has since settled on the in-band side by making the refusal an **ancestor**
  test rather than a byte test. Widening is therefore no longer blocked on that
  objection, but it must reuse 0160's predicate and not a byte comparison, or it
  reintroduces exactly the noise 0160 removed. The other two are filed so they
  do not live only here. Because the
  key keeps enriching, a row recorded where it used to drop (an ignored declared
  workspace outranked by a clean `cwd`, in-band since #476 and, now that the key
  ranks below it, from the **rollout** too: demoting the key widens this case to
  the whole subscription route rather than leaving it to the in-band one) carries
  that workspace's identity even though the directory it names is
  `.hypignore`-ignored: the gate is scoped by `cwd`
  ([LLP 0049](./0049-hypignore-usage-policy.spec.md#scope)), not by enrichment
  source (#481). And the gate does not canonicalize paths, so *which spelling*
  reaches it decides the verdict: a symlinked spelling of an ignored directory
  escapes its `.hypignore`, because the ancestor walk climbs the symlink's own
  parents and never meets the governing file. That is a property of the shared
  matcher rather than of this amendment (#479, and it is also why `pathsEqual`
  misses symlinked spellings here). What this amendment changes is which of two
  symmetric spellings trips it, by taking the client's honest `cwd` over the
  key's: it closes the case where the *key* held the non-canonical spelling and
  opens the case where the *request* does. The widest case is narrowed but not
  closed: a declared symlinked key on a subscription-route request that states no
  `cwd` at all now loses to the rollout, whose value came from `getcwd(2)` and is
  therefore canonical, but it still reaches the gate uncanonicalized whenever no
  rollout is found. Canonicalizing belongs in the
  shared matcher ([LLP 0050](./0050-ignore-enforced-in-adapters.decision.md)),
  where it must also canonicalize the `local-only` list entries or it un-governs
  an entry a user marked by its symlink spelling.

**Extended-by:
[LLP 0160](./0160-workspace-cwd-refusal-is-an-ancestor-test.decision.md#decision)** -
which cases count as "refused" is narrowed to keys off the in-band `cwd`'s
ancestor chain, because an ancestor key was never a guess about where the session
ran (**not** because it could not have changed the verdict - it can, and 0160
§decision discloses when). That
document also records what is now stale in the "an unusable in-band `cwd` is a
miss" bullet's closing #476 sentence
([§corrections](./0160-workspace-cwd-refusal-is-an-ancestor-test.decision.md#corrections-0083)),
and leaves the enrichment question open under #492.

## Why not the alternatives

- **Wait for the client to volunteer `cwd`** (an `x-codex-turn-metadata` on the
  subscription route, or a caller-supplied `X-Hyp-Cwd` header, the future hook
  [LLP 0049 non-goal 1](./0049-hypignore-usage-policy.spec.md#non-goals) leaves
  open). This keeps a privacy control's coverage hostage to client behavior we do
  not own, indefinitely. The rollout makes coverage **client-independent** today;
  if a future client *does* send the header, the adapter already parses it
  route-agnostically and coverage simply resumes via the fast path, no conflict.
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
  an optional `log` and `index.js` passes `ctx.log`. One message, two
  `error_kind`s, because the two refusals have different diagnoses:
  `thread_id_mismatch` (a name that lies: a renamed or copied file) and
  `thread_id_absent` (the divergence recorded below, which the backfill still
  accepts).
- `codex/src/rollout-cwd.js` and `ai-gateway/src/session_command.js`'s
  `readRolloutMeta` were **two readers of the same first line** with different
  needs (a hot-path cwd lookup per thread versus a one-shot CLI scan that must
  report the container), agreeing on the discipline (raw line, `session_meta`
  type guard, absent means refuse) but each keeping its own copy of it. That fold
  has since happened and is no longer this document's follow-up: both now read
  through core's single `readRolloutSessionMeta`
  ([LLP 0150](./0150-one-reader-for-codex-session-meta.decision.md)), so the
  discipline is enforced in one place rather than agreed in two. What stays local
  to this resolver is the part that is not a read: the thread-identity guard
  below, which compares the reader's answer against the id the lookup asked for.
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
