import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

/**
 * @typedef {object} ClaudeContext
 * @property {string | undefined} [cwd]
 * @property {string | undefined} [git_branch]
 * @property {string | undefined} [claude_version]
 */

/**
 * @typedef {ClaudeContext & { timestampMs?: number }} ClaudeContextEntry
 */

/**
 * @typedef {object} ClaudeTranscriptMatch
 * @property {string | undefined} [provider_uuid]
 * @property {string | undefined} [parent_uuid]
 * @property {string | undefined} [logical_parent_uuid]
 * @property {string | undefined} [source_tool_assistant_uuid]
 * @property {string | undefined} [request_id]
 * @property {string | undefined} [prompt_id]
 * @property {string | undefined} [provider_type]
 * @property {string | undefined} [provider_subtype]
 * @property {string | undefined} [entrypoint]
 * @property {string | undefined} [client_version]
 * @property {string | undefined} [user_type]
 * @property {string | undefined} [permission_mode]
 * @property {boolean | undefined} [is_sidechain]
 * @property {string | undefined} [attachment_type]
 * @property {string | undefined} [hook_event]
 * @property {boolean | undefined} [is_compact_summary]
 * @property {unknown} [compact_metadata]
 * @property {unknown} [raw_frame]
 */

/**
 * @typedef {ClaudeTranscriptMatch & {
 *   sessionId: string,
 *   timestampMs?: number,
 *   messageId?: string,
 *   contentKey?: string,
 * }} ClaudeTranscriptEntry
 */

/**
 * @typedef {((sessionId: string | undefined, timestamp: unknown) => ClaudeContext | undefined) & {
 *   matchMessage?: (sessionId: string | undefined, message: Record<string, unknown>, timestamp: unknown) => ClaudeTranscriptMatch | undefined,
 * }} ClaudeContextLookup
 */

/**
 * @param {string} [homeDir]
 * @returns {string}
 */
export function defaultClaudeProjectsDir(homeDir = os.homedir()) {
  return path.join(homeDir, '.claude', 'projects')
}

/**
 * Build a lookup over Claude Code transcript metadata. The call signature
 * returns session context (`cwd`, git branch, version); the returned function
 * also carries `matchMessage()` for proxy-message enrichment with local JSONL
 * frame fields.
 *
 * @param {{ projectsDir?: string, sessionIds?: Iterable<string> }} [opts]
 * @returns {Promise<ClaudeContextLookup>}
 */
export async function loadClaudeContextLookup(opts = {}) {
  const projectsDir = opts.projectsDir ?? defaultClaudeProjectsDir()
  const sessionIds = opts.sessionIds ? new Set(opts.sessionIds) : undefined
  if (sessionIds && sessionIds.size === 0) return emptyLookup
  /** @type {Map<string, ClaudeContextEntry[]>} */
  const contextBySession = new Map()
  /** @type {Map<string, ClaudeTranscriptEntry[]>} */
  const transcriptBySession = new Map()

  for (const filePath of walkJsonlFiles(projectsDir, sessionIds)) {
    await readTranscriptFile(filePath, contextBySession, transcriptBySession)
  }

  for (const entries of contextBySession.values()) {
    entries.sort((a, b) => (a.timestampMs ?? Number.POSITIVE_INFINITY) - (b.timestampMs ?? Number.POSITIVE_INFINITY))
    compactEntries(entries)
  }
  for (const entries of transcriptBySession.values()) {
    entries.sort((a, b) => (a.timestampMs ?? Number.POSITIVE_INFINITY) - (b.timestampMs ?? Number.POSITIVE_INFINITY))
  }
  const transcriptIndexes = buildTranscriptIndexes(transcriptBySession)

  /**
   * @param {string | undefined} sessionId
   * @param {unknown} timestamp
   * @returns {ClaudeContext | undefined}
   */
  function lookup(sessionId, timestamp) {
    if (!sessionId) return undefined
    const entries = contextBySession.get(sessionId)
    if (!entries || entries.length === 0) return undefined
    const entry = nearestEntry(entries, timestampMs(timestamp))
    return entry ? {
      cwd: entry.cwd,
      git_branch: entry.git_branch,
      claude_version: entry.claude_version,
    } : undefined
  }
  const out = /** @type {ClaudeContextLookup} */ (lookup)
  out.matchMessage = function matchMessage(sessionId, message, timestamp) {
    if (!sessionId || !message || typeof message !== 'object') return undefined
    const sessionIndex = transcriptIndexes.get(sessionId)
    if (!sessionIndex) return undefined
    const targetMs = timestampMs(timestamp)
    const messageId = stringValue(message.id)
    if (messageId) {
      const byId = sessionIndex.byMessageId.get(messageId)
      const matched = nearestTranscriptEntry(byId, targetMs)
      if (matched) return projectTranscriptMatch(matched)
    }
    const role = stringValue(message.role)
    if (!role) return undefined
    const key = contentKey(role, normalizeContent(message.content))
    const byContent = sessionIndex.byContentKey.get(key)
    const matched = nearestTranscriptEntry(byContent, targetMs)
    return matched ? projectTranscriptMatch(matched) : undefined
  }
  return out
}

