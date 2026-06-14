# LLP 0026: Claude native transcript granularity for ai_gateway_messages

**Type:** Decision
**Status:** Draft
**Systems:** Gateway, Plugins
**Author:** Brendan / Claude
**Date:** 2026-06-12
**Related:** LLP 0012, LLP 0016

## Summary

For Claude traffic, `message_id` in `ai_gateway_messages` is defined as the
**Claude Code transcript line uuid** — the native DAG node — and the live
gateway projector decomposes each wire message into those units before
projection. The wire's message framing (which blocks were batched into one
HTTP body) is recorded as a grouping attribute, never as identity. This makes
live-captured and backfilled rows structurally identical for the same
conversation, which is what lets every dedup layer (`seenMessages`, the
backfill `part_id` scan, compaction) actually work.

## Context

`ai_gateway_messages` is fed by two paths: live gateway capture (proxying
Anthropic API traffic) and the `@hypaware/claude` backfill (importing on-disk
JSONL transcripts). The schema has a two-level hierarchy
(`message_id` → `part_id = <message_id>#<part_index>`), but Claude's reality
has three levels:

1. **API message** — the wire unit: one request/response message whose
   `content` is an array of blocks.
2. **Transcript line / DAG node** — the uuid unit. Claude Code writes one
   JSONL line per assistant content block and one line per user tool_result,
   each with its own `uuid`, chained by `parentUuid`. Plain user prompts are
   one line per logical message. Empirically (June 2026, ~14k user lines and
   all assistant lines across every local transcript), **every current
   transcript line is single-block**.
3. **Content block** — the part unit.

The two paths mapped these levels onto the schema differently. Backfill put
the uuid (level 2) in `message_id`. Live capture put the API message
(level 1) there — with fallback hash identity when transcript matching
failed, which for multi-block messages was always, because a content key over
a full block array can never equal a single-block line's key. The same column
held two granularities, `part_id`s never converged, and the table accumulated
~86k duplicate rows (live fallback copies alongside backfill uuid copies —
the visible symptom being subagent messages present twice, once with
`is_sidechain = null` and once with `is_sidechain = true`).

The transcript uuid is not merely a label: it is the **referent** of
`parentUuid`, `logicalParentUuid`, and `sourceToolAssistantUUID` (agent
lineage). Each assistant line repeats the full API message envelope
(`message.id`, `model`, `usage`, `stop_reason`) with only `content` split, so
group membership is explicit (shared `message.id` / `requestId`) but group
cardinality is recorded nowhere — a group is only knowably complete once the
next turn begins. Subagent exchanges carry an `x-claude-code-agent-id`
request header naming the agent transcript file
(`<session>/subagents/agent-<id>.jsonl`).

## Options considered

**A. Split wire messages to transcript granularity (chosen).** The Claude
adapter decomposes each wire message into the transcript's units before
handing the projection to the gateway. Reference-preserving: every uuid stays
addressable; the API grouping is recoverable losslessly via the shared
`message.id`. Matches what backfill already produces, so no migration.
Requires no knowledge of group completeness — each line stands alone, so the
transcript-write race can only delay enrichment of individual blocks, never
poison a whole turn.

**B. Merge transcript lines up to wire messages (rejected).** Backfill would
group lines by API `message.id` and collapse them to one multi-part message.
Reference-destroying: one uuid survives as `message_id` and every pointer to
the absorbed uuids (`parentUuid` of the next turn, `source_tool_assistant_uuid`
into a tool_use line) dangles unless globally rewritten — and the rewrite
must be computed identically by live capture mid-stream against a
still-growing file. Breaks the backfill's documented native-identity-verbatim
contract and 1:1 traceability to transcript lines.

**C. Map uuid to `part_id`, keep the wire message as `message_id`
(rejected).** Information-equivalent to A (a relabeling), but: it breaks the
recomposable `part_id = <message_id>#<part_index>` contract the dedup layers
rely on; it moves the DAG's edges to part level, leaving "message" a unit
nothing references; it requires migrating all historical backfill rows; and
user tool_result batches have no API message id, so backfill would have to
*infer* the wire grouping — option B's completeness problem smuggled back in.

