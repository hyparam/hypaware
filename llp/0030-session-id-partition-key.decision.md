# LLP 0030: Split `session_id` from `conversation_id` in ai_gateway_messages

**Type:** Decision
**Status:** Draft
**Systems:** Gateway, Plugins, Sinks
**Author:** Phil / Claude
**Date:** 2026-06-16
**Related:** LLP 0016, LLP 0022, LLP 0023, LLP 0026 (claude-native-granularity)

## Summary

`ai_gateway_messages` gets a dedicated **`session_id`** column that is the
non-null **partition key** and the *session container*; **`conversation_id`**
becomes **nullable** and means the *thread within* a session. This separates
two concepts the single `conversation_id` column had been overloading:

| column | Claude main loop | Claude subagent | Codex |
|---|---|---|---|
| `session_id` (partition key, **non-null**) | session | session | `metadata.session_id` (falls back to thread) |
| `conversation_id` (**nullable**) | null | null | thread |
| `agent_id` (nullable) | null | agent | null |
| `parent_thread_id` (nullable) | null | null | parent thread |

This is a **breaking** schema change (the partition key moved): the cache must
be **recreated and backfilled**, and it must **not** be bundled with any
additive (in-place evolvable) schema change — those follow a different upgrade
path (LLP 0029, the additive-cache-schema-evolution decision, claimed by an
open PR; this doc is numbered 0030 to avoid the collision).

## Context

`ai_gateway_messages` had one identity-of-the-container column,
`conversation_id`, declared as the **required Iceberg partition field** (the
clustering axis for both the cache and the export sort order, LLP 0022) and
the **fallback-hash scope** for synthesized `message_id`s. Both providers were
forced to stuff their container id into it:

- **Claude** has no per-thread "conversation" id. A Claude *session* is a
  container of many threads — the main agent loop, N subagent side-chains, and
  side chats — all sharing one session id (`metadata.user_id.session_id` /
  `x-claude-code-session-id`). The plugin put that session id in
  `conversation_id`, so "conversation_id is a session id for Claude" — the
  premise the code and LLP 0026 were written against.
- **Codex** genuinely has both: a `metadata.session_id` (the session) and a
  thread id (`x-codex-turn-metadata.thread_id`). With one column it could
  expose only one, and chose the thread, dropping the session grouping.

Overloading one column meant queries could not ask "all threads in this
session" for Codex, and the partition key's semantics differed per provider —
the same column was a session for Claude and a thread for Codex. Subagent
threads (which carry `agent_id` / `parent_thread_id`) had no stable container
key distinct from the thread.

## Decision

1. **`session_id` is a non-null column** and the **partition key**. It holds
   the session container: the Claude session id, or Codex
   `metadata.session_id` (falling back to the thread id when no session id was
   captured, so it is never null even for generic SDK traffic). Generic
   Anthropic SDK traffic without a session header hashes content/exchange id,
   exactly as the old `conversation_id` resolution did, so the value is always
   populated.
2. **`conversation_id` becomes nullable** and means the *thread within* the
   session: the Codex thread id; **null for Claude** (no per-thread id).
3. **The fallback-hash scope and the prior-message chain scope on
   `conversation_id ?? session_id`** (with `agent_id` separating a subagent's
   chain from the main loop's). For Claude (conversation_id null) this is the
   session id — the same value the pre-split `conversation_id` held — so
   **Claude fallback ids are unchanged**. For Codex it is the thread, also
   unchanged. The split is identity-preserving by construction.
4. **The Iceberg partition fields become
   `[session_id (required), conversation_id, cwd, date (required)]`.**
   `session_id` is the required identity field (always present);
   `conversation_id` rides along as a secondary, non-required field. These
   identity fields, in declared order, also seed the export's within-partition
   sort (LLP 0022), so `session_id` now leads the clustering and
   `conversation_id` is a secondary thread-lookup sort key.
5. **The context-graph `Session` node keys on `session_id`**, not
   `conversation_id`. Because Claude `conversation_id` is null, a Session node
   keyed on it would be null for the bulk of rows. The `@hypaware/ai-gateway-graph`
   contract's `Session` node/edges and the `@hypaware/context-graph-enrich`
   `anchor_key_column` both select `session_id`.

## Breaking

The partition key moved from `conversation_id` to `session_id`, and
`SCHEMA_VERSION` bumps (`6`). On-disk partition paths are keyed by the
partition label, bumped `proxy_messages_v4` → `proxy_messages_v5` so a
recreated cache writes to a fresh path (the legacy v4 spool is still listed so
any pending v4 rows flush). Upgrading requires:

- **Recreate the cache** (the partition spec changed; the export drift guard
  rejects a partition-spec change in place, LLP 0022 §Drift rejection).
- **Backfill** to repopulate `session_id` from the local transcripts/rollouts.

Do **not** bundle this with an additive (nullable-column) schema change. Those
evolve the cache in place; this one cannot. Shipping them together would force
a recreate where an additive change wanted an in-place evolution, and confuse
the upgrade story.

## Consequences

- Queries can group Codex by session (`session_id`) and still drill into a
  thread (`conversation_id`); Claude sessions partition cleanly.
- `session_id` is non-null everywhere, so it is a safe `GROUP BY` / join key
  and a safe required partition field; `conversation_id` consumers must handle
  null (Claude).
- Backfilled and live rows still converge: both paths stamp `session_id` and
  leave Claude `conversation_id` null, and the fallback-id scope is unchanged,
  so the existing dedup layers (`seenMessages`, the `part_id` scan, compaction)
  keep working across the split.
- LLP 0026's "conversation_id is the session id for Claude" premise is retired:
  the session id lives in `session_id`; Claude `conversation_id` is null. The
  granularity model (message_id := transcript uuid, part expansion) is
  otherwise unchanged.

## References

- [LLP 0016](./0016-ai-gateway.decision.md) — the gateway owns the schema;
  adapters own message shape.
- [LLP 0022](./0022-iceberg-export-partitioning.spec.md) — identity partition
  fields = export sort key; updated so `session_id` leads the clustering.
- [LLP 0023](./0023-context-graph-projection.decision.md) — the graph contract
  whose `Session` node keys on the session container.
- [LLP 0026](./0026-claude-native-granularity.decision.md) — Claude native
  granularity; its conversation_id-as-session premise is updated here.
- Code: `hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js`
  (`AI_GATEWAY_MESSAGE_COLUMNS`, fallback-hash scope),
  `hypaware-core/plugins-workspace/ai-gateway/src/dataset.js` (partition
  fields, `SCHEMA_VERSION`, partition label),
  `hypaware-core/plugins-workspace/claude/src/projector.js` &
  `.../claude/src/backfill.js` & `.../claude/src/settle.js` (session_id set,
  conversation_id null, settle groups by session),
  `hypaware-core/plugins-workspace/codex/src/exchange-projector.js` &
  `.../codex/src/backfill.js` (session_id / conversation_id both set),
  `hypaware-core/plugins-workspace/ai-gateway-graph/src/graph_contract.js` &
  `.../context-graph-enrich/src/config.js` (Session anchors on session_id).
