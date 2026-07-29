# LLP 0143: Codex lineage reads the body's `client_metadata`, not header names

**Type:** Decision
**Status:** Active
**Systems:** Plugins, Sources, Gateway
**Author:** Claude
**Date:** 2026-07-29
**Related:** LLP 0030, LLP 0049, LLP 0050, LLP 0066, LLP 0083, LLP 0141

> The Codex live projector derived a turn's thread, session and parent thread
> from request headers, three of whose names Codex has never emitted, while the
> authoritative ids sat unread in the request body. This names the precedence
> (body map, then turn-metadata blob, then the real compatibility headers), the
> header-name audit, and what happens to rows already recorded.

## Context

`resolveCodexContext` in
[`exchange-projector.js`](../hypaware-core/plugins-workspace/codex/src/exchange-projector.js)
resolved identity from the `x-codex-turn-metadata` header plus a set of bare
header names. Read against Codex's own source
(`codex-rs/core/src/responses_metadata.rs`, `codex-rs/core/src/client.rs`,
`codex-rs/codex-api/src/common.rs`), Codex projects one snapshot,
`CodexResponsesMetadata`, onto **three** surfaces per HTTP request:

| surface | what it carries | when |
| --- | --- | --- |
| body `client_metadata` (flat `string -> string` map, a top-level field of `ResponsesApiRequest`) | `x-codex-installation-id`, `session_id`, `thread_id`, `x-codex-window-id` always; `turn_id`, `x-codex-parent-thread-id`, `parent_turn_id`, `x-openai-subagent` when set; and the whole turn-metadata blob under `x-codex-turn-metadata` | **every** request |
| `x-codex-turn-metadata` (header, and the same-named body entry) | the nested blob: `thread_source`, `sandbox`, `workspaces`, `turn_started_at_unix_ms`, `parent_thread_id`, `forked_from_thread_id` | only when the request kind carries turn metadata; its `session_id`/`thread_id` are omitted for the kinds Codex marks as having no turn identity |
| `compatibility_headers` | exactly `x-codex-window-id`, `x-codex-turn-metadata`, `x-codex-parent-thread-id`, `x-openai-subagent` | as above |

Two consequences the projector was on the wrong side of:

1. **The flat body map is the only surface present for every request.** Codex
   builds it unconditionally in `client_metadata()`. HypAware never read the
   body at all, so identity depended on a surface Codex may legitimately omit.
2. **Three of the header names read were fictional.** `thread-id`,
   `session-id` and `parent-thread-id` are not names any Codex version emits;
   `compatibility_headers` never produces them and the projector matches a full
   header name. They could never supply a right value, and could supply a wrong
   one: any hop or hand-rolled client that happened to set `thread-id` dictated
   `conversation_id`, the value the row's fallback `message_id` is scoped on
   ([LLP 0030](./0030-session-id-partition-key.decision.md)). `parent-thread-id`
   was simply the wrong spelling of the real `x-codex-parent-thread-id`, so
   header-route subagent lineage never resolved at all.

