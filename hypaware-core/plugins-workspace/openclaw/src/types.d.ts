import type fsp from 'node:fs/promises'

/**
 * Construction options for `createOpenclawAttach`. Every field has a
 * process-wide default so a production caller passes only what it has:
 * `index.js` threads the kernel's `ctx.env`/`HOME`, while a test injects a
 * temp `homeDir` (or an `OPENCLAW_HOME` in `env`) and reads the file back.
 */
export interface OpenclawAttachOptions {
  /** `$HOME` the `.openclaw/openclaw.json` path is resolved against. */
  homeDir?: string
  /** Env the `$OPENCLAW_HOME` relocation is read from. */
  env?: NodeJS.ProcessEnv
  /** Injectable `node:fs/promises`, for the read and the atomic write. */
  fs?: typeof fsp
  /** Injectable logger; defaults to the `plugin.openclaw` logger. */
  logger?: { info(event: string, fields: Record<string, unknown>): void, warn(event: string, fields: Record<string, unknown>): void }
}

/**
 * What the effect reports back. Deliberately the `ActionOutcome` shape the
 * generic client-action reconciler already understands (LLP 0169): a refusal
 * is a returned `failed`, never a throw, so nothing is half-written and the
 * caller decides what to do with it.
 *
 * The kernel types the *registered* `attach()` as `Promise<void>`, so
 * `index.js`'s wrapper rethrows a `failed` outcome to make it visible at all;
 * `perform()`'s catch turns it back into this same shape, which the
 * reconciler records, warns about, and retries next pass without failing the
 * join (LLP 0172 §1.3).
 */
export type OpenclawAttachOutcome =
  | { status: 'done' }
  | { status: 'failed', reason: string }

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
 * "unconfirmable is unresolvable" rule the header applies. `id` is the one
 * field read the other way round, record line first and envelope second,
 * because the line is where LLP 0158 rule 7 verified message identity
 * lives. `content` is whatever the envelope wrote (a string or a block
 * array), passed through unnormalized, so unlike the string fields it
 * refuses only an explicit `null` rather than a blank or wrong-typed value.
 * `record` is the full raw record LINE, for a caller that
 * needs a field this reader does not normalize: `parentId` is on the line
 * itself, while a message-level field (`idempotencyKey`, `toolCallId`) is
 * at `record.message`, one level down, and reading it off the line is the
 * same mistake as #543. It is an untyped bag rather than `JsonObject` on
 * purpose, the same choice
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
