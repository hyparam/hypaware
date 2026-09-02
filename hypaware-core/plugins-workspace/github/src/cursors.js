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
 * @import { CursorState, RepoCursor } from './types.js'
 */

const STATE_FILE = 'github-cursors.json'
const SCHEMA_VERSION = 1

/**
 * @param {string} stateDir
 * @returns {CursorState}
 */
export function readCursors(stateDir) {
  const file = path.join(stateDir, STATE_FILE)
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed && parsed.schema_version === SCHEMA_VERSION && parsed.repos && typeof parsed.repos === 'object') {
      return { schema_version: SCHEMA_VERSION, repos: readRepos(parsed.repos) }
    }
  } catch {
    // Missing, malformed, or an older schema - start clean (a fresh poll
    // re-reads from the configured horizon; backfill ignores cursors anyway).
  }
  return { schema_version: SCHEMA_VERSION, repos: {} }
}

/**
 * The cursor for one repo (`owner/repo`), or an empty cursor when unseen.
 *
 * @param {CursorState} state
 * @param {string} repo
 * @returns {RepoCursor}
 */
export function cursorFor(state, repo) {
  return state.repos[repo] ?? {}
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
  if (v.etag && typeof v.etag === 'object') {
    /** @type {Record<string, string>} */
    const etag = {}
    for (const [k, e] of Object.entries(/** @type {Record<string, unknown>} */ (v.etag))) {
      if (typeof e === 'string') etag[k] = e
    }
    if (Object.keys(etag).length > 0) cursor.etag = etag
  }
  return cursor
}
