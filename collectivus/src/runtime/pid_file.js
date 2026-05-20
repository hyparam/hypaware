import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

/**
 * Atomically write the current process's PID to `pidPath`. Creates the
 * parent directory on demand and uses a tmp+rename so a `ctvs` reader
 * never sees a partial file. Overwrites any stale PID file from a prior
 * run that exited without cleanup.
 *
 * @param {string} pidPath
 * @returns {Promise<void>}
 */
export async function writePidFile(pidPath) {
  await fs.mkdir(path.dirname(pidPath), { recursive: true })
  const tmpPath = `${pidPath}.tmp.${process.pid}`
  await fs.writeFile(tmpPath, `${process.pid}\n`, { mode: 0o600 })
  await fs.rename(tmpPath, pidPath)
}

/**
 * Remove the PID file. ENOENT is silently swallowed because shutdown can
 * race with an out-of-band cleanup (or the file may simply not have been
 * written yet).
 *
 * @param {string} pidPath
 * @returns {Promise<void>}
 */
export async function removePidFile(pidPath) {
  try {
    await fs.unlink(pidPath)
  } catch (err) {
    if (err && typeof err === 'object' && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return
    throw err
  }
}

/**
 * Read the daemon PID from `pidPath` if it exists. Returns the parsed PID
 * when:
 *   - the file exists,
 *   - it parses as a positive integer,
 *   - and a `kill -0` probe shows the process is alive.
 *
 * Returns undefined for ENOENT, malformed contents, or a stale PID whose
 * process no longer exists. Callers treat undefined as "no live daemon".
 *
 * Why probe with `kill -0`: the daemon may have crashed without removing
 * its PID file. Sending SIGHUP to a dead PID would silently fail or — worse
 * — hit a recycled PID owned by an unrelated process.
 *
 * @param {string} pidPath
 * @param {{ probe?: (pid: number) => boolean }} [opts]
 *   `probe` defaults to `process.kill(pid, 0)`; tests override it so they
 *   don't have to spawn live processes to test the read path.
 * @returns {Promise<number | undefined>}
 */
export async function readPidFile(pidPath, opts = {}) {
  const probe = opts.probe ?? defaultProbe
  /** @type {string} */
  let raw
  try {
    raw = await fs.readFile(pidPath, 'utf8')
  } catch (err) {
    if (err && typeof err === 'object' && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return undefined
    throw err
  }
  const trimmed = raw.trim()
  if (!/^[1-9][0-9]*$/.test(trimmed)) return undefined
  const pid = Number.parseInt(trimmed, 10)
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  if (!probe(pid)) return undefined
  return pid
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
function defaultProbe(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err) {
      const code = /** @type {NodeJS.ErrnoException} */ err.code
      // EPERM means the PID exists but we don't own it — the daemon should be
      // owned by the same user as the CLI in standalone mode, but if for some
      // reason it isn't, treat it as "live" so we don't pretend it's gone.
      if (code === 'EPERM') return true
      if (code === 'ESRCH') return false
    }
    return false
  }
}
