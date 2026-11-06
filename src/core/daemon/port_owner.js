// @ts-check

import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import net from 'node:net'
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
 * an owner that exited mid-scan, a probe past its budget, listeners that could
 * have refused the bind held by more than one process) is `undefined`, so a
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
  const budgetMs = opts.budgetMs ?? PROBE_BUDGET_MS
  const deadline = Date.now() + budgetMs
  /** @type {Promise<PortOwner | undefined> | undefined} */
  let probe
  if (platform === 'linux') probe = probeProc(port, opts.host, opts.procRoot ?? '/proc', deadline)
  else if (platform === 'darwin') probe = probeLsof(port, opts.host, opts.execFile ?? execFile, deadline)
  if (!probe) return undefined
  // A single slow read (a wedged /proc entry) can outlast every deadline check
  // between awaits, so the budget is also enforced on the whole probe. A read
  // still in flight when it expires finishes unobserved and is discarded.
  /** @type {NodeJS.Timeout | undefined} */
  let timer
  const expired = new Promise(resolve => { timer = setTimeout(resolve, budgetMs, undefined) })
  try {
    return /** @type {PortOwner | undefined} */ (await Promise.race([probe.catch(() => undefined), expired]))
  } catch {
    // Any failure the probes did not already fold is still only "unknown".
    return undefined
  } finally {
    clearTimeout(timer)
  }
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
  /** @type {string | undefined} */
  let owner
  const pids = (await fsp.readdir(procRoot)).filter(name => /^\d+$/.test(name))
  for (const pid of pids) {
    if (Date.now() > deadline || entries >= MAX_FD_ENTRIES) return undefined
    const fdDir = path.join(procRoot, pid, 'fd')
    let fds
    // Another user's process, or one that has already exited: not ours to
    // know, and never a reason to stop looking.
    try { fds = await fsp.readdir(fdDir) } catch { continue }
    for (const fd of fds) {
      if (++entries > MAX_FD_ENTRIES || Date.now() > deadline) return undefined
      let target
      try { target = await fsp.readlink(path.join(fdDir, fd)) } catch { continue }
      if (!inodes.has(target)) continue
      // One candidate listener: the first process holding it is the answer.
      // Several (a v4 and a v6 listener when the failing host is unknown):
      // only an answer if one process holds them all, so keep scanning.
      if (inodes.size === 1) return { pid: Number(pid), executable: await procExecutable(procRoot, pid) }
      if (owner !== undefined && owner !== pid) return undefined
      owner = pid
      break
    }
  }
  return owner === undefined ? undefined : { pid: Number(owner), executable: await procExecutable(procRoot, owner) }
}

/**
 * Whether a listener on this `/proc/net` address could be what refused a bind
 * on `host`. An IPv4 bind is refused by a listener on that address or a
 * wildcard of either family (a dual-stack `::` covers IPv4). A specific IPv6
 * bind is refused only by an IPv6 listener on that address or on `::`; an
 * IPv4 listener never conflicts with it. An unknown host, or a wildcard one,
 * matches any listener on the port.
 *
 * @param {string} hex
 * @param {string | undefined} host
 * @returns {boolean}
 */
function couldHoldHost(hex, host) {
  const family = host ? net.isIP(host.replace(/%.*$/, '')) : 0
  if (family === 0) return true
  const want = family === 4 ? ipv4ProcHex(host ?? '') : ipv6ProcHex(host?.replace(/%.*$/, '') ?? '')
  if (want === undefined || /^0+$/.test(want)) return true
  if (/^0+$/.test(hex)) return family === 4 || hex.length === 32
  if (family === 6) return hex === want
  // A v4-mapped IPv6 listener ends in the IPv4 word.
  return hex === want || hex === `0000000000000000FFFF0000${want}`
}

/**
 * An IPv4 address as `/proc/net/tcp` prints it: one little-endian word.
 *
 * @param {string} host
 * @returns {string}
 */
function ipv4ProcHex(host) {
  return host.split('.').reverse().map(b => Number(b).toString(16).padStart(2, '0')).join('').toUpperCase()
}

/**
 * An IPv6 address as `/proc/net/tcp6` prints it: four little-endian words.
 * `undefined` for a form this does not expand (an embedded IPv4 tail), which
 * then matches any listener and leaves ambiguity to the caller.
 *
 * @param {string} host
 * @returns {string | undefined}
 */
function ipv6ProcHex(host) {
  if (host.includes('.')) return undefined
  const [head, tail] = host.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const groups = host.includes('::')
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left
  if (groups.length !== 8) return undefined
  let out = ''
  for (let i = 0; i < 8; i += 2) {
    const word = groups[i].padStart(4, '0') + groups[i + 1].padStart(4, '0')
    out += word.match(/../g)?.reverse().join('') ?? ''
  }
  return out.toUpperCase()
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
 * `lsof -F pctn` prints, per process with a listening socket on the port, its
 * pid and short command name (not its arguments), then each socket's family
 * and local address. Only sockets that could refuse a bind on `host` count,
 * by the same rule as on Linux, and sockets held by more than one process
 * read as unknown.
 *
 * @param {number} port
 * @param {string | undefined} host
 * @param {typeof execFile} run
 * @param {number} deadline
 * @returns {Promise<PortOwner | undefined>}
 */
function probeLsof(port, host, run, deadline) {
  const timeout = Math.max(1, deadline - Date.now())
  const bare = host?.replace(/%.*$/, '')
  const family = bare ? net.isIP(bare) : 0
  const wildcard = family === 0 || bare === '0.0.0.0' || bare === '::'
  return new Promise(resolve => {
    run('lsof', ['-nP', '-w', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpctn'], { timeout, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error) { resolve(undefined); return }
      /** @type {PortOwner | undefined} */
      let owner
      /** @type {number | undefined} */
      let pid
      /** @type {string | undefined} */
      let executable
      let type = ''
      for (const line of String(stdout).split('\n')) {
        const field = line.slice(1)
        if (line.startsWith('p')) { pid = Number(field); executable = undefined; type = '' }
        else if (line.startsWith('c')) executable = sanitizeLabel(field, MAX_EXECUTABLE_CHARS)
        else if (line.startsWith('t')) type = field
        else if (line.startsWith('n') && pid !== undefined && Number.isInteger(pid) && pid > 0) {
          const address = field.slice(0, field.lastIndexOf(':')).replace(/^\[|\]$/g, '')
          const holds = wildcard
            || address === bare
            || (address === '*' && (family === 4 || type === 'IPv6'))
          if (!holds) continue
          if (owner && owner.pid !== pid) { resolve(undefined); return }
          owner = { pid, executable }
        }
      }
      resolve(owner)
    })
  })
}
