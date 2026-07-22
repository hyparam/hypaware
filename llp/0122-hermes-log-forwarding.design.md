# LLP 0122: hermes log forwarding - technical design

**Type:** Design
**Status:** Active
**Systems:** Sources, Plugins
**Author:** Phil / Claude
**Date:** 2026-07-20
**Related:** LLP 0118, LLP 0119, LLP 0120, LLP 0121, LLP 0124, LLP 0125, LLP 0012, LLP 0026, LLP 0035, LLP 0049, LLP 0050

> Buildable design for the `@hypaware/hermes` client adapter.
> `@ref LLP 0118 [implements]`: realizes the hermes-log-forwarding spec.
> `@ref LLP 0119 [constrained-by]`: capture pulls read-only from
> `~/.hermes/state.db`; hermes is never modified or proxied.
> `@ref LLP 0120 [constrained-by]`: rows materialize into
> `ai_gateway_messages` via `ai_gateway.projected_exchange`; the adapter owns
> no dataset.
> `@ref LLP 0121 [constrained-by]`: bundled plugin, single pre-bundled
> entrypoint, no runtime dependency install.
> `@ref LLP 0124 [constrained-by]`: channel sessions are stamped with the
> canonical policy scope path; no hermes-specific policy config exists.

## Overview

One new bundled plugin mirroring the claude/codex adapter shape: a SQLite
reader over hermes's `state.db`, a projector from hermes rows to
`AiGatewayProjectedExchange`, a backfill provider for history, and a polling
source for ongoing capture. No gateway, cache-schema, or export changes.

```
hypaware-core/plugins-workspace/hermes/
  hypaware.plugin.json     // manifest
  src/index.js             // activate(): config section, source, backfill
  src/config.js            // [hermes] section validation
  src/state_db.js          // read-only SQLite access + change detection
  src/projector.js         // hermes session/messages -> AiGatewayProjectedExchange
  src/backfill.js          // BackfillContribution (history, --since window)
  src/source.js            // polling StartedSource + watermark
  src/types.d.ts           // HermesSessionRow, HermesMessageRow, watermark types
```

## Manifest

`hypaware.plugin.json` per [LLP 0005](./0005-plugin-manifest.spec.md):
`name: "@hypaware/hermes"`, `requires.plugins: ["@hypaware/ai-gateway"]`
(the materializer is a hard dependency, LLP 0120), and `contributes`:

- `config_sections: ["hermes"]`
- `sources: ["hermes"]`
- no `datasets` (the adapter owns no table)

## Config section {#config}

```toml
[hermes]
# enabled = true            # default: true when state.db exists
# state_db = "~/.hermes/state.db"   # override for profiles/tests
# poll_interval = "60s"     # ongoing-capture lag bound (spec R6)
```

