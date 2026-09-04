// @ts-check

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * Per-repo capture cursors, persisted as a single sidecar JSON under the
 * plugin's state dir (the per-session-watermark pattern from
 * `@hypaware/context-graph-enrich`, applied to repos).
 *
 * **Why a sidecar, not `github_events` columns.** `github_events` is the
 * append-only activity *skeleton* (LLP 0360) - one event per row, no mutable
 * bookkeeping. A poll cursor is mutable per-repo control state, not an
 * observed event, so it lives beside the table, not in it. Backfill and the
 * ongoing poll share the same cursor, so a backfilled repo's poller resumes
 * past history rather than re-fetching it.
 *
 * @ref LLP 0360#cursoring [implements]: cursored per repo, shared by backfill + poll; cursors are sidecar state, not event columns
 *
 * @import { CursorState, GithubCommitTask, GithubPullTask, GithubRepoWork, RepoCursor } from './types.js'
 */

const STATE_FILE = 'github-cursors.json'
const SCHEMA_VERSION = 1
export const MAX_BOUNDARY_IDS = 1000

/**
 * @param {string} stateDir
 * @returns {CursorState}
 */
export function readCursors(stateDir) {
  const file = path.join(stateDir, STATE_FILE)
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed && parsed.schema_version === SCHEMA_VERSION && parsed.repos && typeof parsed.repos === 'object') {
      const nextRepo = typeof parsed.next_repo === 'string' && parsed.next_repo !== '' ? parsed.next_repo : undefined
      return { schema_version: SCHEMA_VERSION, repos: readRepos(parsed.repos), ...(nextRepo ? { next_repo: nextRepo } : {}) }
    }
  } catch {
    // Missing, malformed, or an older schema - start clean (a fresh poll
    // re-reads from the configured horizon; backfill ignores cursors anyway).
  }
  return { schema_version: SCHEMA_VERSION, repos: {} }
}

/**
 * @param {string} stateDir
 * @param {CursorState} state
 */
