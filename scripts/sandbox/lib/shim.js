// @ts-check

/**
 * Mock `launchctl`, `security`, and `systemctl` for the HypAware sandbox.
 *
 * Every service-manager and keychain call in the kernel goes through one
 * seam: `runServiceCommand(bin, args)` in `src/core/daemon/service_ops.js`,
 * which spawns the bare binary name and so resolves it through `PATH`. The
 * sandbox puts `$HYP_SANDBOX_ROOT/bin` first on `PATH`, and the wrappers
 * there call into this file.
 *
 * The mocks keep their own state on disk so an install/uninstall round trip
 * behaves like the real thing (bootstrap twice fails, bootout of an unknown
 * label exits 3, an untrusted cert fails verify-cert) without ever touching
 * the real launchd domain or the real login keychain.
 *
 * Usage: `node shim.js <tool> <args...>`
 *
 * Env:
 * - `HYP_SANDBOX_ROOT`        sandbox root (required)
 * - `HYP_SANDBOX_SPAWN=1`     launchctl really starts the plist's program
 * - `HYP_SANDBOX_TRUST_REFUSE=1` `security add-trusted-cert` acts like the
 *                             user cancelling the macOS password dialog
 * - `HYP_SANDBOX_TRUST_FROM_DAEMON=grant`
 *                             let a daemon-issued `add-trusted-cert` succeed.
 *                             The default refuses it: the login keychain is
 *                             gated by a password dialog and the daemon is a
 *                             background agent with nobody watching. This is
 *                             an assumption the sandbox cannot verify, not a
 *                             measured fact - see README.md.
 * - `HYP_SANDBOX_SERVICE=1`   set by the supervisor in the daemon it starts,
 *                             so the shim can tell a daemon-issued call from
 *                             one the user typed. Inherited by its children.
 * - `HYP_SANDBOX_VERBOSE=1`   echo each intercepted call to stderr
 *
 * Test-only hooks. The sandbox is developer tooling excluded from the
 * published package (`package.json#files` has no `scripts/`), and the lock's
 * break-glass paths are unreachable from a test in any bounded time without
 * them: the wait budget is 15s and the critical section is microseconds long.
 * - `HYP_SANDBOX_TEST_HOLD_MS`  `updateState` parks this long inside the lock,
 *                             between the read and the write, so a test can
 *                             hold a second shim in the wait.
 * - `HYP_SANDBOX_TEST_LOCK_WAIT_MS`
 *                             override `LOCK_WAIT_MS`, so a test can reach the
 *                             budget-exhausted break without waiting 15s.
 *
 * @import {
 *   SandboxKeychainState,
 *   SandboxLaunchdState,
 *   SandboxService,
 *   SandboxSystemdState,
 *   ShimResult,
 * } from '../../../scripts/sandbox/lib/types.js'
 */

import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.env.HYP_SANDBOX_ROOT
if (!root) {
  process.stderr.write('hyp-sandbox shim: HYP_SANDBOX_ROOT is not set\n')
  process.exit(64)
}

const stateDir = path.join(root, 'state')
const callsPath = path.join(stateDir, 'calls.jsonl')
const launchdPath = path.join(stateDir, 'launchd.json')
const keychainPath = path.join(stateDir, 'keychain.json')
const systemdPath = path.join(stateDir, 'systemd.json')

// How long a stop waits for the processes it signalled to actually exit, and
// how often it re-checks. Real launchd holds the label until the job is gone,
// which is what `waitUntilUnloaded` (`src/core/daemon/macos.js`) polls for.
const STOP_WAIT_MS = 5000
const STOP_POLL_MS = 25

// How long a shim waits for another shim's state lock, and how old a lock has
// to be before it is assumed abandoned by a process that was killed mid-update.
const LOCK_WAIT_MS = 15_000
const LOCK_STALE_MS = 60_000

const tool = process.argv[2]
const args = process.argv.slice(3)

// `__supervise` is the shim re-entering itself as a KeepAlive supervisor; it
// never returns, and it must not be recorded as an intercepted call.
if (tool === '__supervise') {
  supervise(args[0], args[1])
} else if (tool === '__supervise_systemd') {
  superviseSystemd(args[0], args[1])
} else {
  main()
}

function main() {
  try {
    if (tool === 'launchctl') return finish(launchctl(args))
    if (tool === 'security') return finish(security(args))
    if (tool === 'systemctl') return finish(systemctl(args))
    return finish({ code: 64, err: `hyp-sandbox shim: unknown tool ${tool}\n` })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return finish({ code: 70, err: `hyp-sandbox shim: ${tool} failed: ${message}\n` })
  }
}

/**
 * @param {ShimResult} result
 */
function finish(result) {
  record(result)
  // `process.exitCode` rather than `process.exit()`: stdout is asynchronous
  // for a pipe on macOS, and every call arrives through the PATH wrapper on a
  // pipe. Exiting outright can truncate the payloads the kernel parses
  // (`launchctl print`'s pid line, `launchctl getenv`'s value), and the
  // failure is silent - the daemon reads as loaded with no pid.
  process.exitCode = result.code
  if (result.out) process.stdout.write(result.out)
  if (result.err) process.stderr.write(result.err)
}

/**
 * @param {ShimResult} result
 */
function record(result) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    tool,
    args,
    exit: result.code,
    note: result.note,
    cwd: process.cwd(),
    ppid: process.ppid,
  })
  fs.mkdirSync(stateDir, { recursive: true })
  fs.appendFileSync(callsPath, `${line}\n`)
  if (process.env.HYP_SANDBOX_VERBOSE === '1') {
    process.stderr.write(`[sandbox] ${tool} ${args.join(' ')} -> exit ${result.code}\n`)
  }
}

// Read errors worth another go: a fanned-out install can exhaust descriptors,
// and a retry costs a poll interval. Anything else (EACCES, EISDIR) will not
// improve by waiting.
const TRANSIENT_READ_CODES = new Set(['EMFILE', 'ENFILE', 'EAGAIN', 'EBUSY', 'EINTR'])
const READ_RETRIES = 3