## Decision

1. **`message_id` := transcript line uuid** wherever a transcript line
   exists. The wire framing is an attribute (`raw_frame.message_id`,
   `request_id`), never identity. The general rule for any adapter: when a
   provider has a native identity unit, `message_id` is that unit.
2. **The Claude projector decomposes wire messages into transcript units**:
   - *Assistant messages*: one projected message per content block. Match a
     block to its line via the API `message.id` group (ordered list — the
     index must keep all lines per message id, not last-wins) aligned by
     block order with a type check, falling back to a per-block content key.
   - *User tool_result messages*: one projected message per `tool_result`
     block, matched by `tool_use_id` — a unique join key present identically
     on both sides.
   - *User prompt messages*: whole-message, matched by content key after
     stripping wire-injected blocks. When matched, the projected content is
     the **transcript's** content (the logical message); wire-injected
     extras (`<system-reminder>` text blocks the harness adds at
     request-build time) are projected as a separate fallback message marked
     `attributes.claude.wire_only = true`. Without canonicalization, live
     `uuid#0` (a reminder) would collide with backfill `uuid#0` (the prompt).
   - Identity computations ignore volatile/channel-specific fields:
     `cache_control` (wire-only, breakpoint moves between exchanges) and
     `caller` (transcript-only annotation on tool_use blocks).
3. **Unmatched wire messages keep wire granularity** — assistant messages
   still split per block (per-block fallback hashes make the eventual uuid
   reconciliation a 1:1 id upgrade), but content is the wire's view. Plain
   API traffic (non-Claude-Code SDK callers) has no transcript and projects
   the same way.
4. **`agent_id` is a first-class column** (schema_version 5): the subagent
   id from the transcript entry's `agentId` and/or the
   `x-claude-code-agent-id` request header, which also stamps
   `is_sidechain = true` even when transcript matching misses (and may be
   used to scope matching to that agent's lines). Null for main-loop
   traffic and for providers without a subagent concept (Codex, for now).
5. **`part_index` stays.** For transcript-matched Claude rows it is
   degenerately 0; it carries real structure for wire-grained rows, other
   providers (Codex max observed 2, raw API max 4), and legacy multi-block
   backfill rows (max 4). Retiring it would be a deliberate `schema_version`
   bump, not a side effect.

## Consequences

- Live and backfilled rows for the same conversation share
  `message_id`/`part_id` structure, so the existing dedup layers converge:
  the backfill pre-write scan recognizes live rows and vice versa.
- "Message" in this table means *DAG node*, not *API message*. Counting
  messages per turn yields more rows than before for live Claude data
  (matching what backfill already produced).
- The API message envelope (`usage`, `stop_reason`, `model`) is duplicated
  across a group's rows, mirroring the transcript. **Consumers summing token
  usage must dedupe by API message id, not by row.**
- `stop_reason`-derived `status.finish_reason` lands on the last block's
  message of a group.
- Remaining known gaps (out of scope here): durable live dedup across daemon
  restarts (seed the seen-set from committed `part_id`s), and id-upgrade
  reconciliation when a fallback row's uuid arrives later.

## Open questions

- Should the API message id be promoted from `raw_frame.message_id` to a
  first-class `api_message_id` column so the wire view is a cheap group-by?
  (Leaning yes; requires a schema addition.)
- Whether the fallback `previous_message_id` full-history chain should be
  capped — it grows quadratically over a conversation and the split
  multiplies rows carrying it.
- Whether Codex has an analogous native-granularity source worth adopting.

## References

- [LLP 0012](./0012-sources.spec.md) — sources (live + backfill paths)
- [LLP 0016](./0016-ai-gateway.decision.md) — gateway owns the schema;
  adapters own message shape
- `hypaware-core/plugins-workspace/claude/src/projector.js` — the splitter
- `hypaware-core/plugins-workspace/claude/src/transcripts.js` — line index
- `hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js` —
  row expansion and fallback identity
