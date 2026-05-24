// @ts-check

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

/**
 * Claude Code JSONL transcript reader. The Claude CLI writes one
 * JSONL file per session under `<homeDir>/.claude/projects/<repo>/<session-id>.jsonl`
 * (and optionally the hook tells us the exact path through
 * `transcript_path` on the session-context channel). Every line is a
 * record like:
 *
 * ```jsonl
 * {"sessionId":"...","uuid":"u-1","parentUuid":null,"type":"user","message":{...},"timestamp":"..."}
 * {"sessionId":"...","uuid":"u-2","parentUuid":"u-1","type":"assistant","message":{...},"timestamp":"..."}
 * ```
 *
 * The projector calls `loadTranscript()` per exchange. The reader is
 * best-effort: a missing directory, a missing file, or a truncated
 * line never throws — projection falls back to gateway-computed
 * identity in that case.
 */

/**
 * @import { TranscriptEntry } from './types.d.ts'
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
 *    session-context state file), read THAT file. Cheap and direct,
 *    no filesystem walk.
 *  - Otherwise scan `<projectsDir>/**\/<sessionId>.jsonl` and
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
  } else {
    for (const filePath of walkJsonlFiles(opts.projectsDir, opts.sessionId)) {
      await readTranscriptFile(filePath, entries)
    }
  }
  entries.sort((a, b) => (a.timestampMs ?? Number.POSITIVE_INFINITY) - (b.timestampMs ?? Number.POSITIVE_INFINITY))
  return entries
}

/**
 * Index transcript entries by their `provider_uuid`. The projector
 * walks projected messages and, for each one, looks up the matching
 * transcript entry by `uuid` (when the response carries one) or by a
 * canonicalized role+content key.
 *
 * @param {TranscriptEntry[]} entries
 */
export function indexTranscriptEntries(entries) {
  /** @type {Map<string, TranscriptEntry>} */
  const byUuid = new Map()
  /** @type {Map<string, TranscriptEntry>} */
  const byContentKey = new Map()
  /** @type {Map<string, TranscriptEntry>} */
  const byMessageId = new Map()
  for (const entry of entries) {
    if (entry.provider_uuid) byUuid.set(entry.provider_uuid, entry)
    if (entry.messageId) byMessageId.set(entry.messageId, entry)
    if (entry.contentKey) byContentKey.set(entry.contentKey, entry)
  }
  return { byUuid, byContentKey, byMessageId, ordered: entries }
}

/**
 * Find the transcript entry that matches one projected message. The
 * projection has no `uuid` of its own (the Anthropic wire format
 * doesn't carry one on request rows), so we look it up via the
 * response `message.id` for assistant messages and via canonical
 * role+content for everything else.
 *
 * @param {ReturnType<typeof indexTranscriptEntries>} index
 * @param {{ role: string, content: unknown, messageId?: string }} candidate
 */
export function findTranscriptMatch(index, candidate) {
  if (candidate.messageId) {
    const byId = index.byMessageId.get(candidate.messageId)
    if (byId) return byId
  }
  const key = contentKey(candidate.role, normalizeContent(candidate.content))
  return index.byContentKey.get(key)
}

/**
 * @param {string} dir
 * @param {string} sessionId
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
      yield* walkJsonlFiles(filePath, sessionId)
    } else if (entry.isFile() && entry.name === `${sessionId}.jsonl`) {
      yield filePath
    }
  }
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
    entrypoint: stringValue(row.entrypoint),
    client_version: stringValue(row.version) ?? stringValue(row.claude_version),
    user_type: stringValue(row.userType) ?? stringValue(row.user_type),
    permission_mode: stringValue(row.permissionMode) ?? stringValue(row.permission_mode),
    is_sidechain: typeof row.isSidechain === 'boolean' ? row.isSidechain : undefined,
    attachment_type: stringValue(readKey(attachment, 'type')),
    hook_event: stringValue(readKey(attachment, 'hookEvent')) ?? stringValue(row.hookEvent),
    is_compact_summary: typeof row.isCompactSummary === 'boolean' ? row.isCompactSummary : undefined,
    compact_metadata: readKey(row, 'compactMetadata') ?? readKey(row, 'compact_metadata'),
    raw_frame: row,
  }
  if (!entry.messageId && !entry.contentKey && !entry.provider_uuid) return undefined
  return entry
}

/**
 * @param {string} role
 * @param {unknown} content
 */
function contentKey(role, content) {
  return sha256Hex(`${role}:${canonicalJson(content)}`)
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
