/**
 * The `type: "session"` header line of an OpenClaw session JSONL file
 * (`~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`). Each field is
 * present only when the header states it as a non-blank string; `cwd` is
 * additionally required to be an absolute path (a relative value reads as
 * absent, the same rule the Codex `session_meta` reader applies to its own
 * `cwd`). @ref LLP 0158#decision
 */
export interface OpenclawSessionHeader {
  sessionId?: string
  cwd?: string
  startedAt?: string
}

/**
 * One `type: "message"` record recovered from an OpenClaw session
 * transcript. The normalized fields are the ones LLP 0158's Context names as
 * present on every message envelope (`id`, a timestamp) or on an assistant
 * envelope specifically (`model`, `provider`, `api`, `stopReason`, `usage`);
 * each is a present-value read off the envelope, absent when the field is
 * missing, non-string (for the string fields), or blank, following the same
 * "unconfirmable is unresolvable" rule the header applies. `record` is the
 * full raw envelope, for a caller that needs a field this reader does not
 * normalize (e.g. message content/blocks); it is an untyped bag rather than
 * `JsonObject` on purpose, the same choice `CodexRolloutItem.payload` makes
 * for the same reason (an arbitrary parsed line, not a value this reader
 * constructs and can vouch for the shape of).
 */
export interface OpenclawSessionMessage {
  id?: string
  timestampMs?: number
  model?: string
  provider?: string
  api?: string
  stopReason?: string
  usage?: Record<string, unknown>
  record: Record<string, unknown>
}
