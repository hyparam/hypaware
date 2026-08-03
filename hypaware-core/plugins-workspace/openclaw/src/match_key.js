// @ts-check

import { canonicalJson, isPlainObject, sha256Hex, stringValue, stripVolatileBlockFields } from 'hypaware/core/util'

/**
 * LLP 0159 match keys: cross-shape content normalization for OpenClaw.
 *
 * Claude's precedent (`claude/src/transcripts.js`'s `contentKey`) hashes
 * the raw wire content array directly, because Claude Code's transcript
 * stores byte-identical wire-shaped blocks. That does not transfer here:
 * OpenClaw's session file stores its own normalized message shape (the
 * `@mariozechner/pi-ai` `Message` union OpenClaw depends on), which is
 * genuinely different from what the Anthropic/OpenAI wire carries, not
 * just differently named.
 *
 * Verified against the real `openclaw` package (`packages/llm-core/src/types.ts`)
 * and a real session-file fixture
 * (`src/agents/sessions/session-manager.tool-result-replay.test.ts`) rather
 * than guessed:
 *
 *  - A session-file assistant tool call is a `{ type: "toolCall", id, name,
 *    arguments }` content block; the Anthropic wire's equivalent is
 *    `{ type: "tool_use", id, name, input }`. This is the one divergence
 *    LLP 0159 already names.
 *  - A session-file tool result is its own top-level record,
 *    `{ role: "toolResult", toolCallId, toolName, content, isError }`, not
 *    a `tool_result` block nested inside a `user`-role message the way the
 *    Anthropic Messages wire nests it. There is no per-block wire
 *    equivalent to fold through a block-kind synonym alone; see
 *    `sessionMatchKey` below for how this is reconciled.
 *
 * One canonical, shape-independent tuple format
 * (`{ kind: string, identity: string }[]`), fed by two shape-specific
 * builders (`wireMatchKey`, `sessionMatchKey`), both funneling into one
 * hash function (`canonicalMatchKey`) so there is exactly one hash
 * implementation to drift, the LLP 0150 anti-drift argument applied to a
 * hash instead of a file parse.
 *
 * @ref LLP 0161#match-keys [implements]: one canonical tuple format fed by
 * two shape-specific builders, both funneling into one hash function
 * @ref LLP 0157#requirements [implements]: R8, stamp the LLP 0159 match
 * key on every fallback-identity row
 */

/**
 * OpenClaw session-file block-kind synonym table. A small, explicitly
 * incomplete table (LLP 0162's "living list" norm), not a hardcoded pair:
 * a later addition is a one-line diff here, not a new code path.
 * `toolCall` -> `tool_use` is the one mapping LLP 0159 names; `toolUse`,
 * `function_call`, and `functionCall` are included because the same
 * openclaw source that defines `ToolCall.type = "toolCall"`
 * (`packages/llm-core/src/types.ts`) also accepts them as tool-call
 * synonyms elsewhere in its own normalization (e.g.
 * `session-transcript-repair.attachments.test.ts`'s `type: "toolUse"`
 * fixtures). `redacted_thinking` folds into `thinking`: both are the same
 * logical block (a redacted thinking block just has no visible text, only
 * an opaque signature), and `wireMatchKey`'s Anthropic wire side already
 * treats them as one case.
 *
 * @ref LLP 0159#open-questions [implements]: "OpenClaw's session file
 * stores its own normalized message shape (for example toolCall blocks
 * where the Anthropic wire has tool_use)", generalized to a table instead
 * of a hardcoded pair
 * @type {Map<string, string>}
 */
const BLOCK_KIND_SYNONYMS = new Map([
  ['toolCall', 'tool_use'],
  ['toolUse', 'tool_use'],
  ['function_call', 'tool_use'],
  ['functionCall', 'tool_use'],
  ['redacted_thinking', 'thinking'],
])

/** @param {string} rawKind */
function normalizeBlockKind(rawKind) {
  return BLOCK_KIND_SYNONYMS.get(rawKind) ?? rawKind
}

