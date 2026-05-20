import fs from 'node:fs/promises'
import { readCursor } from './cursor.js'
import { cursorsDir } from './paths.js'

/**
 * @import { NormalizerDispatcher } from './normalizer_dispatcher.js'
 * @import { SessionCursor, SessionContext } from './types.d.ts'
 */

const POLL_TIMEOUT_MS = 5000

/**
 * Run a one-shot backfill against the supervisor's `/transcript` endpoint
 * for every non-retired cursor file on disk. Each call enumerates the
 * `.cursors/<city>/` directory for the configured city, then fetches the
 * transcript starting after the cursor's `last_uuid` (so a SSE tail that
 * starts before backfill finishes can't produce duplicates — the writer's
 * dedup set collapses the overlap).
 *
 * Returns the number of frames successfully dispatched. Failures per
 * session are logged to stderr but do NOT throw — backfill must remain a
 * best-effort path because a transient supervisor outage at startup
 * shouldn't prevent the live SSE tail from coming up.
 *
 * @param {{
 *   city: { name: string, api_url: string, template?: string, rig?: string, alias?: string },
 *   sinkRoot: string,
 *   dispatcher: NormalizerDispatcher,
 *   stderr?: { write: (s: string) => void },
 *   fetchFn?: typeof fetch,
 *   debug?: boolean,
 * }} opts
 * @returns {Promise<{ sessionsAttempted: number, framesDispatched: number, sessionsFailed: number }>}
 */
export async function backfillCity(opts) {
  const stderr = opts.stderr ?? process.stderr
  const fetchFn = opts.fetchFn ?? fetch
  const cursorsRoot = cursorsDir(opts.sinkRoot, opts.city.name)
  /** @type {string[]} */
  let entries
  try {
    entries = await fs.readdir(cursorsRoot)
  } catch (err) {
    const code = err && typeof err === 'object' ? /** @type {NodeJS.ErrnoException} */ (err).code : undefined
    if (code === 'ENOENT') {
      return { sessionsAttempted: 0, framesDispatched: 0, sessionsFailed: 0 }
    }
    stderr.write(`[gascity] backfill_readdir_failed city=${opts.city.name} err=${formatError(err)}\n`)
    return { sessionsAttempted: 0, framesDispatched: 0, sessionsFailed: 0 }
  }
  let sessionsAttempted = 0
  let framesDispatched = 0
  let sessionsFailed = 0
  for (const entry of entries) {
    if (!entry.endsWith('.json') || entry === 'lifecycle.json') continue
    const sessionId = entry.slice(0, -'.json'.length)
    if (sessionId.length === 0) continue
    const cursorPath = `${cursorsRoot}/${entry}`
    /** @type {SessionCursor | undefined} */
    const cursor = /** @type {SessionCursor | undefined} */
      await readCursor(cursorPath, { onError: (m) => stderr.write(`${m}\n`) })

    if (!cursor) continue
    if (cursor.retired === true) continue
    sessionsAttempted += 1
    try {
      const count = await backfillSession({
        city: opts.city,
        sessionId,
        afterUuid: typeof cursor.last_uuid === 'string' ? cursor.last_uuid : undefined,
        dispatcher: opts.dispatcher,
        fetchFn,
        stderr,
        debug: opts.debug ?? false,
      })
      framesDispatched += count
    } catch (err) {
      sessionsFailed += 1
      stderr.write(
        `[gascity] backfill_session_failed city=${opts.city.name} session=${sessionId} err=${formatError(err)}\n`
      )
    }
  }
  if (opts.debug) {
    stderr.write(
      `[gascity] backfill_complete city=${opts.city.name} sessions=${sessionsAttempted} frames=${framesDispatched} failed=${sessionsFailed}\n`
    )
  }
  return { sessionsAttempted, framesDispatched, sessionsFailed }
}

/**
 * Pull the transcript for one session, parse it as a sequence of frames,
 * and dispatch each through the normalizer pipeline. The supervisor's
 * `/transcript?format=raw` endpoint returns a JSON array of frame
 * envelopes; if the response shape changes we log and stop rather than
 * try to recover blindly.
 *
 * @param {{
 *   city: { name: string, api_url: string, template?: string, rig?: string, alias?: string },
 *   sessionId: string,
 *   afterUuid: string | undefined,
 *   dispatcher: NormalizerDispatcher,
 *   fetchFn: typeof fetch,
 *   stderr: { write: (s: string) => void },
 *   debug: boolean,
 * }} args
 * @returns {Promise<number>} number of frames dispatched
 */
export async function backfillSession(args) {
  const url = buildTranscriptUrl(args.city.api_url, args.city.name, args.sessionId, args.afterUuid)
  /** @type {SessionContext} */
  const ctx = {
    city: args.city.name,
    sessionId: args.sessionId,
    template: args.city.template,
    rig: args.city.rig,
    alias: args.city.alias,
  }
  if (args.debug) {
    args.stderr.write(
      `[gascity] backfill_session_start city=${args.city.name} session=${args.sessionId} url=${url}\n`
    )
  }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), POLL_TIMEOUT_MS)
  /** @type {Response} */
  let response
  try {
    response = await args.fetchFn(url, { signal: ac.signal })
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    if (response.status === 404) {
      // Session is gone (already retired / never existed). Quietly skip.
      return 0
    }
    throw new Error(`transcript HTTP ${response.status}`)
  }
  const body = await response.text()
  if (body.length === 0) return 0
  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch (err) {
    throw new Error(`transcript JSON parse failed: ${formatError(err)}`)
  }
  const frames = extractFrameArray(parsed)
  let dispatched = 0
  for (const frame of frames) {
    args.dispatcher.dispatch(frame, ctx)
    dispatched += 1
  }
  if (args.debug) {
    args.stderr.write(
      `[gascity] backfill_session_done city=${args.city.name} session=${args.sessionId} frames=${dispatched}\n`
    )
  }
  return dispatched
}

/**
 * @param {string} apiUrl
 * @param {string} city
 * @param {string} sessionId
 * @param {string | undefined} afterUuid
 * @returns {string}
 */
export function buildTranscriptUrl(apiUrl, city, sessionId, afterUuid) {
  const base = `${apiUrl.replace(/\/+$/, '')}/v0/city/${encodeURIComponent(city)}/session/${encodeURIComponent(sessionId)}/transcript`
  const params = new URLSearchParams({ format: 'raw' })
  if (afterUuid !== undefined) params.set('after', afterUuid)
  return `${base}?${params.toString()}`
}

/**
 * Tolerate both `[frames...]` and `{frames: [...]}` envelopes — different
 * supervisor versions have shipped both.
 *
 * @param {unknown} body
 * @returns {unknown[]}
 */
function extractFrameArray(body) {
  if (Array.isArray(body)) return body
  if (body && typeof body === 'object') {
    const obj = /** @type {Record<string, unknown>} */ (body)
    if (Array.isArray(obj.messages)) return wrapProviderFrames(obj.messages, obj.provider)
    if (Array.isArray(obj.frames)) return obj.frames
    if (Array.isArray(obj.transcript)) return obj.transcript
  }
  return []
}

/**
 * @param {unknown[]} frames
 * @param {unknown} provider
 * @returns {unknown[]}
 */
function wrapProviderFrames(frames, provider) {
  if (typeof provider !== 'string') return frames
  return frames.map((frame) => ({ provider, frame }))
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
