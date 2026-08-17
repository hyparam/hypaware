# LLP 0245: OTEL telemetry replaces proxy attach for Claude Code

**Type:** RFC
**Status:** Draft
**Systems:** Gateway, Sources, Config, Plugins, Privacy, Observability
**Author:** Phil / Claude
**Date:** 2026-08-17
**Related:** LLP 0231, LLP 0242, LLP 0243, LLP 0244, LLP 0027, LLP 0030, LLP 0032, LLP 0049, LLP 0085, LLP 0103, LLP 0012, LLP 0015
**Tracker:** hyparam/hypaware#798 (implementation spec)
**Spawns (on acceptance):** LLP 0251, LLP 0252, LLP 0253, LLP 0254, LLP 0255,
LLP 0256 (decisions), LLP 0257 (spec). All Draft until this RFC is accepted.

> Claude Code now ships a sanctioned, documented export path for everything the
> proxy intercepts: OTEL telemetry events plus raw API body files
> (`OTEL_LOG_RAW_API_BODIES=file:<dir>`). Attaching via that path needs no CA in
> the keychain, no `HTTPS_PROXY`, no launchd env, and no terminal restart: one
> `env` block written into `~/.claude/settings.json` reaches every session,
> however it is launched. This RFC proposes replacing proxy attach for the
> `claude` client with an OTEL attach, while the gateway proxy remains for every
> other client.

## Context

Proxy-mode capture (LLP 0231, default since LLP 0242 to 0244) exists because
repointing `ANTHROPIC_BASE_URL` broke Remote Control. It works, but it carries
standing costs that are intrinsic to TLS interception, not bugs to fix:

- A machine-local CA trusted in the login keychain (one dialog at attach, a
  `detach --purge` obligation at the end of life).
- `HTTPS_PROXY` plus `NODE_USE_SYSTEM_CA` in the launchd env, which never
  reaches new windows of an already-running terminal app; a full quit and
  reopen is required and is undetectable from our side (LLP 0231 run G
  finding).
- The daemon sits on the wire for every request: if it is down or wedged,
  Claude Code's traffic is affected, not just our capture.
- The capture depends on Claude Code not changing its proxy and CA handling,
  which is behavior we consume but Anthropic does not promise us.

Meanwhile Claude Code's telemetry system (docs: `monitoring-usage.md`) grew the
missing piece: raw request and response bodies, exportable untruncated to local
files, alongside an event stream that carries identity, cost, and behavioral
data the wire never shows.

Sequencing (settled 2026-08-17): PR #794 shipped the proxy default as a
stopgap. If this RFC succeeds, OTEL attach is the successor migration for the
`claude` client in a later release; LLP 0244's migration machinery gets an
`Extended-by:` forward ref on acceptance, not a revert.

### What was validated before this was proposed

Spike run 2026-08-17 on Claude Code 2.1.233, one real session captured
simultaneously by the proxy (control) and by a scratch OTLP http/json listener
plus body-file spool (candidate):

- Events observed: `user_prompt`, `assistant_response`, `api_request`,
  `api_request_body`, `api_response_body`, `tool_decision`, `tool_result`,
  `permission_mode_changed`, `mcp_server_connection`, `plugin_loaded`, and
  (beyond the docs) `hook_registered`, `hook_execution_start`,
  `hook_execution_complete`.
- Every event carried `session.id`, `prompt.id`, `user.email`,
  `organization.id`, `user.account_uuid`, `terminal.type`, `app.version`,
  `app.entrypoint`; content events carried full prompt text, full response
  text, and full `tool_input` JSON (with `OTEL_LOG_USER_PROMPTS`,
  `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS` set).
- Body files held the complete request JSON: 4 system blocks, 12 tool
  definitions, full message history, and `metadata.user_id` embedding
  session id, account uuid, and device id. About 145 KB per request for a
  trivial session (system prompt and tool definitions dominate).
- Thinking parity: the response body carries thinking blocks as
  `"thinking":"<REDACTED>"` with the signature kept. The proxy control capture
  of the same session stored its 2 reasoning parts with empty text. The wire
  no longer carries thinking either (checked across August: 7201 of 7201
  captured Claude reasoning parts are empty). Neither path loses anything the
  other has.
- `workspace.host_paths` did NOT appear on any event, so cwd and git identity
  do not come from event attributes on a plain local session.

## Requirements

- **R1 Field parity.** Every `ai_gateway_messages` column populated by the
  proxy path today is populated by the OTEL path, from events, body files, or
  the retained SessionStart hook. See the parity table below.
- **R2 More when useful.** Net-new data with clear report or graph value is
  captured, not discarded: tool accept/reject decisions with their source,
  permission mode changes, active time, per-request USD cost, lines of code,
  commit and PR counts, user email and org id, terminal type, hook execution,
  MCP server health, refusals.