/**
 * Read a state file, or hand back `fallback` when there is nothing to read.
 *
 * "Nothing to read" means ENOENT, and only ENOENT. Any other read failure is
 * thrown: `updateState` would otherwise take the empty fallback for the real
 * state and commit it under the lock, so one EMFILE erases the whole mock
 * domain and the shim reports success while doing it. A mock that says the
 * daemon was never installed is the confident wrong answer this sandbox
 * exists to avoid; an exit 70 naming the errno is not.
 *
 * A parse failure still falls back. `writeState` renames into place, so no
 * reader can see a torn file, and a body that will not parse is damage from
 * outside the shim that only a fresh file can clear.
 *
 * @param {string} file
 * @param {any} fallback
 */
function readState(file, fallback) {
  let raw = ''
  for (let attempt = 0; ; attempt += 1) {
    try {
      raw = fs.readFileSync(file, 'utf8')
      break
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code
      if (code === 'ENOENT') return fallback
      if (attempt >= READ_RETRIES || !TRANSIENT_READ_CODES.has(code ?? '')) throw err
      sleepSync(STOP_POLL_MS)
    }
  }
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

/**
 * Replace a state file atomically: write a sibling temp file, then rename it
 * over the target. A plain `writeFileSync` leaves a window in which a second
 * shim (the daemon's reconciler running `launchctl setenv` while the user
 * runs `hyp daemon install`) reads a half-written file. `readState` swallows
 * the parse error and hands back the empty fallback, so that reader would go
 * on to write a domain with no services and no setenv values, erasing the
 * whole mock domain. A rename is atomic, so every reader sees one complete
 * version or the other.
 *
 * @param {string} file
 * @param {any} value
 */
function writeState(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
    fs.renameSync(tmp, file)
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* nothing to clear */ }
    throw err
  }
}

/**
 * Read, change, and write a state file as one indivisible step.
 *
 * `writeState`'s rename fixes half the hazard: no reader sees a torn file.
 * The other half is the lost update, and a rename does nothing for it. Two
 * shims that each read, then each write, leave the second one's copy in
 * place, silently dropping whatever the first committed - which is the very
 * "erases the whole mock domain" outcome `writeState` is written to prevent.
 *
 * It is not theoretical. `bootout` blocks until the job has drained, so a
 * `launchctl setenv NODE_USE_SYSTEM_CA 1` landing in that window is erased
 * when the bootout writes back the domain it read seconds earlier. Delivering
 * that variable to the next launch is the whole point of the attach path this
 * mock exists to model, so losing it is a confident false negative.
 *
 * Anything that blocks - killing a job and waiting for it to go - stays
 * outside the lock. Only the read-change-write is held.
 *
 * @template S
 * @template T
 * @param {string} file
 * @param {S} fallback
 * @param {(state: S) => T} change
 * @returns {T}
 */
function updateState(file, fallback, change) {
  const release = acquireStateLock(file)
  try {
    const state = /** @type {S} */ (readState(file, fallback))
    testHold()
    // Write only what actually changed. The error and no-op paths (a second
    // `bootstrap`, a `systemctl start` of a unit that is not installed, a
    // `delete-certificate` that matches nothing) return without touching the
    // state, and writing anyway materialises a file that was never there:
    // `hyp-sandbox state` then prints an empty domain where it used to print
    // `(empty)`, which reads as "installed, and holding nothing".
    const before = JSON.stringify(state)
    const result = change(state)
    if (JSON.stringify(state) !== before) writeState(file, state)
    return result
  } finally {
    release()
  }
}

/**
 * How long to wait for another shim's lock. Overridable so a test can reach
 * the budget-exhausted break; see `HYP_SANDBOX_TEST_LOCK_WAIT_MS` above.
 *
 * @returns {number}
 */
function lockWaitMs() {
  const raw = process.env.HYP_SANDBOX_TEST_LOCK_WAIT_MS
  if (raw === undefined || raw === '') return LOCK_WAIT_MS
  const ms = Number(raw)
  return Number.isFinite(ms) && ms >= 0 ? ms : LOCK_WAIT_MS
}

/**
 * Park inside the critical section when a test asks for it; see
 * `HYP_SANDBOX_TEST_HOLD_MS` above. A no-op otherwise.
 */
function testHold() {
  const raw = process.env.HYP_SANDBOX_TEST_HOLD_MS
  if (!raw) return
  const ms = Number(raw)
  if (Number.isFinite(ms) && ms > 0) sleepSync(ms)
}

/**
 * Take the lock guarding `file`, and hand back the call that releases it.
 *
 * A mock that deadlocks is worse than one that races, so a lock left behind
 * by a shim that was killed mid-update is broken rather than waited on
 * forever, and a wait that outlives its budget gives up and proceeds
 * unlocked.
 *
 * @param {string} file
 * @returns {() => void}
 */
function acquireStateLock(file) {
  const lockPath = `${file}.lock`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const started = Date.now()
  const deadline = started + lockWaitMs()
  for (;;) {
    const held = tryStateLock(lockPath)
    if (held) return held
    const ageMs = lockAgeMs(lockPath)
    const stale = ageMs !== null && ageMs > LOCK_STALE_MS
    if (stale || Date.now() >= deadline) {
      // Every path out of here is a degraded one, and a degraded run that
      // leaves no line is indistinguishable from a clean one afterwards. The
      // lost update it may have caused shows up as a state file quietly
      // missing a setenv, hours later, in a run nobody can replay.
      //
      // Only when there is still a lock here to break, though. The holder can
      // release between the take that failed and this check, and a line
      // claiming an eviction that never happened is the same false record
      // this event exists to prevent: it sends a reader hunting a lost update
      // through a run that in the end never contended past its wait.
      if (ageMs !== null) recordLockEvent(file, stale ? 'broke-stale' : 'broke-budget', started, ageMs)
      try { fs.rmSync(lockPath, { force: true }) } catch { /* another shim broke it first */ }
      const retaken = tryStateLock(lockPath)
      if (retaken) return retaken
      recordLockEvent(file, 'degraded-unlocked', started, ageMs ?? 0)
      return () => {}
    }
    sleepSync(STOP_POLL_MS)
  }
}

