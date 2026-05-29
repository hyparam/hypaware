import type { AiGatewayExchangeInput } from '../../../../collectivus-plugin-kernel-types.d.ts'

export interface CodexLogReader {
  /** Identifier used in telemetry and de-dup. */
  name: string
  /**
   * Pure function that may augment the projection with locally-collected
   * Codex state (e.g. parsed SQLite turn rows). Returning `undefined`
   * means "no augmentation"; the projector still proceeds.
   */
  read(input: AiGatewayExchangeInput): Record<string, unknown> | undefined
}

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
