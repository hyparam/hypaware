export interface SessionContextRecord {
  session_id: string
  transcript_path: string | undefined
  cwd: string | undefined
  git_branch: string | undefined
  ts: string | undefined
}

export interface TranscriptEntry {
  sessionId: string
  role: string | undefined
  content: unknown
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
  entrypoint: string | undefined
  client_version: string | undefined
  user_type: string | undefined
  permission_mode: string | undefined
  is_sidechain: boolean | undefined
  attachment_type: string | undefined
  hook_event: string | undefined
  is_compact_summary: boolean | undefined
  compact_metadata: unknown
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