/**
 * The timestamp prefix OpenClaw prepends to user messages ON THE WIRE but
 * not in its session file: `[Mon 2026-08-03 15:33 PDT] What is ...` goes
 * upstream while the file stores the bare `What is ...`. Verified live
 * (LLP 0175 evidence, 2026-08-03): with the prefix hashed into the wire
 * key, every user turn content-missed and stayed at fallback identity
 * while the same exchange's assistant turns settled, so the one residual
 * duplication after the header fix was exactly the prefixed user rows.
 *
 * Weekday, ISO date, HH:MM(:SS optional), and a 1-6 char uppercase zone
 * abbreviation, then `] ` - the shape observed on real captures. The strip
 * is applied symmetrically by {@link reduceBlock} to BOTH match-key
 * builders, so a text that legitimately starts with such a stamp on both
 * sides still matches (both get stripped), and a one-sided stamp (the bug)
 * stops mattering.
 */
const WIRE_TIMESTAMP_PREFIX = /^\[[A-Z][a-z]{2} \d{4}-\d{2}-\d{2} \d{1,2}:\d{2}(?::\d{2})? [A-Z]{1,6}\] /

/**
 * @param {string} text
 * @returns {string}
 * @ref LLP 0175#fix-direction [implements]: the settle residual - normalize
 *   OpenClaw's wire-only user-message timestamp prefix out of the match key
 */
function normalizeMatchText(text) {
  return text.replace(WIRE_TIMESTAMP_PREFIX, '')
}

/**
 * The canonical role+tuple hash both match-key builders below funnel into.
 *
 * @param {string} role
 * @param {Array<{ kind: string, identity: string }>} tuples
 * @returns {string}
 */
export function canonicalMatchKey(role, tuples) {
  return sha256Hex(`${role}:${canonicalJson(tuples)}`)
}

/**
 * Coerce a message's `content` into a plain-object block array, mirroring
 * the Claude precedent's `normalizeContent`: a bare string is one text
 * block, a non-array/non-string content value has no blocks.
 *
 * @param {unknown} content
 * @returns {Record<string, unknown>[]}
 */
function normalizeToBlocks(content) {
  if (typeof content === 'string') {
    return content.length === 0 ? [] : [{ type: 'text', text: content }]
  }
  if (Array.isArray(content)) return content.filter(isPlainObject)
  return []
}

/**
 * Reduce one already-stripped wire/session content block to its canonical
 * `{ kind, identity }` tuple. `identity` is deliberately never the
 * block's own id/`tool_use_id`: openclaw can assign a fresh synthetic id
 * to a text-promoted tool call on replay (verified:
 * `createStandaloneTextToolCallId()` in the openclaw source), which would
 * make id-based identity diverge between the two capture routes for
 * exactly the turns this match key exists to reconcile. Every kind's
 * identity is instead a content hash, matching the design's own framing
 * ("identity: the text hash or the tool name plus argument hash").
 *
 * @param {Record<string, unknown>} block
 * @returns {{ kind: string, identity: string }}
 */
function reduceBlock(block) {
  const kind = normalizeBlockKind(stringValue(block.type) ?? 'unknown')
  if (kind === 'tool_use') {
    const name = stringValue(block.name) ?? ''
    const args = block.arguments ?? block.input ?? {}
    return { kind, identity: sha256Hex(`${name}:${canonicalJson(args)}`) }
  }
  if (kind === 'tool_result') {
    // Anthropic wire tool_result blocks carry `tool_use_id`/`is_error`
    // alongside `content`; the session-side synthesized tuple (see
    // sessionMatchKey) carries only `content`. Hashing `content` alone
    // keeps both sides comparable without needing to reconcile the
    // differently-cased/differently-shaped surrounding fields.
    return { kind, identity: sha256Hex(canonicalJson(block.content ?? null)) }
  }
  if (kind === 'thinking') {
    const thinking = stringValue(block.thinking)
    const signature = stringValue(block.thinkingSignature) ?? stringValue(block.signature) ?? stringValue(block.thought_signature)
    return { kind, identity: sha256Hex(thinking ?? signature ?? '') }
  }
  if (kind === 'text') {
    return { kind, identity: sha256Hex(normalizeMatchText(stringValue(block.text) ?? '')) }
  }
  // Generic fallback for image blocks and any future/unrecognized kind:
  // hash the whole stripped block minus its own type tag, so an
  // unrecognized kind still gets a stable (if coarse) identity instead of
  // collapsing every block of that kind onto one hash.
  const { type: _type, ...rest } = block
  return { kind, identity: sha256Hex(canonicalJson(rest)) }
}

