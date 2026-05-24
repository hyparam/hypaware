// @ts-check

import fs from 'node:fs'
import path from 'node:path'

/**
 * @import { PidFileEntry } from './types.d.ts'
 */

/**
 * Resolve the directory the daemon uses for runtime state files —
 * `<HYP_HOME>/hypaware/run`. The dispatcher passes `stateRoot`
 * (`<HYP_HOME>/hypaware`); this returns the `run` child.
 *
 * @param {string} stateRoot
 */
export function daemonRunDir(stateRoot) {
  return path.join(stateRoot, 'run')
}

/**
 * Path to the PID file. There is exactly one daemon per `HYP_HOME`,
 * so a single fixed filename keeps `daemon stop` / `daemon status`
 * simple.
 *
 * @param {string} stateRoot
 */
export function pidFilePath(stateRoot) {
  return path.join(daemonRunDir(stateRoot), 'hypaware.pid')
}

/**
 * Write a PID file atomically (write to `.tmp`, then rename). The
 * caller is the running daemon, so we crash hard on any I/O failure —
 * a daemon that cannot record its PID has nothing for `daemon stop`
 * to target later.
 *
 * @param {string} stateRoot
 * @param {PidFileEntry} entry
 */
export function writePidFile(stateRoot, entry) {
  if (!entry || typeof entry.pid !== 'number' || !Number.isFinite(entry.pid)) {
    throw new TypeError('writePidFile: entry.pid must be a finite number')
  }
  const dir = daemonRunDir(stateRoot)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `hypaware.pid.${process.pid}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(entry, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, pidFilePath(stateRoot))
}

/**
 * Read the current PID file, returning `null` when no daemon has
 * claimed this `HYP_HOME` (no file). Malformed files raise — the
 * caller's job is to surface "daemon state is corrupt" to the user
 * rather than silently swallowing it.
 *
 * @param {string} stateRoot
 * @returns {PidFileEntry | null}
 */
export function readPidFile(stateRoot) {
  const file = pidFilePath(stateRoot)
  /** @type {string} */
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return null
    throw err
  }
  /** @type {unknown} */
  const parsed = JSON.parse(raw)
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof /** @type {Record<string, unknown>} */ (parsed).pid !== 'number'
  ) {
    throw new Error(`readPidFile: malformed entry at ${file}`)
  }
  return /** @type {PidFileEntry} */ (parsed)
}

/**
 * Best-effort delete of the PID file. Silent when nothing is there —
 * shutdown should not throw if a parallel `daemon stop` already
 * cleaned up.
 *
 * @param {string} stateRoot
 */
export function clearPidFile(stateRoot) {
  try {
    fs.unlinkSync(pidFilePath(stateRoot))
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return
    throw err
  }
}

/**
 * Send signal 0 to probe whether `pid` is still running. Returns
 * false when the process is gone or when we don't have permission to
 * signal it (in which case it isn't *our* daemon anyway).
 *
 * @param {number} pid
 */
export function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = err && /** @type {NodeJS.ErrnoException} */ (err).code
    if (code === 'EPERM') return true
    return false
  }
}
