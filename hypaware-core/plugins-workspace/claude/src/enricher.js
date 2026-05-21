// @ts-check

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

/**
 * Claude transcript enricher. Reads Claude Code's local JSONL
 * transcripts under `<homeDir>/.claude/projects/` and supplies the
 * extra UUID / hook / version columns the donor projected into the
 * `proxy_messages` dataset onto `ai_gateway_messages` rows here.
 *
 * The donor's full session/timestamp matching is reduced to a single
 * `enrich(row)` entry point that the recorder calls per row: when
 * the row carries a session id and a message id (or canonicalizable
 * content), we walk the matching transcript file and merge the
 * nearest entry's columns onto the row. When nothing matches we
 * return the row unchanged — enrichment is strictly additive.
 *
 * @typedef {Object} EnrichOpts
 * @property {string} homeDir
 *
 * @typedef {Object} TranscriptEntry
 * @property {string} sessionId
 * @property {number} [timestampMs]
 * @property {string} [messageId]
 * @property {string} [contentKey]
 * @property {string} [provider_uuid]
 * @property {string} [parent_uuid]
 * @property {string} [logical_parent_uuid]
 * @property {string} [source_tool_assistant_uuid]
 * @property {string} [request_id]
 * @property {string} [prompt_id]
 * @property {string} [provider_type]
 * @property {string} [provider_subtype]
 * @property {string} [entrypoint]
 * @property {string} [client_version]
 * @property {string} [user_type]
 * @property {string} [permission_mode]
 * @property {boolean} [is_sidechain]
 * @property {string} [attachment_type]
 * @property {string} [hook_event]
 * @property {boolean} [is_compact_summary]
 * @property {unknown} [compact_metadata]
 * @property {unknown} [raw_frame]
 */

/**
 * @param {string} homeDir
 * @returns {string}
 */
export function defaultClaudeProjectsDir(homeDir) {
  return path.join(homeDir, '.claude', 'projects')
}

/**
 * Build the enricher closure. The projects directory is resolved
 * once at construction so a missing tree (test runs with no Claude
 * Code installed) returns the row unchanged on every call.
 *
 * @param {EnrichOpts} opts
 */
export function createClaudeTranscriptEnricher(opts) {
  const projectsDir = defaultClaudeProjectsDir(opts.homeDir)

  /**
   * @param {Record<string, unknown>} row
   * @returns {Promise<Record<string, unknown>>}
   */
  return async function enrich(row) {
    const sessionId = readSessionId(row)
    if (!sessionId) return row
    const entries = await readTranscriptFor(projectsDir, sessionId)
    if (entries.length === 0) return row
    const matched = matchEntry(entries, row)
    if (!matched) return row
    return projectMatch(row, matched)
  }
}

/**
 * @param {Record<string, unknown>} row
 * @returns {string | undefined}
 */
function readSessionId(row) {
  const direct = stringValue(row.session_id)
  if (direct) return direct
  const metadata = isPlainObject(row.metadata) ? /** @type {Record<string, unknown>} */ (row.metadata) : undefined
  if (metadata) {
    const fromMeta = stringValue(metadata.session_id)
    if (fromMeta) return fromMeta
  }
  return undefined
}

/**
 * @param {string} projectsDir
 * @param {string} sessionId
 * @returns {Promise<TranscriptEntry[]>}
 */
async function readTranscriptFor(projectsDir, sessionId) {
  /** @type {TranscriptEntry[]} */
  const entries = []
  for (const filePath of walkJsonlFiles(projectsDir, sessionId)) {
    await readTranscriptFile(filePath, entries)
  }
  entries.sort((a, b) => (a.timestampMs ?? Number.POSITIVE_INFINITY) - (b.timestampMs ?? Number.POSITIVE_INFINITY))
  return entries
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
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
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
  } catch { /* truncated/rotated file → enrichment best-effort */ }
}

/**
 * @param {unknown} row
 * @returns {TranscriptEntry | undefined}
 */
