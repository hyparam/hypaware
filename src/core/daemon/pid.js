// @ts-check

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { atomicWriteJsonSync, readFileIfExistsSync } from '../util/fs_atomic.js'

/**
 * @import { PidFileEntry } from '../../../src/core/daemon/types.js'
 */

/**
 * Resolve the directory the daemon uses for runtime state files:
 * `<HYP_HOME>/hypaware/run`. The dispatcher passes `stateRoot`
 * (`<HYP_HOME>/hypaware`); this returns the `run` child.
 *
 * @param {string} stateRoot
 */
export function daemonRunDir(stateRoot) {
  return path.join(stateRoot, 'run')
}

/**
 * Resolve the state root the supervised processing daemon keeps its own
 * runtime files under: `<HYP_HOME>/hypaware/processing`. Its pid, status,
 * control and log paths are the ordinary ones rooted here, so a reader that
 * wants the processor's copy of one derives it through this rather than
 * repeating the segment. The gateway keeps the primary state root.
 *
 * @ref LLP 0038#lifecycle-and-operator-behavior [implements]: the processor's runtime files live below `hypaware/processing`
 * @param {string} stateRoot
 */
export function processingStateRoot(stateRoot) {
  return path.join(stateRoot, 'processing')
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
 * caller is the running daemon, so we crash hard on any I/O failure.
 * A daemon that cannot record its PID has nothing for `daemon stop`
 * to target later.
 *
 * @param {string} stateRoot
 * @param {PidFileEntry} entry
 */
export function writePidFile(stateRoot, entry) {
  if (!entry || typeof entry.pid !== 'number' || !Number.isFinite(entry.pid)) {
    throw new TypeError('writePidFile: entry.pid must be a finite number')
  }
  atomicWriteJsonSync(pidFilePath(stateRoot), entry)
}

/**
 * Read the current PID file, returning `null` when no daemon has
 * claimed this `HYP_HOME` (no file). Malformed files raise errors.
 * The caller's job is to surface "daemon state is corrupt" to the user
 * rather than silently swallowing it.
 *
 * @param {string} stateRoot
 * @returns {PidFileEntry | null}
 */
export function readPidFile(stateRoot) {
  const file = pidFilePath(stateRoot)
  const raw = readFileIfExistsSync(file)
  if (raw === null) return null
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
 * Best-effort delete of the PID file. Silent when nothing is there.
 * Shutdown should not throw if a parallel `daemon stop` already
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
 * Send signal 0 to probe whether `pid` is still running. True when the
 * signal lands, and true on `EPERM`: a pid we lack permission to signal
 * is a pid some process still holds, and reading it as dead would let a
 * stale-pid clear delete the pid file of a live, reissued pid. False on
 * `ESRCH` and on any other error.
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

/**
 * Command line of `pid` as a string, or `null` when it cannot be read
 * (no such process, no permission, or no supported mechanism). Linux
 * reads `/proc/<pid>/cmdline`; elsewhere falls back to `ps`.
 *
 * @param {number} pid
 * @returns {string | null}
 */
export function readProcessCmdline(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  if (process.platform === 'linux') {
    try {
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      return raw.replace(/\0/g, ' ').trim() || null
    } catch {
      return null
    }
  }
  try {
    const out = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const cmd = String(out).trim()
    return cmd || null
  } catch {
    return null
  }
}

/**
 * Whether `pid` looks like a hypaware daemon process. `processIsAlive`
 * only proves *some* process holds the pid: after an unclean shutdown
 * the pid file survives and pid numbering can restart, so an unrelated
 * process may hold it (`#2583`). The daemon runs as `hypaware … daemon`,
 * which an unrelated process will not contain in its command line.
 *
 * Returns `null` when identity cannot be established: callers must keep
 * the old fail-closed behavior (treat as alive).
 *
 * @param {number} pid
 * @returns {boolean | null}
 */
export function isDaemonProcess(pid) {
  const cmd = readProcessCmdline(pid)
  if (cmd === null) return null
  const lower = cmd.toLowerCase()
  return lower.includes('hypaware') && lower.includes('daemon')
}

/**
 * Drop the PID file under `stateRoot` when the pid it names is no longer
 * running, and leave it exactly as it is otherwise: a file whose pid is still
 * held belongs to whoever holds it, which is why `processIsAlive` reads
 * `EPERM` as alive.
 *
 * Best-effort, because the callers are stops that already happened: a pid file
 * this cannot parse or unlink is `hyp daemon status`'s to report rather than a
 * reason to call a completed stop a failure.
 *
 * @param {string} stateRoot
 */
export function clearStalePidFile(stateRoot) {
  try {
    const entry = readPidFile(stateRoot)
    if (entry && !processIsAlive(entry.pid)) clearPidFile(stateRoot)
  } catch { /* an unreadable or unremovable pid file outlives this stop */ }
}