/**
 * Extract Claude Code session ids from recorded proxy exchange rows without
 * retaining request content.
 *
 * @param {Iterable<Record<string, unknown>>} exchanges
 * @returns {Set<string>}
 */
export function sessionIdsFromExchanges(exchanges) {
  /** @type {Set<string>} */
  const out = new Set()
  for (const exchange of exchanges) {
    const reqBody = parseMaybeJson(readPath(exchange, ['request', 'body']))
    if (reqBody && typeof reqBody === 'object') {
      const sessionId = readMetadataSessionId(/** @type {Record<string, unknown>} */ (reqBody))
      if (sessionId) out.add(sessionId)
    }
    const headerSession = readHeader(exchange, 'x-claude-code-session-id')
    if (headerSession) out.add(headerSession)
  }
  return out
}

/**
 * @param {string} dir
 * @param {Set<string> | undefined} sessionIds
 * @returns {Generator<string>}
 */
function* walkJsonlFiles(dir, sessionIds) {
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
      yield* walkJsonlFiles(filePath, sessionIds)
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      if (sessionIds && !sessionIds.has(entry.name.slice(0, -'.jsonl'.length))) continue
      yield filePath
    }
  }
}

/**
 * @param {string} filePath
 * @param {Map<string, ClaudeContextEntry[]>} contextBySession
 * @param {Map<string, ClaudeTranscriptEntry[]>} transcriptBySession
 * @returns {Promise<void>}
 */
async function readTranscriptFile(filePath, contextBySession, transcriptBySession) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
  stream.on('error', () => {})
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (!line) continue
      let row
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      const entry = contextEntryFromRow(row)
      if (entry) {
        let entries = contextBySession.get(entry.sessionId)
        if (!entries) {
          entries = []
          contextBySession.set(entry.sessionId, entries)
        }
        entries.push(entry)
      }
      const transcript = transcriptEntryFromRow(row)
      if (transcript) {
        let entries = transcriptBySession.get(transcript.sessionId)
        if (!entries) {
          entries = []
          transcriptBySession.set(transcript.sessionId, entries)
        }
        entries.push(transcript)
      }
    }
  } catch {
    // A transcript file can be rotated or truncated while we scan it. Treat
    // that as a missing enrichment source rather than failing export/query.
  }
}

/**
 * @param {unknown} row
 * @returns {(ClaudeContextEntry & { sessionId: string }) | undefined}
 */
function contextEntryFromRow(row) {
  if (!row || typeof row !== 'object') return undefined
  const obj = /** @type {Record<string, unknown>} */ (row)
  const sessionId = stringValue(obj.sessionId)
  if (!sessionId) return undefined
  const cwd = stringValue(obj.cwd)
  const git_branch = stringValue(obj.gitBranch) ?? stringValue(obj.git_branch)
  const claude_version = stringValue(obj.version) ?? stringValue(obj.claude_version)
  if (!cwd && !git_branch && !claude_version) return undefined
  return {
    sessionId,
    timestampMs: timestampMs(obj.timestamp),
    cwd,
    git_branch,
    claude_version,
  }
}

/**
 * @param {unknown} row
 * @returns {ClaudeTranscriptEntry | undefined}
 */