- **R3 Storage must not explode.** Steady-state Iceberg growth stays at or
  below the proxy path's (the local all-history table is 182 MB today; August
  is 45,200 rows). The transient body-file spool is bounded by a hard cap with
  oldest-first eviction; eviction degrades to transcript backfill, never to
  unbounded disk.
- **R4 Privacy seams hold.** `.hypignore` and the machine-local list (LLP
  0049, 0103), local-only withholding, `hyp purge`, and per-session ignore all
  keep working. The policy check runs inline at ingest with cwd in hand; the
  fail-open window LLP 0085 patches must not reappear. Settled 2026-08-17:
  transient spool presence of a to-be-dropped session's bodies is acceptable
  (the same content already sits in `~/.claude/projects` transcripts), with
  three duties: the spool lives under hyp-home with owner-only permissions,
  ingest DELETES (never merely skips) the bodies of ignored or policy-dropped
  sessions, and `hyp purge` and detach both sweep the spool.
- **R5 Attach is one reversible write.** `hyp attach claude` merges keys into
  the `env` block of `~/.claude/settings.json`; detach removes exactly those
  keys. No PATH shim, no corporate launcher, no keychain, no launchd env, no
  terminal restart.
- **R6 Remote Control untouched.** The base URL is never repointed and no
  proxy is set, so the first-party predicate holds trivially. The override
  keys LLP 0231 documents are not needed.

## Proposal

### Injection

Attach writes into `~/.claude/settings.json`:

```
"env": {
  "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
  "OTEL_LOGS_EXPORTER": "otlp",
  "OTEL_METRICS_EXPORTER": "otlp",
  "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
  "OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:<listener-port>",
  "OTEL_LOG_USER_PROMPTS": "1",
  "OTEL_LOG_ASSISTANT_RESPONSES": "1",
  "OTEL_LOG_TOOL_DETAILS": "1",
  "OTEL_LOG_RAW_API_BODIES": "file:<hyp-home>/spool/claude-bodies",
  ...
}
```

Settings `env` overrides the shell environment at startup and reaches every
session regardless of launch path (terminal, desktop-spawned, SDK, background
service), which is strictly broader than the PATH-shim idea and does not need
the corporate launcher (`CLAUDE_CODE_PROCESS_WRAPPER`); that mechanism wraps
processes, which we do not need for env injection. Fleets can deliver the same
block via managed settings, with the documented approval dialog.

### Capture

A new listener source (home: the `@hypaware/claude` plugin, since the payload
shapes are Claude Code's, with the OTLP endpoint itself possibly shared
kernel machinery) receives the event stream and tails the body spool:

- **Events first.** The event stream is naturally incremental: each piece of
  content is emitted exactly once (`user_prompt` once, `assistant_response`
  once, `tool_result` once), so it arrives pre-deduplicated.
- **Bodies for what events lack.** `system_text`, the `tools` list, message
  ordering, and untruncated tool args come from the body files referenced by
  `api_request_body.body_ref`. A body file is projected and then deleted.
- **Projection unchanged.** The source yields the same
  `ai_gateway.projected_exchange` values backfill providers yield today; the
  dataset, `part_id` dedupe, partitioning (LLP 0030), and repo identity
  columns (LLP 0032) are untouched. OTEL is a third producer, not a new table.
- **Behavioral events** (`tool_decision`, `permission_mode_changed`, hook
  execution, MCP health, and the metrics) land in their own dataset(s), not
  crammed into `ai_gateway_messages`. Shape is an open question below.

### Enrichment shrinks

Native `message.uuid` on events kills the identity race the flush-time
settlement enricher exists for (LLP 0027). The `.hypignore` check moves inline
to ingest with cwd known (R4), retiring the late-drop machinery of LLP 0085 on
this path. What survives: transcript backfill as the recovery path, and the
SessionStart hook as the source of cwd and git identity (`git_remote`,
`head_sha`, `git_branch`), since events do not carry them (spike finding) and
deriving them from body system text is parseable but fragile.

### Storage budget (R3)

- Iceberg: identical mechanics to today. Request bodies repeat the full
  history each turn, exactly as the proxied wire does, and the same `part_id`
  dedupe stores each part once. Events reduce pressure further because they
  never repeat content at all.
- Spool: bodies are large transiently (about 145 KB per request measured, so
  a heavy day can pass gigabytes through the directory) but are deleted on
  projection. The daemon enforces a byte cap with oldest-first eviction for
  the daemon-down window; evicted bodies are recovered later from transcript
  backfill. The cap is a config value with a sane default (proposal: 512 MB).

### Migration

`hyp attach claude` on a proxy-attached machine removes the proxy env keys,
unwinds launchd env, offers `detach --purge` for the CA trust, and writes the
OTEL env block. Sessions started before the flip keep proxying until restart;
capture overlap is harmless because both producers dedupe into the same rows.
The gateway proxy remains fully supported for codex, claude-desktop, openclaw,
hermes, and raw SDK traffic: this RFC narrows the proxy's client list, it does
not retire the gateway.

