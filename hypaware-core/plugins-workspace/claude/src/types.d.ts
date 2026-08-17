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

/**
 * One decoded Claude Code telemetry event: an OTLP log record with its
 * `AnyValue` wrappers removed, keyed by the `event.name` attribute
 * rather than by the record body.
 */
export interface ClaudeTelemetryEvent {
  /** `event.name`, e.g. `user_prompt`, `assistant_response`, `api_request`. */
  name: string
  /** `event.timestamp` (ISO-8601), falling back to the record's `timeUnixNano`. */
  timestamp?: string
  /** `event.sequence`, Claude Code's per-session ordering counter. */
  sequence?: number
  /** Every attribute on the record, unwrapped. */
  attributes: Record<string, unknown>
}

/**
 * Session-level identity repeated on every Claude Code event. Collected
 * once per batch so the projection carries it without each message
 * restating it.
 */
export interface ClaudeTelemetrySessionFacts {
  clientVersion?: string
  entrypoint?: string
  userId?: string
  organizationId?: string
  terminalType?: string
  querySource?: string
  agentName?: string
  model?: string
  startedAt?: string
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
   *
   * `otel` writes neither routing key: it turns on Claude Code's own telemetry
   * export, so the client talks to Anthropic directly and reports to the local
   * listener. See LLP 0258.
   */
  mode?: 'proxy' | 'base_url' | 'otel'
  /**
   * Absolute path to the machine-local CA certificate. Required in `proxy`
   * mode, and its existence is the preflight: the gateway writes it only once
   * proxy mode has booted, and attaching without it would break all of Claude
   * Code's HTTPS rather than just its capture.
   */
  caCertPath?: string
  /**
   * Port of the Claude telemetry listener, written into
   * `env.OTEL_EXPORTER_OTLP_ENDPOINT`. Required in `otel` mode, and distinct
   * from `port`: that one stays the gateway's, because it is what the
   * attach-drift check compares against.
   */
  telemetryPort?: number
  /**
   * Absolute path to the raw body spool, written into
   * `env.OTEL_LOG_RAW_API_BODIES` and recorded on the marker so detach and
   * purge can sweep it. Required in `otel` mode.
   */
  spoolDir?: string
  /**
   * The installed Claude Code version, when it could be read. `otel` mode
   * refuses below the floor (LLP 0258 #version-floor); an undetectable
   * version is not a refusal, so `undefined` proceeds.
   */
  claudeVersion?: string
}

export interface ClaudeAttachChanged {
  changed: true
  /**
   * The pre-existing value of the env key this mode took over
   * (`ANTHROPIC_BASE_URL`, `HTTPS_PROXY`, or `OTEL_EXPORTER_OTLP_ENDPOINT`),
   * if any. A display copy: userinfo-redacted except in `base_url` mode.
   */
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
