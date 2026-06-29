// @ts-check

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

/**
 * Claude Code JSONL transcript reader. The Claude CLI writes one
 * JSONL file per session under `<homeDir>/.claude/projects/<repo>/<session-id>.jsonl`
 * (and optionally the hook tells us the exact path through
 * `transcript_path` on the session-context channel). Subagent
 * (sidechain) entries are NOT in the session file: the CLI splits them
 * into `<repo>/<session-id>/subagents/agent-*.jsonl`, one file per
 * agent, with each entry still carrying the parent `sessionId`. A
 * session's transcript is therefore the session file PLUS everything
 * under its session-named directory. Every line is a record like:
 *
 * ```jsonl
 * {"sessionId":"...","uuid":"u-1","parentUuid":null,"type":"user","message":{...},"timestamp":"..."}
 * {"sessionId":"...","uuid":"u-2","parentUuid":"u-1","type":"assistant","message":{...},"timestamp":"..."}
 * ```
 *
 * The projector calls `loadTranscript()` per exchange. The reader is
 * best-effort: a missing directory, a missing file, or a truncated
 * line never throws: projection falls back to gateway-computed
 * identity in that case.
 */

/**
 * @import { TranscriptEntry } from './types.js'
 */

/**
 * @param {string} homeDir
 */
export function defaultClaudeProjectsDir(homeDir) {
  return path.join(homeDir, '.claude', 'projects')
}

/**
 * Load the transcript entries for one session.
 *
 * Lookup order:
 *  - When `transcriptPath` is provided (e.g. straight off the
 *    session-context state file), read THAT file plus the subagent
 *    files under its sibling session directory. Cheap and direct,
 *    no projects-wide walk.
 *  - Otherwise scan `<projectsDir>/**\/<sessionId>.jsonl` (which also
 *    descends into `<sessionId>/` directories for subagent files) and
 *    concatenate matching files.
 *
 * @param {{
 *   projectsDir: string,
 *   sessionId: string,
 *   transcriptPath?: string,
 * }} opts
 * @returns {Promise<TranscriptEntry[]>}
 */
export async function loadTranscript(opts) {
  /** @type {TranscriptEntry[]} */
  const entries = []
  if (opts.transcriptPath) {
    await readTranscriptFile(opts.transcriptPath, entries)
    // Subagent transcripts live next to the session file in a directory
    // named for the session, not inside it: without this walk every
    // sidechain message misses transcript identity and lands as a
    // gateway-fallback row that later duplicates against the backfill.
    const sessionDir = path.join(
      path.dirname(opts.transcriptPath),
      path.basename(opts.transcriptPath, '.jsonl')
    )
    for (const filePath of walkJsonlFiles(sessionDir, undefined)) {
      await readTranscriptFile(filePath, entries)
    }
  } else {
    for (const filePath of walkJsonlFiles(opts.projectsDir, opts.sessionId)) {
      await readTranscriptFile(filePath, entries)
    }
  }
  entries.sort(byTimestampAsc)
  return entries
}

/**
 * Walk every Claude JSONL transcript under `projectsDir`, yielding
 * absolute file paths. `loadTranscript()` targets one live session;
 * the backfill provider needs the full local history, so this exposes
 * the same recursive scan without a session-id filter.
 *
 * @param {string} projectsDir
 * @returns {Generator<string>}
 */
export function* walkTranscriptFiles(projectsDir) {
  yield* walkJsonlFiles(projectsDir, undefined)
}

/**
 * Read the subagent metadata sidecars Claude Code writes beside each
 * subagent transcript: `<sessionDir>/subagents/agent-<agentId>.meta.json`.
 * The sidecar's `toolUseId` is the parent-thread `Agent`/`Task` tool call
 * that spawned the subagent: provenance that lives in neither the
 * subagent's own `.jsonl` (its first line has null parent/source uuids)
 * nor the wire exchange. Returns a map keyed by the agent id parsed from
 * each filename.
 *
 * Resolution mirrors `loadTranscript`: a `transcriptPath` scans just that
 * session's directory (cheap: the live path); otherwise `projectsDir`
 * is scanned recursively (the backfill path). Best-effort: a missing
 * directory or an unparseable sidecar is skipped, never thrown.
 *
 * @param {{ transcriptPath?: string, projectsDir?: string }} opts
 * @returns {Map<string, { tool_use_id: string }>}
 */
