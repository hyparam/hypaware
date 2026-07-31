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
 * present on every message envelope (`id`, a timestamp, `role`, `content`)
 * or on an assistant envelope specifically (`model`, `provider`, `api`,
 * `stopReason`, `usage`); each is read off the nested `message` envelope,
 * falling back to the record line, and is absent when the field is missing,
 * non-string (for the string fields), or blank, following the same
 * "unconfirmable is unresolvable" rule the header applies. `content` is
 * whatever the envelope wrote (a string or a block array), passed through
 * unnormalized. `record` is the full raw record line, for a caller that
 * needs a field this reader does not normalize (`parentId`, `toolCallId`);
 * it is an untyped bag rather than `JsonObject` on purpose, the same choice
 * `CodexRolloutItem.payload` makes for the same reason (an arbitrary parsed
 * line, not a value this reader constructs and can vouch for the shape of).
 * Reaching into `record` for `role`/`content` is the #543 defect: those live
 * under `message`, and the reader is the one place that knows it.
 */
export interface OpenclawSessionMessage {
  id?: string
  timestampMs?: number
  role?: string
  content?: unknown
  model?: string
  provider?: string
  api?: string
  stopReason?: string
  usage?: Record<string, unknown>
  record: Record<string, unknown>
}

/**
 * One session file's flush-time settlement view (LLP 0161 Section 6): the
 * header facts that govern the whole file (`sessionId`, `cwd`) plus the two
 * lookup structures the enricher's two match passes need. `byContentKey`
 * holds only unambiguously-owned {@link OpenclawSessionMessage} keys;
 * `ordinalIndex` is the `(role, same-role ordinal)` index the LLP 0161
 * Section 5 fallback matcher consumes, and `positions` is its parallel
 * per-file-position `(role, ordinal)` table, so a row's `message_index` can
 * be turned into the ordinal to look up. `path`/`mtimeMs` identify the file
 * the view was built from (candidate ordering and telemetry).
 */
export interface OpenclawSessionIndex {
  path: string
  mtimeMs: number
  sessionId?: string
  cwd?: string
  messageCount: number
  byContentKey: Map<string, OpenclawSessionMessage>
  ordinalIndex: Map<string, Array<{ timestampMs: number, value: OpenclawSessionMessage }>>
  positions: Array<{ role: string, ordinal: number }>
}
