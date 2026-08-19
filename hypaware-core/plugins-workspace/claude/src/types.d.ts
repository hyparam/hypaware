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
  /**
   * The OTLP resource attributes of the export this event arrived in,
   * unwrapped. Present only when the resource carried any. Kept separate from
   * `attributes` because it describes the exporting process, not the event:
   * `claude_telemetry_events` rows stay per-event, and the projector reads it
   * only for facts Claude Code reports once per export (`service.version`).
   */
  resource?: Record<string, unknown>
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
  /**
   * The main loop's `query_source`, kept only as the default for messages in
   * the same batch that carry none of their own. Per-request attribution
   * (`query_source`, `agent.name`) belongs on the message: a Task subagent
   * shares its parent's session id, so a session-level value would stamp its
   * whole batch. Read only off events a subagent did not emit; these facts
   * live for one POST and are not carried between batches.
   */
  querySource?: string
  /**
   * The main loop's model, on the same terms as `querySource`: an assistant
   * message carries its own, so this is the exchange-level fallback for the
   * rows that do not.
   */
  model?: string
  startedAt?: string
  /**
   * Exchange-level fields only a spooled request body carries (events never
   * do): the system prompt and the tool declarations, stamped on every row of
   * the session's projection.
   */
  systemText?: string
  tools?: unknown
}

/**
 * What the usage policy says about one session at ingest, resolved from the
 * cwd its SessionStart hook recorded (LLP 0254 #policy-inline).
 *
 * `class` is a `UsageClass` plus `'undetermined'`, the state a session is in
 * while (or because) no hook record names its cwd: not `full`, because nothing
 * was asked, and not `ignore`, because nothing said so.
 */
export interface ClaudeTelemetrySessionVerdict {
  class: 'ignore' | 'local-only' | 'full' | 'undetermined'
  /** The cwd the verdict was resolved from; absent when undetermined. */
  cwd?: string
  /** Absolute path of the governing `.hypignore` or machine-local list. */
  governedBy?: string | null
  /** The raw token before the fail-safe clamp. */
  declared?: string | null
  /** Present only on a fail-safe clamp of an unknown token. */
  warn?: string
}

/**
 * What one received batch suppressed, accumulated across the opt-out gate and
 * the usage-policy gate so the batch's span reports one total per outcome
 * rather than whichever gate ran last.
 */
export interface BatchSuppressionTally {
  /** Events a policy answered "no" for: the opt-out, or an `ignore` cwd. */
  eventsDropped: number
  /** Events withheld because no verdict existed yet (no hook record). */
  eventsUndetermined: number
  /** Spooled bodies deleted unread across both. */
  bodiesDropped: number
}

/**
 * Mutable counters one running Claude telemetry listener accumulates,
 * surfaced through `status()` details.
 */
export interface ClaudeTelemetryListenerState {
  rowsWritten: number
  rowsSkipped: number
  /** Rows written to `claude_telemetry_events`, counted apart from the message rows. */
  telemetryRowsWritten: number
  eventsReceived: number
  /**
   * Events suppressed at ingest by a policy that said no: the per-session
   * opt-out (LLP 0256) or an `ignore` cwd (LLP 0254 #policy-inline).
   */
  eventsDropped: number
  /**
   * Events withheld at ingest because the session's cwd was not known, so no
   * policy verdict existed to write under (LLP 0257 S10).
   */
  eventsUndetermined: number
  lastEventAt: string | undefined
  lastError: string | undefined
  listenFallbackFrom: number | undefined
  /** Spool size as of the last sweep, decremented as bodies are consumed. */
  spoolBytes: number
  bodiesProjected: number
  bodiesDeleted: number
  /** Bodies deleted unread because their session was policy-dropped. */
  bodiesDropped: number
  bodiesEvicted: number
  bodiesMissing: number
  bodiesUnparseable: number
}

/**
 * One raw body file Claude Code dropped into the spool, located through an
 * `api_request_body` / `api_response_body` event's `body_ref` and parsed. A
 * `request` is a full Anthropic Messages request (system, tools, message
 * history); a `response` is the assistant message the API returned.
 */
export interface SpooledClaudeBody {
  kind: 'request' | 'response'
  /** Resolved absolute path, proven to live inside the spool directory. */
  file: string
  body: Record<string, unknown>
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
   * accident.
   *
   * `otel` writes neither routing key: it turns on Claude Code's own telemetry
   * export, so the client talks to Anthropic directly and reports to the local
   * listener. See LLP 0258.
   *
   * @ref LLP 0231#decision [implements]: `proxy` is the RFC's accepted
   * narrowed-aperture transport, and the RFC is where "why a second transport
   * at all, and what it costs" lives rather than in any one spawned decision
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
   * The mode the prior `_hypaware` marker recorded, when one of the three
   * known modes. `proxy` is the one the caller acts on: a proxy attach left
   * residue outside the settings file (the launchd environment, the keychain
   * trust) that the mode switch alone cannot reach, and by the time the caller
   * runs, this write has already replaced the marker that said so. Absent on a
   * first attach and on legacy markers that predate modes.
   */
  priorMode?: 'proxy' | 'base_url' | 'otel'
  /**
   * One notice per `env` / `hooks` block this run found present on disk with
   * the wrong JSON type and had to rebuild. Attach backs the displaced value
   * up into the marker's `prev_malformed` and keeps succeeding (LLP 0163), so
   * this is the only thing that tells the user a hand-edit was moved aside.
   *
   * A list, not a joined string: attach's callers render it (`hyp client attach`
   * prints a line each, `--json` echoes the array) and there is no reason to
   * hand them a field they would have to split. Omitted when nothing was
   * displaced, including on a re-attach whose backup was carried over from an
   * earlier run.
   */
  warnings?: string[]
}

export type ClaudeAttachResult = ClaudeAttachChanged | { changed: false }