function transcriptEntryFromRow(row) {
  if (!row || typeof row !== 'object') return undefined
  const obj = /** @type {Record<string, unknown>} */ (row)
  const sessionId = stringValue(obj.sessionId)
  if (!sessionId) return undefined
  const message = isObject(obj.message) ? obj.message : undefined
  const role = stringValue(readKey(message, 'role')) ?? (obj.type === 'user' || obj.type === 'assistant' ? obj.type : undefined)
  const content = readKey(message, 'content')
  const attachment = isObject(obj.attachment) ? obj.attachment : undefined
  /** @type {ClaudeTranscriptEntry} */
  const entry = {
    sessionId,
    timestampMs: timestampMs(obj.timestamp),
    messageId: stringValue(readKey(message, 'id')) ?? stringValue(obj.messageId),
    contentKey: role ? contentKey(role, normalizeContent(content)) : undefined,
    provider_uuid: stringValue(obj.uuid),
    parent_uuid: stringValue(obj.parentUuid) ?? stringValue(obj.parent_uuid),
    logical_parent_uuid: stringValue(obj.logicalParentUuid) ?? stringValue(obj.logical_parent_uuid),
    source_tool_assistant_uuid: stringValue(obj.sourceToolAssistantUUID) ?? stringValue(obj.source_tool_assistant_uuid),
    request_id: stringValue(obj.requestId) ?? stringValue(obj.request_id),
    prompt_id: stringValue(obj.promptId) ?? stringValue(obj.prompt_id),
    provider_type: stringValue(obj.type),
    provider_subtype: stringValue(obj.subtype),
    entrypoint: stringValue(obj.entrypoint),
    client_version: stringValue(obj.version) ?? stringValue(obj.claude_version),
    user_type: stringValue(obj.userType) ?? stringValue(obj.user_type),
    permission_mode: stringValue(obj.permissionMode) ?? stringValue(obj.permission_mode),
    is_sidechain: typeof obj.isSidechain === 'boolean' ? obj.isSidechain : undefined,
    attachment_type: stringValue(readKey(attachment, 'type')),
    hook_event: stringValue(readKey(attachment, 'hookEvent')) ?? stringValue(obj.hookEvent),
    is_compact_summary: typeof obj.isCompactSummary === 'boolean' ? obj.isCompactSummary : undefined,
    compact_metadata: obj.compactMetadata,
    raw_frame: cloneJson(obj),
  }
  if (!entry.messageId && !entry.contentKey && !entry.provider_uuid) return undefined
  return entry
}

/**
 * @param {ClaudeContextEntry[]} entries
 * @returns {void}
 */
function compactEntries(entries) {
  let write = 0
  /** @type {ClaudeContextEntry | undefined} */
  let last
  for (const entry of entries) {
    if (last && sameContext(last, entry)) continue
    entries[write++] = entry
    last = entry
  }
  entries.length = write
}

/**
 * @param {ClaudeContextEntry} a
 * @param {ClaudeContextEntry} b
 * @returns {boolean}
 */
function sameContext(a, b) {
  return a.cwd === b.cwd &&
    a.git_branch === b.git_branch &&
    a.claude_version === b.claude_version
}

/**
 * @template {{ timestampMs?: number }} T
 * @param {T[]} entries
 * @param {number | undefined} targetMs
 * @returns {T | undefined}
 */
function nearestEntry(entries, targetMs) {
  if (entries.length === 0) return undefined
  if (targetMs === undefined) return entries[entries.length - 1]

  let lo = 0
  let hi = entries.length - 1
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    const midMs = entries[mid].timestampMs ?? Number.POSITIVE_INFINITY
    if (midMs < targetMs) lo = mid + 1
    else hi = mid
  }

  const after = entries[lo]
  const before = lo > 0 ? entries[lo - 1] : undefined
  if (!before) return after
  if (!after) return before
  const beforeDistance = Math.abs((before.timestampMs ?? targetMs) - targetMs)
  const afterDistance = Math.abs((after.timestampMs ?? targetMs) - targetMs)
  return beforeDistance <= afterDistance ? before : after
}

/**
 * @param {Map<string, ClaudeTranscriptEntry[]>} transcriptBySession
 * @returns {Map<string, {
 *   byMessageId: Map<string, ClaudeTranscriptEntry[]>,
 *   byContentKey: Map<string, ClaudeTranscriptEntry[]>,
 * }>}
 */
function buildTranscriptIndexes(transcriptBySession) {
  /** @type {Map<string, { byMessageId: Map<string, ClaudeTranscriptEntry[]>, byContentKey: Map<string, ClaudeTranscriptEntry[]> }>} */
  const out = new Map()
  for (const [sessionId, entries] of transcriptBySession) {
    const index = { byMessageId: new Map(), byContentKey: new Map() }
    for (const entry of entries) {
      if (entry.messageId) pushIndex(index.byMessageId, entry.messageId, entry)
      if (entry.contentKey) pushIndex(index.byContentKey, entry.contentKey, entry)
    }
    out.set(sessionId, index)
  }
  return out
}