/**
 * Append a line saying the lock guarding `file` was broken, or given up on.
 *
 * Shaped like `record`'s lines so `hyp-sandbox calls` renders it in place,
 * with a `lock` object a reader can filter on. `exit: -1` marks it as an
 * observation rather than an intercepted call, the way `supervisorNote` does.
 *
 * @param {string} file
 * @param {'broke-stale' | 'broke-budget' | 'degraded-unlocked'} event
 * @param {number} started
 * @param {number} ageMs
 */
function recordLockEvent(file, event, started, ageMs) {
  const name = path.basename(file)
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    tool,
    args,
    exit: -1,
    note: `state lock ${event}: ${name}`,
    lock: { file: name, event, ageMs, waitedMs: Date.now() - started },
    pid: process.pid,
    ppid: process.ppid,
  })
  try {
    fs.mkdirSync(stateDir, { recursive: true })
    fs.appendFileSync(callsPath, `${line}\n`)
  } catch { /* the sandbox root is gone; nothing left to tell */ }
}

/**
 * @param {string} lockPath
 * @returns {(() => void) | null}
 */
function tryStateLock(lockPath) {
  let fd
  try {
    fd = fs.openSync(lockPath, 'wx')
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'EEXIST') return null
    throw err
  }
  // The token is what makes the release safe, not a courtesy: a waiter whose
  // budget ran out breaks this lock and takes it for itself, so releasing by
  // name alone would delete a lock another shim is still holding and hand a
  // third one the read-change-write underneath it.
  const token = `${process.pid}.${crypto.randomBytes(4).toString('hex')}\n`
  try { fs.writeSync(fd, token) } catch { /* the release below then leaves it to the stale sweep */ }
  try { fs.closeSync(fd) } catch { /* already closed */ }
  return () => {
    try {
      if (fs.readFileSync(lockPath, 'utf8') !== token) return
    } catch {
      return // already broken or released; not ours to remove
    }
    try { fs.rmSync(lockPath, { force: true }) } catch { /* already released */ }
  }
}

/**
 * How long ago the lock at `lockPath` was taken, or null when there is no
 * lock there. Null rather than 0: a lock taken this same millisecond is also
 * 0ms old, and the caller has to tell "nothing to break" from "just taken".
 *
 * @param {string} lockPath
 * @returns {number | null}
 */
function lockAgeMs(lockPath) {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs
  } catch {
    // It was released while we looked at it, so it is not stale, it is gone.
    return null
  }
}

/** @returns {SandboxLaunchdState} */
function emptyLaunchd() {
  return { services: {}, env: {} }
}

/** @returns {SandboxSystemdState} */
function emptySystemd() {
  return { units: {} }
}

/** @returns {SandboxKeychainState} */
function emptyKeychain() {
  return { certs: [] }
}

// ---------------------------------------------------------------- launchctl

/**
 * @param {string[]} argv
 * @returns {ShimResult}
 */
function launchctl(argv) {
  const sub = argv[0]

  if (sub === 'setenv') {
    const [, name, value] = argv
    updateState(launchdPath, emptyLaunchd(), (state) => { state.env[name] = value ?? '' })
    return { code: 0, note: `setenv ${name}` }
  }

  if (sub === 'unsetenv') {
    const name = argv[1]
    updateState(launchdPath, emptyLaunchd(), (state) => { delete state.env[name] })
    return { code: 0, note: `unsetenv ${name}` }
  }

  if (sub === 'getenv') {
    const name = argv[1]
    const value = readState(launchdPath, emptyLaunchd()).env[name]
    // Real launchctl prints nothing and still exits 0 for an unset variable.
    return { code: 0, out: value === undefined ? '' : `${value}\n` }
  }

  if (sub === 'bootstrap') {
    const plist = argv[argv.length - 1]
    const label = labelFromPlistFile(plist)
    if (!label) return { code: 64, err: `Bootstrap failed: 64: unreadable plist ${plist}\n` }
    return updateState(launchdPath, emptyLaunchd(), (state) => {
      // launchd refuses to bootstrap a label already in the domain, running or
      // not; `installLaunchAgent` boots out first, so this only fires on a real
      // double-bootstrap. Checking it inside the lock is what makes two racing
      // bootstraps produce one service and one error 5 rather than two
      // supervisors fighting over the port.
      if (state.services[label]) {
        return { code: 5, err: 'Bootstrap failed: 5: Input/output error\n', note: `already loaded ${label}` }
      }
      /** @type {SandboxService} */
      const service = { label, plist, pid: null, loadedAt: new Date().toISOString() }
      if (process.env.HYP_SANDBOX_SPAWN === '1') {
        service.pid = startSupervisor(label, plist)
        service.supervised = true
      }
      state.services[label] = service
      return { code: 0, note: `bootstrap ${label}${service.pid ? ` pid ${service.pid}` : ' (not spawned)'}` }
    })
  }

  if (sub === 'bootout') {
    const label = labelFromTarget(argv[argv.length - 1])
    // Read once, unlocked, only to find what to kill: the kill blocks for as
    // long as the job takes to drain, and holding the lock across it would
    // stall every other shim for the same seconds.
    const service = label ? readState(launchdPath, emptyLaunchd()).services[label] : undefined
    if (!label || !service) return { code: 3, err: 'Boot-out failed: 3: No such process\n' }
    killService(label, service)
    // Re-read under the lock rather than writing back the pre-wait copy, which
    // would erase every setenv and bootstrap that landed during the wait, and
    // delete only the instance this call actually killed. The supervisor dies
    // on the first SIGTERM while its child is still draining, so a `kickstart`
    // landing in that window sees a dead pid and installs a fresh supervisor
    // under the same label. Deleting that one strands it outside the domain:
    // `print` answers 113 while it is live, the next `bootstrap` succeeds and
    // puts a second daemon on the port, and `stop_everything` cannot find it
    // to kill because it enumerates the domain.
    const kept = updateState(launchdPath, emptyLaunchd(), (state) => {
      const entry = state.services[label]
      // `kickstart` replaces the supervisor in place and leaves `loadedAt`
      // alone, so the pid is the part that identifies the instance; `loadedAt`
      // catches a bootout-then-bootstrap in the same window.
      if (!entry || entry.pid !== service.pid || entry.loadedAt !== service.loadedAt) return true
      delete state.services[label]
      return false
    })
    // Say which of the two things happened. `calls.jsonl` is the only account
    // the sandbox can give of itself, and "the label is gone" and "the label
    // now holds a supervisor this call did not start" are different worlds for
    // anyone reading back why a `hyp daemon restart` behaved as it did.
    const note = kept ? `bootout ${label} (kept the instance that replaced it)` : `bootout ${label}`
    return { code: 0, note }
  }

  if (sub === 'kickstart') {
    const label = labelFromTarget(argv[argv.length - 1])
    const service = label ? readState(launchdPath, emptyLaunchd()).services[label] : undefined
    if (!label || !service) {
      return { code: 3, err: `Could not find service "${label}" in domain for\n` }
    }
    if (process.env.HYP_SANDBOX_SPAWN === '1') {
      // Only `-k` kills the running instance (the supervisor then restarts
      // it, which is what launchd's KeepAlive does). Plain `kickstart` starts
      // an idle job and leaves a running one alone, and the difference is
      // load-bearing: `installLaunchAgent` and `startLaunchAgent`
      // (`src/core/daemon/macos.js`) kickstart *without* `-k` and then poll
      // for a pid, so a mock that always killed would report a successful
      // start while leaving the daemon down.
      const forceRestart = argv.includes('-k')
      const child = childPid(label)
      if (child) {
        if (forceRestart) {
          try { process.kill(child, 'SIGTERM') } catch { /* already gone */ }
        }
      } else if (!alivePid(service.pid)) {
        updateState(launchdPath, emptyLaunchd(), (state) => {
          const entry = state.services[label]
          // Re-check under the lock: another shim may have started one while
          // this one was deciding to, and two supervisors for one label means
          // two daemons on the port.
          if (!entry || alivePid(entry.pid)) return
          entry.pid = startSupervisor(label, entry.plist)
        })
      }
    }
    return { code: 0, note: `kickstart ${label}` }
  }

  if (sub === 'print') {
    const label = labelFromTarget(argv[argv.length - 1])
    const service = label ? readState(launchdPath, emptyLaunchd()).services[label] : undefined
    if (!label || !service) {
      return {
        code: 113,
        err: `Could not find service "${label}" in domain for login\n`,
      }
    }
    const child = childPid(label)
    const running = Boolean(child)
    const lines = [
      `${label} = {`,
      '\tactive count = 1',
      `\tpath = ${service.plist}`,
      `\tstate = ${running ? 'running' : 'not running'}`,
    ]
    if (running) lines.push(`\tpid = ${child}`)
    lines.push('\tdomain = sandbox', '}')
    return { code: 0, out: `${lines.join('\n')}\n` }
  }

  // Anything else: succeed loudly enough to be visible in `hyp-sandbox calls`.
  return { code: 0, note: `unhandled launchctl subcommand ${sub}` }
}