/**
 * Build the match key for one Anthropic/OpenAI wire-shaped message.
 * Called by the projector at capture time (design Section 3.5), stamped
 * as `attributes.openclaw.match_key` on every row emitted under fallback
 * identity (R8): the wire content is in hand at projection, so settlement
 * only needs a lookup, never a reconstruction.
 *
 * @ref LLP 0161#match-keys [implements]: wireMatchKey builds tuples from
 * Anthropic/OpenAI wire-shaped blocks via stripVolatileBlockFields plus a
 * per-block {kind, identity} reduction
 * @param {string} role
 * @param {unknown} content
 * @returns {string}
 */
export function wireMatchKey(role, content) {
  const blocks = /** @type {Record<string, unknown>[]} */ (stripVolatileBlockFields(normalizeToBlocks(content)))
  return canonicalMatchKey(role, blocks.map(reduceBlock))
}

/**
 * Build the match key for one OpenClaw session-file message record,
 * through the block-kind synonym table (`BLOCK_KIND_SYNONYMS`) and one
 * message-shape reconciliation the table alone cannot express: a
 * session-file `role: "toolResult"` record has no per-block wire
 * equivalent (its `toolCallId`/`toolName` live on the message, not on a
 * content block), so it is folded into a single synthetic `tool_result`
 * tuple under the `user` role, mirroring how the Anthropic Messages wire
 * nests a `tool_result` block inside a `user` turn -- the shape the real
 * session fixture's `api: "anthropic-messages"` field confirms is what
 * OpenClaw's own backend speaks. A session captured against an
 * OpenAI-shaped wire (`role: "tool"`, not nested in `user`) will not match
 * this normalization and falls through to the ordinal/time fallback
 * below: an accepted, documented residue, not a bug, matching LLP 0159's
 * Open Questions ("measure it during implementation and revisit this
 * decision if content matching proves unreliable").
 *
 * `blocks` is the session record's own content: for a `toolResult` role
 * record, its `content` field (a string or a `TextContent`/`ImageContent`
 * array); for every other role, its `content` block array unchanged.
 *
 * @ref LLP 0159#open-questions [implements]: the toolCall/tool_use
 * divergence, generalized to a synonym table, plus the toolResult
 * message-shape reconciliation verified against the real session-file
 * fixture shape
 * @param {string} role
 * @param {unknown} blocks
 * @returns {string}
 */
export function sessionMatchKey(role, blocks) {
  if (role === 'toolResult') {
    const content = Array.isArray(blocks) ? stripVolatileBlockFields(blocks.filter(isPlainObject)) : blocks
    return canonicalMatchKey('user', [reduceBlock({ type: 'tool_result', content })])
  }
  const stripped = /** @type {Record<string, unknown>[]} */ (stripVolatileBlockFields(normalizeToBlocks(blocks)))
  return canonicalMatchKey(role, stripped.map(reduceBlock))
}

/**
 * Bound for the ordinal/time fallback matcher: a five-minute window
 * around the row's own `message_created_at`.
 *
 * @ref LLP 0161#match-keys [implements]: "(role, ordinal among same-role
 * messages in the session) bounded to a five-minute window"
 */
export const ORDINAL_FALLBACK_WINDOW_MS = 5 * 60 * 1000

