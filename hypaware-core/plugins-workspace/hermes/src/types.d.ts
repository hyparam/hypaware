/**
 * Row and watermark shapes for the `@hypaware/hermes` adapter's reader
 * (`src/state_db.js`). Column sets mirror hermes's own `state.db` schema as
 * described in LLP 0118 (spec) and mapped in LLP 0122 (design, projection
 * table); the reader returns these unmodified, the projector (T2) is the
 * only place that reshapes them into `AiGatewayProjectedExchange`.
 */

/**
 * One row of hermes's `sessions` table.
 *
 * @ref LLP 0122#projection [constrained-by]: column set is exactly what the
 *   projection table consumes, no more, so the reader stays a thin,
 *   testable mirror of the schema rather than growing adapter-shaped
 *   fields.
 */
export interface HermesSessionRow {
  /** Store-scoped integer id, namespaced by the projector as `hermes-<id>`. */
  id: number
  /** Launch surface: `cli`, `telegram`, `discord`, `slack`, `whatsapp`, `signal`, `email`, ... */
  source: string
  /** Model id, when recorded. */
  model: string | null
  /** Working directory for interactive sessions; NULL for some interactive and all channel sessions until the projector stamps the channel scope path. */
  cwd: string | null
  /** Parent session id for subagent/child sessions, namespaced the same way as `id`. */
  parent_session_id: number | null
  /** ISO-8601 session start timestamp. */
  started_at: string
  /** ISO-8601 session end timestamp, or NULL while the session is open. */
  ended_at: string | null
  /** Terminal reason once `ended_at` is set (e.g. `completed`, `error`, `cancelled`). */
  end_reason: string | null
  /** Upstream billing provider label hermes recorded for this session. */
  billing_provider: string | null
  /** Upstream `base_url` hermes recorded for this session. */
  billing_base_url: string | null
  /** System prompt text, when recorded. */
  system_prompt: string | null
  /** Final input token total, populated once the session ends. */
  input_tokens: number | null
  /** Final output token total, populated once the session ends. */
  output_tokens: number | null
  /** Final cache-read token total, populated once the session ends. */
  cache_read_tokens: number | null
  /** Final cache-write token total, populated once the session ends. */
  cache_write_tokens: number | null
  /** Final reasoning token total, populated once the session ends. */
  reasoning_tokens: number | null
  /** Estimated cost in USD. */
  estimated_cost_usd: number | null
  /** Actual (billed) cost in USD, when hermes reconciles it. */
  actual_cost_usd: number | null
  /** Number of upstream API calls the session made. */
  api_call_count: number | null
}

/**
 * One row of hermes's `messages` table.
 *
 * @ref LLP 0122#projection [constrained-by]: column set is exactly what the
 *   projection table consumes.
 */
export interface HermesMessageRow {
  /** Store-scoped integer id; the projector derives `message_id`/`part_id` from (session id, this id, part index). */
  id: number
  /** Owning session id (`HermesSessionRow.id`). */
  session_id: number
  /** Message role: `system`, `user`, `assistant`, `tool`. */
  role: string
  /** Text content, when the message carries a text part. */
  content: string | null
  /** Serialized tool-call payload (JSON text), when the message issued one or more tool calls. */
  tool_calls: string | null
  /** Tool name for a tool-call / tool-result message. */
  tool_name: string | null
  /** Tool-call correlation id, linking a tool result back to its call. */
  tool_call_id: string | null
  /** Reasoning/thinking text, when the model emitted it. */
  reasoning: string | null
  /** ISO-8601 message timestamp. */
  timestamp: string
  /** Per-message token count, when hermes records one for this message. */
  token_count: number | null
  /** Finish reason for this message's generation, when applicable. */
  finish_reason: string | null
}

/**
 * The poll source's per-session progress mark (T4), kept in plugin kernel
 * storage. `state_db.js#listChangedSessions` compares the store's current
 * aggregate against a map of these to find sessions to re-project.
 *
 * @ref LLP 0122#watermark [implements]: `{ max_message_id, ended_at }` is
 *   exactly the pair the change-detection aggregate needs: `max_message_id`
 *   catches new messages in an open session, `ended_at` catches the
 *   NULL -> set transition that fires the synthetic session-end part.
 */
export interface HermesSessionWatermark {
  /** Highest `messages.id` observed for this session as of the last successful poll/backfill; 0 if none observed. */
  max_message_id: number
  /** `sessions.ended_at` as of the last observation; NULL while still open. */
  ended_at: string | null
}

/** `{ session_id (stringified) -> watermark }`, the full persisted poll state for one state.db. */
export type HermesWatermarkState = Record<string, HermesSessionWatermark>

/** Why `listChangedSessions` flagged a session: new messages appended, or `ended_at` transitioned from NULL. */
export type HermesChangedSessionReason = 'new_messages' | 'ended'

/** One session `listChangedSessions` (LLP 0122#watermark) determined needs re-projection. */
export interface HermesChangedSession {
  /** `HermesSessionRow.id`. */
  session_id: number
  /** Which condition triggered the change; informational, both re-project the whole session identically. */
  reason: HermesChangedSessionReason
  /** The store's current `max(messages.id)` for this session (0 if it has none). */
  max_message_id: number
  /** The store's current `sessions.ended_at` for this session. */
  ended_at: string | null
}

/** Options accepted by `state_db.js`'s bounded SQLITE_BUSY retry. */
export interface HermesBusyRetryOptions {
  /** Maximum attempts (including the first) before giving up; defaults to `DEFAULT_BUSY_RETRY_ATTEMPTS`. */
  attempts?: number
  /** Delay between attempts in ms; defaults to `DEFAULT_BUSY_RETRY_DELAY_MS`. */
  delayMs?: number
  /** Injectable delay function, defaulting to a real `setTimeout` wait; tests substitute a fast/no-op sleep. */
  sleep?: (ms: number) => Promise<void>
}

/** Construction options for `openHermesStateDb`. */
export interface HermesStateDbOptions extends HermesBusyRetryOptions {
  /** Injectable `require`-style loader for `node:sqlite`, defaulting to a real `createRequire` lookup; tests substitute one that throws to simulate an absent builtin. */
  requireFn?: (id: string) => unknown
}