/**
 * Read the `Label` out of a LaunchAgent plist. Falls back to the filename
 * so a malformed body still round-trips through bootstrap/bootout.
 *
 * @param {string} plist
 * @returns {string | null}
 */
function labelFromPlistFile(plist) {
  let xml = ''
  try {
    xml = fs.readFileSync(plist, 'utf8')
  } catch {
    return null
  }
  const match = /<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(xml)
  if (match) return match[1].trim()
  return path.basename(plist).replace(/\.plist$/, '')
}

/**
 * Turn a launchctl target into a bare label. Accepts `gui/501/com.foo.bar`,
 * `user/501/com.foo.bar`, a bare label, or a plist path.
 *
 * @param {string} target
 * @returns {string | null}
 */
function labelFromTarget(target) {
  if (!target) return null
  if (target.endsWith('.plist')) return labelFromPlistFile(target)
  const parts = target.split('/')
  return parts[parts.length - 1] || null
}

/**
 * @param {{ pid: number | null }} service
 */
function aliveService(service) {
  return Boolean(service) && alivePid(service.pid)
}

/**
 * @param {number | null | undefined} pid
 */
function alivePid(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  return !isZombie(pid)
}

/**
 * A pid that has exited but not yet been reaped still answers signal 0, so a
 * stop that waits on `process.kill(pid, 0)` alone can hang on a zombie. The
 * supervisors are detached and orphaned by design, so whether they are reaped
 * promptly is up to whatever PID 1 the sandbox happens to run under. macOS
 * has no `/proc` and its launchd always reaps, so the read simply fails there
 * and the answer falls back to the signal probe.
 *
 * @param {number} pid
 */
function isZombie(pid) {
  let stat = ''
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
  } catch {
    return false
  }
  // `comm` is parenthesised and may itself contain spaces, so the state field
  // is the character two positions past the final `)`.
  const close = stat.lastIndexOf(')')
  return close !== -1 && stat[close + 2] === 'Z'
}

/**
 * Stop a service: kill its supervisor, which kills the daemon it is watching,
 * and do not return until both are actually gone.
 *
 * Waiting is the point. `bootout` deletes the domain entry, so `print` starts
 * answering 113 the moment this returns and `waitUntilUnloaded` is satisfied.
 * If the daemon were still winding down at that instant, the `bootstrap` that
 * follows a stop/restart/reinstall would race it for the gateway's listen
 * port, and an explicitly configured `listen` fails loudly on EADDRINUSE. The
 * sandbox would be manufacturing a HypAware bug that is not there.
 *
 * @param {string} label
 * @param {{ pid: number | null }} service
 */
function killService(label, service) {
  const child = childPid(label)
  if (aliveService(service)) {
    try { process.kill(/** @type {number} */ (service.pid), 'SIGTERM') } catch { /* gone */ }
  }
  // Belt and braces: if the supervisor died without cleaning up, the daemon
  // it started would otherwise keep the port and the pid file.
  if (child) {
    try { process.kill(child, 'SIGTERM') } catch { /* gone */ }
  }
  waitForExit([service.pid, child])
  // Clear the pid file only when it does not name a live child some other
  // supervisor is running. A supervisor installed while this one was draining
  // (a `kickstart` or a `systemctl start` landing inside the wait) has already
  // written its own child here, and the callers this mock serves read exactly
  // this: `launchctl print`'s `pid = N` line and `systemctl show`'s `MainPID`.
  // Removing it makes the sandbox report a running daemon as `not running`,
  // which is the same confident wrong answer that leaving the domain entry in
  // place is there to avoid.
  const recorded = readState(servicePidPath(label), null)?.pid ?? null
  if (!recorded || recorded === child || !alivePid(recorded)) {
    try { fs.rmSync(servicePidPath(label)) } catch { /* nothing to clear */ }
  }
}

