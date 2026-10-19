// @ts-check
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

/** @import { DatabaseSync } from 'node:sqlite' */
const require = createRequire(import.meta.url)
import { directories, fingerprint } from './paths.js'

/** @import { CopilotStore, CopilotSpan } from '../../../../hypaware-core/plugins-workspace/copilot/src/types.js' */

/** @param {string} file @returns {DatabaseSync} */
export function openDatabase(file) {
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(file, { readOnly: true })
  db.exec('PRAGMA query_only = ON')
  db.exec('PRAGMA busy_timeout = 100')
  return db
}

/** @param {string} value */
export function localDirectory(value) {
  if (typeof value !== 'string' || !value || value.length > 8192) return undefined
  try {
    if (value.startsWith('file:')) {
      const uri = new URL(value)
      if (uri.hostname || uri.search || uri.hash) return undefined
      return fileURLToPath(uri)
    }
    return path.isAbsolute(value) ? path.normalize(value) : undefined
  } catch { return undefined }
}

/** @param {string} file @param {number} [limit] */
async function readBounded(file, limit = 4 * 1024 * 1024) {
  const handle = await fs.open(file, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > limit) throw new Error('metadata_size_limit')
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1))
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > stat.size) throw new Error('metadata_changed')
    return buffer.toString('utf8', 0, length)
  } finally { await handle.close() }
}

/**
 * Only metadata is retained. UI content is never a second recording lane.
 * Mutations can remove or replace session identity and workingDirectory.
 * @param {string} text @param {boolean} jsonl
 */
export function sessionMetadata(text, jsonl) {
  let id
  let cwd
  const directoriesSeen = new Set()
  if (!jsonl) {
    const value = JSON.parse(text)
    id = value.sessionId
    cwd = value.workingDirectory
    if (cwd) directoriesSeen.add(cwd)
  } else {
    let initial = false
    const lines = text.split('\n')
    // A writer may be halfway through its last operation. Do not import it.
    if (lines.at(-1) !== '') throw new Error('metadata_incomplete')
    for (const line of lines) {
      if (!line.trim()) continue
      const entry = JSON.parse(line)
      if (entry.kind === 0 && !initial) {
        initial = true
        id = entry.v?.sessionId
        cwd = entry.v?.workingDirectory
        if (cwd) directoriesSeen.add(cwd)
      } else if (!initial || entry.kind === 0 || ![1, 2, 3].includes(entry.kind) || !Array.isArray(entry.k)) throw new Error('metadata_schema')
      else if (entry.k.length === 1 && ['sessionId', 'workingDirectory'].includes(entry.k[0])) {
        if (entry.kind === 2) throw new Error('metadata_schema')
        const value = entry.kind === 3 ? undefined : entry.v
        if (entry.k[0] === 'sessionId') id = value
        else {
          cwd = value
          if (cwd) directoriesSeen.add(cwd)
        }
      }
    }
    if (!initial) throw new Error('metadata_schema')
  }
  return { id, cwd: localDirectory(cwd), changedDirectory: directoriesSeen.size > 1 }
}

/** @param {DatabaseSync} db @param {number} [limit] @returns {CopilotSpan[]} */
export function retainedSpans(db, limit = 16384) {
  if (db.prepare('SELECT version FROM schema_version LIMIT 1').get()?.version !== 1) throw new Error('unsupported_schema')
  const result = []
  let rowid = 0
  while (true) {
    const page = /** @type {CopilotSpan[]} */ (/** @type {unknown} */ (db.prepare(`SELECT rowid, substr(span_id, 1, 1025) AS span_id, substr(trace_id, 1, 1025) AS trace_id, substr(parent_span_id, 1, 1025) AS parent_span_id, substr(conversation_id, 1, 1025) AS conversation_id, substr(chat_session_id, 1, 1025) AS chat_session_id, substr(name, 1, 1025) AS name, substr(operation_name, 1, 1025) AS operation_name, substr(provider_name, 1, 1025) AS provider_name, substr(response_model, 1, 1025) AS response_model, substr(request_model, 1, 1025) AS request_model, substr(tool_name, 1, 1025) AS tool_name, substr(tool_call_id, 1, 1025) AS tool_call_id, start_time_ms, end_time_ms, status_code, input_tokens, output_tokens, cached_tokens, reasoning_tokens FROM spans WHERE rowid > ? ORDER BY rowid LIMIT 128`).all(rowid)))
    if (!page.length) break
    if (page.some(span => Object.values(span).some(value => typeof value === 'string' && value.length > 1024))) throw new Error('span_metadata_limit')
    result.push(...page)
    if (result.length > limit) throw new Error('span_count_limit')
    rowid = page[page.length - 1].rowid
  }
  return result
}

