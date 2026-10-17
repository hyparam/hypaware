// @ts-check

import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { sanitizeLabel } from '../util/json_util.js'

/**
 * @import { PortOwner } from '../../../src/core/daemon/types.js'
 */

/**
 * Who holds a TCP port the daemon could not bind, asked once per failed boot
 * and answered best-effort (issue #137). Read-only by construction: it reads
 * `/proc` on Linux and runs `lsof` on macOS, and it never signals, connects
 * to, or otherwise touches the process it finds. It reports a pid and an
 * executable name only, never a command line, which can carry secrets.
 *
 * Every way of not knowing (no probe on this platform, a permission denial,
 * an owner that exited mid-scan, a probe past its budget) is `undefined`, so a
 * caller says "unknown" rather than naming the wrong process.
 */

/** The whole probe's wall-clock budget. It runs once per failed boot. */
const PROBE_BUDGET_MS = 1_000
/** How many `/proc/<pid>/fd` entries the Linux scan reads at most. */
const MAX_FD_ENTRIES = 100_000
const MAX_EXECUTABLE_CHARS = 64
const TCP_LISTEN = '0A'

/**
 * The address of an address-in-use failure, or `undefined` when `error` is
 * not one. `port` is `0` when the failure does not say which port it was.
 *
 * @param {unknown} error
 * @returns {{ port: number, host?: string } | undefined}
 */
export function addressInUse(error) {
  const err = /** @type {NodeJS.ErrnoException & { port?: unknown, address?: unknown } | undefined} */ (error)
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (err?.code !== 'EADDRINUSE' && !/EADDRINUSE/.test(message)) return undefined
  if (typeof err?.port === 'number' && Number.isInteger(err.port)) {
    return { port: err.port, ...(typeof err.address === 'string' ? { host: err.address } : {}) }
  }
  const match = /EADDRINUSE\b[^\n]*?\s(\S+):(\d{1,5})\b/.exec(message)
  const port = match ? Number(match[2]) : 0
  return port > 0 && port <= 65_535 ? { port, host: match?.[1] } : { port: 0 }
}

/**
 * @param {number} port
 * @param {{ host?: string, platform?: NodeJS.Platform, procRoot?: string, execFile?: typeof execFile, budgetMs?: number }} [opts]
 * @returns {Promise<PortOwner | undefined>}
 */
export async function probePortOwner(port, opts = {}) {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return undefined
  const platform = opts.platform ?? process.platform
  const deadline = Date.now() + (opts.budgetMs ?? PROBE_BUDGET_MS)
  try {
    if (platform === 'linux') return await probeProc(port, opts.host, opts.procRoot ?? '/proc', deadline)
    if (platform === 'darwin') return await probeLsof(port, opts.execFile ?? execFile, deadline)
  } catch {
    // Any failure the probes did not already fold is still only "unknown".
  }
  return undefined
}

/**
 * The sentence a boot failure carries about the owner.
 *
 * @param {number} port
 * @param {PortOwner | undefined} owner
 * @returns {string}
 */
export function describePortOwner(port, owner) {
  if (!owner) return `the owner of port ${port} is unknown`
  return `port ${port} is held by pid ${owner.pid}${owner.executable ? ` (${owner.executable})` : ''}`
}

/**
 * @param {number} port
 * @param {string | undefined} host
 * @param {string} procRoot
 * @param {number} deadline
 * @returns {Promise<PortOwner | undefined>}
 */
