# LLP 0118: hermes log forwarding

**Type:** Spec
**Status:** Accepted
**Systems:** Sources, Plugins
**Author:** Phil / Claude
**Date:** 2026-07-20
**Related:** LLP 0000, LLP 0012, LLP 0016, LLP 0026, LLP 0035, LLP 0049, LLP 0119, LLP 0120, LLP 0121, LLP 0122, LLP 0123, LLP 0124

> Capture Hermes Agent activity into HypAware so hermes sessions appear in
> `ai_gateway_messages` alongside Claude and Codex. The capture seam (pull from
> hermes's own store) is [LLP 0119](./0119-hermes-pull-from-state-db.decision.md);
> the dataset choice is [LLP 0120](./0120-hermes-rows-are-ai-gateway-messages.decision.md);
> packaging is [LLP 0121](./0121-hermes-plugin-bundled.decision.md); the buildable
> design is [LLP 0122](./0122-hermes-log-forwarding.design.md).

## Motivation

[Hermes Agent](https://github.com/NousResearch/hermes-agent) is an open-source
AI agent (interactive TUI, messaging gateway daemon, cron scheduler) that talks
to arbitrary OpenAI-compatible providers. On a machine where hermes runs,
HypAware today records nothing about it: hermes sessions are invisible to
`hyp query`, the usage reports, and the context graph, even though the same
machine's Claude and Codex activity is fully captured.

Hermes keeps a rich local record of its own activity:

- **`~/.hermes/state.db`** (SQLite, WAL mode): the canonical conversation
  store. A `sessions` table (id, source, model, cwd, parent_session_id,
  started_at/ended_at, input/output/cache_read/cache_write/reasoning token
  counts, cost estimates, api_call_count) and a `messages` table (session_id,
  role, content, tool_calls, tool_name, tool_call_id, reasoning, timestamp,
  token_count, finish_reason). Hermes's own docs call state.db "the canonical
  message store", and its logging layer redacts secrets before persisting.
- **`~/.hermes/logs/*.log`**: rotating plain-text operational logs.
- An **observer-hook plugin contract** (`hermes.observer.v1`) that can push
  sanitized per-call telemetry to in-process plugins.

"Hermes logs" in this spec means the **structured conversation record**
(sessions and messages), the data that makes hermes activity comparable to
Claude/Codex capture. The plain-text operational logs are a
[non-goal](#non-goals).

## Scope {#scope}

One new client adapter, `@hypaware/hermes`, in the same family as
`@hypaware/claude` and `@hypaware/codex` (read the client's native on-disk
record, [LLP 0026](./0026-claude-native-granularity.decision.md)): a backfill
provider for history plus a polling source for ongoing capture, both
materializing into `ai_gateway_messages` through the existing
`ai_gateway.projected_exchange` materializer.

## Requirements {#requirements}

- **R1.** Hermes sessions and messages MUST land in `ai_gateway_messages` as
  canonical rows, shape-identical to rows produced by the Claude/Codex
  backfills (`client_name = 'hermes'`), so every existing consumer (query,
  reports, graph projection, sinks, purge) works on them unchanged.
- **R2.** Capture MUST be idempotent: re-running the backfill or the poll over
  already-imported data writes no duplicate rows. Identity (`message_id`,
  `part_id`) MUST be deterministic, derived from hermes's own stable keys.
- **R3.** Usage policy MUST be honored at the capture seam: a hermes session
  whose `cwd` resolves to `ignore` via the shared resolver
  ([LLP 0049](./0049-hypignore-usage-policy.spec.md#requirements) R1/R4,
  [LLP 0050](./0050-ignore-enforced-in-adapters.decision.md)) is never written,
  in both backfill and poll paths. Sessions matched by the local-only
  machinery ([LLP 0069](./0069-local-only-dir-selection.spec.md),
  [LLP 0103](./0103-machine-local-policy-classes.decision.md)) get the same
  treatment as any other captured row with that `cwd`.
- **R4.** Token usage MUST be normalized per
  [LLP 0035](./0035-token-usage-normalization.decision.md), from the token
  counts hermes already persists (input, output, cache read, cache write,
  reasoning).
- **R5.** Capture MUST be strictly read-only against hermes state: open
  `state.db` read-only, tolerate WAL activity and lock contention without
  disturbing a running hermes, and never modify anything under `~/.hermes/`.
- **R6.** Ongoing capture MUST be automatic: new hermes sessions and new
  messages in open sessions appear in the cache without manual action, with
  lag bounded by a configurable poll interval. Explicit history import is
  `hyp backfill hermes` with the standard `--since` window.
- **R7.** The adapter MUST be observable per the log-driven-development
  conventions: structured logs/spans around poll ticks and backfill runs
  (`component`, rows written, watermark position, `error_kind`), and the
  source `status()` reports state, rows written, and last error.
- **R8.** Capture MUST NOT touch hermes's live LLM traffic: no proxying, no
  config changes to hermes, no alteration of its calls. The seam is
  store-side only ([LLP 0119](./0119-hermes-pull-from-state-db.decision.md)).
- **R9.** When no hermes installation exists on the machine (no
  `~/.hermes/state.db`), the source MUST idle cleanly (no errors, no busy
  polling noise) and report that state via `status()`.
- **R10.** Messaging-channel sessions (Telegram, Discord, Slack, WhatsApp,
  Signal, Email) MUST carry the canonical policy scope path
  `~/.hermes/channels/<source>` as their `cwd`
  ([LLP 0124](./0124-hermes-channel-policy-scope-path.decision.md)), so the
  standard marking machinery governs them: captured and sync-eligible by
  default (`full`), per-channel opt-down to `local-only` or `ignore` via the
  machine-local list or a `.hypignore`, with no hermes-specific policy
  config.

## Non-goals {#non-goals}

1. **Operational text logs.** `~/.hermes/logs/*.log` (agent.log, gateway.log,
   errors.log) are unstructured and secondary; forwarding them (plausibly into
   the otel `logs` dataset) is future work, not this spec.
2. **Wire capture via the AI gateway.** Pointing hermes's `model.base_url` at
   the HypAware gateway would capture raw LLM traffic inline. Rejected as the
   seam in [LLP 0119](./0119-hermes-pull-from-state-db.decision.md); it also
   remains possible later as a complement, not a replacement.
3. **A hermes-side observer plugin.** Pushing telemetry out of hermes via its
   `hermes.observer.v1` hooks requires shipping and enabling Python code in
   every hermes install. Also rejected in LLP 0119.
4. **Channel-specific default hardening.** Messaging-channel sessions are
   captured by default and policy-addressable per R10; whether any channel
   should *default* to something stricter than `full` (e.g. org-pushed
   local-only for third-party content) is future policy work layered on the
   [LLP 0124](./0124-hermes-channel-policy-scope-path.decision.md) scope
   paths, not part of this spec.