The premise that `x-codex-turn-metadata` is a Codex Desktop signal
([LLP 0083](./0083-codex-live-cwd-from-rollout.decision.md#context),
[LLP 0141](./0141-codex-desktop-rides-the-codex-adapter.decision.md)) is also
false: `compatibility_headers` emits it for every turn regardless of client.
Both docs are corrected alongside this one.

This is the same defect class as the `.hypignore` cwd gap
([LLP 0083](./0083-codex-live-cwd-from-rollout.decision.md)) one layer up:
"identity is available at projection time" was really "identity is available
when the client volunteers it on a version-specific surface".

## Decision

<a id="body-is-authority"></a>**The body's flat `client_metadata` map is the
lineage authority; the turn-metadata blob is the fallback.** `thread_id`,
`session_id`, `turn_id` and the parent thread resolve body-map-first,
blob-second. The two are projections of one snapshot, so they cannot disagree in
real traffic; the body wins because it is the surface that is always there. The
map is only trusted when it carries a Codex-owned key (an `x-codex-*` entry, or
both `session_id` and `thread_id`), so a `client_metadata` from an unrelated
client cannot masquerade as Codex lineage.

The turn-metadata **blob** is still read from the header first and from the body
map second. Both spellings of the blob are byte-equal but for Code Mode tool
names, and header-first is what keeps already-recorded rows bit-identical
([#row-identity](#row-identity)).

<a id="body-is-a-codex-signal"></a>**A Codex-owned `client_metadata` map is
itself sufficient evidence that an exchange is Codex.** The API-key route posts
a generic `/v1/responses` and can carry no Codex-namespaced header, so gating
codex-context resolution on headers would have left the body unread exactly
where it matters most.

<a id="real-header-names"></a>**Only header names Codex actually emits are
read.** The audit of every header this file reads:

| name read | real? | source |
| --- | --- | --- |
| `x-codex-turn-metadata` | yes | `compatibility_headers` |
| `x-codex-window-id` | yes | `compatibility_headers` |
| `x-codex-parent-thread-id` | yes | `compatibility_headers` (was misspelled `parent-thread-id`) |
| `originator` | yes | `add_originator_header` |
| `user-agent` | yes | the shared default client |
| `x-client-request-id` | yes | `codex-api`'s responses endpoint |
| `x-oai-request-id` (response) | yes | the service |
| ~~`thread-id`~~, ~~`session-id`~~, ~~`parent-thread-id`~~ | **no** | nothing emits them; removed |

`x-openai-subagent` is real and still **unread**. Adopting it would change what
`is_sidechain` means (its values are Codex's subagent *kinds*: `review`,
`compact`, `memory_consolidation`, `collab_spawn`), which is a separate
decision from where lineage is read. `forked_from_thread_id`, likewise present
in the blob and unread, would need a column.

<a id="lineage-source"></a>**The surface that stated the identity is recorded**
as `attributes.codex.lineage_source` (`body_client_metadata` |
`turn_metadata`, absent when nothing stated one). A future Codex version that
stops filling a surface then shows up as a queryable shift rather than as a
silent drift in `conversation_id`.

<a id="row-identity"></a>**Already-recorded rows are left alone. No backfill.**
Nothing re-keys, because for every shape HypAware already resolved an identity
from, the new precedence returns the same string:

- The blob's `thread_id` and the body map's `thread_id` are the same field of
  the same snapshot, so a row that resolved a thread from the blob resolves the
  identical thread from the body.
- The three removed header names never matched real Codex traffic, so no
  recorded Codex row was keyed on them.
- `conversation_id` therefore does not move for existing shapes, and neither do
  the `message_id` / `part_id` values scoped on it
  ([LLP 0030](./0030-session-id-partition-key.decision.md)). A test pins the
  literal ids captured from the pre-change projector.

What **does** change is coverage: turns that stated identity only in the body
were previously keyed on the gateway's content hash, and are now keyed on the
real thread. Those rows are not rewritten. They were never joinable to a thread
in the first place, so leaving them costs nothing a backfill would recover, and
a backfill would have to re-key rows the partition spec clusters on
(LLP 0030 §Breaking) for no query anyone can express today. If that history is
wanted, `hyp backfill codex` already re-imports the same conversations from the
rollout tree, keyed on the rollout's session id.

## Consequences

- `.hypignore` coverage improves for real traffic: the rollout-cwd fallback
  ([LLP 0083](./0083-codex-live-cwd-from-rollout.decision.md)) is keyed on the
  Codex session id, which on the subscription route previously had to come from
  a header Codex never sends. It now comes from the body.
- Session opt-out ([LLP 0066](./0066-session-opt-out.spec.md)) keys on the same
  stamped `session_id`, so it gains the same coverage.
- `parent_thread_id` and `is_sidechain` stop depending on the blob alone for the
  parent id; `is_sidechain` still derives only from the blob's `thread_source`,
  so a turn with no blob records a parent with `is_sidechain` unset. Tightening
  that needs the `x-openai-subagent` decision above.
- The Codex-source facts here are a snapshot of an upstream HypAware does not
  control. The mitigation is `lineage_source` plus the acceptance check in
  [`docs/ACCEPTANCE.md`](../docs/ACCEPTANCE.md), not a pinned literal.

## References

- Code: `hypaware-core/plugins-workspace/codex/src/exchange-projector.js`
  (`readCodexClientMetadata`, `readCodexTurnMetadata`, `resolveCodexContext`,
  `resolveConversationId`, `isCodexExchange`).
- Tests: `test/plugins/codex-exchange-projector.test.js` (lineage surfaces),
  `test/plugins/codex-rollout-cwd.test.js` (subscription-route fixtures).
- Fixture: `hypaware-core/smoke/flows/gateway_codex_capture.js`.
- [LLP 0030](./0030-session-id-partition-key.decision.md) - `session_id` is the
  partition key; `conversation_id ?? session_id` is the fallback-hash scope.
- [LLP 0083](./0083-codex-live-cwd-from-rollout.decision.md) - the cwd half of
  the same "only when the client volunteers it" assumption.
- [LLP 0141](./0141-codex-desktop-rides-the-codex-adapter.decision.md) - one
  Codex adapter covers CLI and Desktop; its turn-metadata premise is corrected.
