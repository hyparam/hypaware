// @ts-check

import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { atomicWriteJsonSync, withFileLock } from 'hypaware/core/util'
import { getLinearClient } from './runtime.js'
import { DATASET_NAME, LINEAR_EVENTS_COLUMNS, linearEventsTablePath } from './dataset.js'
import { pullRequestFromUrl } from './graph_contract.js'
import { uuid } from './oauth.js'
import { validTime } from './client.js'
import { linearError } from './http.js'

/** @import { LinearCursor, LinearRuntime, LinearIssue, LinearAttachment } from '../../../../hypaware-core/plugins-workspace/linear/src/types.js' */

export const CAPTURE_REQUEST_LIMIT = 40
/** @param {string} stateDir */
export function cursorPath(stateDir) { return path.join(stateDir, 'linear-cursor.json') }

/** @param {string} stateDir @returns {LinearCursor | null} */
export function readLinearCursor(stateDir) {
  try {
    const file = cursorPath(stateDir)
    if (fs.statSync(file).size > 16384) throw new Error()
    const c = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (c.version !== 1 || !uuid(c.generation) || typeof c.scope !== 'string' || !/^[a-f0-9]{64}$/.test(c.scope) ||
        !(c.since === null || validTime(c.since)) ||
        !(c.work === null || (['issues', 'attachments'].includes(c.work?.stream) && validTime(c.work.until) &&
          (c.work.since === null || validTime(c.work.since)) &&
          (c.work.after === null || (typeof c.work.after === 'string' && c.work.after.length <= 4096))))) throw new Error()
    return c
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err)?.code === 'ENOENT') return null
    throw linearError('cursor', 'cannot read capture cursor; repair or remove linear-cursor.json before retrying')
  }
}

/** @param {LinearRuntime} rt @param {() => Promise<any>} fn */
function cursorLock(rt, fn) { return withFileLock(`${cursorPath(rt.stateDir)}.lock`, fn) }

/** @param {LinearRuntime} rt @param {LinearCursor} cursor */
function saveCursor(rt, cursor) {
  cursor.generation = randomUUID()
  try { atomicWriteJsonSync(cursorPath(rt.stateDir), cursor, { mode: 0o600 }) }
  catch { throw linearError('cursor_write', 'failed to persist capture progress; the next tick will replay the uncommitted page') }
}

/** @param {LinearRuntime} rt @param {LinearCursor} expected */
function compareCursor(rt, expected) {
  if (readLinearCursor(rt.stateDir)?.generation !== expected.generation) throw linearError('capture_changed', 'another capture changed the cursor; retry')
}

/** @param {string} workspace @param {LinearIssue} issue @param {LinearAttachment} [attachment] */
function snapshot(workspace, issue, attachment) {
  const pr = attachment ? pullRequestFromUrl(attachment.url) : null
  if (attachment && !pr) return null
  const revision = attachment ?? issue
  return {
    event_id: `${attachment ? 'attachment' : 'issue'}:${workspace}:${revision.id}:${revision.updatedAt}`,
    event_type: attachment ? 'pr_attachment' : 'issue',
    workspace_id: workspace, issue_id: issue.id, identifier: issue.identifier,
    team_id: issue.team.id, team_key: issue.team.key,
    state: issue.state.type, actor_id: issue.creator?.id ?? null, assignee_id: issue.assignee?.id ?? null,
    attachment_id: attachment?.id ?? null, repo: pr?.repo ?? null, pr_number: pr?.number ?? null,
    created_at: revision.createdAt, updated_at: revision.updatedAt,
  }
}

/**
 * @param {LinearRuntime} rt
 * @param {{ backfill?: boolean, signal?: AbortSignal, requestLimit?: number, now?: () => number }} [opts]
 */
