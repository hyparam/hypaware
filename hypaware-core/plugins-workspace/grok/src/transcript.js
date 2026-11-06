// @ts-check

import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { boundary, fingerprint, lines } from '../../droid/src/transcript.js'
import { isPlainObject, stringValue } from '../../../../src/core/util/index.js'
import { redactRemoteUserinfo } from '../../goose/src/git_repo.js'
import { createGrokFolder, grokExchange } from './projector.js'

/** @import { GrokCursor, GrokPolicy, GrokSession, GrokWithheldStore } from '../../../../hypaware-core/plugins-workspace/grok/src/types.js' */

export const UPDATES_FILE = 'updates.jsonl'
export const MAX_FILE_BYTES = 256 * 1024 * 1024
// User chunks carry images inline and tool updates carry whole outputs. A line
// past this is skipped, not parsed, and still counts toward line numbers.
export const MAX_LINE_BYTES = 16 * 1024 * 1024
export const MAX_LIVE_BYTES = 8 * 1024 * 1024
const MAX_SUMMARY_BYTES = 1024 * 1024
const MAX_BATCH_MESSAGES = 64
const MAX_BATCH_BYTES = 1024 * 1024
const MAX_DISCOVERY_ENTRIES = 100000
const MAX_LINEAGE_DEPTH = 16
const SUBAGENT_RESCAN_MS = 1000
/** A file untouched this long will not settle anything that is still open. */
export const IDLE_FLUSH_MS = 5 * 60 * 1000

/** @param {NodeJS.ProcessEnv} env */
export function grokSessionsRoot(env) {
  return path.resolve(env.GROK_HOME || path.join(env.HOME || os.homedir(), '.grok'), 'sessions')
}

/** @param {string} file */
async function readBounded(file) {
  let fd
  try {
    fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    const { size } = await fd.stat()
    if (size > MAX_SUMMARY_BYTES) return undefined
    const buffer = Buffer.alloc(size)
    const { bytesRead } = await fd.read(buffer, 0, size, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch {
    return undefined
  } finally { await fd?.close() }
}

/** @param {string} dir @returns {Promise<any>} */
async function readSummary(dir) {
  const raw = await readBounded(path.join(dir, 'summary.json'))
  if (raw === undefined) return undefined
  try { return JSON.parse(raw) } catch { return undefined }
}

/**
 * Directory entries of a bounded listing, or none when it is gone.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function subdirs(dir) {
  /** @type {string[]} */
  const names = []
  let handle
  try { handle = await fs.opendir(dir) } catch { return names }
  for await (const entry of handle) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) names.push(entry.name)
    if (names.length >= MAX_DISCOVERY_ENTRIES) break
  }
  return names
}

/** @param {string} file */
async function exists(file) {
  try {
    await fs.access(file)
    return true
  } catch { return false }
}

/** @param {string} root @param {string} bucket @returns {AsyncGenerator<string>} own bucket first, since most relatives share a cwd */
async function* bucketsFrom(root, bucket) {
  yield bucket
  for (const name of await subdirs(root)) {
    const other = path.join(root, name)
    if (other !== bucket) yield other
  }
}

/** @param {string} root @param {string} bucket @param {string} id */
async function findSessionDir(root, bucket, id) {
  for await (const candidate of bucketsFrom(root, bucket)) {
    const dir = path.join(candidate, id)
    if (await exists(dir)) return dir
  }
  return undefined
}

/** @type {{ root?: string, parents: Map<string, string>, at: number }} */
const subagentIndex = { parents: new Map(), at: 0 }

/**
 * A child session names no parent. Only the parent's directory records the
 * link. One walk indexes every child, so a restart rereading many subagents
 * walks once, and a child whose owner is gone cannot make each read walk again.
 *
 * @param {string} root
 * @param {string} id
 * @ref LLP 0588#lineage: subagents/<child>/meta.json is the only record
 */
