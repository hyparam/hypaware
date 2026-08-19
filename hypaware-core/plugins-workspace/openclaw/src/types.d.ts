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
 * is a returned value, never a throw, so nothing is half-written and the
 * caller decides what to do with it.
 *
 * The kernel types the *registered* `attach()` as `Promise<void>`, so
 * `index.js`'s wrapper rethrows a non-`done` outcome to make it visible at
 * all; `perform()`'s catch turns it back into this same shape, which the
 * reconciler records and acts on (LLP 0172 §1.3).
 *
 * `failed` and `refused` split that non-`done` half by whether a retry could
 * ever help. `failed` is the transient case (an unresolvable settings path, a
 * missing endpoint this boot, a read or write error): recorded, warned about,
 * and retried next pass without failing the join. `refused` is the terminal
 * one and has exactly one source, the `models.providers` ownership conflict of
 * LLP 0167#attach-detach: a value HypAware did not write sits at a key attach
 * owns, which is a property of the user's config that no number of passes
 * changes, so the reconciler writes a terminal marker and stops rather than
 * climbing `attempts` forever (LLP 0184). Only the user removing the entry (or
 * running `hyp detach`) clears it, and only an explicit `hyp attach` re-arms.
 *
 * This split is internal to the reconciler seam. The CLI-facing attach output
 * (`--json` payload and prose) still reports `status: 'failed'` for both, so
 * a scripted caller's wire contract is unchanged.
 */
export type OpenclawAttachOutcome =
  | { status: 'done' }
  | { status: 'failed', reason: string }
  | { status: 'refused', reason: string }

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
  /**
   * When the session file recorded the message, from the record LINE's own
   * `timestamp`, read at that level only. Distinct from `timestampMs`, which
   * prefers the envelope's value: an envelope states when the message was
   * made (a webchat prompt carries its send time), the line states when this
   * file wrote it down. Consumers that order the transcript against another
   * file OpenClaw wrote in the same instants want this one (@ref LLP 0265).
   */
  recordedAtMs?: number
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
 * One run's compiled context, recovered from an OpenClaw trajectory file
 * (`<sessionId>.trajectory.jsonl`). A run is one prompt-to-completion cycle,
 * and OpenClaw compiles a fresh context for each: `systemText` and `tools`
 * are the two facts the session transcript never states, and both change
 * within a single session (@ref LLP 0265#decision).
 *
 * `startMs` is the run's `context.compiled` timestamp and `endMs` its
 * `session.ended`; a context with no end is open until the next one starts,
 * which is a run still in flight at sweep time.
 *
 * `systemText` is whatever the run RECORDED, which is not always the whole
 * prompt: OpenClaw drops an over-32768-character value entirely (leaving
 * `systemText` absent) and silently clips a long one to 20000 characters
 * plus an ellipsis. `systemPromptDigest` is what is known about the prompt
 * itself either way: `chars` its true assembled size, `hash` the digest the
 * run's `trace.metadata` reported, `recordedChars` how much of it
 * `systemText` actually holds, and `truncated` that the two differ. A
 * consumer that needs a whole prompt must check `truncated`, not the
 * presence of `systemText`.
 */
export interface OpenclawRunContext {
  startMs: number
  endMs?: number
  runId?: string
  systemText?: string
  systemPromptDigest?: { chars?: number, hash?: string, recordedChars?: number, truncated?: boolean }
  tools?: unknown[]
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
