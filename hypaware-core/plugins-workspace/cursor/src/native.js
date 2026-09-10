// @ts-check
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { opendir, readFile, stat, realpath } from 'node:fs/promises'
import { isPlainObject } from '../../../../src/core/util/json_util.js'

/** @import { DatabaseSync } from 'node:sqlite' */
/** @import { CursorSession, CursorSnapshot, CursorReadOptions, CursorMessage } from '../../../../hypaware-core/plugins-workspace/cursor/src/types.js' */

const MAX_RECORD = 1024 * 1024
const MAX_BYTES = 32 * MAX_RECORD
const MAX_BLOBS = 4096
const MAX_SESSIONS = 1000
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const HEX = /^[a-f0-9]{64}$/
const require = createRequire(import.meta.url)

/** Fixed error codes only: database errors can contain private paths or data. */
export class CursorReadError extends Error {
  /** @param {string} code */
  constructor(code) { super(code) }
}

/** @param {CursorReadOptions} [opts] */
export function cursorStorePaths(opts = {}) {
  const env = opts.env ?? process.env
  const home = opts.homeDir ?? env.HOME ?? os.homedir()
  const platform = opts.platform ?? process.platform
  const app = platform === 'darwin' ? path.join(home, 'Library/Application Support/Cursor')
    : platform === 'win32' ? path.join(env.APPDATA ?? path.join(home, 'AppData/Roaming'), 'Cursor')
      : path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'Cursor')
  const cli = env.CURSOR_CONFIG_DIR ?? (env.XDG_CONFIG_HOME ? path.join(env.XDG_CONFIG_HOME, 'cursor') : path.join(home, '.cursor'))
  return { editorDb: opts.editorDb ?? path.join(app, 'User/globalStorage/state.vscdb'), cliRoot: opts.cliRoot ?? path.join(cli, 'chats') }
}

/** @param {string} filename @returns {DatabaseSync} */
function openDb(filename) {
  let db
  try {
    const { DatabaseSync } = require('node:sqlite')
    db = new DatabaseSync(filename, { readOnly: true })
    // A live WAL must be visible. Never use SQLite immutable mode here.
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=50; BEGIN')
    return db
  } catch {
    try { db?.close() } catch {}
    throw new CursorReadError('native_database_unavailable')
  }
}

/** @param {DatabaseSync} db */
function closeDb(db) { try { db.exec('ROLLBACK') } finally { db.close() } }

/** @param {string} filename */
async function exists(filename) {
  try { return (await stat(filename)).isFile() } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return false
    throw new CursorReadError('native_database_unavailable')
  }
}

/** Metadata enumeration is bounded; reaching the bound is an observable failure.
 * @param {CursorReadOptions} [opts]
 * @param {{ sinceMs?: number, untilMs?: number }} [window]
 * @returns {Promise<CursorSession[]>}
 */
export async function listCursorSessions(opts = {}, window = {}) {
  const { editorDb, cliRoot } = cursorStorePaths(opts)
  /** @type {CursorSession[]} */
  const sessions = []
  // A recently updated session can contain older messages before `until`.
  // Apply that upper bound to messages, not to the session's last update.
  const within = (time) => Number.isFinite(time) && (window.sinceMs === undefined || time >= window.sinceMs)
  const report = (err) => { if (opts.onError) opts.onError(safeError(err)); else throw safeError(err) }
  try {
    if (await exists(editorDb)) {
      const db = openDb(editorDb)
      try {
        // Order through Cursor's recency index; never scan blob contents.
        const heads = db.prepare('SELECT composerId FROM composerHeaders ORDER BY recency DESC, composerId DESC LIMIT ?').all(MAX_SESSIONS + 1)
        if (heads.length > MAX_SESSIONS) report(new CursorReadError('native_session_limit'))
        for (const head of heads.slice(0, MAX_SESSIONS)) {
          try {
            if (typeof head.composerId !== 'string' || !UUID.test(head.composerId)) continue
            const item = editorMetadata(db, head.composerId, editorDb)
            if (item && within(item.updatedAt)) sessions.push(item)
          } catch (err) { report(err) }
        }
      } finally { closeDb(db) }
    }
  } catch (err) { report(err) }
  let visited = 0
  try {
    for await (const workspace of directories(cliRoot)) {
      if (++visited > MAX_SESSIONS) throw new CursorReadError('native_session_limit')
      for await (const directory of directories(workspace)) {
        if (++visited > MAX_SESSIONS) throw new CursorReadError('native_session_limit')
        const id = path.basename(directory)
        if (!UUID.test(id)) continue
        try {
          const item = await cliMetadata(directory, id)
          if (item && within(item.updatedAt)) sessions.push(item)
        } catch (err) { report(err) }
      }
    }
  } catch (err) { report(err) }
  return sessions
}

