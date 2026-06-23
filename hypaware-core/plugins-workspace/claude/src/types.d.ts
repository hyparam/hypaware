export interface SessionContextRecord {
  session_id: string
  transcript_path: string | undefined
  cwd: string | undefined
  git_branch: string | undefined
  /**
   * Repo identity for the GitHub↔LLM graph bridge (LLP 0032), captured by the
   * hook. Optional (not `string | undefined`): each is best-effort and the hook
   * omits a key when its git lookup fails, so older records simply lack them.
   */
  git_remote?: string
  head_sha?: string
  repo_root?: string
  ts: string | undefined
}

export interface TranscriptEntry {
  sessionId: string
  role: string | undefined
  content: unknown
  /**
   * The working directory Claude Code stamps on each transcript line. The
   * backfill recovers a session's repo from it when the session-context record
   * predates the LLP 0032 git capture (see `git_repo.js`).
   */
  cwd: string | undefined
  messageId: string | undefined
  contentKey: string | undefined
  provider_uuid: string | undefined
  parent_uuid: string | undefined
  logical_parent_uuid: string | undefined
  source_tool_assistant_uuid: string | undefined
  request_id: string | undefined
  prompt_id: string | undefined
  provider_type: string | undefined
  provider_subtype: string | undefined
  /**
   * The model Claude Code stamps on each assistant transcript line. Backfill
   * surfaces it per message so the gateway `model` column matches live
   * capture, including sessions that switch models mid-stream. The
   * `<synthetic>` sentinel (locally-generated assistant lines that never hit a
   * model) is dropped to undefined.
   */
  model: string | undefined
  entrypoint: string | undefined
  client_version: string | undefined
  user_type: string | undefined
  permission_mode: string | undefined
  is_sidechain: boolean | undefined
  agent_id: string | undefined
  attachment_type: string | undefined
  hook_event: string | undefined
  is_compact_summary: boolean | undefined
  compact_metadata: unknown
  /**
   * The Anthropic `message.usage` block Claude Code writes onto assistant
   * transcript lines (`input_tokens` / `output_tokens` /
   * `cache_*_input_tokens`). Backfill folds it into `attributes.usage`, the
   * same column the live projector stamps from the wire response.
   */
  usage: unknown
  raw_frame: unknown
  timestampMs: number | undefined
}

export interface ClaudeAttachOptions {
  /** Gateway listener port; written into `env.ANTHROPIC_BASE_URL`. */
  port: number
  version: string
  /**
   * Absolute path to the session-context JSONL file the managed hook appends to.
   * Replaces the v1 `--port` argument: phase 2 moved the session-context channel
   * from HTTP to a file on disk.
   */
  stateFile: string
  settingsPath?: string
  binPath?: string
}

export type ClaudeAttachResult = { changed: true; prevValue?: string } | { changed: false }

export interface ClaudeDetachOptions {
  settingsPath?: string
}

export type ClaudeDetachResult =
  | { changed: true; removed?: string; warning?: string }
  | { changed: false }