export function writeCursors(stateDir, state) {
  fs.mkdirSync(stateDir, { recursive: true })
  const file = path.join(stateDir, STATE_FILE)
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * @param {unknown} value
 * @returns {Record<string, RepoCursor>}
 */
function readRepos(value) {
  /** @type {Record<string, RepoCursor>} */
  const out = {}
  for (const [repo, raw] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    const cursor = readRepoCursor(raw)
    if (cursor) out[repo] = cursor
  }
  return out
}

/**
 * @param {unknown} value
 * @returns {RepoCursor | null}
 */
function readRepoCursor(value) {
  if (!value || typeof value !== 'object') return null
  const v = /** @type {Record<string, unknown>} */ (value)
  /** @type {RepoCursor} */
  const cursor = {}
  if (v.since && typeof v.since === 'object') {
    const s = /** @type {Record<string, unknown>} */ (v.since)
    /** @type {NonNullable<RepoCursor['since']>} */
    const since = {}
    for (const k of /** @type {const} */ (['issues', 'commits', 'comments', 'pulls'])) {
      if (typeof s[k] === 'string') since[k] = /** @type {string} */ (s[k])
    }
    if (Object.keys(since).length > 0) cursor.since = since
  }
  if (v.boundary && typeof v.boundary === 'object') {
    const b = /** @type {Record<string, unknown>} */ (v.boundary)
    /** @type {NonNullable<RepoCursor['boundary']>} */
    const boundary = {}
    for (const k of /** @type {const} */ (['issues', 'commits', 'comments'])) {
      const ids = readBoundaryIds(b[k])
      if (ids) boundary[k] = ids
    }
    if (Object.keys(boundary).length > 0) cursor.boundary = boundary
  }
  if (v.etag && typeof v.etag === 'object') {
    /** @type {Record<string, string>} */
    const etag = {}
    for (const [k, e] of Object.entries(/** @type {Record<string, unknown>} */ (v.etag))) {
      if (typeof e === 'string') etag[k] = e
    }
    if (Object.keys(etag).length > 0) cursor.etag = etag
  }
  if (Array.isArray(v.pull_numbers)) {
    cursor.pull_numbers = [...new Set(v.pull_numbers.filter((n) => Number.isSafeInteger(n) && n > 0))]
  }
  const work = readWork(v.work)
  if (work) cursor.work = work
  return cursor
}

/** @param {unknown} value @returns {GithubRepoWork | null} */
function readWork(value) {
  if (!value || typeof value !== 'object') return null
  const v = /** @type {Record<string, unknown>} */ (value)
  if (v.mode !== 'backfill' && v.mode !== 'poll') return null
  if (v.phase !== 'issues' && v.phase !== 'pulls' && v.phase !== 'commits' && v.phase !== 'comments') return null
  /** @type {GithubRepoWork} */
  const work = { mode: v.mode, phase: v.phase }
  if (v.page === null || typeof v.page === 'string') work.page = v.page
  if (typeof v.baseline_pulls === 'string') work.baseline_pulls = v.baseline_pulls
  if (typeof v.issues_high === 'string') work.issues_high = v.issues_high
  if (typeof v.pulls_high === 'string') work.pulls_high = v.pulls_high
  if (typeof v.commits_high === 'string') work.commits_high = v.commits_high
  if (typeof v.comments_high === 'string') work.comments_high = v.comments_high
  if (typeof v.pulls_etag === 'string') work.pulls_etag = v.pulls_etag
  const issuesIds = readBoundaryIds(v.issues_high_ids)
  if (issuesIds) work.issues_high_ids = issuesIds
  const commitsIds = readBoundaryIds(v.commits_high_ids)
  if (commitsIds) work.commits_high_ids = commitsIds
  const commentsIds = readBoundaryIds(v.comments_high_ids)
  if (commentsIds) work.comments_high_ids = commentsIds
  if (Array.isArray(v.pull_tasks)) work.pull_tasks = v.pull_tasks.map(readPullTask).filter((x) => x !== null).slice(0, 100)
  if (Array.isArray(v.commit_tasks)) work.commit_tasks = v.commit_tasks.map(readCommitTask).filter((x) => x !== null).slice(0, 100)
  return work
}

/**
 * Boundary event ids read back from the sidecar. Capped like the task lists
 * are: a boundary set holds one watermark second's worth of items, so a longer
 * array is a corrupt or hand-edited sidecar. Truncating costs a re-appended
 * row at worst, never a dropped one.
 *
 * @param {unknown} value @returns {string[] | null}
 */
function readBoundaryIds(value) {
  if (!Array.isArray(value)) return null
  const ids = [...new Set(value.filter((id) => typeof id === 'string' && id !== ''))].slice(0, MAX_BOUNDARY_IDS)
  return ids.length > 0 ? ids : null
}

/** @param {unknown} value @returns {GithubPullTask | null} */
function readPullTask(value) {
  if (!value || typeof value !== 'object') return null
  const v = /** @type {Record<string, unknown>} */ (value)
  if (typeof v.number !== 'number' || !Number.isSafeInteger(v.number) || v.number <= 0) return null
  if (v.phase !== 'files' && v.phase !== 'reviews' && v.phase !== 'commits') return null
  /** @type {GithubPullTask} */
  const task = { number: /** @type {number} */ (v.number), phase: v.phase }
  if (typeof v.created_at === 'string') task.created_at = v.created_at
  if (v.page === null || typeof v.page === 'string') task.page = v.page
  return task
}

/** @param {unknown} value @returns {GithubCommitTask | null} */
function readCommitTask(value) {
  if (!value || typeof value !== 'object') return null
  const v = /** @type {Record<string, unknown>} */ (value)
  if (typeof v.sha !== 'string' || v.sha === '') return null
  /** @type {GithubCommitTask} */
  const task = { sha: v.sha }
  if (typeof v.created_at === 'string') task.created_at = v.created_at
  if (v.page === null || typeof v.page === 'string') task.page = v.page
  return task
}
