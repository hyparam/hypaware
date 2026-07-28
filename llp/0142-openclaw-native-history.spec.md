# LLP 0142: OpenClaw native session history

**Type:** Spec
**Status:** Active
**Systems:** Plugins, Gateway, Cache
**Author:** neutral (escalated from issue #423)
**Date:** 2026-07-28
**Related:** LLP 0109, LLP 0037, LLP 0027, LLP 0035
**Generated-by:** neutral

> OpenClaw work must be recorded from its own on-disk session history, not only
> from the subset of traffic that happens to pass through the gateway, and live
> gateway rows must carry native OpenClaw identity rather than a system-prompt
> hash. Escalated from GitHub issue #423, whose scope is a new backfill provider
> plus a settlement design, not a localized bug.

## Problem

The OpenClaw adapter records routed Anthropic API exchanges, and those rows do
not reliably represent the work performed in OpenClaw. Two distinct defects,
both verified against `origin/master@6a64273`:

**1. Most OpenClaw usage is never recorded at all.** `attach()` reroutes only an
`anthropic/*` primary, hard-refusing anything else with `NON_ANTHROPIC_PRIMARY`
(`hypaware-core/plugins-workspace/openclaw/src/settings.js:161`), and it
repoints only `agents.defaults.model.primary`. OpenAI, local-model, and
non-primary-slot OpenClaw traffic therefore never reaches the gateway and is
invisible. The native session files record `provider` / `modelId` / `modelApi`
for every session regardless of routing, so they are the only route by which
that work can be captured.

**2. The rows that do exist lack identity and workspace context.**
`openclawSessionId()` (`.../openclaw/src/projector.js`) derives `session_id` by
hashing the first `SESSION_HASH_HEAD_CHARS` of the system prompt, so separate
conversations sharing an agent prompt collapse into one synthetic session. Native
message ancestry, `cwd`, `repo_root`, `git_branch`, and agent identity are left
unset, so reports and the activity graph see token traffic without enough
context to attribute the work.

The adapter reads none of the native history that would fix either: `activate()`
registers a config section and an upstream preset but no backfill provider, and
`config.js` says so outright in its own header comment ("there is no `backfill`
block: the plugin registers no backfill provider"). [LLP 0109](./0109-openclaw-client-adapter.decision.md)
leaves this as an explicit open question.

## Why this is a design, not a fix

Issue #423 was filed as a bug and is an architectural change on three counts:

- **A new backfill provider** must be designed against the Claude and Codex
  provider contracts and the `src/core/backfill/` surface, parsing two parallel
  per-session formats (`<sessionId>.jsonl` and the richer
  `<sessionId>.trajectory.jsonl`) defensively across OpenClaw versions.
- **Live settlement needs a join design.** The issue establishes that the
  Anthropic response message id (`msg_...`) is persisted in both native files
  and is already visible to the gateway, so an exact provider-issued join key
  exists. Choosing settlement-on-write versus a settlement pass in the shape of
  the Claude transcript enricher ([LLP 0027](./0027-cache-settlement.decision.md))
  is a design decision, and it revises LLP 0109's open question rather than
  patching around it.
- **New config surface.** `openclaw.backfill.{on_join,window_days}` must follow
  the on-join contract in [LLP 0037](./0037-backfill-on-join.decision.md),
  which is a documented cross-plugin decision, not a local validator tweak.

## Constraints the design must respect

- **The system-prompt hash cannot be retro-keyed.** When the system prompt
  exceeds the trajectory field-size limit the text is dropped entirely and
  replaced by a `{"truncated": true, "reason": "trajectory-field-size-limit"}`
  stub with no retained prefix, so `openclawSessionId()`'s hash cannot be
  recomputed from disk. The issue reports this as the normal case (a ~40k-char
  prompt against a 32,768-char limit), not an edge case. Any settlement design
  keyed on the existing hash is a dead end; the `msg_...` id is the key.
- **Token usage maps onto the existing normalized names** from
  [LLP 0035](./0035-token-usage-normalization.decision.md):
  `input`/`output`/`cacheRead`/`cacheWrite` to
  `input_tokens`/`output_tokens`/`cache_read_tokens`/`cache_write_tokens`.
- **Capture-seam resolution becomes possible here.** Native records carry `cwd`
  and `workspaceDir`, which the live gateway route structurally cannot supply
  (OpenClaw forwards no cwd channel), so policy filtering must be applied on the
  backfill path consistently with Claude and Codex.
- **Probe sessions are not user work.** `probe-anthropic-<uuid>` and
  `probe-claude-cli-<uuid>` entries appear in the sessions directory and must be
  excluded.

## Acceptance

- `hyp backfill openclaw` imports native OpenClaw sessions into
  `ai_gateway_messages`, from fixtures and from real-format history.
- Two conversations sharing one system prompt remain distinct sessions.
- Sessions from non-Anthropic providers and non-primary model slots, which never
  reach the gateway, are imported.
- Imported rows expose the workspace context reports and the activity graph use.
- Backfill is deterministic and idempotent across reruns, via the existing
  materializer/dedup contracts.
- Ignored and private sessions are not imported, and the policy decision is
  observable in structured logs.
- `openclaw.backfill.on_join` defaults and completion markers follow LLP 0037.
- Newly captured live traffic is enriched with native identity and workspace
  context without a manual backfill, joined on the `msg_...` provider message id.
- Probe sessions are excluded.
- Tests cover malformed and truncated JSONL, truncated `systemPrompt` stubs,
  multiple agents, tool calls and results, usage, time windows, ignored
  workspaces, a populated `agent/models.json`, and duplicate reruns.
- A hermetic smoke proves native history reaches `ai_gateway_messages`, and a
  written acceptance procedure exercises the packaged CLI against a real or
  path-faithful OpenClaw install.
- LLP 0109's open question is replaced by the chosen design.

## Origin

Escalated by the neutral reconciler from GitHub issue
[#423](https://github.com/hyparam/hypaware/issues/423). The issue carries a
verified on-disk format survey (OpenClaw `2026.7.1-2`, macOS, node 26.5.0,
schema only) that the design should be read alongside; it is the primary source
for the record shapes summarized above. The work re-enters the pipeline family
as a request rather than the maintenance family as a fix, because no
test-provable localized fix exists ahead of the backfill-provider and
settlement-join decisions.