Defaults resolve `state_db` from the hermes home (`~/.hermes/`, the same
resolution hermes's `get_hermes_home()` uses on POSIX). All keys optional; a
missing section means defaults.

## SQLite access {#sqlite}

The reader uses **`node:sqlite`** (`DatabaseSync`, opened with
`{ readOnly: true }`): a builtin, so it satisfies the
[LLP 0008](./0008-plugin-runtime-dependencies.decision.md) no-runtime-deps
rule with zero bundled bytes, and read-only open cannot disturb hermes's WAL
(spec R5). Reads wrap SQLITE_BUSY in a short bounded retry; a persistently
locked store degrades the source status rather than erroring the daemon.

**Runtime floor:** `node:sqlite` exists flag-free from Node 22.5. The repo
`engines` floor moves to `>=22.12`
([LLP 0125](./0125-node-engines-floor-22.decision.md)), so the reader
assumes the builtin. A one-line activation probe turns a missing builtin
(engines warning ignored) into a clear refusal message rather than a crash;
that is an error path, not a supported degraded mode.

Rejected alternatives: `better-sqlite3` (native addon, incompatible with the
prebuilt single-artifact rule), sql.js (a WASM SQLite build bundled into
every install for one adapter), shelling out to the `sqlite3` CLI (an
undeclared external dependency with quoting and portability hazards).

## Change detection and the poll model {#watermark}

Hermes appends messages to open sessions over time, and the cache's pre-write
`part_id` dedupe **drops** already-present rows rather than updating them. The
poll model leans on that:

1. Each tick, the reader asks state.db for sessions that changed since the
   stored mark: `max(messages.id)` advanced, **or** `ended_at` transitioned
   from NULL (one cheap indexed aggregate query).
2. Every changed session is re-projected **whole** into a single
   `AiGatewayProjectedExchange` item, exactly like a claude/codex backfill
   item. The materializer expands it to rows; dedupe silently drops the
   already-imported prefix and appends only the new tail.
3. The watermark (`{ session_id -> { max_message_id, ended_at } }`, plus a
   global `max(messages.id)` fast-path check) persists in the plugin's
   kernel storage, the same pattern as the github plugin's cursors.

Re-projecting whole sessions keeps the projector pure and deterministic
(spec R2): `message_index`, `previous_message_id` chains, and part ids are
always computed from the full session, never from a partial batch, so a row's
identity does not depend on when it was first observed.

**The session-end part.** {#session-end-part} Rows are frozen once written
(dedupe drops re-seen `part_id`s, never updates), but hermes records a
session's final facts (`end_reason`, final token totals,
`estimated_cost_usd` / `actual_cost_usd`) on the `sessions` row *after* the
last message exists, usually without adding any new message. Those finals
therefore get their own row: once a session's `ended_at` is set, the
projector emits one synthetic **session-end part** carrying them, with a
stable `part_id` derived from (session id, `session_end`) and a `part_type`
in the existing status family. Dedupe appends it exactly once no matter how
many times the session is re-projected; message capture stays prompt for
open sessions; and a backfill of an already-ended session emits the same
part in the same pass, so backfilled and live-captured sessions converge to
identical row sets. While a session is open, session-level aggregates in
consumers are sums over per-message usage (the LLP 0035 carrier); after it
ends, the end part is the authoritative record.

## Projection {#projection}

`src/projector.js` maps hermes rows to the materializer item
(`kind: 'ai_gateway.projected_exchange'`, via the shared
`projectedExchangeItem` helper in `src/core/backfill/scan_util.js`):

| hermes (`state.db`) | `ai_gateway_messages` |
|---|---|
| `sessions.id` | `session_id` = `hermes-<id>` (namespaced: hermes ids are store-scoped integers, not UUIDs) |
| `sessions.started_at` | `conversation_started_at` |
| `sessions.model` | `model` |
| `sessions.billing_provider` / `billing_base_url` | `provider` (normalized upstream name, LLP 0120 [row semantics](./0120-hermes-rows-are-ai-gateway-messages.decision.md#row-semantics)) |
| `sessions.cwd` | `cwd` for interactive sessions (+ repo derivation via the shared `deriveRepoFromCwd` helper for `repo_root` / `git_remote`); channel sessions get `cwd = ~/.hermes/channels/<source>` per [LLP 0124](./0124-hermes-channel-policy-scope-path.decision.md), real daemon cwd preserved in `attributes` |
| `sessions.source` (cli/telegram/discord/...) | `entrypoint`, and verbatim in `attributes` |
| `sessions.parent_session_id` | `parent_thread_id` (namespaced the same way) |
| `sessions.system_prompt` | `system_text` |
| per-message token counts | `attributes.usage` per [LLP 0035](./0035-token-usage-normalization.decision.md) |
| `sessions.ended_at` / `end_reason` / final token totals / `estimated_cost_usd` / `actual_cost_usd` / `api_call_count` | the synthetic [session-end part](#session-end-part), emitted once `ended_at` is set |
| `messages.id` | `provider_uuid`; `message_id` / `part_id` minted deterministically from (session id, message id, part index) |
| `messages.role` | `role` |
| `messages.content` | text part (`content_text`) |
| `messages.tool_calls` / `tool_name` / `tool_call_id` | tool-use / tool-result parts (`tool_name`, `tool_call_id`, `tool_args`, `tool_result_for`) |
| `messages.reasoning` / `reasoning_content` | thinking part |
| `messages.timestamp` | `message_created_at` |
| `messages.finish_reason` / `token_count` | `attributes` on the part |

`client_name` and `conversation_source` are `'hermes'`. Anything hermes-only
with no canonical column stays in `attributes`; no new columns are added
([LLP 0029](./0029-additive-cache-schema-evolution.decision.md)).

## Usage policy {#usage-policy}

Both the backfill and the poll path resolve every session's **effective
scope** through the shared resolver (`src/core/usage-policy/`) **before**
projecting, and skip ignored sessions entirely, the exact pattern of the
sibling adapters ([LLP 0050](./0050-ignore-enforced-in-adapters.decision.md),
spec R3). The effective scope is the session's `cwd` for interactive
sessions, and the [LLP 0124](./0124-hermes-channel-policy-scope-path.decision.md)
canonical scope path `~/.hermes/channels/<source>` for channel sessions, so
no hermes session is policy-invisible: `ignore` drops at this seam, and
`local-only` marking of a scope path flows through the standard export seam
([LLP 0070](./0070-local-only-export-seam.decision.md)) because the stamped
`cwd` column is what that seam matches. An interactive session with
`cwd = NULL` (no scope to match) records, consistent with folder rules being
folder-scoped.

## Backfill {#backfill}

`ctx.backfills.register(...)` contributes the `hermes` provider: walk all
sessions (windowed by the standard `resolveWindow` / `filterByWindow`
`--since` handling), one projected-exchange item per session, provenance
naming the state.db path. `hyp backfill hermes` thereby behaves exactly like
the claude/codex backfills, including backfill-on-join
([LLP 0037](./0037-backfill-on-join.decision.md)) eligibility.

## Source lifecycle {#source}

`startHermesSource(ctx)` returns a `StartedSource`:

- **start:** probe `state_db`. Missing file -> idle mode (spec R9): status
  `ready` with `detail: "no hermes installation detected"`, re-probe each
  tick, no error noise. Present -> open read-only, load watermark, start the
  poll timer.
- **status():** state, rows written, watermark position, last error.
- **reload():** re-read config (path, interval), reopen if the path changed.
- **stop():** clear the timer, close the database.

Observability per spec R7: a span per poll tick (`hermes.poll`) and per
backfill run with `component: 'hermes'`, sessions examined, rows appended,
and `error_kind` on failures, matching the log-driven-development
conventions.

## Open questions {#open-questions}

1. **Provider normalization table.** The exact `billing_provider` /
   `base_url` to `provider` mapping (when is it `openai` vs `openrouter` vs
   a raw hostname) needs one settled table in the projector, seeded from
   observed hermes configs.
2. **Multiple hermes profiles.** Hermes supports profile-scoped homes. V1
   reads the default home (one `state_db` path, overridable in config);
   multi-profile enumeration is future work if anyone runs profiles.

(The Node-floor question this section used to carry is settled by
[LLP 0125](./0125-node-engines-floor-22.decision.md).)