/**
 * Block until none of `pids` is alive, escalating to SIGKILL once the grace
 * period is spent. The child is escalated alongside the supervisor so a
 * SIGKILL cannot orphan the daemon onto the port.
 *
 * @param {(number | null | undefined)[]} pids
 */
function waitForExit(pids) {
  const targets = pids.filter((pid) => typeof pid === 'number' && pid > 0)
  if (targets.length === 0) return
  if (waitWhileAlive(targets, STOP_WAIT_MS)) return
  for (const pid of targets) {
    if (alivePid(pid)) {
      try { process.kill(/** @type {number} */ (pid), 'SIGKILL') } catch { /* gone */ }
    }
  }
  waitWhileAlive(targets, STOP_WAIT_MS)
}

/**
 * @param {(number | null | undefined)[]} pids
 * @param {number} budgetMs
 * @returns {boolean} true when every pid is gone within the budget
 */
function waitWhileAlive(pids, budgetMs) {
  const deadline = Date.now() + budgetMs
  for (;;) {
    if (!pids.some(alivePid)) return true
    if (Date.now() >= deadline) return false
    sleepSync(STOP_POLL_MS)
  }
}

/**
 * Sleep without yielding to the event loop. The shim is a one-shot process
 * whose exit code and stdout are the whole contract, so `killService` has to
 * stay synchronous all the way up to `launchctl(argv)`'s return.
 *
 * @param {number} ms
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Path of the file the supervisor keeps its current child's pid in.
 *
 * @param {string} label
 */
function servicePidPath(label) {
  return path.join(stateDir, `service-${label}.json`)
}

/**
 * The pid of the daemon a supervisor is currently running, or null.
 *
 * @param {string} label
 * @returns {number | null}
 */
function childPid(label) {
  const entry = readState(servicePidPath(label), null)
  if (!entry || !alivePid(entry.pid)) return null
  return entry.pid
}

/**
 * Start a detached supervisor for the plist. Only used when
 * `HYP_SANDBOX_SPAWN=1`; the default mock records the bootstrap and starts
 * nothing.
 *
 * A plain one-shot spawn is not enough: HypAware applies a pulled config by
 * exiting and letting launchd's `KeepAlive` bring it back, so a mock without a
 * supervisor leaves the machine daemon-less exactly when a fleet config lands.
 *
 * @param {string} label
 * @param {string} plist
 * @returns {number | null}
 */