export function loadAgentMeta(opts) {
  /** @type {Map<string, { tool_use_id: string }>} */
  const meta = new Map()
  const rootDir = opts.transcriptPath
    ? path.join(path.dirname(opts.transcriptPath), path.basename(opts.transcriptPath, '.jsonl'))
    : opts.projectsDir
  if (!rootDir) return meta
  for (const { agentId, filePath } of walkAgentMetaFiles(rootDir)) {
    let parsed
    try { parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch { continue }
    if (!isPlainObject(parsed)) continue
    const toolUseId = stringValue(parsed.toolUseId)
    if (toolUseId) meta.set(agentId, { tool_use_id: toolUseId })
  }
  return meta
}

/**
 * Yield `{ agentId, filePath }` for every `agent-<id>.meta.json` sidecar
 * under `dir`, recursing into subdirectories (the sidecars live in
 * `<sessionDir>/subagents/`). The agent id is parsed from the filename.
 *
 * @param {string} dir
 * @returns {Generator<{ agentId: string, filePath: string }>}
 */
function* walkAgentMetaFiles(dir) {
  /** @type {fs.Dirent[]} */
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const filePath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walkAgentMetaFiles(filePath)
    } else if (entry.isFile()) {
      const match = /^agent-(.+)\.meta\.json$/.exec(entry.name)
      if (match) yield { agentId: match[1], filePath }
    }
  }
}

/**
 * Load and timestamp-sort the entries in a single transcript file.
 * Best-effort like `loadTranscript`: a missing or truncated file
 * yields whatever parsed cleanly. The backfill provider walks files
 * directly (one file per session) rather than resolving a session id.
 *
 * @param {string} filePath
 * @returns {Promise<TranscriptEntry[]>}
 */
export async function loadTranscriptFile(filePath) {
  /** @type {TranscriptEntry[]} */
  const entries = []
  await readTranscriptFile(filePath, entries)
  entries.sort(byTimestampAsc)
  return entries
}

/**
 * @param {TranscriptEntry} a
 * @param {TranscriptEntry} b
 */
function byTimestampAsc(a, b) {
  return (a.timestampMs ?? Number.POSITIVE_INFINITY) - (b.timestampMs ?? Number.POSITIVE_INFINITY)
}

/**
 * Index transcript entries for the projector's wire→line matching.
 *
 * // @ref LLP 0026#decision: one line per native DAG node: an API
 * // message spans SEVERAL lines (one per assistant block), so the
 * // message-id index must keep the ordered list, not last-wins.
 *
 *  - `byUuid`        : native uuid → entry.
 *  - `byMessageId`   : API `message.id` → ordered entry list (block
 *                      order; assistant turns split one line per block
 *                      all sharing the API id).
 *  - `byToolUseId`   : `tool_use_id` of a user tool_result line →
 *                      entry. Each tool_result is its own line, so
 *                      this is a unique join key.
 *  - `byContentKey`  : canonicalized role+content key → entry.
 *
 * @param {TranscriptEntry[]} entries
 */
export function indexTranscriptEntries(entries) {
  /** @type {Map<string, TranscriptEntry>} */
  const byUuid = new Map()
  /** @type {Map<string, TranscriptEntry>} */
  const byContentKey = new Map()
  /** @type {Map<string, TranscriptEntry[]>} */
  const byMessageId = new Map()
  /** @type {Map<string, TranscriptEntry>} */
  const byToolUseId = new Map()
  for (const entry of entries) {
    if (entry.provider_uuid) byUuid.set(entry.provider_uuid, entry)
    if (entry.messageId) {
      const list = byMessageId.get(entry.messageId)
      if (list) list.push(entry)
      else byMessageId.set(entry.messageId, [entry])
    }
    if (entry.contentKey) byContentKey.set(agentScopedKey(entry.agent_id, entry.contentKey), entry)
    const toolUseId = entryToolUseId(entry)
    if (toolUseId) byToolUseId.set(toolUseId, entry)
  }
  return { byUuid, byContentKey, byMessageId, byToolUseId, ordered: entries }
}