async function findSubagentParent(root, id) {
  if (subagentIndex.root === root) {
    const known = subagentIndex.parents.get(id)
    if (known || Date.now() - subagentIndex.at < SUBAGENT_RESCAN_MS) return known
  }
  /** @type {Map<string, string>} */
  const parents = new Map()
  for (const bucket of await subdirs(root)) {
    for (const parent of await subdirs(path.join(root, bucket))) {
      const dir = path.join(root, bucket, parent, 'subagents')
      for (const child of await subdirs(dir)) {
        if (child !== parent && await exists(path.join(dir, child, 'meta.json'))) parents.set(child, parent)
      }
    }
  }
  subagentIndex.root = root
  subagentIndex.parents = parents
  subagentIndex.at = Date.now()
  return parents.get(id)
}

/** @param {unknown} value @returns {number | undefined} */
function timeOf(value) {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(ms) ? ms : undefined
}

/**
 * Where a session's work belongs. A Grok worktree is a separate clone under
 * GROK_HOME, so only the summary leads back to the folder it came from.
 * @param {any} summary
 * @param {string} [cwd]
 * @returns {string[]}
 */
function workspaceDirs(summary, cwd = isPlainObject(summary?.info) ? stringValue(summary.info.cwd) : undefined) {
  const dirs = new Set()
  for (const dir of [cwd, stringValue(summary?.source_workspace_dir)]) if (dir && path.isAbsolute(dir)) dirs.add(dir)
  return [...dirs]
}

/** @param {any} summary */
function gitOf(summary) {
  /** @type {NonNullable<GrokSession['git']>} */
  const git = {}
  const branch = stringValue(summary?.head_branch)
  if (branch) git.git_branch = branch
  const remote = Array.isArray(summary?.git_remotes) ? stringValue(summary.git_remotes[0]) : undefined
  if (remote) git.git_remote = redactRemoteUserinfo(remote)
  const repoRoot = stringValue(summary?.git_root_dir)
  if (repoRoot) git.repo_root = repoRoot.length > 1 ? repoRoot.replace(/\/+$/, '') : repoRoot
  const head = stringValue(summary?.head_commit)
  if (head && /^[0-9a-f]{40}$/.test(head)) git.head_sha = head
  return Object.keys(git).length ? git : undefined
}

/**
 * Identity comes from the directory, which Grok names after the session. The
 * summary is rewritten as the session runs, and is absent early on, so the
 * bucket name stands in for its cwd. Hashed long buckets record theirs in .cwd.
 *
 * @param {string} dir
 * @param {string} root
 * @returns {Promise<GrokSession>}
 * @ref LLP 0588#format: summary.json may lag the update stream
 */
export async function readGrokSession(dir, root) {
  const id = path.basename(dir)
  const bucket = path.dirname(dir)
  const summary = await readSummary(dir)
  const info = isPlainObject(summary?.info) ? summary.info : undefined
  if (info?.id !== undefined && String(info.id) !== id) throw new Error('unsupported_session')
  let cwd = stringValue(info?.cwd)
  if (!cwd) cwd = (await readBounded(path.join(bucket, '.cwd')))?.trim()
  if (!cwd) {
    try { cwd = decodeURIComponent(path.basename(bucket)) } catch { cwd = undefined }
  }
  if (!cwd || !path.isAbsolute(cwd)) throw new Error('unsupported_session')
  /** @type {GrokSession} */
  const session = { id, cwd, policy_dirs: workspaceDirs(summary, cwd), lineage: [id], fork_sources: [] }
  // Only the summary says whose log a fork copied, so its exclusions are unknown until then.
  if (!summary) session.parent_pending = true
  const model = stringValue(summary?.current_model_id)
  if (model) session.model = model
  const startedAt = timeOf(summary?.created_at)
  if (startedAt !== undefined) session.started_at = new Date(startedAt).toISOString()
  const git = gitOf(summary)
  if (git) session.git = git
  // @ref LLP 0588#lineage: exclusions follow a session into what it spawned
  let current = summary
  let currentId = id
  let copying = true
  for (let depth = 0; depth < MAX_LINEAGE_DEPTH; depth++) {
    const isSubagent = String(current?.session_kind ?? '').startsWith('subagent')
    const owner = isSubagent ? await findSubagentParent(root, currentId) : undefined
    if (depth === 0 && isSubagent) {
      if (owner) session.parent_thread_id = owner
      else session.parent_pending = true
    }
    // A fork or a resumed subagent names the session whose log it copied. A plain
    // subagent starts its own log, and a resumed one reaches its owner through its source.
    const source = stringValue(current?.parent_session_id)
    const parent = source ?? owner
    if (!parent || session.lineage.includes(parent)) break
    session.lineage.push(parent)
    copying = copying && source !== undefined
    if (copying) {
      const beforeMs = timeOf(current?.forked_at)
      session.fork_sources.push({ id: parent, ...(beforeMs === undefined ? {} : { before_ms: beforeMs }) })
    }
    const parentDir = await findSessionDir(root, bucket, parent)
    if (!parentDir) break
    current = await readSummary(parentDir)
    currentId = parent
    for (const dir of workspaceDirs(current)) if (!session.policy_dirs.includes(dir)) session.policy_dirs.push(dir)
  }
  return session
}