function startSupervisor(label, plist) {
  const child = spawn(process.execPath, [import.meta.filename, '__supervise', label, plist], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()
  return child.pid ?? null
}

/**
 * Run the plist's program, restarting it when it exits, the way launchd's
 * `KeepAlive` does. Exits when booted out (SIGTERM) or when the program has
 * crash-looped past the ceiling below.
 *
 * Restarts are throttled at 1s rather than launchd's 10s `ThrottleInterval`,
 * so a restart-driven test does not spend most of its wall clock waiting.
 *
 * @param {string} label
 * @param {string} plist
 */
function supervise(label, plist) {
  const xml = fs.readFileSync(plist, 'utf8')
  const argv = parsePlistArray(xml, 'ProgramArguments')
  const keepAlive = /<key>KeepAlive<\/key>\s*<true\/>/.test(xml)
  const jobEnv = parsePlistDict(xml, 'EnvironmentVariables')
  // Real launchd injects whatever `launchctl setenv` put in the domain into
  // every job it starts afterwards. That delivery is the point of the
  // `NODE_USE_SYSTEM_CA` setenv the attach path makes, so a mock that only
  // stored the value would let `getenv` report it set while the daemon it
  // started never saw it - a false green whose outcome depends on whatever
  // the invoking shell happened to export. The plist's own
  // `EnvironmentVariables` still win, the way a job-level setting outranks
  // the domain.
  //
  // Read the domain per launch rather than once here: `hyp attach claude`
  // setenvs and *then* lets the daemon restart to pick the value up, so a
  // snapshot taken at bootstrap would miss every setenv the run makes and
  // give a confident false negative on the one path this models.
  //
  // `HYP_SANDBOX_SERVICE` marks everything launchd starts, and is inherited by
  // whatever the daemon spawns, so the shim can tell "the background agent did
  // this" from "the user typed this" without walking the process tree.
  const env = () => {
    /** @type {SandboxLaunchdState} */
    let domain = { services: {}, env: {} }
    // `readState` now throws on a read that failed for a reason other than the
    // file being absent, and this getter runs on every relaunch inside a
    // detached process with stdio ignored, where an uncaught throw would take
    // KeepAlive down without a word. Launch with what the plist carries and
    // leave a line naming the errno instead.
    try {
      domain = readState(launchdPath, domain)
    } catch (err) {
      supervisorNote(label, `could not read the launchd domain: ${err instanceof Error ? err.message : String(err)}`)
    }
    return {
      ...process.env,
      ...domain.env,
      ...jobEnv,
      HYP_SANDBOX_SERVICE: '1',
    }
  }
  const outPath = parsePlistString(xml, 'StandardOutPath')
  const errPath = parsePlistString(xml, 'StandardErrorPath')

  superviseProgram({
    label,
    argv,
    keepAlive,
    env,
    outPath,
    errPath,
    throttleMs: 1000,
  })
}

/**
 * Run a systemd unit's ExecStart under the same detached supervisor used for
 * launchd. The generated HypAware units use only the directives read here.
 *
 * @param {string} unit
 * @param {string} unitPath
 */
function superviseSystemd(unit, unitPath) {
  const body = fs.readFileSync(unitPath, 'utf8')
  const argv = parseSystemdWords(unitValues(body, 'ExecStart')[0] ?? '')
  const restart = unitValues(body, 'Restart')[0] === 'always'
  const restartSec = Number(unitValues(body, 'RestartSec')[0] ?? '1')
  // The same marker the launchd lane sets. Without it a daemon started
  // through systemd looks user-issued to the `security` mock, and the
  // default-refuse assumption silently does not apply on this lane.
  /** @type {NodeJS.ProcessEnv} */
  const unitEnv = { ...process.env, HYP_SANDBOX_SERVICE: '1' }
  for (const declaration of unitValues(body, 'Environment')) {
    for (const assignment of parseSystemdWords(declaration)) {
      const equals = assignment.indexOf('=')
      if (equals > 0) unitEnv[assignment.slice(0, equals)] = assignment.slice(equals + 1)
    }
  }
  // systemd has no `launchctl setenv` equivalent in this mock, so the unit's
  // environment is fixed at load time; the getter keeps one supervisor shape.
  const env = () => unitEnv
  const stdout = unitValues(body, 'StandardOutput')[0] ?? ''
  const stderr = unitValues(body, 'StandardError')[0] ?? ''

  superviseProgram({
    label: unit,
    argv,
    keepAlive: restart,
    env,
    outPath: stdout.startsWith('append:') ? stdout.slice('append:'.length) : null,
    errPath: stderr.startsWith('append:') ? stderr.slice('append:'.length) : null,
    throttleMs: Number.isFinite(restartSec) && restartSec >= 0 ? restartSec * 1000 : 1000,
  })
}

/**
 * Supervise one service command until it stops or exceeds the crash-loop cap.
 *
 * @param {{
 *   label: string,
 *   argv: string[],
 *   keepAlive: boolean,
 *   env: () => NodeJS.ProcessEnv,
 *   outPath: string | null,
 *   errPath: string | null,
 *   throttleMs: number,
 * }} options
 */
function superviseProgram(options) {
  const { label, argv, keepAlive, env, outPath, errPath, throttleMs } = options
  if (argv.length === 0) process.exit(0)
  const pidFile = path.join(stateDir, `service-${label}.json`)

  const RESTART_CEILING = 20
  const RESTART_WINDOW_MS = 60_000
  /** @type {number[]} */
  const recentStarts = []
  /** @type {import('node:child_process').ChildProcess | null} */
  let current = null
  let stopping = false

  const stop = () => {
    stopping = true
    if (current && current.pid) {
      try { process.kill(current.pid, 'SIGTERM') } catch { /* gone */ }
    }
    try { fs.rmSync(pidFile) } catch { /* nothing to clear */ }
    process.exit(0)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)

  const runOnce = () => {
    if (stopping) return
    const now = Date.now()
    recentStarts.push(now)
    while (recentStarts.length > 0 && now - recentStarts[0] > RESTART_WINDOW_MS) recentStarts.shift()
    if (recentStarts.length > RESTART_CEILING) {
      supervisorNote(label, `crash loop: ${recentStarts.length} starts in ${RESTART_WINDOW_MS / 1000}s, giving up`)
      stop()
      return
    }
    const out = outPath ? openAppend(outPath) : 'ignore'
    const err = errPath ? openAppend(errPath) : 'ignore'
    // `spawn` does not take ownership of fds handed to it, and the restart
    // cycle this supervisor exists to reproduce would otherwise leak two per
    // restart and walk a long session toward EMFILE.
    const closeLogFds = () => {
      for (const fd of [out, err]) {
        if (typeof fd === 'number') {
          try { fs.closeSync(fd) } catch { /* already closed */ }
        }
      }
    }
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', out, err], env: env() })
    current = child
    writeState(pidFile, {
      label,
      pid: child.pid ?? null,
      startedAt: new Date().toISOString(),
      starts: recentStarts.length,
    })
    // `spawn` reports a program it could not launch at all (a stale node path
    // after an in-sandbox `npm install -g`, say) as an `error` event and no
    // `exit`. With stdio ignored and no listener, that unhandled event kills
    // the supervisor itself: KeepAlive silently stops keeping anything alive
    // and `hyp-sandbox calls` shows only the bootstrap that appeared to work.
    // Treat it as an immediate exit, and leave a line saying which program.
    let settled = false
    const settle = (/** @type {string | null} */ note) => {
      if (settled) return
      settled = true
      if (current === child) current = null
      closeLogFds()
      if (note) supervisorNote(label, note)
      if (stopping) return
      if (!keepAlive) {
        try { fs.rmSync(pidFile) } catch { /* nothing to clear */ }
        process.exit(0)
      }
      setTimeout(runOnce, throttleMs)
    }
    child.on('error', (spawnErr) => {
      try { fs.rmSync(pidFile) } catch { /* nothing to clear */ }
      settle(`could not start ${argv[0]}: ${spawnErr.message}`)
    })
    child.on('exit', () => settle(null))
  }

  runOnce()
}

/**
 * Append a supervisor observation to `calls.jsonl`. The supervisor runs
 * detached with stdio ignored, so this log is the only channel it has, and a
 * failure it does not write here is a failure the run cannot explain.
 *
 * @param {string} label
 * @param {string} note
 */
function supervisorNote(label, note) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    tool: 'launchctl',
    args: ['(supervisor)', label],
    exit: -1,
    note,
  })
  try {
    fs.mkdirSync(stateDir, { recursive: true })
    fs.appendFileSync(callsPath, `${line}\n`)
  } catch { /* the sandbox root is gone; nothing left to tell */ }
}

/**
 * @param {string} file
 */
function openAppend(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  return fs.openSync(file, 'a')
}

/**
 * @param {string} xml
 * @param {string} key
 * @returns {string[]}
 */
function parsePlistArray(xml, key) {
  const block = sliceAfterKey(xml, key)
  if (!block) return []
  const arrayMatch = /<array>([\s\S]*?)<\/array>/.exec(block)
  if (!arrayMatch) return []
  return [...arrayMatch[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unescapeXml(m[1]))
}

/**
 * @param {string} xml
 * @param {string} key
 * @returns {Record<string, string>}
 */
function parsePlistDict(xml, key) {
  const block = sliceAfterKey(xml, key)
  if (!block) return {}
  const dictMatch = /<dict>([\s\S]*?)<\/dict>/.exec(block)
  if (!dictMatch) return {}
  /** @type {Record<string, string>} */
  const out = {}
  const pairs = [...dictMatch[1].matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g)]
  for (const pair of pairs) out[unescapeXml(pair[1])] = unescapeXml(pair[2])
  return out
}