async function probeProc(port, host, procRoot, deadline) {
  const inodes = new Set()
  for (const table of ['tcp', 'tcp6']) {
    let text
    try { text = await fsp.readFile(path.join(procRoot, 'net', table), 'utf8') } catch { continue }
    for (const line of text.split('\n')) {
      const cols = line.trim().split(/\s+/)
      if (cols.length < 10 || cols[3] !== TCP_LISTEN) continue
      const local = cols[1]
      const colon = local.lastIndexOf(':')
      if (colon < 0 || parseInt(local.slice(colon + 1), 16) !== port) continue
      if (!couldHoldHost(local.slice(0, colon), host)) continue
      if (cols[9] !== '0') inodes.add(`socket:[${cols[9]}]`)
    }
  }
  if (inodes.size === 0 || Date.now() > deadline) return undefined
  let entries = 0
  const pids = (await fsp.readdir(procRoot)).filter(name => /^\d+$/.test(name))
  for (const pid of pids) {
    if (Date.now() > deadline || entries >= MAX_FD_ENTRIES) return undefined
    const fdDir = path.join(procRoot, pid, 'fd')
    let fds
    // Another user's process, or one that has already exited: not ours to
    // know, and never a reason to stop looking.
    try { fds = await fsp.readdir(fdDir) } catch { continue }
    for (const fd of fds) {
      if (++entries > MAX_FD_ENTRIES) return undefined
      let target
      try { target = await fsp.readlink(path.join(fdDir, fd)) } catch { continue }
      if (!inodes.has(target)) continue
      return { pid: Number(pid), executable: await procExecutable(procRoot, pid) }
    }
  }
  return undefined
}

/**
 * Whether a listener on this `/proc/net` address could be what refused a bind
 * on `host`: a wildcard listener, or one on that IPv4 address. A listener on
 * another specific address did not cause the failure and is not reported. An
 * unknown or non-IPv4 host matches any listener on the port.
 *
 * @param {string} hex
 * @param {string | undefined} host
 * @returns {boolean}
 */
function couldHoldHost(hex, host) {
  if (!host || !/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true
  if (/^0+$/.test(hex)) return true
  // IPv4 is one little-endian word; a v4-mapped IPv6 address ends in it.
  const v4 = hex.length === 8 ? hex : hex.startsWith('0000000000000000FFFF0000') ? hex.slice(24) : undefined
  if (!v4) return false
  const bytes = [6, 4, 2, 0].map(i => parseInt(v4.slice(i, i + 2), 16))
  return bytes.join('.') === host
}

/**
 * The executable's file name, or its kernel `comm` when the link is not
 * readable. Never `cmdline`.
 *
 * @param {string} procRoot
 * @param {string} pid
 * @returns {Promise<string | undefined>}
 */
async function procExecutable(procRoot, pid) {
  try {
    const exe = await fsp.readlink(path.join(procRoot, pid, 'exe'))
    const name = sanitizeLabel(path.basename(exe.replace(/ \(deleted\)$/, '')), MAX_EXECUTABLE_CHARS)
    if (name) return name
  } catch { /* fall through to comm */ }
  try {
    return sanitizeLabel((await fsp.readFile(path.join(procRoot, pid, 'comm'), 'utf8')).trim(), MAX_EXECUTABLE_CHARS)
  } catch {
    return undefined
  }
}

/**
 * `lsof -F pc` prints the pid and the short command name (not its arguments)
 * of each process with a listening socket on the port.
 *
 * @param {number} port
 * @param {typeof execFile} run
 * @param {number} deadline
 * @returns {Promise<PortOwner | undefined>}
 */
function probeLsof(port, run, deadline) {
  const timeout = Math.max(1, deadline - Date.now())
  return new Promise(resolve => {
    run('lsof', ['-nP', '-w', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], { timeout, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error) { resolve(undefined); return }
      /** @type {number | undefined} */
      let pid
      /** @type {string | undefined} */
      let executable
      for (const line of String(stdout).split('\n')) {
        if (line.startsWith('p') && pid === undefined) pid = Number(line.slice(1))
        else if (line.startsWith('c') && pid !== undefined && executable === undefined) executable = sanitizeLabel(line.slice(1), MAX_EXECUTABLE_CHARS)
      }
      resolve(pid !== undefined && Number.isInteger(pid) && pid > 0 ? { pid, executable } : undefined)
    })
  })
}