/**
 * Snapshot one session's update stream, yielding bounded projections and then
 * a cursor. The consumer must finish writing a projection before asking for
 * the next item, and commits the cursor only after all writes succeeded.
 *
 * @param {string} file
 * @param {{ root: string, cursor?: GrokCursor, maxBytes?: number, sessionId?: string,
 *   policy: GrokPolicy, withheld?: GrokWithheldStore, signal?: AbortSignal,
 *   window?: { sinceMs?: number, untilMs?: number } }} opts
 * @ref LLP 0588#bounds: offset reads held before the earliest open item
 */
export async function* readGrokTranscript(file, opts) {
  const realRoot = await fs.realpath(opts.root)
  const realFile = await fs.realpath(file)
  const parts = path.relative(realRoot, realFile).split(path.sep)
  if (parts.length !== 3 || parts[0].startsWith('.') || parts[2] !== UPDATES_FILE) throw new Error('transcript_outside_root')
  const session = await readGrokSession(path.dirname(realFile), realRoot)
  if (opts.sessionId !== undefined && session.id !== opts.sessionId) throw new Error('unsupported_session')
  const fd = await fs.open(realFile, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await fd.stat()
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('file_budget')
    // @ref LLP 0588#withheld: what was written while ignored stays out after unignore
    const drop = async () => {
      if (opts.withheld && opts.policy.sessionIgnored(session)) await opts.withheld.mark(session.id, (await fd.stat()).size)
      return { dropped: true }
    }
    if (!opts.policy.allowed(session)) {
      yield await drop()
      return
    }
    // @ref LLP 0588#lineage: rows carry the folder whose class governs them, since export checks a row's cwd
    session.cwd = opts.policy.governingDir(session)
    const idle = Date.now() - stat.mtimeMs >= IDLE_FLUSH_MS
    // The summary and a child's link are written around the moment a session
    // starts. Rows are written once, so wait for them rather than record a
    // subagent as a root session or a fork's copy past its parent's exclusions.
    if (session.parent_pending && !idle) return
    const floors = opts.withheld ? await opts.withheld.floors(session) : []
    const inode = `${stat.dev}:${stat.ino}`
    let offset = 0
    let lineNumber = 0
    /** @type {{ model?: string, previous?: string, prompts?: Map<number, string | undefined> }} */
    let startAt = {}
    const cursor = opts.cursor
    // The log is append-only, so an intact boundary vouches for what is below it.
    if (cursor && cursor.inode === inode && cursor.offset <= stat.size && cursor.boundary === await boundary(fd, cursor.offset)) {
      offset = cursor.offset
      lineNumber = cursor.line
      startAt = { model: cursor.model, previous: cursor.previous, prompts: cursor.prompts }
    }
    const budget = opts.maxBytes ?? stat.size
    const folder = createGrokFolder(session, startAt)
    let settledOffset = offset
    let settledLine = lineNumber
    let settledModel = startAt.model
    let settledPrevious = startAt.previous
    let batch = []
    let batchBytes = 0
    let oversized = 0
    let reachedEnd = true
    const window = opts.window
    /** @param {any[]} closed */
    const add = closed => {
      /** @type {any[]} */
      const ready = []
      for (const item of closed) {
        // A fork's new messages sit past the copy, whatever their parent's size.
        if (floors.some(f => item.offset < f.offset && !(f.before_ms !== undefined && item.atMs >= f.before_ms))) continue
        if ((window?.sinceMs !== undefined && item.atMs < window.sinceMs) || (window?.untilMs !== undefined && item.atMs > window.untilMs)) continue
        if (batch.length && (batch.length >= MAX_BATCH_MESSAGES || batchBytes + item.bytes > MAX_BATCH_BYTES)) {
          ready.push(batch)
          batch = []
          batchBytes = 0
        }
        batch.push(item.message)
        batchBytes += item.bytes
      }
      return ready
    }
    let start = offset
    for await (const line of lines(fd, offset, stat.size, MAX_LINE_BYTES, true)) {
      if (opts.signal?.aborted) return
      const at = { line: lineNumber, offset: start, bytes: line.bytes }
      lineNumber++
      start = line.end
      let closed = []
      if (line.oversized) oversized++
      else if (line.text.trim()) {
        let entry
        // A crash can tear a line that a resumed session then appends after.
        // Skipping it keeps every later line number, and so every identity.
        try { entry = JSON.parse(line.text) } catch { entry = undefined }
        if (isPlainObject(entry)) closed = folder.push(entry, at)
      }
      for (const ready of add(closed)) {
        if (!opts.policy.allowed(session)) {
          yield await drop()
          return
        }
        const projection = grokExchange(session, ready)
        if (projection) yield { projection }
      }
      const open = folder.earliestOpen()
      settledOffset = open ? open.offset : line.end
      settledLine = open ? open.line : lineNumber
      settledModel = open ? open.model : folder.model()
      settledPrevious = open ? open.previous : folder.previous()
      // Stop at the budget only once the cursor can move, so an open item with
      // more than a budget of updates behind it cannot stall this lane.
      if (line.end < stat.size && line.end - offset >= budget && settledOffset > offset) {
        reachedEnd = false
        break
      }
    }
    // @ref LLP 0588#folding: a quiet file has nothing left to settle what is
    // open, including when a crash left a torn last line behind it
    if (reachedEnd && idle) {
      for (const ready of add(folder.flush())) {
        if (!opts.policy.allowed(session)) {
          yield await drop()
          return
        }
        const projection = grokExchange(session, ready)
        if (projection) yield { projection }
      }
      settledOffset = start
      settledLine = lineNumber
      settledModel = folder.model()
      settledPrevious = folder.previous()
    }
    if (!opts.policy.allowed(session)) {
      yield await drop()
      return
    }
    const projection = grokExchange(session, batch)
    if (projection) yield { projection }
    if (opts.signal?.aborted) return
    /** @type {GrokCursor} */
    const next = { offset: settledOffset, line: settledLine, inode, fingerprint: fingerprint(stat), boundary: await boundary(fd, settledOffset) }
    if (settledModel) next.model = settledModel
    if (settledPrevious) next.previous = settledPrevious
    if (folder.prompts().size) next.prompts = folder.prompts()
    yield { cursor: next, oversized }
  } finally { await fd.close() }
}

/** Two levels, bucket then session, with no symlink traversal. @param {string} root */
export async function* grokSessionFiles(root) {
  let count = 0
  /** @param {string} dir */
  async function* entries(dir) {
    let handle
    try { handle = await fs.opendir(dir) } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return
      throw error
    }
    for await (const entry of handle) {
      if (++count > MAX_DISCOVERY_ENTRIES) throw new Error('discovery_budget')
      // Dot directories are Grok's relocation staging.
      if (entry.isDirectory() && !entry.name.startsWith('.')) yield path.join(dir, entry.name)
    }
  }
  for await (const bucket of entries(root)) {
    for await (const session of entries(bucket)) yield path.join(session, UPDATES_FILE)
  }
}