// @ref LLP 0592#capture [implements]: revision pages commit with compare-before-write; no network work holds the cross-process cursor mutex
export async function runLinearCaptureTick(rt, opts = {}) {
  const result = { events: 0, requests: 0, pending: false, cancelled: false, errors: /** @type {string[]} */ ([]) }
  if (!rt.config.teams.length) {
    rt.log.info('linear.capture_skipped', { operation: 'linear.capture', status: 'skipped', reason: 'no_teams' })
    return result
  }
  const deadline = AbortSignal.timeout(45000)
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline
  const now = opts.now ?? Date.now
  const client = getLinearClient(rt, signal)
  let step = 'identity'
  const started = Date.now()
  rt.log.info('linear.capture_started', { operation: 'linear.capture', mode: opts.backfill ? 'backfill' : 'poll', teams: rt.config.teams.length })
  try {
    signal.throwIfAborted()
    const identity = await client.identity()
    result.requests++
    const scope = createHash('sha256').update(JSON.stringify([identity.workspace_id, identity.user_id, rt.config.teams])).digest('hex')
    step = 'cursor'
    /** @type {LinearCursor} */
    let cursor = await cursorLock(rt, async () => {
      signal.throwIfAborted()
      const prior = readLinearCursor(rt.stateDir)
      const c = prior?.scope === scope && !opts.backfill ? prior :
        { version: /** @type {const} */ (1), generation: randomUUID(), scope, since: null, work: null }
      if (!c.work) {
        c.work = { stream: 'issues', since: c.since, until: new Date(now()).toISOString(), after: null }
        saveCursor(rt, c)
      }
      return c
    })
    const limit = Math.min(CAPTURE_REQUEST_LIMIT, Math.max(2, opts.requestLimit ?? CAPTURE_REQUEST_LIMIT))
    while (cursor.work && result.requests < limit) {
      signal.throwIfAborted()
      const work = { ...cursor.work }
      step = work.stream
      const page = await client.page(work.stream, work, identity.workspace_id)
      result.requests++
      const rows = []
      for (const item of page.nodes) {
        const attachment = work.stream === 'attachments' ? /** @type {LinearAttachment} */ (item) : undefined
        const issue = attachment ? attachment.issue : /** @type {LinearIssue} */ (item)
        if (!rt.config.teams.includes(issue.team.key.toLowerCase()) && !rt.config.teams.includes(issue.team.id.toLowerCase())) continue
        const row = snapshot(identity.workspace_id, issue, attachment)
        if (row) rows.push(row)
      }
      await cursorLock(rt, async () => {
        signal.throwIfAborted()
        compareCursor(rt, cursor)
        if (rows.length) {
          step = 'append'
          await rt.storage.appendRows(linearEventsTablePath(rt.storage), LINEAR_EVENTS_COLUMNS, rows)
          result.events += rows.length
          rt.projectionNeeded = true
        }
        // Cursor advancement follows the durable append, including on stop.
        if (page.pageInfo.hasNextPage) cursor.work = { ...work, after: page.pageInfo.endCursor }
        else if (work.stream === 'issues') cursor.work = { ...work, stream: 'attachments', after: null }
        else {
          cursor.since = new Date(Date.parse(work.until) - 1000).toISOString()
          cursor.work = null
        }
        step = 'persist'
        saveCursor(rt, cursor)
      })
    }
    result.pending = cursor.work !== null
  } catch (err) {
    const kind = /** @type {{ hypErrorKind?: string }} */ (err)?.hypErrorKind ?? 'linear_capture_failed'
    if (opts.signal?.aborted) result.cancelled = true
    else if (deadline.aborted) result.pending = true
    else {
      result.errors.push(kind)
      rt.log.warn('linear.capture_failed', { operation: 'linear.capture', smoke_step: step, error_kind: kind })
    }
  }
  if (!signal.aborted && rt.projectionNeeded !== false) {
    try {
      rt.log.info('linear.projection_started', { operation: 'graph.project', source_dataset: DATASET_NAME })
      const projected = await rt.graph.project(DATASET_NAME)
      rt.projectionNeeded = false
      rt.log.info('linear.projection_completed', { operation: 'graph.project', source_dataset: DATASET_NAME,
        nodes_written: projected.nodesWritten, edges_written: projected.edgesWritten })
    } catch {
      result.errors.push('linear_projection_failed')
      rt.log.warn('linear.projection_failed', { operation: 'graph.project', error_kind: 'linear_projection_failed' })
    }
  }
  rt.log.info('linear.capture_completed', { operation: 'linear.capture', status: result.cancelled ? 'cancelled' : result.errors.length ? 'error' : 'ok',
    rows_written: result.events, requests: result.requests, pending: result.pending, duration_ms: Date.now() - started })
  return result
}
