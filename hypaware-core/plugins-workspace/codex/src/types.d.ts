import type { JsonObject } from '../../../../hypaware-plugin-kernel-types.d.ts'

/**
 * One Codex rollout session recovered from a `~/.codex/sessions/**` file.
 * Both the legacy single-document `{ session, items }` format and the
 * modern line-delimited `{ timestamp, type, payload }` format normalize
 * into this shape so the projector is format-agnostic.
 */
export interface CodexRolloutSession {
  /** Native session id (`session_meta.id` / legacy `session.id`), or a deterministic path-derived fallback. */
  sessionId: string
  /** Conversation start in epoch millis, when recoverable. */
  startedAtMs?: number
  /** Workspace directory recorded for the session/turns. */
  cwd?: string
  /** Git remote origin URL (`session_meta.git.repository_url`). */
  gitOriginUrl?: string
  /** Git commit hash at session time (`session_meta.git.commit_hash`). */
  gitCommit?: string
  /** Git branch when the client version records it. */
  gitBranch?: string
  /** Working-tree dirty flag when recorded. */
  gitDirty?: boolean
  /** Sandbox policy label (`turn_context.sandbox_policy.type`). */
  sandbox?: string
  /** Launch surface / originator (`session_meta.originator`). */
  entrypoint?: string
  /** Codex CLI version (`session_meta.cli_version`). */
  clientVersion?: string
  /** Thread provenance, e.g. `user` or `subagent` (`session_meta.thread_source`). */
  threadSource?: string
  /** Parent thread that spawned this subagent (`session_meta.parent_thread_id`). */
  parentThreadId?: string
  /** Model id resolved from the turn context(s). */
  model?: string
  /** Configured upstream provider (`session_meta.model_provider`). */
  modelProvider?: string
  /** Launch source label, e.g. `vscode` (`session_meta.source`). */
  source?: string
  /** Ordered response items recovered from the rollout. */
  items: CodexRolloutItem[]
}

/** One recovered rollout response item plus its envelope timestamp. */
export interface CodexRolloutItem {
  /** The response-item payload (OpenAI Responses item shape). */
  payload: Record<string, unknown>
  /** Envelope timestamp in epoch millis, when present (modern JSONL only). */
  timestampMs?: number
  /**
   * Per-turn token usage recovered from a `token_count` event_msg, already
   * normalized into the gateway's `{ usage: {...} }` attributes shape. Present
   * only on the synthetic marker item the parser inserts at a turn boundary;
   * the projector consumes it to stamp usage onto that turn's assistant
   * message rather than projecting a message of its own.
   */
  usageAttributes?: JsonObject
}

export interface CodexAttachOptions {
  port: number
  version: string
  configPath?: string
  baseUrl?: string
  providerName?: string
}

export type CodexAttachResult = { changed: true; prevValue?: string }

export interface CodexDetachOptions {
  configPath?: string
}

export type CodexDetachResult =
  | { changed: true; removed?: string; restoredValue?: string; warning?: string }
  | { changed: false }