/** Find one hook-owned session without reading other conversations.
 * @param {string} id @param {string} cwd @param {CursorReadOptions} [opts]
 * @returns {Promise<CursorSession | undefined>}
 */
export async function findCursorSession(id, cwd, opts = {}) {
  if (!UUID.test(id) || !path.isAbsolute(cwd)) return undefined
  const paths = cursorStorePaths(opts)
  // Cursor hashes the launch spelling; check its canonical spelling too.
  let canonical = cwd
  try { canonical = await realpath(cwd) } catch {}
  for (const spelling of new Set([cwd, canonical])) {
    const dir = path.join(paths.cliRoot, createHash('md5').update(spelling).digest('hex'), id)
    const item = await cliMetadata(dir, id)
    if (item) return item
  }
  if (!await exists(paths.editorDb)) return undefined
  const db = openDb(paths.editorDb)
  try { return editorMetadata(db, id, paths.editorDb) }
  catch (err) { throw safeError(err) } finally { closeDb(db) }
}

/** @param {string} root */
async function* directories(root) {
  let dir
  try { dir = await opendir(root) } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return
    throw new CursorReadError('native_directory_unavailable')
  }
  for await (const entry of dir) if (entry.isDirectory()) yield path.join(root, entry.name)
}

/** @param {string} dir @param {string} id @returns {Promise<CursorSession | undefined>} */
async function cliMetadata(dir, id) {
  const dbPath = path.join(dir, 'store.db')
  if (!await exists(dbPath)) return undefined
  try {
    const filename = path.join(dir, 'meta.json')
    if ((await stat(filename)).size > 16384) throw new CursorReadError('native_metadata_limit')
    const meta = JSON.parse(await readFile(filename, 'utf8'))
    if (meta.schemaVersion !== 1 || typeof meta.cwd !== 'string' || !path.isAbsolute(meta.cwd)) throw new CursorReadError('native_metadata_shape')
    const updatedAt = meta.updatedAtMs ?? meta.createdAtMs
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) throw new CursorReadError('native_metadata_shape')
    return { id, cwd: meta.cwd, dbPath, frontend: 'cli', updatedAt }
  } catch (err) { throw safeError(err) }
}

/** @param {DatabaseSync} db @param {string} id @param {string} dbPath @returns {CursorSession | undefined} */
function editorMetadata(db, id, dbPath) {
  const row = db.prepare(`SELECT json_extract(value,'$._v') AS version,
    json_extract(value,'$.workspaceIdentifier.uri.path') AS cwd,
    json_extract(value,'$.conversationCheckpointLastUpdatedAt') AS checkpoint,
    json_extract(value,'$.lastUpdatedAt') AS updated,
    json_extract(value,'$.createdAt') AS created
    FROM cursorDiskKV WHERE key=? AND length(value)<=?`).get('composerData:' + id, MAX_RECORD)
  if (!row) {
    if (db.prepare('SELECT 1 FROM cursorDiskKV WHERE key=?').get('composerData:' + id)) throw new CursorReadError('native_metadata_limit')
    return undefined
  }
  if (row.version !== 18 || typeof row.cwd !== 'string' || !path.isAbsolute(row.cwd)) throw new CursorReadError('native_metadata_shape')
  const updatedAt = Number(row.checkpoint ?? row.updated ?? row.created)
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) throw new CursorReadError('native_metadata_shape')
  return { id, cwd: row.cwd, dbPath, frontend: 'editor', updatedAt }
}

