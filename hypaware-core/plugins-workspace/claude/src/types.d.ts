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
   * surfaces it per message so the gateway `model` column reflects the model
   * that served each assistant message, including sessions that switch models
   * mid-stream. Only assistant lines record `message.model`, so user-prompt
   * and tool_result entries have none. The `<synthetic>` sentinel
   * (locally-generated assistant lines that never hit a model) is dropped to
   * undefined.
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
  /**
   * Claude Code's structured tool result (`toolUseResult`), written only to
   * the transcript, never the wire: structuredPatch / filePath on edits,
   * interrupted / stdout metadata on commands, subagent descriptors on Task
   * results. Promoted verbatim into `attributes.claude.tool_use_result` on
   * both the live and backfill paths so it survives transcript pruning.
   */
  tool_use_result: unknown
  raw_frame: unknown
  timestampMs: number | undefined
}

export interface ClaudeAttachOptions {
  /**
   * Gateway listener port. Written into `env.ANTHROPIC_BASE_URL` in
   * `base_url` mode, or `env.HTTPS_PROXY` in `proxy` mode.
   */
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
  /**
   * How Claude Code is routed through the gateway.
   *
   * `proxy` sets `HTTPS_PROXY` plus `NODE_EXTRA_CA_CERTS` and leaves the base
   * URL alone, so the endpoint stays `api.anthropic.com` and Claude Code keeps
   * treating it as first party (Remote Control refuses to run against any other
   * host). `base_url` is the original mechanism, repointing
   * `ANTHROPIC_BASE_URL` at the local gateway. Defaults to `base_url` so a
   * caller that has not been taught about proxy mode cannot acquire it by
   * accident. See LLP 0231.
   */
  mode?: 'proxy' | 'base_url'
  /**
   * Absolute path to the machine-local CA certificate. Required in `proxy`
   * mode, and its existence is the preflight: the gateway writes it only once
   * proxy mode has booted, and attaching without it would break all of Claude
   * Code's HTTPS rather than just its capture.
   */
  caCertPath?: string
}

export interface ClaudeAttachChanged {
  changed: true
  /** The pre-existing `env.ANTHROPIC_BASE_URL` attach backed up, if any. */
  prevValue?: string
  /**
   * One notice per `env` / `hooks` block this run found present on disk with
   * the wrong JSON type and had to rebuild. Attach backs the displaced value
   * up into the marker's `prev_malformed` and keeps succeeding (LLP 0163), so
   * this is the only thing that tells the user a hand-edit was moved aside.
   *
   * A list, not a joined string: attach's callers render it (`hyp attach`
   * prints a line each, `--json` echoes the array) and there is no reason to
   * hand them a field they would have to split. Omitted when nothing was
   * displaced, including on a re-attach whose backup was carried over from an
   * earlier run.
   */
  warnings?: string[]
}

export type ClaudeAttachResult = ClaudeAttachChanged | { changed: false }
