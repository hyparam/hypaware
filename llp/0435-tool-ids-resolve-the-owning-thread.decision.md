# LLP 0435: A body-derived tool row resolves its thread by tool id, and the matched line arbitrates attribution

**Type:** Decision
**Status:** Accepted
**Systems:** Gateway, Sources, Cache, Plugins
**Author:** Phil / Claude
**Date:** 2026-09-25
**Related:** LLP 0026 (#decision points 2, 4 and 5), LLP 0027, LLP 0133,
LLP 0389 (the consequence retired here), LLP 0390
**Tracker:** hyparam/hypaware#2143

> LLP 0389 settled that a body-derived row carries the LLP 0027 match-key and
> settles onto its transcript line's uuid, and recorded as a standing
> consequence that a subagent's never would: the OTEL event labels the row from
> `agent.name` while the transcript scopes by `agentId`, so the agent-scoped
> content key can never meet its line. That consequence is retired here. A tool
> block already carries a join key unique across the session and identical on
> both sides, so settlement resolves the owning thread by tool id first and
> keeps the agent-scoped content key as the fallback. Once a line is known and
> that line knows the thread, the LINE arbitrates `agent_id` and
> `is_sidechain`, not the event.

## Context

LLP 0026 #decision point 2 already joins a user tool_result message to its
transcript line by `tool_use_id`, "a unique join key present identically on
both sides". Settlement did not use it. It had only the agent-scoped content
key of LLP 0027, whose scope term is the row's own `agent_id`.

On the OTEL path that term is wrong by construction. `agent.name` is the
subagent's TYPE (`general-purpose`), shared by every subagent of that type in a
session, while the transcript's `agentId` is per-spawn. The scoped key
therefore never matched, so:

- every subagent tool call and tool result kept its gateway fallback id and
  stood as a second row beside the transcript sweep's copy of the same block,
  which is the LLP 0389 duplicate made permanent for sidechains
- two same-name subagents in one session were indistinguishable, so nothing
  downstream could place a tool call in the conversation that made it
- `claude.spawned_by_tool_use_id` could not be recovered for a row whose event
  carried no `agent.name` at all, because the sidecar lookup keys on `agent_id`

## Decision

### The tool id resolves the thread, the content key remains the fallback {#tool-id-first}

**A body-derived row whose block carries a tool id settles against the entry
that id names, ahead of the agent-scoped content key.** Calls and results are
indexed separately (`byToolCallId` on an assistant `tool_use` /
`server_tool_use` block id, the existing `byToolUseId` on a user
`tool_result`), so each side keeps its own native uuid and a call can settle
before its result exists.

Two conditions bound the lookup.

The entry must hold exactly ONE content block. A body-derived row is always
`part_index` 0 (each gap block is projected as its own message), so it can
claim `<uuid>#0` and nothing else. A legacy multi-block line owns
`<uuid>#0..n`, and a standalone block cannot say which, so those lines stay on
the content path. This is LLP 0026 #decision point 5's `part_index` contract
read from the settlement side.

The entry must carry a `provider_uuid`. A tool id that names a uuid-less line
knows LESS than the content key, so it falls through rather than standing as a
match the uuid guard then rejects, which would strand the row on its fallback
id for good.

### The matched line arbitrates attribution, but only when it knows the thread {#line-arbitrates}

**When the tool id names a line, that line's `agent_id` and `is_sidechain`
replace the row's labels, including by clearing them.** LLP 0026 #decision
point 4 lets the agent header stamp `is_sidechain = true` "even when transcript
matching misses". It misses no longer, and a miss was the premise: a request
body replays history, so a parent's spawn call can appear inside a subagent's
body and carry that body's `agent.name` while belonging to the main loop.
Deciding attribution from the event there would move a main-loop tool call into
a sidechain.

**A line that claims `isSidechain: true` while naming no `agentId` is the
exception, and keeps the row's `agent_id`.** `conversation_source =
'claude_code'` is the `claude-cli` User-Agent, not an OTEL marker, so the live
proxy lane's fallback rows reach this path too, and there `agent_id` is the
authoritative `x-claude-code-agent-id` request header rather than a provisional
`agent.name`. Such a line knows less than the header, and clearing the column
would also drop the row's `spawned_by_tool_use_id` late-stamp, whose lookup
keys on `agent_id`. The row still gains the line's native identity and its
`is_sidechain` (which `assignTranscriptIdentity` copies before this guard is
reached, and which such a row already carried as `true`); only the `agent_id`
is left as it was.

Attribution is resolved on the tool-id path only. A content-key match is
agent-scoped, so it can only have matched a line of the thread the row already
claimed, and re-deciding from it would say nothing new.

Provenance follows ownership, so the `agent-<id>.meta.json` sidecar is read
AFTER identity settles rather than before: a tool-id match can reveal a
sidechain whose event named no agent, and that row wants its
`spawned_by_tool_use_id` too. The load stays at most once per session and keeps
the LLP 0133 #attribution container roots.

## Consequences

- LLP 0389's closing Consequences bullet is retired. A subagent's body-derived
  tool rows now do reach their transcript line, so they collapse onto the
  sweep's copy instead of standing beside it.
- Rows already committed under a fallback id are not repaired by this decision.
  A row still carrying its match-key is re-settled by the LLP 0027 re-settle
  sweep while its transcript survives. A row whose marker is spent, or which
  has already been exported, needs a separate repair migration, out of scope
  here.
- Nothing mis-attributed is being corrected, only un-settled rows recovered:
  the content key folds in the tool id (it is not a `VOLATILE_BLOCK_FIELDS`
  strip), so the pre-fix scoped lookup missed rather than matched the wrong
  line.
- `previous_message_id` is NOT recomputed. Its chain is built at projection
  time over `(conversation_id ?? session_id, agent_id)`, so two same-name
  subagents now get distinct correct `agent_id`s while their chain pointers
  still come from the single merged label. Thread linkage across those two
  agents is no worse than the fallback-id rows it replaces, but it is not yet
  right, and a chain rebuild is its own change.
- Event-derived rows (`user_prompt`, `assistant_response`) are untouched: they
  carry no match-key and never enter this path.
- A tool id appearing on two loaded transcript lines resolves to the later one
  by timestamp, because the index is last-wins as `byToolUseId` already was.
  Claude mints tool ids per call, so that is a corruption case, not a shape.
- Cost is one additional map per indexing pass, linear in the session's tool
  calls, with constant-time per-row lookups. A tool-id hit also skips the
  content key's per-row string build, so the settled path allocates less than
  before.