/** @param {unknown} err */
export function safeError(err) { return err instanceof CursorReadError ? err : new CursorReadError('native_read_failed') }

/** Narrow protobuf wire reader. Only chosen field bytes are decoded by callers.
 * @param {Uint8Array} input @returns {Map<number, Array<Buffer | number>>}
 * @ref LLP 0399#native-format: bounded descriptor-specific traversal; no thought decoding
 */
export function cursorFields(input) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input)
  if (data.length > MAX_RECORD) throw new CursorReadError('native_record_limit')
  let offset = 0
  const fields = new Map()
  const integer = () => {
    let value = 0n
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= data.length) throw new CursorReadError('native_truncated')
      const byte = data[offset++]
      value |= BigInt(byte & 127) << shift
      if (byte < 128) {
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new CursorReadError('native_integer_limit')
        return Number(value)
      }
    }
    throw new CursorReadError('native_varint_limit')
  }
  let count = 0
  while (offset < data.length) {
    if (++count > 16384) throw new CursorReadError('native_field_limit')
    const tag = integer()
    const number = Math.floor(tag / 8)
    const kind = tag % 8
    if (!number) throw new CursorReadError('native_wire_shape')
    let value
    if (kind === 0) value = integer()
    else {
      const size = kind === 2 ? integer() : kind === 1 ? 8 : kind === 5 ? 4 : -1
      if (size < 0 || size > data.length - offset) throw new CursorReadError('native_wire_shape')
      value = data.subarray(offset, offset + size)
      offset += size
    }
    const list = fields.get(number) ?? []
    list.push(value)
    fields.set(number, list)
  }
  return fields
}

/** @param {Map<number, Array<Buffer | number>>} fields @param {number} key */
function bytes(fields, key) {
  const value = fields.get(key)?.[0]
  if (value === undefined) return Buffer.alloc(0)
  if (!Buffer.isBuffer(value)) throw new CursorReadError('native_wire_shape')
  return value
}
/** @param {Map<number, Array<Buffer | number>>} fields @param {number} key */
function string(fields, key) { return bytes(fields, key).toString('utf8') }
/** @param {Map<number, Array<Buffer | number>>} fields @param {number} key */
function time(fields, key) {
  const value = fields.get(key)?.[0]
  return typeof value === 'number' && value > 0 && value < 8640000000000000 ? new Date(value).toISOString() : undefined
}