/**
 * Select only owned content classes. Model inputs repeat the entire context
 * and are deliberately not fetched. No raw attributes are persisted.
 * @param {DatabaseSync} db @param {CopilotSpan} span
 */
export function readAttributes(db, span) {
  const keys = ['gen_ai.response.id', 'copilot_chat.parent_chat_session_id']
  if (span.operation_name === 'invoke_agent') keys.push('gen_ai.input.messages')
  if (span.operation_name === 'chat') keys.push('gen_ai.system_instructions', 'gen_ai.tool.definitions', 'copilot_chat.reasoning_content', 'gen_ai.output.messages', 'gen_ai.usage.cache_creation.input_tokens', 'gen_ai.usage.reasoning.output_tokens', 'gen_ai.response.finish_reasons')
  if (span.operation_name === 'execute_tool') keys.push('gen_ai.tool.call.arguments', 'gen_ai.tool.call.result')
  const placeholders = keys.map(() => '?').join(',')
  // A short read transaction keeps the size check and content fetch on the
  // same WAL snapshot. It is closed before any asynchronous policy or write.
  db.exec('BEGIN')
  try {
    const current = db.prepare('SELECT rowid, trace_id, end_time_ms, status_code, input_tokens, output_tokens FROM spans WHERE span_id = ?').get(span.span_id)
    if (!current || current.rowid !== span.rowid || current.trace_id !== span.trace_id || current.end_time_ms !== span.end_time_ms || current.status_code !== span.status_code || current.input_tokens !== span.input_tokens || current.output_tokens !== span.output_tokens) throw new Error('span_changed')
    const size = db.prepare(`SELECT SUM(length(CAST(value AS BLOB))) AS bytes FROM span_attributes WHERE span_id = ? AND key IN (${placeholders})`).get(span.span_id, ...keys)?.bytes
    if (Number(size) > 4 * 1024 * 1024) throw new Error('span_content_limit')
    const rows = db.prepare(`SELECT key, value FROM span_attributes WHERE span_id = ? AND key IN (${placeholders})`).all(span.span_id, ...keys)
    return Object.fromEntries(rows.map(r => [String(r.key), String(r.value ?? '')]))
  } finally { db.exec('ROLLBACK') }
}

/** @param {string} file */
async function initialSdkDirectory(file) {
  const handle = await fs.open(file, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error('ownership_missing')
    const buffer = Buffer.alloc(64 * 1024)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, Math.min(1024, buffer.length - length), length)
      if (!bytesRead) break
      length += bytesRead
      const newline = buffer.subarray(length - bytesRead, length).indexOf(10)
      if (newline >= 0) {
        const event = JSON.parse(buffer.toString('utf8', 0, length - bytesRead + newline))
        if (event.type !== 'session.start') throw new Error('ownership_initial_context_missing')
        const cwd = localDirectory(event.data?.context?.cwd)
        if (!cwd) throw new Error('ownership_initial_context_missing')
        return cwd
      }
    }
    throw new Error('ownership_initial_context_missing')
  } finally { await handle.close() }
}

/**
 * Resolve only the exact session's passive metadata. A title, active repo,
 * daemon cwd or nearest/newest conversation is never ownership evidence.
 * @ref LLP 0549#ownership: ambiguous and changed-directory history is withheld
 */