/**
 * @param {string} xml
 * @param {string} key
 * @returns {string | null}
 */
function parsePlistString(xml, key) {
  const block = sliceAfterKey(xml, key)
  if (!block) return null
  const match = /^\s*<string>([\s\S]*?)<\/string>/.exec(block)
  return match ? unescapeXml(match[1]) : null
}

/**
 * @param {string} xml
 * @param {string} key
 * @returns {string | null}
 */
function sliceAfterKey(xml, key) {
  const idx = xml.indexOf(`<key>${key}</key>`)
  if (idx === -1) return null
  return xml.slice(idx + key.length + 11)
}

/**
 * @param {string} value
 */
function unescapeXml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * Read every value assigned to a systemd unit directive.
 *
 * @param {string} body
 * @param {string} name
 * @returns {string[]}
 */
function unitValues(body, name) {
  const prefix = `${name}=`
  return body.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length))
}

/**
 * Split the quoting and escaping emitted by `buildUnit` into argv words.
 *
 * @param {string} value
 * @returns {string[]}
 */
function parseSystemdWords(value) {
  /** @type {string[]} */
  const words = []
  let word = ''
  let quote = ''
  let escaped = false
  let started = false
  for (const char of value) {
    if (escaped) {
      word += char
      escaped = false
      started = true
    } else if (char === '\\') {
      escaped = true
      started = true
    } else if (quote) {
      if (char === quote) quote = ''
      else word += char
      started = true
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started) {
        words.push(word)
        word = ''
        started = false
      }
    } else {
      word += char
      started = true
    }
  }
  if (escaped) word += '\\'
  if (started) words.push(word)
  return words
}

// ------------------------------------------------------------------ security

/**
 * @param {string[]} argv
 * @returns {ShimResult}
 */
function security(argv) {
  const sub = argv[0]

  if (sub === 'verify-cert') {
    const certPath = flagValue(argv, '-c')
    if (!certPath) return { code: 1, err: 'Error: no certificate given\n' }
    const digest = fileDigest(certPath)
    const hit = readState(keychainPath, emptyKeychain()).certs.find((c) => c.sha256 === digest && c.trusted)
    if (hit) return { code: 0, out: '...certificate verification successful.\n' }
    return {
      code: 1,
      err: 'Error: certificate verification failed: CSSMERR_TP_NOT_TRUSTED\n',
      note: 'cert not trusted in sandbox keychain',
    }
  }

  if (sub === 'add-trusted-cert') {
    if (process.env.HYP_SANDBOX_TRUST_REFUSE === '1') {
      return {
        code: 1,
        err: 'SecTrustSettingsSetTrustSettings: User canceled the operation.\n',
        note: 'simulated dialog cancel',
      }
    }
    // Trusting a CA in the login keychain is gated by the macOS password
    // dialog, so it needs a human at the session. The attach action runs the
    // same code in the CLI and in the daemon's reconciler, and the daemon is a
    // background LaunchAgent with nobody watching - so a mock that always
    // succeeds makes an unattended fleet setup look like it establishes trust,
    // which is precisely the wrong answer to take away from a test run.
    //
    // Whether real macOS lets a LaunchAgent raise that dialog is NOT settled
    // (only a second user account or a VM can settle it). The sandbox takes
    // the pessimistic reading by default and says so; flip it with
    // `--trust-from-daemon grant` to test the other branch.
    if (process.env.HYP_SANDBOX_SERVICE === '1' && process.env.HYP_SANDBOX_TRUST_FROM_DAEMON !== 'grant') {
      return {
        code: 1,
        err: 'SecTrustSettingsSetTrustSettings: User interaction is not allowed.\n',
        note: 'daemon-issued trust refused (sandbox ASSUMPTION: a background LaunchAgent cannot raise the password dialog; --trust-from-daemon grant to assume it can)',
      }
    }
    const certPath = argv[argv.length - 1]
    const digest = fileDigest(certPath)
    if (!digest) return { code: 1, err: `SecCertificateCreateFromData: unreadable ${certPath}\n` }
    const commonName = certCommonName(certPath)
    const keychain = flagValue(argv, '-k') ?? ''
    updateState(keychainPath, emptyKeychain(), (state) => {
      const without = state.certs.filter((c) => c.sha256 !== digest)
      without.push({
        cn: commonName,
        path: certPath,
        sha256: digest,
        keychain,
        trusted: true,
        addedAt: new Date().toISOString(),
      })
      state.certs = without
    })
    return { code: 0, note: `trusted ${commonName ?? certPath}` }
  }

  if (sub === 'delete-certificate') {
    const commonName = flagValue(argv, '-c')
    return updateState(keychainPath, emptyKeychain(), (state) => {
      const remaining = state.certs.filter((c) => c.cn !== commonName)
      if (remaining.length === state.certs.length) {
        return {
          code: 1,
          err: 'SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n',
        }
      }
      state.certs = remaining
      return { code: 0, note: `deleted ${commonName}` }
    })
  }

  if (sub === 'find-certificate') {
    const commonName = flagValue(argv, '-c')
    const hit = readState(keychainPath, emptyKeychain()).certs.find((c) => c.cn === commonName)
    if (!hit) {
      return {
        code: 44,
        err: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n',
      }
    }
    return { code: 0, out: `keychain: "${hit.keychain}"\n"labl"<blob>="${hit.cn}"\n` }
  }

  return {
    code: 0,
    err: `hyp-sandbox: unhandled 'security ${sub}', pretending it succeeded\n`,
    note: `unhandled security subcommand ${sub}`,
  }
}

/**
 * @param {string[]} argv
 * @param {string} flag
 * @returns {string | undefined}
 */
function flagValue(argv, flag) {
  const idx = argv.indexOf(flag)
  return idx === -1 ? undefined : argv[idx + 1]
}

/**
 * @param {string} file
 * @returns {string | null}
 */