/** @param {CursorSession} session @param {string} [previousRoot] @returns {CursorSnapshot} */
export function readCursorSession(session, previousRoot) {
  const db = openDb(session.dbPath)
  let total = 0
  let reads = 0
  try {
    const editor = session.frontend === 'editor'
    const blobQuery = db.prepare(editor ? 'SELECT value AS data FROM cursorDiskKV WHERE key=? AND length(value)<=?' : 'SELECT data FROM blobs WHERE id=? AND length(data)<=?')
    const blob = (pointer) => {
      const hex = Buffer.isBuffer(pointer) ? pointer.toString('hex') : pointer
      if (typeof hex !== 'string' || !HEX.test(hex)) throw new CursorReadError('native_pointer_shape')
      if (++reads > MAX_BLOBS) throw new CursorReadError('native_graph_limit')
      const row = blobQuery.get(editor ? 'agentKv:blob:' + hex : hex, MAX_RECORD)
      if (!row) throw new CursorReadError('native_blob_missing_or_large')
      const data = typeof row.data === 'string' ? Buffer.from(row.data, 'hex') : Buffer.from(/** @type {Uint8Array} */ (row.data))
      total += data.length
      if (total > MAX_BYTES) throw new CursorReadError('native_graph_limit')
      if (createHash('sha256').update(data).digest('hex') !== hex) throw new CursorReadError('native_blob_hash')
      return data
    }
    let rootData
    if (editor) {
      const metadata = editorMetadata(db, session.id, session.dbPath)
      if (metadata?.cwd !== session.cwd) throw new CursorReadError('native_workspace_changed')
      const row = db.prepare("SELECT json_extract(value,'$.status') AS status, json_extract(value,'$.conversationState') AS state FROM cursorDiskKV WHERE key=? AND length(value)<=?").get('composerData:' + session.id, MAX_RECORD)
      if (typeof row?.state !== 'string' || !row.state.startsWith('~')) throw new CursorReadError('native_state_shape')
      if (row.status !== 'completed') throw new CursorReadError('native_in_progress')
      rootData = Buffer.from(row.state.slice(1), 'base64')
    } else {
      if (db.prepare('PRAGMA user_version').get()?.user_version !== 1) throw new CursorReadError('native_database_version')
      // Decode only the metadata root pointer and session identity, not keys.
      const row = db.prepare("SELECT value FROM meta WHERE key='0' AND length(value)<=?").get(MAX_RECORD)
      if (typeof row?.value !== 'string') throw new CursorReadError('native_metadata_shape')
      const meta = JSON.parse(Buffer.from(row.value, 'hex').toString('utf8'))
      if (meta.agentId !== session.id) throw new CursorReadError('native_session_mismatch')
      rootData = blob(meta.latestRootBlobId)
    }
    const fingerprint = createHash('sha256').update(rootData).digest('hex')
    if (fingerprint === previousRoot) return { root: fingerprint, exchanges: [], unchanged: true }
    const root = cursorFields(rootData)
    if (root.has(4)) throw new CursorReadError('native_in_progress')
    if (!root.has(8)) throw new CursorReadError('native_no_turns')
    // JSON results complement typed steps; never deserialize the system/user
    // context or reasoning variants into projected messages.
    const toolResults = new Map()
    const toolInputs = new Map()
    const assistantTexts = new Map()
    const refs = [...(root.get(1) ?? [])]
    for (const archive of [...(root.get(11) ?? []), ...(root.get(13) ?? [])]) {
      const fields = cursorFields(blob(archive))
      refs.push(...(fields.get(1) ?? []))
    }
    if (refs.length > MAX_BLOBS) throw new CursorReadError('native_graph_limit')
    const seenRefs = new Set()
    for (const pointer of refs) {
      const key = Buffer.isBuffer(pointer) ? pointer.toString('hex') : pointer
      if (seenRefs.has(key)) continue
      seenRefs.add(key)
      const data = blob(pointer)
      const message = JSON.parse(data.toString('utf8'))
      if (!Array.isArray(message.content)) continue
      if (message.role === 'assistant') {
        for (const block of message.content) {
          if (block?.type === 'text' && typeof block.text === 'string') assistantTexts.set(block.text, (assistantTexts.get(block.text) ?? 0) + 1)
        }
        for (const block of message.content) {
          if (block?.type === 'tool-call' && typeof block.toolCallId === 'string' && isPlainObject(block.args)) toolInputs.set(block.toolCallId, block.args)
        }
      }
      if (message.role !== 'tool') continue
      for (const block of message.content) {
        if (block?.type !== 'tool-result' || typeof block.toolCallId !== 'string' || typeof block.toolName !== 'string') continue
        if (toolResults.has(block.toolCallId)) throw new CursorReadError('native_tool_id_collision')
        if (block.result === undefined) throw new CursorReadError('native_tool_result_missing')
        toolResults.set(block.toolCallId, { name: block.toolName, result: block.result })
      }
    }
    const exchanges = []
    for (const pointer of root.get(8) ?? []) {
      const turn = cursorFields(blob(pointer))
      if (!turn.has(1)) throw new CursorReadError('native_turn_shape')
      const agent = cursorFields(bytes(turn, 1))
      const user = cursorFields(blob(bytes(agent, 1)))
      const userId = string(user, 2)
      const generation = string(agent, 3)
      if (!userId || userId.length > 256 || !generation || generation.length > 256) throw new CursorReadError('native_identity_missing')
      /** @type {CursorMessage[]} */
      const messages = []
      const id = (...parts) => 'cursor:' + JSON.stringify([session.id, userId, ...parts])
      const attrs = { cursor: { generation_id: generation, identity_source: 'native_turn_step' } }
      // Simulated prompts are not human speech. Refuse untested external text
      // blobs rather than silently replacing a real prompt with empty text.
      if (user.has(18) || user.has(19)) throw new CursorReadError('native_external_user_text')
      if (user.get(5)?.[0] !== 1) messages.push({ role: 'user', message_id: id('user'), provider_uuid: userId,
        content: string(user, 1), message_created_at: time(user, 25), request_id: generation, attributes: attrs })
      let index = 0
      for (const stepRef of agent.get(2) ?? []) {
        const ordinal = index++
        const step = cursorFields(blob(stepRef))
        if (step.has(3)) continue
        if (step.has(1)) {
          const assistant = cursorFields(bytes(step, 1))
          const text = string(assistant, 1)
          // Cursor omits the final end timestamp even after CLI exit. Require
          // corroborating model-context text for that case; a streaming typed
          // step alone must not claim the durable identity of finished text.
          if (!editor && !time(assistant, 3) && text) {
            const remaining = assistantTexts.get(text) ?? 0
            if (!remaining) throw new CursorReadError('native_in_progress')
            assistantTexts.set(text, remaining - 1)
          }
          if (text) messages.push({ role: 'assistant', message_id: id('assistant', generation, ordinal), content: text,
            message_created_at: time(assistant, 2), request_id: generation, attributes: attrs })
        } else if (step.has(2)) {
          const tool = cursorFields(bytes(step, 2))
          const callId = string(tool, 57)
          if (!callId || callId.length > 256) throw new CursorReadError('native_identity_missing')
          const result = toolResults.get(callId)
          if (!result) throw new CursorReadError('native_tool_result_missing')
          const variants = [...tool.keys()].filter((n) => ![54, 57, 59, 60].includes(n))
          if (variants.length !== 1) throw new CursorReadError('native_tool_shape')
          const body = cursorFields(bytes(tool, variants[0]))
          const outcome = cursorFields(bytes(body, 2))
          const terminal = [...outcome.keys()]
          // Outcome 1 is success in the tested tool contracts. Restrict the
          // interpretation to verified variants; unknown tools stay unknown.
          const known = [1, 4, 5, 8, 44].includes(variants[0])
          const isError = known && terminal.length === 1
            ? terminal[0] === 1 ? false : [2, 3, 4].includes(terminal[0]) ? true : null
            : null
          messages.push({ role: 'tool', message_id: id('tool', callId), request_id: generation,
            message_created_at: time(tool, 59), attributes: attrs,
            content: [{ type: 'tool_result', name: result.name, tool_use_id: callId,
              ...(toolInputs.has(callId) ? { input: toolInputs.get(callId) } : {}),
              content: typeof result.result === 'string' ? result.result : JSON.stringify(result.result), is_error: isError }] })
        } else throw new CursorReadError('native_step_shape')
      }
      for (const message of messages) message.previous_message_id = []
      exchanges.push({ provider: 'unknown', client_name: 'cursor', session_id: session.id, conversation_id: session.id,
        conversation_source: 'cursor-native', entrypoint: session.frontend, cwd: session.cwd, messages })
    }
    return { root: fingerprint, exchanges }
  } catch (err) { throw safeError(err) } finally { closeDb(db) }
}