/**
 * Namespace a content key by agent so the main loop and each subagent
 * occupy separate key-spaces. A session's transcript holds the main
 * loop AND every subagent, and content can repeat across them; without
 * this a subagent block could match a main-session (or other-agent)
 * entry and inherit the wrong uuid / `is_sidechain`. `byMessageId` and
 * `byToolUseId` need no scoping: those ids are globally unique.
 * `agent_id` empty/undefined is the main loop; ids and content keys are
 * hex, so `:` is an unambiguous separator.
 *
 * // @ref LLP 0026#decision: match within a thread, not across the session.
 *
 * @param {string | undefined} agentId
 * @param {string} contentKey
 */
export function agentScopedKey(agentId, contentKey) {
  return `${agentId ?? ''}:${contentKey}`
}

/**
 * The `tool_use_id` answered by a user tool_result line, when the
 * entry is one. Claude Code writes one line per tool_result, so a
 * single id per entry is the invariant (the first one wins if a
 * legacy multi-result line ever shows up).
 *
 * @param {TranscriptEntry} entry
 */
function entryToolUseId(entry) {
  if (entry.role !== 'user') return undefined
  const content = entry.content
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (isPlainObject(block) && block.type === 'tool_result') {
      const id = stringValue(block.tool_use_id)
      if (id) return id
    }
  }
  return undefined
}

/**
 * Find the transcript entry that matches one projected message by
 * canonical role+content key, with an optional `message.id` shortcut
 * that only applies when the id maps to exactly one line (an API
 * message split across several lines is ambiguous at message
 * granularity: the splitter aligns those per block instead).
 *
 * The content-key lookup is scoped to `candidate.agentId` (the
 * exchange's `x-claude-code-agent-id`, empty for the main loop) so a
 * block only matches entries from its own thread. The `message.id`
 * shortcut needs no scoping (API ids are globally unique).
 *
 * @param {ReturnType<typeof indexTranscriptEntries>} index
 * @param {{ role: string, content: unknown, messageId?: string, agentId?: string }} candidate
 */
export function findTranscriptMatch(index, candidate) {
  if (candidate.messageId) {
    const byId = index.byMessageId.get(candidate.messageId)
    if (byId && byId.length === 1) return byId[0]
  }
  return index.byContentKey.get(agentScopedKey(candidate.agentId, matchKey(candidate.role, candidate.content)))
}

/**
 * The canonical role+content lookup key for matching a wire message to
 * its transcript line. Exported so the projector can stamp it on a
 * fallback row at projection time (when wire content is in hand) and
 * flush-time settlement can re-match by pure lookup once the transcript
 * line lands: without reconstructing the lost content array.
 *
 * // @ref LLP 0027#decision: match-key at projection enables flush-time settlement.
 *
 * @param {string} role
 * @param {unknown} content
 */
export function matchKey(role, content) {
  return contentKey(role, normalizeContent(content))
}

/**
 * Copy a transcript line's native identity and provenance onto a target
 * object keyed by the canonical `ai_gateway_messages` field names. The
 * single source of truth shared by the live projector
 * (`applyTranscriptMatch`, target = projected message) and flush-time
 * settlement (target = a stored row). Sets `message_id`/`provider_uuid`
 * only when the entry has a native uuid; `previous_message_id` is left
 * to the gateway (full prior-message chain) so enriched and fallback
 * rows stay one shape.
 *
 * // @ref LLP 0027#decision: one identity-copy core for projection and settlement.
 *
 * @param {Record<string, unknown>} target
 * @param {TranscriptEntry} match
 */