function fileDigest(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

/**
 * The certificate's CN, which is the only handle `delete-certificate -c <CN>`
 * and `find-certificate -c <CN>` have on a stored cert. Parsed in process
 * rather than by shelling out: a null CN makes removal a silent no-op,
 * `removeCaTrust` reads the resulting "could not be found" as already-absent,
 * and `hyp daemon uninstall` then reports it removed trust it did not.
 * `openssl` stays as a fallback for anything this Node cannot parse.
 *
 * @param {string} certPath
 * @returns {string | null}
 */
function certCommonName(certPath) {
  let subject = ''
  try {
    subject = new crypto.X509Certificate(fs.readFileSync(certPath)).subject
  } catch {
    const res = spawnSync('openssl', ['x509', '-noout', '-subject', '-in', certPath], {
      encoding: 'utf8',
    })
    if (res.status !== 0 || !res.stdout) return null
    subject = res.stdout
  }
  const match = /CN\s*=\s*([^,/\n]+)/.exec(subject)
  return match ? match[1].trim() : null
}

// ----------------------------------------------------------------- systemctl

/**
 * @param {string[]} argv
 * @returns {ShimResult}
 */
function systemctl(argv) {
  const rest = argv.filter((a) => a !== '--user')
  const sub = rest[0]
  const unit = rest[1]

  if (sub === 'daemon-reload' || sub === 'reset-failed') return { code: 0 }

  if (sub === 'enable') {
    updateState(systemdPath, emptySystemd(), (state) => {
      const entry = state.units[unit] ?? newUnit()
      entry.enabled = true
      entry.changedAt = new Date().toISOString()
      state.units[unit] = entry
    })
    return { code: 0, note: `${sub} ${unit}` }
  }

  if (sub === 'start' || sub === 'restart') {
    if (sub === 'restart') {
      // Outside the lock: this blocks until the unit has actually exited.
      const previous = readState(systemdPath, emptySystemd()).units[unit]
      if (previous && previous.pid) killService(unit, previous)
    }
    return updateState(systemdPath, emptySystemd(), (state) => {
      const entry = state.units[unit] ?? newUnit()
      // `childPid` alone is not enough to say a unit is already running: a
      // supervisor between restarts has removed its child's pid file and is
      // still very much alive, so a second `start` would install a second
      // supervisor for the one unit. Only the newer pid reaches `systemd.json`,
      // and `stop` and `stop_everything` kill only what it records, so the
      // older one survives both. Same re-check `kickstart` makes above.
      if (process.env.HYP_SANDBOX_SPAWN === '1' && !childPid(unit) && !alivePid(entry.pid)) {
        const unitPath = path.join(process.env.HOME ?? '', '.config', 'systemd', 'user', unit)
        if (!fs.existsSync(unitPath)) return { code: 5, err: `Unit ${unit} not found.\n` }
        entry.pid = startSystemdSupervisor(unit, unitPath)
      }
      entry.active = true
      entry.changedAt = new Date().toISOString()
      state.units[unit] = entry
      return { code: 0, note: `${sub} ${unit}` }
    })
  }

  if (sub === 'stop') {
    const previous = readState(systemdPath, emptySystemd()).units[unit]
    if (!previous) return { code: 0, note: `${sub} ${unit}` }
    killService(unit, previous)
    const kept = updateState(systemdPath, emptySystemd(), (state) => {
      const entry = state.units[unit]
      // Only clear the instance this call killed. A `start` that landed while
      // the unit was draining recorded a live supervisor here, and nulling
      // its pid would strand it: nothing else records it, so neither `stop`
      // nor `stop_everything` could reach it again.
      if (!entry) return false
      if (entry.pid !== previous.pid) return true
      entry.active = false
      entry.pid = null
      entry.changedAt = new Date().toISOString()
      return false
    })
    // Leaving the replacement alone is the right trade, but this call still
    // exits 0 with the unit live, and that is the whole of what the caller
    // sees. Say it here, the way `bootout` does, so a run that hit the race
    // can be told from one where the stop really did stop everything.
    const note = kept ? `${sub} ${unit} (kept the instance that replaced it)` : `${sub} ${unit}`
    return { code: 0, note }
  }

  if (sub === 'disable') {
    updateState(systemdPath, emptySystemd(), (state) => {
      const entry = state.units[unit]
      if (!entry) return
      entry.enabled = false
      entry.changedAt = new Date().toISOString()
    })
    return { code: 0, note: `${sub} ${unit}` }
  }

  if (sub === 'is-active') {
    const entry = readState(systemdPath, emptySystemd()).units[unit]
    const active = process.env.HYP_SANDBOX_SPAWN === '1'
      ? Boolean(entry && childPid(unit))
      : Boolean(entry && entry.active)
    return { code: active ? 0 : 3, out: `${active ? 'active' : 'inactive'}\n` }
  }

  if (sub === 'is-enabled') {
    const entry = readState(systemdPath, emptySystemd()).units[unit]
    const enabled = Boolean(entry && entry.enabled)
    return { code: enabled ? 0 : 1, out: `${enabled ? 'enabled' : 'disabled'}\n` }
  }

  if (sub === 'show') {
    const entry = readState(systemdPath, emptySystemd()).units[unit]
    const pid = entry ? childPid(unit) : null
    const active = process.env.HYP_SANDBOX_SPAWN === '1' ? Boolean(pid) : Boolean(entry && entry.active)
    return {
      code: 0,
      out: `LoadState=${entry ? 'loaded' : 'not-found'}\nMainPID=${pid ?? 0}\nActiveState=${active ? 'active' : 'inactive'}\n`,
    }
  }

  return { code: 0, note: `unhandled systemctl subcommand ${sub}` }
}

/**
 * A unit the mock has not seen before.
 *
 * @returns {SandboxSystemdState['units'][string]}
 */
function newUnit() {
  return { enabled: false, active: false, pid: null, changedAt: '' }
}

/**
 * Start a detached supervisor for a systemd unit.
 *
 * @param {string} unit
 * @param {string} unitPath
 * @returns {number | null}
 */
function startSystemdSupervisor(unit, unitPath) {
  const child = spawn(process.execPath, [import.meta.filename, '__supervise_systemd', unit, unitPath], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()
  return child.pid ?? null
}
