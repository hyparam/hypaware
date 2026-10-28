# LLP 0285: `is_sidechain` is three-valued, and the Claude live producers never write `false`

**Type:** Issue
**Status:** Draft
**Systems:** Sources, Plugins
**Author:** Phil / Claude
**Date:** 2026-08-19
**Related:** LLP 0026, LLP 0028, LLP 0151, LLP 0252, LLP 0262
**Tracker:** hyparam/hypaware#920 (deferred finding 2 from the PR #895 review rounds)

> `ai_gateway_messages.is_sidechain` is a nullable boolean, and the producers
> disagree about what null means. The Codex producers and the Claude transcript
> backfill write the real boolean, so a main-loop row reads `false`. The two
> Claude live producers (proxy and OTEL) write `true` or nothing, so their
> main-loop rows read null. A consumer writing `where is_sidechain = false`
> silently gets a partial answer: every Claude live main-loop row is dropped
> while the transcript-backfilled ones for the same session survive.

## Observed

Four producers write the column, and they do not agree.

Write `false` for a positively identified main-loop turn:

- Codex live: `codex/src/exchange-projector.js:1195` maps
  `thread_source === 'subagent'`, so a `thread_source` of `user` yields
  `false`.
- Codex backfill: `codex/src/backfill.js:656`, the same mapping.
- Claude transcript backfill: `claude/src/transcripts.js:692` passes
  `row.isSidechain` through whenever it is a boolean, and Claude Code writes
  `isSidechain: false` on main-loop transcript lines.

Never write `false`:

- Claude proxy: `claude/src/projector.js:354` sets `is_sidechain = true` only
  inside `if (agentId)`, where `agentId` comes from the
  `x-claude-code-agent-id` request header.
- Claude OTEL: `claude/src/telemetry/projection.js:191` sets
  `is_sidechain = true` only inside `if (facts.agentName)`, where
  `facts.agentName` comes from the `agent.name` event attribute.

`ai-gateway/src/message_projector.js:992` passes whatever the projection
carries straight to the row, so the projection's absence becomes a null column
value. The consequence is visible in the repo's own gates:
`smoke/flows/gateway_codex_capture.js:291` asserts `is_sidechain === false` on
a Codex main-loop row, and there is no equivalent assertion on either Claude
live path because there is nothing to assert.

## Why

The two Claude live producers only ever see positive evidence of a subagent.
The proxy reads a request header that a subagent's exchange carries and a
main-loop exchange does not; the OTEL listener reads an event attribute with
the same shape. Absence of the marker is not by itself proof of a main-loop
turn: it is equally consistent with an older client that does not send the
marker, a request the header was stripped from, or an event batch that lost
the attribute. Writing `false` on absence would assert something the producer
does not know, which is why both paths were written the way they are.

The transcript path has the opposite situation. Claude Code writes the boolean
into the transcript line itself, so `false` there is a real observation, not an
inference from absence.

LLP 0028 already records that `is_sidechain` is null for about 37 percent
of rows and treats it as an unreliable graph signal, so the tri-state is not
new. What is new is that LLP 0262's field-parity requirement (R1) brings a
second Claude live producer onto the same column, and LLP 0252 turns on the two
Claude live producers' rows being indistinguishable. Any change here has to
move both of them together or it breaks that parity.

## Impact

- A query filtering `where is_sidechain = false` to mean "main loop only"
  returns a subset that depends on which producer captured the session, not on
  what the session was. Mixed-producer history (a session captured live, then
  backfilled from its transcript) can return both shapes for the same session.
- Issue #881's acceptance text asked for `is_sidechain: false` on main-loop
  rows on the OTEL path. PR #895 deliberately did not do that, on the parity
  argument above, so the issue's literal acceptance text and the shipped
  behaviour differ and neither is currently written down as the rule.
- The query guidance the analyst agent and the `hypaware-query` skill hand to
  consumers (`claude/agents/hypaware-analyst.md:35`,
  `claude/skills/hypaware-query/SKILL.md:115`) presents `is_sidechain` as a
  "direct boolean column" to be preferred over JSON probing, with nothing about
  the null arm.

## Decision needed

Two coherent resolutions, and the choice is a change to the shape settled in
LLP 0252 and LLP 0262, so it needs a decision document rather than a drive-by
edit in an unrelated PR.

**Option A: both Claude live producers stamp the boolean.** Define what counts
as a positively identified main-loop turn on each path (for the OTEL path the
candidate is `query_source` present and not naming an agent; for the proxy path
there is no equivalent positive signal today, which is the option's main cost),
and write `false` when that holds. Leaves null to mean "the producer could not
tell", which is what a nullable column should mean. Requires a version floor or
a capability check so an older client's silence is not read as `false`, and it
must land on both Claude live producers in one change to hold LLP 0252 parity.

**Option B: the tri-state is the contract, and the guidance moves.** Record
that `is_sidechain` is true-or-unknown on every live producer, that `false`
only ever comes from a transcript or from Codex, and change the consumer-facing
guidance to `is not true` / `is null` / `is_not_distinct_from` instead of
`= false`. Cheapest, changes no rows, and matches LLP 0028's existing verdict
on the signal. Costs the column its usefulness as a plain boolean filter, and
leaves the Codex and Claude columns meaning different things.

Whichever is chosen, the outputs are the same three: the rule written into a
decision LLP, the `hypaware-analyst` and `hypaware-query` guidance updated to
match, and a test or smoke assertion that pins the chosen shape on the Claude
live paths the way `gateway_codex_capture.js:291` pins it on the Codex path.

## Not in scope

- Whether body-derived gap rows on the OTEL path can carry subagent
  attribution at all. That is a separate empirical question about whether
  `api_request_body` / `api_response_body` events carry `agent.name`, tracked
  as finding 1 on hyparam/hypaware#920.
- `parent_uuid`, `logical_parent_uuid`, `user_type`, and `permission_mode`,
  which LLP 0262 open question 3 settled as null on the OTEL path.