/**
 * The lookup key for the ordinal/time fallback pass: same role, same
 * 1-based position among same-role messages. Deliberately not hashed
 * (unlike `canonicalMatchKey`): the input space is small and stable, and
 * a readable key keeps index dumps debuggable when measuring the
 * settlement match rate (LLP 0159's implementation-time check).
 *
 * @param {string} role
 * @param {number} ordinal
 * @returns {string}
 */
export function ordinalFallbackKey(role, ordinal) {
  return `${role}#${ordinal}`
}

/**
 * Assign each entry its 1-based ordinal among same-role entries, in the
 * order given. Shared by both sides of the fallback pass: a caller uses
 * it once over a session's ordered transcript to build the fallback index
 * below, and again over one session's own committed rows (in
 * `message_created_at` order) to find a miss row's own ordinal, so both
 * sides count the same way.
 *
 * @template T
 * @param {T[]} entries
 * @param {(entry: T) => string} roleOf
 * @returns {Array<{ entry: T, role: string, ordinal: number }>}
 */
export function withRoleOrdinals(entries, roleOf) {
  /** @type {Map<string, number>} */
  const counts = new Map()
  return entries.map((entry) => {
    const role = roleOf(entry)
    const ordinal = (counts.get(role) ?? 0) + 1
    counts.set(role, ordinal)
    return { entry, role, ordinal }
  })
}

/**
 * Build the ordinal/time fallback index from a session's ordered message
 * records: for each `(role, ordinal)` position, every candidate's
 * timestamp and a caller-supplied payload (the settlement enricher stores
 * its native-identity payload here).
 *
 * @template T
 * @param {Array<{ role: string, timestampMs: number, value: T }>} entries
 * @returns {Map<string, Array<{ timestampMs: number, value: T }>>}
 */
export function buildOrdinalFallbackIndex(entries) {
  /** @type {Map<string, Array<{ timestampMs: number, value: T }>>} */
  const index = new Map()
  for (const { entry, role, ordinal } of withRoleOrdinals(entries, (item) => item.role)) {
    const key = ordinalFallbackKey(role, ordinal)
    const record = { timestampMs: entry.timestampMs, value: entry.value }
    const list = index.get(key)
    if (list) list.push(record)
    else index.set(key, [record])
  }
  return index
}

/**
 * The ordinal/time fallback matcher (design Section 5): retried only when
 * content matching (`canonicalMatchKey`/`wireMatchKey`/`sessionMatchKey`)
 * already missed, as a deliberately separate second pass, never merged
 * into the same score as content matching -- a match via content hash
 * (strong evidence) and a match via ordinal-plus-time (weaker evidence,
 * degrades gracefully as sessions replay or retry) must never be
 * conflated in the same code path, so the two passes can be tuned
 * independently later. Picks the index candidate at `(role, ordinal)`
 * closest in time to `rowTimestampMs`, bounded to
 * `ORDINAL_FALLBACK_WINDOW_MS`; `undefined` when there is no candidate in
 * the window.
 *
 * @ref LLP 0161#match-keys [implements]: "retry once against (role,
 * ordinal among same-role messages in the session) bounded to a
 * five-minute window", as a narrower, second-pass matcher rather than a
 * merged first-pass score
 * @template T
 * @param {Map<string, Array<{ timestampMs: number, value: T }>>} index
 * @param {string} role
 * @param {number} ordinal
 * @param {number} rowTimestampMs
 * @returns {T | undefined}
 */
export function matchOrdinalFallback(index, role, ordinal, rowTimestampMs) {
  const candidates = index.get(ordinalFallbackKey(role, ordinal))
  if (!candidates || candidates.length === 0) return undefined
  /** @type {{ timestampMs: number, value: T } | undefined} */
  let best
  let bestDelta = Infinity
  for (const candidate of candidates) {
    const delta = Math.abs(candidate.timestampMs - rowTimestampMs)
    if (delta > ORDINAL_FALLBACK_WINDOW_MS) continue
    if (delta < bestDelta) {
      best = candidate
      bestDelta = delta
    }
  }
  return best?.value
}