/** @param {NodeJS.ProcessEnv} [env] */
export function createOwnershipResolver(env = process.env) {
  /** @type {Map<string, { signature: string, value: ReturnType<typeof sessionMetadata> }>} */
  const cache = new Map()
  /** @type {Map<string, { file: string, signature: string }[]>} */
  const witnesses = new Map()
  /** @type {Map<string, { signature: string, cwd: string }>} */
  const sdkInitial = new Map()
  let workspaces
  return {
    begin() {
      witnesses.clear()
      workspaces = undefined
    },
    /** @param {CopilotStore} store @param {string} id @param {DatabaseSync} db @param {string} cwd */
    async recheck(store, id, db, cwd) {
      if (store.harness === 'agent-host') return await this.resolve(store, id, db) === cwd
      const proof = witnesses.get(id)
      if (!proof) return false
      for (const item of proof) if (await fingerprint(item.file) !== item.signature) return false
      return true
    },
    /** @param {CopilotStore} store @param {string} id @param {DatabaseSync} db */
    async resolve(store, id, db) {
      if (!/^[a-zA-Z0-9_.-]{1,256}$/.test(id) || id === '.' || id === '..') throw new Error('session_identity')
      if (store.harness === 'agent-host') {
        // The synthetic host span links the SDK conversation to host storage.
        // Do not assume their IDs match, particularly for resumed/peer chats.
        const links = db.prepare(`SELECT DISTINCT substr(a.value, 1, 8193) AS value FROM spans s JOIN span_attributes a ON a.span_id = s.span_id WHERE s.conversation_id = ? AND s.name = 'vscode.agent_host.session' AND a.key = 'vscode.agent_host.session.uri' LIMIT 2`).all(id)
        if (links.length !== 1) throw new Error('ownership_missing')
        const uri = new URL(String(links[0].value))
        if (!['copilotcli:', 'ahp-session:'].includes(uri.protocol) || uri.host || uri.search || uri.hash) throw new Error('ownership_remote')
        const key = decodeURIComponent(uri.pathname.slice(1))
        if (!/^[a-zA-Z0-9_.-]{1,256}$/.test(key) || ['.', '..'].includes(key)) throw new Error('ownership_identity')
        const metadata = openDatabase(path.join(store.root, 'agentSessionData', key, 'session.db'))
        try {
          const rows = metadata.prepare("SELECT key, substr(value, 1, 8193) AS value FROM session_metadata WHERE key IN ('copilot.workingDirectory', 'copilot.workingDirectories')").all()
          if (rows.some(row => String(row.value).length > 8192)) throw new Error('metadata_size_limit')
          const values = Object.fromEntries(rows.map(r => [String(r.key), r.value]))
          const roots = values['copilot.workingDirectories'] ? JSON.parse(String(values['copilot.workingDirectories'])) : [values['copilot.workingDirectory']]
          if (!Array.isArray(roots) || roots.length !== 1) throw new Error('ownership_multiroot')
          // Transitions do not carry a trace/span mapping. Never relabel old
          // spans with today's cwd after a native directory change.
          const hasTransitions = metadata.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'turn_workspace_transition'").get()
          if (hasTransitions && metadata.prepare('SELECT 1 FROM turn_workspace_transition LIMIT 1').get()) throw new Error('ownership_cwd_changed')
          const cwd = localDirectory(roots[0])
          if (!cwd || (values['copilot.workingDirectory'] && localDirectory(String(values['copilot.workingDirectory'])) !== cwd)) throw new Error('ownership_missing')
          // Current provider metadata is mutable. The initial SDK context is
          // independent evidence against relabeling earlier spans after a move.
          const eventsFile = path.join(env.COPILOT_HOME || path.join(env.HOME ?? os.homedir(), '.copilot'), 'session-state', id, 'events.jsonl')
          const signature = await fingerprint(eventsFile)
          let initial = sdkInitial.get(eventsFile)
          if (!initial || initial.signature !== signature) {
            initial = { signature, cwd: await initialSdkDirectory(eventsFile) }
            if (await fingerprint(eventsFile) !== signature) throw new Error('metadata_changed')
            if (sdkInitial.size >= 1024) sdkInitial.delete(sdkInitial.keys().next().value)
            sdkInitial.set(eventsFile, initial)
          }
          if (initial.cwd !== cwd) throw new Error('ownership_cwd_changed')
          return cwd
        } finally { metadata.close() }
      }
      const found = new Set()
      const proof = []
      workspaces ??= await directories(path.join(store.root, 'User', 'workspaceStorage'))
      for (const workspace of workspaces) {
        let metadata
        for (const suffix of ['.jsonl', '.json']) {
          const file = path.join(workspace, 'chatSessions', id + suffix)
          const signature = await fingerprint(file)
          if (signature === 'missing') continue
          const previous = cache.get(file)
          metadata = previous?.signature === signature ? previous.value : sessionMetadata(await readBounded(file), suffix === '.jsonl')
          if (cache.size >= 1024) cache.delete(cache.keys().next().value)
          if (await fingerprint(file) !== signature) throw new Error('metadata_changed')
          cache.set(file, { signature, value: metadata })
          proof.push({ file, signature })
          break
        }
        if (!metadata) continue
        if (metadata.id !== id || metadata.changedDirectory) throw new Error('ownership_cwd_changed')
        const workspaceFile = path.join(workspace, 'workspace.json')
        const workspaceSignature = await fingerprint(workspaceFile)
        const workspaceMeta = JSON.parse(await readBounded(workspaceFile, 64 * 1024))
        if (await fingerprint(workspaceFile) !== workspaceSignature) throw new Error('metadata_changed')
        proof.push({ file: workspaceFile, signature: workspaceSignature })
        // A workspace-file URI is a root set, not the workspace file's parent.
        if (workspaceMeta.workspace) throw new Error('ownership_multiroot')
        const root = localDirectory(workspaceMeta.folder)
        if (!root || (metadata.cwd && metadata.cwd !== root)) throw new Error('ownership_ambiguous')
        found.add(root)
      }
      if (found.size !== 1) throw new Error('ownership_missing')
      witnesses.set(id, proof)
      return [...found][0]
    },
  }
}