export function assignTranscriptIdentity(target, match) {
  if (match.provider_uuid) {
    target.message_id = match.provider_uuid
    target.provider_uuid = match.provider_uuid
  }
  if (match.parent_uuid) target.parent_uuid = match.parent_uuid
  if (match.logical_parent_uuid) target.logical_parent_uuid = match.logical_parent_uuid
  if (match.source_tool_assistant_uuid) target.source_tool_assistant_uuid = match.source_tool_assistant_uuid
  if (match.request_id) target.request_id = match.request_id
  if (match.prompt_id) target.prompt_id = match.prompt_id
  if (match.provider_type) target.provider_type = match.provider_type
  if (match.provider_subtype) target.provider_subtype = match.provider_subtype
  if (match.entrypoint) target.entrypoint = match.entrypoint
  if (match.user_type) target.user_type = match.user_type
  if (match.permission_mode) target.permission_mode = match.permission_mode
  if (match.is_sidechain !== undefined) target.is_sidechain = match.is_sidechain
  if (match.agent_id) target.agent_id = match.agent_id
  if (match.attachment_type) target.attachment_type = match.attachment_type
  if (match.hook_event) target.hook_event = match.hook_event
  if (match.is_compact_summary !== undefined) target.is_compact_summary = match.is_compact_summary
  if (match.compact_metadata !== undefined) target.compact_metadata = match.compact_metadata
  if (isPlainObject(match.raw_frame)) target.raw_frame = match.raw_frame
}

/**
 * The block type a single transcript line holds: used by the
 * splitter's order-alignment sanity check. String content is a text
 * line; array content reports the first block's type (lines are
 * single-block in current transcripts).
 *
 * @param {TranscriptEntry} entry
 */
export function entryBlockType(entry) {
  const content = entry.content
  if (typeof content === 'string') return 'text'
  if (Array.isArray(content) && isPlainObject(content[0])) {
    return stringValue(content[0].type) ?? 'text'
  }
  return undefined
}

/**
 * @param {string} dir
 * @param {string | undefined} sessionId  match `<sessionId>.jsonl`; when
 *   undefined, match every `.jsonl` file (full backfill scan)
 * @returns {Generator<string>}
 */
function* walkJsonlFiles(dir, sessionId) {
  /** @type {fs.Dirent[]} */
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const filePath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      // A directory named for the session holds per-session files the
      // CLI splits out of the main transcript (subagents/agent-*.jsonl).
      // Everything under it belongs to the session, so drop the filter.
      yield* walkJsonlFiles(filePath, entry.name === sessionId ? undefined : sessionId)
    } else if (entry.isFile() && matchesTranscriptName(entry.name, sessionId)) {
      yield filePath
    }
  }
}

/**
 * @param {string} name
 * @param {string | undefined} sessionId
 */
function matchesTranscriptName(name, sessionId) {
  if (sessionId === undefined) return name.endsWith('.jsonl')
  return name === `${sessionId}.jsonl`
}

/**
 * @param {string} filePath
 * @param {TranscriptEntry[]} entries
 * @returns {Promise<void>}
 */
async function readTranscriptFile(filePath, entries) {
  /** @type {fs.ReadStream} */
  let stream
  try {
    stream = fs.createReadStream(filePath, { encoding: 'utf8' })
  } catch {
    return
  }
  stream.on('error', () => {})
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (!line) continue
      let row
      try { row = JSON.parse(line) } catch { continue }
      const entry = transcriptEntryFromRow(row)
      if (entry) entries.push(entry)
    }
  } catch { /* truncated/rotated file → best-effort */ }
}

/**
 * @param {unknown} row
 * @returns {TranscriptEntry | undefined}
 */