/**
 * @param {Map<string, ClaudeTranscriptEntry[]>} map
 * @param {string} key
 * @param {ClaudeTranscriptEntry} entry
 * @returns {void}
 */
function pushIndex(map, key, entry) {
  let entries = map.get(key)
  if (!entries) {
    entries = []
    map.set(key, entries)
  }
  entries.push(entry)
}

/**
 * @param {ClaudeTranscriptEntry[] | undefined} entries
 * @param {number | undefined} targetMs
 * @returns {ClaudeTranscriptEntry | undefined}
 */
function nearestTranscriptEntry(entries, targetMs) {
  if (!entries || entries.length === 0) return undefined
  return nearestEntry(entries, targetMs)
}

/**
 * @param {ClaudeTranscriptEntry} entry
 * @returns {ClaudeTranscriptMatch}
 */
function projectTranscriptMatch(entry) {
  return {
    provider_uuid: entry.provider_uuid,
    parent_uuid: entry.parent_uuid,
    logical_parent_uuid: entry.logical_parent_uuid,
    source_tool_assistant_uuid: entry.source_tool_assistant_uuid,
    request_id: entry.request_id,
    prompt_id: entry.prompt_id,
    provider_type: entry.provider_type,
    provider_subtype: entry.provider_subtype,
    entrypoint: entry.entrypoint,
    client_version: entry.client_version,
    user_type: entry.user_type,
    permission_mode: entry.permission_mode,
    is_sidechain: entry.is_sidechain,
    attachment_type: entry.attachment_type,
    hook_event: entry.hook_event,
    is_compact_summary: entry.is_compact_summary,
    compact_metadata: entry.compact_metadata,
    raw_frame: entry.raw_frame,
  }
}

/**
 * @param {string} role
 * @param {unknown} content
 * @returns {string}
 */
function contentKey(role, content) {
  return sha256Hex(`${role}:${canonicalJson(content)}`)
}

/**
 * @param {unknown} content
 * @returns {unknown}
 */
function normalizeContent(content) {
  if (typeof content === 'string') {
    return content.length === 0 ? [] : [{ type: 'text', text: content }]
  }
  if (Array.isArray(content)) return content
  return []
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function canonicalJson(value) {
  return JSON.stringify(sortKeys(value))
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const obj = /** @type {Record<string, unknown>} */ (value)
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortKeys(obj[key])
    }
    return out
  }
  return value
}

/**
 * @param {string} input
 * @returns {string}
 */
function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex')
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function cloneJson(value) {
  if (value === undefined || value === null) return value
  return JSON.parse(JSON.stringify(value))
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function stringValue(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * @param {unknown} reqBody
 * @returns {string | undefined}
 */
function readMetadataSessionId(reqBody) {
  const meta = readKey(reqBody, 'metadata')
  if (!meta || typeof meta !== 'object') return undefined
  const userId = /** @type {Record<string, unknown>} */ (meta).user_id
  const parsed = parseMaybeJson(userId)
  if (!parsed || typeof parsed !== 'object') return undefined
  return stringValue(/** @type {Record<string, unknown>} */ (parsed).session_id)
}

/**
 * @param {unknown} exchange
 * @param {string} name
 * @returns {string | undefined}
 */
function readHeader(exchange, name) {
  const headers = readPath(exchange, ['request', 'headers'])
  if (!headers || typeof headers !== 'object') return undefined
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (headers))) {
    if (key.toLowerCase() !== wanted) continue
    if (typeof value === 'string' && value.length > 0) return value
    if (Array.isArray(value)) {
      const found = value.find((entry) => typeof entry === 'string' && entry.length > 0)
      if (typeof found === 'string') return found
    }
  }
  return undefined
}

/**
 * @param {unknown} obj
 * @param {string[]} keys
 * @returns {unknown}
 */
function readPath(obj, keys) {
  /** @type {unknown} */
  let cur = obj
  for (const key of keys) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = /** @type {Record<string, unknown>} */ (cur)[key]
  }
  return cur
}

/**
 * @param {unknown} obj
 * @param {string} key
 * @returns {unknown}
 */
function readKey(obj, key) {
  if (obj === null || typeof obj !== 'object') return undefined
  return /** @type {Record<string, unknown>} */ (obj)[key]
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function parseMaybeJson(value) {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function timestampMs(value) {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    if (Number.isFinite(ms)) return ms
  }
  return undefined
}

/**
 * @returns {undefined}
 */
function emptyLookup() {
  return undefined
}
