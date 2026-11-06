// @ts-check

import fs from 'node:fs'
import fsp from 'node:fs/promises'

import { getLogger } from '../observability/index.js'
import { atomicWriteJson } from '../util/fs_atomic.js'
import { usagePolicyPath } from '../runtime/paths.js'

/**
 * A machine-wide pause: nothing timestamped inside a paused window is recorded,
 * then or later.
 *
 * Clients keep writing their own transcripts during a pause, and the scheduled
 * imports would read them after a resume. So the pause is a list of time windows
 * enforced where every recorder's rows are written, not a switch that recorders
 * consult. A row's own timestamp decides, so a turn from the pause stays out however
 * long after the resume it's imported.
 *
 * @ref LLP 0579#windows [implements]: windows on row time, so a resume doesn't import the pause
 *
 * @typedef {{ start: number, end?: number }} PauseWindow
 */

const VERSION = 1

/** The columns that say when a recorded row happened, in the order they're tried. */
const ROW_TIME_COLUMNS = Object.freeze(['message_created_at', 'event_timestamp', 'timestamp'])

/** @param {string} stateDir */
export function recordingPausePath(stateDir) {
  return usagePolicyPath(stateDir, 'recording-pause')
}

/**
 * @param {unknown} parsed
 * @returns {PauseWindow[]}
 */
function parseWindows(parsed) {
  const windows = /** @type {{ windows?: unknown }} */ (parsed)?.windows
  if (!Array.isArray(windows)) throw new Error('recording pause state has no windows')
  return windows.map((entry) => {
    const { start, end } = /** @type {PauseWindow} */ (entry)
    if (!Number.isFinite(start) || (end !== undefined && !Number.isFinite(end))) {
      throw new Error('recording pause state has an invalid window')
    }
    return end === undefined ? { start } : { start, end }
  })
}

/**
 * @param {{ stateDir: string }} opts
 * @returns {Promise<PauseWindow[]>}
 */
export async function readPauseWindows({ stateDir }) {
  try {
    return parseWindows(JSON.parse(await fsp.readFile(recordingPausePath(stateDir), 'utf8')))
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return []
    throw err
  }
}

/**
 * Starts a pause. Pausing while paused keeps the original start.
 *
 * @param {{ stateDir: string, now?: number }} opts
 * @returns {Promise<{ since: number, changed: boolean }>}
 */
export async function pauseRecording({ stateDir, now = Date.now() }) {
  const windows = await readPauseWindows({ stateDir })
  const open = windows.find((w) => w.end === undefined)
  if (open) return { since: open.start, changed: false }
  await atomicWriteJson(recordingPausePath(stateDir), { version: VERSION, windows: [...windows, { start: now }] }, { mode: 0o600 })
  return { since: now, changed: true }
}

/**
 * Ends a pause. The window stays, which is what keeps its transcripts out.
 *
 * @param {{ stateDir: string, now?: number }} opts
 * @returns {Promise<{ changed: boolean }>}
 */
export async function resumeRecording({ stateDir, now = Date.now() }) {
  const windows = await readPauseWindows({ stateDir })
  if (!windows.some((w) => w.end === undefined)) return { changed: false }
  const closed = windows.map((w) => (w.end === undefined ? { start: w.start, end: now } : w))
  await atomicWriteJson(recordingPausePath(stateDir), { version: VERSION, windows: closed }, { mode: 0o600 })
  return { changed: true }
}

/**
 * When the current pause began, or null when recording isn't paused. An unreadable
 * state file counts as paused, matching what the write path does with it.
 *
 * @param {{ stateDir: string }} opts
 * @returns {Promise<number | null>}
 */
export async function readPausedSince({ stateDir }) {
  try {
    const open = (await readPauseWindows({ stateDir })).find((w) => w.end === undefined)
    return open ? open.start : null
  } catch {
    return 0
  }
}

/**
 * A row's time in milliseconds, whichever way a recorder wrote it, or null.
 *
 * @param {Record<string, unknown>} row
 * @returns {number | null}
 */
function rowTimeMs(row) {
  for (const column of ROW_TIME_COLUMNS) {
    const value = row[column]
    if (value === undefined || value === null) continue
    if (value instanceof Date) return value.getTime()
    if (typeof value === 'string') {
      const parsed = Date.parse(value)
      if (Number.isFinite(parsed)) return parsed
      continue
    }
    const number = Number(value)
    if (!Number.isFinite(number)) continue
    // Epoch seconds, milliseconds or microseconds, told apart by size.
    if (number >= 1e14) return number / 1000
    return number >= 1e11 ? number : number * 1000
  }
  return null
}

/**
 * The write-path check. It costs one stat per batch while there's no state file,
 * and only compares numbers per row otherwise.
 *
 * @param {string} stateDir
 * @returns {{ keep: (rows: Record<string, unknown>[]) => Record<string, unknown>[] }}
 */
export function createRecordingPauseFilter(stateDir) {
  const file = recordingPausePath(stateDir)
  const log = getLogger('usage-policy')
  /** @type {PauseWindow[]} */
  let windows = []
  let stamp = ''

  function refresh() {
    let next
    try {
      const stat = fs.statSync(file, { bigint: true })
      next = `${stat.mtimeNs}:${stat.ctimeNs}`
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
        windows = []
        stamp = ''
        return
      }
      next = 'unreadable'
    }
    if (next === stamp) return
    stamp = next
    try {
      windows = parseWindows(JSON.parse(fs.readFileSync(file, 'utf8')))
    } catch (err) {
      // The person asked for nothing to be recorded and we can't tell since when,
      // so fail closed until the file is repaired.
      windows = [{ start: 0 }]
      log.warn('recording_pause.state_unreadable', { hyp_error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** @param {Record<string, unknown>} row */
  function isPaused(row) {
    const time = rowTimeMs(row)
    if (time === null) {
      // Without a time, only a live pause can apply, and only to a row from a session.
      return row.session_id !== undefined && windows.some((w) => w.end === undefined)
    }
    return windows.some((w) => time >= w.start && (w.end === undefined || time < w.end))
  }

  return {
    keep(rows) {
      refresh()
      return windows.length > 0 ? rows.filter((row) => !isPaused(row)) : rows
    },
  }
}

export const __test = { rowTimeMs }
