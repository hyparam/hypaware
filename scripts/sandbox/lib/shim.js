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
  if (result.out) process.stdout.write(result.out)
  if (result.err) process.stderr.write(result.err)
  process.exit(result.code)
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

/**
 * @param {string} file
 * @param {any} fallback
 */
function readState(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * @param {string} file
 * @param {any} value
 */
function writeState(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

// ---------------------------------------------------------------- launchctl

/**
 * @param {string[]} argv
 * @returns {ShimResult}
 */
function launchctl(argv) {
  const sub = argv[0]
  /** @type {SandboxLaunchdState} */
  const state = readState(launchdPath, { services: {}, env: {} })

  if (sub === 'setenv') {
    const [, name, value] = argv
    state.env[name] = value ?? ''
    writeState(launchdPath, state)
    return { code: 0, note: `setenv ${name}` }
  }

  if (sub === 'unsetenv') {
    const name = argv[1]
    delete state.env[name]
    writeState(launchdPath, state)
    return { code: 0, note: `unsetenv ${name}` }
  }

  if (sub === 'getenv') {
    const name = argv[1]
    const value = state.env[name]
    // Real launchctl prints nothing and still exits 0 for an unset variable.
    return { code: 0, out: value === undefined ? '' : `${value}\n` }
  }

  if (sub === 'bootstrap') {
    const plist = argv[argv.length - 1]
    const label = labelFromPlistFile(plist)
    if (!label) return { code: 64, err: `Bootstrap failed: 64: unreadable plist ${plist}\n` }
    // launchd refuses to bootstrap a label already in the domain, running or
    // not; `installLaunchAgent` boots out first, so this only fires on a real
    // double-bootstrap.
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
    writeState(launchdPath, state)
    return { code: 0, note: `bootstrap ${label}${service.pid ? ` pid ${service.pid}` : ' (not spawned)'}` }
  }

  if (sub === 'bootout') {
    const label = labelFromTarget(argv[argv.length - 1])
    const service = label ? state.services[label] : undefined
    if (!label || !service) return { code: 3, err: 'Boot-out failed: 3: No such process\n' }
    killService(label, service)
    delete state.services[label]
    writeState(launchdPath, state)
    return { code: 0, note: `bootout ${label}` }
  }

  if (sub === 'kickstart') {
    const label = labelFromTarget(argv[argv.length - 1])
    const service = label ? state.services[label] : undefined
    if (!label || !service) {
      return { code: 3, err: `Could not find service "${label}" in domain for\n` }
    }
    if (process.env.HYP_SANDBOX_SPAWN === '1') {
      // `-k` kills the running instance; the supervisor restarts it, which is
      // what launchd's KeepAlive does.
      const child = childPid(label)
      if (child) {
        try { process.kill(child, 'SIGTERM') } catch { /* already gone */ }
      } else if (!alivePid(service.pid)) {
        service.pid = startSupervisor(label, service.plist)
        writeState(launchdPath, state)
      }
    }
    return { code: 0, note: `kickstart ${label}` }
  }

  if (sub === 'print') {
    const label = labelFromTarget(argv[argv.length - 1])
    const service = label ? state.services[label] : undefined
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
    return true
  } catch {
    return false
  }
}

/**
 * Stop a service: kill its supervisor, which kills the daemon it is watching.
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
  try { fs.rmSync(servicePidPath(label)) } catch { /* nothing to clear */ }
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
  // `HYP_SANDBOX_SERVICE` marks everything launchd starts, and is inherited by
  // whatever the daemon spawns, so the shim can tell "the background agent did
  // this" from "the user typed this" without walking the process tree.
  const env = {
    ...process.env,
    ...parsePlistDict(xml, 'EnvironmentVariables'),
    HYP_SANDBOX_SERVICE: '1',
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
  const env = { ...process.env }
  for (const declaration of unitValues(body, 'Environment')) {
    for (const assignment of parseSystemdWords(declaration)) {
      const equals = assignment.indexOf('=')
      if (equals > 0) env[assignment.slice(0, equals)] = assignment.slice(equals + 1)
    }
  }
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
 *   env: NodeJS.ProcessEnv,
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
      fs.appendFileSync(callsPath, `${JSON.stringify({
        ts: new Date().toISOString(),
        tool: 'launchctl',
        args: ['(supervisor)', label],
        exit: -1,
        note: `crash loop: ${recentStarts.length} starts in ${RESTART_WINDOW_MS / 1000}s, giving up`,
      })}\n`)
      stop()
      return
    }
    const out = outPath ? openAppend(outPath) : 'ignore'
    const err = errPath ? openAppend(errPath) : 'ignore'
    current = spawn(argv[0], argv.slice(1), { stdio: ['ignore', out, err], env })
    writeState(pidFile, {
      label,
      pid: current.pid ?? null,
      startedAt: new Date().toISOString(),
      starts: recentStarts.length,
    })
    current.on('exit', () => {
      current = null
      if (stopping) return
      if (!keepAlive) {
        try { fs.rmSync(pidFile) } catch { /* nothing to clear */ }
        process.exit(0)
      }
      setTimeout(runOnce, throttleMs)
    })
  }

  runOnce()
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
  /** @type {SandboxKeychainState} */
  const state = readState(keychainPath, { certs: [] })

  if (sub === 'verify-cert') {
    const certPath = flagValue(argv, '-c')
    if (!certPath) return { code: 1, err: 'Error: no certificate given\n' }
    const digest = fileDigest(certPath)
    const hit = state.certs.find((c) => c.sha256 === digest && c.trusted)
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
    writeState(keychainPath, state)
    return { code: 0, note: `trusted ${commonName ?? certPath}` }
  }

  if (sub === 'delete-certificate') {
    const commonName = flagValue(argv, '-c')
    const remaining = state.certs.filter((c) => c.cn !== commonName)
    if (remaining.length === state.certs.length) {
      return {
        code: 1,
        err: 'SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n',
      }
    }
    state.certs = remaining
    writeState(keychainPath, state)
    return { code: 0, note: `deleted ${commonName}` }
  }

  if (sub === 'find-certificate') {
    const commonName = flagValue(argv, '-c')
    const hit = state.certs.find((c) => c.cn === commonName)
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
 * Best-effort CN extraction. Real `openssl` is on every macOS box; when it is
 * missing the sandbox falls back to the file path as the identity, which only
 * costs a `delete-certificate -c <CN>` match.
 *
 * @param {string} certPath
 * @returns {string | null}
 */
function certCommonName(certPath) {
  const res = spawnSync('openssl', ['x509', '-noout', '-subject', '-in', certPath], {
    encoding: 'utf8',
  })
  if (res.status !== 0 || !res.stdout) return null
  const match = /CN\s*=\s*([^,/\n]+)/.exec(res.stdout)
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
  /** @type {SandboxSystemdState} */
  const state = readState(systemdPath, { units: {} })

  if (sub === 'daemon-reload' || sub === 'reset-failed') return { code: 0 }

  if (sub === 'enable') {
    const entry = state.units[unit] ?? { enabled: false, active: false, pid: null, changedAt: '' }
    entry.enabled = true
    entry.changedAt = new Date().toISOString()
    state.units[unit] = entry
    writeState(systemdPath, state)
    return { code: 0, note: `${sub} ${unit}` }
  }

  if (sub === 'start' || sub === 'restart') {
    const entry = state.units[unit] ?? { enabled: false, active: false, pid: null, changedAt: '' }
    if (sub === 'restart' && entry.pid) killService(unit, entry)
    if (process.env.HYP_SANDBOX_SPAWN === '1' && !childPid(unit)) {
      const unitPath = path.join(process.env.HOME ?? '', '.config', 'systemd', 'user', unit)
      if (!fs.existsSync(unitPath)) return { code: 5, err: `Unit ${unit} not found.\n` }
      entry.pid = startSystemdSupervisor(unit, unitPath)
    }
    entry.active = true
    entry.changedAt = new Date().toISOString()
    state.units[unit] = entry
    writeState(systemdPath, state)
    return { code: 0, note: `${sub} ${unit}` }
  }

  if (sub === 'stop') {
    const entry = state.units[unit]
    if (entry) {
      killService(unit, entry)
      entry.active = false
      entry.pid = null
      entry.changedAt = new Date().toISOString()
      writeState(systemdPath, state)
    }
    return { code: 0, note: `${sub} ${unit}` }
  }

  if (sub === 'disable') {
    const entry = state.units[unit]
    if (entry) {
      entry.enabled = false
      entry.changedAt = new Date().toISOString()
      writeState(systemdPath, state)
    }
    return { code: 0, note: `${sub} ${unit}` }
  }

  if (sub === 'is-active') {
    const entry = state.units[unit]
    const active = process.env.HYP_SANDBOX_SPAWN === '1'
      ? Boolean(entry && childPid(unit))
      : Boolean(entry && entry.active)
    return { code: active ? 0 : 3, out: `${active ? 'active' : 'inactive'}\n` }
  }

  if (sub === 'is-enabled') {
    const enabled = Boolean(state.units[unit] && state.units[unit].enabled)
    return { code: enabled ? 0 : 1, out: `${enabled ? 'enabled' : 'disabled'}\n` }
  }

  if (sub === 'show') {
    const entry = state.units[unit]
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