function transcriptEntryFromRow(row) {
  if (!isPlainObject(row)) return undefined
  const obj = /** @type {Record<string, unknown>} */ (row)
  const sessionId = stringValue(obj.sessionId)
  if (!sessionId) return undefined
  const message = isPlainObject(obj.message) ? /** @type {Record<string, unknown>} */ (obj.message) : undefined
  const role = stringValue(readKey(message, 'role')) ??
    (obj.type === 'user' || obj.type === 'assistant' ? /** @type {string} */ (obj.type) : undefined)
  const content = readKey(message, 'content')
  const attachment = isPlainObject(obj.attachment) ? /** @type {Record<string, unknown>} */ (obj.attachment) : undefined
  /** @type {TranscriptEntry} */
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
    compact_metadata: readKey(obj, 'compactMetadata') ?? readKey(obj, 'compact_metadata'),
    raw_frame: obj,
  }
  if (!entry.messageId && !entry.contentKey && !entry.provider_uuid) return undefined
  return entry
}

/**
 * @param {TranscriptEntry[]} entries
 * @param {Record<string, unknown>} row
 * @returns {TranscriptEntry | undefined}
 */
function matchEntry(entries, row) {
  const messageId = stringValue(row.message_id) ?? stringValue(row.messageId)
  if (messageId) {
    const byId = entries.find((e) => e.messageId === messageId)
    if (byId) return byId
  }
  const role = stringValue(row.role)
  if (!role) return undefined
  const key = contentKey(role, normalizeContent(row.content))
  return entries.find((e) => e.contentKey === key)
}

/**
 * @param {Record<string, unknown>} row
 * @param {TranscriptEntry} entry
 * @returns {Record<string, unknown>}
 */
function projectMatch(row, entry) {
  const merged = { ...row }
  setIf(merged, 'provider_uuid', entry.provider_uuid)
  setIf(merged, 'parent_uuid', entry.parent_uuid)
  setIf(merged, 'logical_parent_uuid', entry.logical_parent_uuid)
  setIf(merged, 'source_tool_assistant_uuid', entry.source_tool_assistant_uuid)
  setIf(merged, 'request_id', entry.request_id)
  setIf(merged, 'prompt_id', entry.prompt_id)
  setIf(merged, 'provider_type', entry.provider_type)
  setIf(merged, 'provider_subtype', entry.provider_subtype)
  setIf(merged, 'entrypoint', entry.entrypoint)
  setIf(merged, 'client_version', entry.client_version)
  setIf(merged, 'user_type', entry.user_type)
  setIf(merged, 'permission_mode', entry.permission_mode)
  setIf(merged, 'attachment_type', entry.attachment_type)
  setIf(merged, 'hook_event', entry.hook_event)
  if (entry.is_sidechain !== undefined) merged.is_sidechain = entry.is_sidechain
  if (entry.is_compact_summary !== undefined) merged.is_compact_summary = entry.is_compact_summary
  if (entry.compact_metadata !== undefined && merged.compact_metadata === undefined) merged.compact_metadata = entry.compact_metadata
  if (entry.raw_frame !== undefined && merged.raw_frame === undefined) merged.raw_frame = entry.raw_frame
  return merged
}

/**
 * @param {Record<string, unknown>} target
 * @param {string} key
 * @param {string | undefined} value
 */
function setIf(target, key, value) {
  if (value !== undefined && target[key] === undefined) target[key] = value
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
    const obj = /** @type {Record<string, unknown>} */ (value)
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const key of Object.keys(obj).sort()) out[key] = sortKeys(obj[key])
    return out
  }
  return value
}

/** @param {string} input */
function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex')
}

/** @param {unknown} value */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {unknown} obj
 * @param {string} key
 */
function readKey(obj, key) {
  if (!isPlainObject(obj)) return undefined
  return /** @type {Record<string, unknown>} */ (obj)[key]
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