function transcriptEntryFromRow(row) {
  if (!isPlainObject(row)) return undefined
  const sessionId = stringValue(row.sessionId)
  if (!sessionId) return undefined
  const message = isPlainObject(row.message) ? row.message : undefined
  const role = stringValue(readKey(message, 'role')) ??
    (row.type === 'user' || row.type === 'assistant' ? /** @type {string} */ (row.type) : undefined)
  const content = readKey(message, 'content')
  const attachment = isPlainObject(row.attachment) ? row.attachment : undefined
  /** @type {TranscriptEntry} */
  const entry = {
    sessionId,
    role,
    content,
    cwd: stringValue(row.cwd),
    timestampMs: timestampMs(row.timestamp),
    messageId: stringValue(readKey(message, 'id')) ?? stringValue(row.messageId),
    contentKey: role ? contentKey(role, normalizeContent(content)) : undefined,
    provider_uuid: stringValue(row.uuid),
    parent_uuid: stringValue(row.parentUuid) ?? stringValue(row.parent_uuid),
    logical_parent_uuid: stringValue(row.logicalParentUuid) ?? stringValue(row.logical_parent_uuid),
    source_tool_assistant_uuid: stringValue(row.sourceToolAssistantUUID) ?? stringValue(row.source_tool_assistant_uuid),
    request_id: stringValue(row.requestId) ?? stringValue(row.request_id),
    prompt_id: stringValue(row.promptId) ?? stringValue(row.prompt_id),
    provider_type: stringValue(row.type),
    provider_subtype: stringValue(row.subtype),
    model: transcriptModel(message),
    entrypoint: stringValue(row.entrypoint),
    client_version: stringValue(row.version) ?? stringValue(row.claude_version),
    user_type: stringValue(row.userType) ?? stringValue(row.user_type),
    permission_mode: stringValue(row.permissionMode) ?? stringValue(row.permission_mode),
    is_sidechain: typeof row.isSidechain === 'boolean' ? row.isSidechain : undefined,
    agent_id: stringValue(row.agentId) ?? stringValue(row.agent_id),
    attachment_type: stringValue(readKey(attachment, 'type')),
    hook_event: stringValue(readKey(attachment, 'hookEvent')) ?? stringValue(row.hookEvent),
    is_compact_summary: typeof row.isCompactSummary === 'boolean' ? row.isCompactSummary : undefined,
    compact_metadata: readKey(row, 'compactMetadata') ?? readKey(row, 'compact_metadata'),
    // Claude Code writes the API `usage` block onto assistant transcript lines;
    // backfill surfaces it as attributes.usage to match live capture.
    usage: readKey(message, 'usage'),
    raw_frame: row,
  }
  if (!entry.messageId && !entry.contentKey && !entry.provider_uuid) return undefined
  return entry
}

/**
 * Role+content lookup key for matching a wire message to its
 * transcript entry. The two representations of the same block are not
 * byte-identical: the wire side carries `cache_control` (prompt-cache
 * breakpoints, absent from transcripts and moving between exchanges)
 * and the transcript side annotates tool_use blocks with `caller`
 * (absent on the wire). Both are stripped before hashing so the key
 * compares what the block says, not which channel it came from.
 *
 * @param {string} role
 * @param {unknown} content
 */
function contentKey(role, content) {
  const blocks = Array.isArray(content)
    ? content.map((block) => {
      if (!isPlainObject(block)) return block
      if (!('cache_control' in block) && !('caller' in block)) return block
      const { cache_control: _cache_control, caller: _caller, ...rest } = block
      return rest
    })
    : content
  return sha256Hex(`${role}:${canonicalJson(blocks)}`)
}

/** @param {unknown} content */
function normalizeContent(content) {
  if (typeof content === 'string') {
    return content.length === 0 ? [] : [{ type: 'text', text: content }]
  }
  if (Array.isArray(content)) return content
  return []
}

/** @param {unknown} value */
function canonicalJson(value) {
  return JSON.stringify(sortKeys(value))
}

/** @param {unknown} value */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (isPlainObject(value)) {
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key])
    return out
  }
  return value
}

/** @param {unknown} obj @param {string} key */
function readKey(obj, key) {
  if (!isPlainObject(obj)) return undefined
  return /** @type {Record<string, unknown>} */ (obj)[key]
}

/**
 * The model id from an assistant transcript line's `message.model`.
 *
 * @ref LLP 0026#decision [implements]: native per-line granularity: each
 * assistant line carries its own model, so backfill surfaces it per message
 * rather than collapsing a session to one model. Only assistant lines record
 * `message.model`; user-prompt and tool_result lines have none. Claude Code
 * stamps `<synthetic>` on assistant lines it generates locally (interrupt
 * notices, injected errors) that never hit a model: that is a sentinel, not a
 * model id, so it is dropped to undefined.
 * @param {unknown} message
 */
function transcriptModel(message) {
  const model = stringValue(readKey(message, 'model'))
  return model === '<synthetic>' ? undefined : model
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value */
function stringValue(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** @param {unknown} value */
function timestampMs(value) {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    if (Number.isFinite(ms)) return ms
  }
  return undefined
}

/** @param {string} input */
function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex')
}