## Field parity (R1)

| Column(s) | OTEL source |
| --- | --- |
| `session_id`, `message_id`, `provider_uuid`, `request_id`, `prompt_id` | event attributes (`session.id`, `message.uuid`, `request_id`, `prompt.id`) |
| `model`, `role`, `content_text`, `part_*` | events + body messages |
| `system_text`, `tools` | body files |
| `tool_name`, `tool_call_id`, `tool_args`, `tool_result_for` | `tool_result` events + body blocks |
| usage tokens, `attributes.usage` | `api_request` events (plus body `usage`) |
| `cwd`, `git_branch`, `git_remote`, `head_sha`, `repo_root` | SessionStart hook (unchanged) |
| `client_version`, `entrypoint` | `app.version`, `app.entrypoint` (today: enrichment) |
| `user_id` | `user.account_uuid` / body `metadata.user_id` |
| `is_sidechain`, `agent_id` | `query_source`, `agent.name` (today: transcript inference) |
| `parent_uuid`, `logical_parent_uuid`, `user_type`, `permission_mode` | transcript join only, if retained (open question 3) |
| `thinking_signature` | body thinking blocks (text redacted both paths) |
| `raw_frame` | body excerpt at projection, same policy as today |

Net-new (R2): everything listed in R2, none of it visible on the wire.

## Alternatives considered

- **Keep proxy attach, add OTEL alongside.** Captures the same content twice
  and keeps every proxy cost. The behavioral event stream is worth ingesting
  regardless, but content capture does not need two producers.
- **PATH shim plus corporate launcher.** The docs' own pattern for process
  wrapping, but strictly more moving parts than the settings `env` block for
  env injection, with worse coverage (shim misses GUI launches; launcher
  misses plain terminal sessions by design).
- **Events only, no body files.** Cleanest storage story, but loses
  `system_text`, the `tools` list, and untruncated tool args
  (`tool_input` in events clips values at 512 chars, about 4 KB total).
  Revisit if `CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH` plus future event
  coverage closes those gaps.

## Open questions

1. **Delivery guarantees: resolved 2026-08-17.** Best-effort delivery is
   accepted. Content loss has a recovery path (spool survives a down daemon;
   transcript backfill covers the rest, as it already does for pre-attach
   history); behavioral-event loss during daemon downtime is tolerated.
   Duty: `hyp status` grows a capture-health line (last event seen vs last
   transcript activity) so silent gaps are visible instead of discovered at
   report time.
2. **Behavioral dataset shape: resolved 2026-08-17.** A new
   `claude_telemetry_events` dataset owned by `@hypaware/claude`: one row per
   event, typed columns for the hot fields (event name, session_id,
   tool_name, decision, source, cost), attributes JSON for the rest. Not
   routed through `@hypaware/otel`'s generic logs/metrics datasets, and not
   widened into `ai_gateway_messages`.
3. **Parent chains: resolved 2026-08-17.** Code survey found no consumer of
   `parent_uuid` / `logical_parent_uuid` outside their producers, and no graph
   plugin reads `is_sidechain`. The columns stay in the schema and read null
   on the OTEL path; `query_source` and `agent.name` are the attribution
   source. No transcript join is kept for live capture.
4. **Session ignore: resolved 2026-08-17.** The claude listener hosts the
   same session-ignore control route the gateway proxy hosts, and
   `hyp session ignore` / `unignore` posts to both. Reuses the existing
   in-memory mechanism; no new on-disk contract. (Settled in the
   implementation spec, hyparam/hypaware#798.)
5. **Flag stability (position).** `OTEL_LOG_RAW_API_BODIES` and friends are
   documented but young. Detection is two-layered: the `hyp status`
   capture-health line (open question 1's duty) catches silent field drift in
   production, and a hermetic smoke asserts the event and body shapes against
   the installed Claude Code on every release.
6. **Version floor: resolved 2026-08-17.** Below the floor (>= 2.1.193 for
   the event set, `tool_source` detail at >= 2.1.214), `hyp attach claude`
   REFUSES to switch modes: it leaves any existing attach untouched and
   prints an upgrade hint (`claude update`). No proxy fallback for the
   `claude` client: one attach mode per client keeps the test matrix single,
   and Claude Code self-updates aggressively enough that stale clients are
   transient.

## On acceptance

This RFC stays the deliberation record and spawns six narrow decisions, one per
settled choice: injection mechanism (LLP 0251), events-plus-bodies split
(LLP 0252), spool cap policy (LLP 0253), settlement retirement scope
(LLP 0254), behavioral dataset shape (LLP 0255), and session-ignore transport
(LLP 0256, the choice open question 4 above resolves). It also spawns a spec
for the listener source (LLP 0257). The proxy-attach docs it displaces for the
`claude` client (parts of LLP 0231 to 0244) get `Extended-by:` /
`Superseded-by:` forward refs at that point, not before.
