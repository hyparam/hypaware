// @ts-check

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/**
 * Fixtures shared by the `sandbox-shim*.test.js` files: a sandbox root with a
 * LaunchAgent plist or a systemd user unit in it, the shim run as a child
 * process the way the PATH wrappers run it, and the polls that wait on what
 * a detached supervisor writes.
 */

export const SHIM = fileURLToPath(new URL('../../scripts/sandbox/lib/shim.js', import.meta.url))

/**
 * Run the shim once against `root`.
 *
 * @param {string} root
 * @param {string} tool
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 */
export function shim(root, tool, args, env = {}) {
  const result = spawnSync(process.execPath, [SHIM, tool, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HYP_SANDBOX_ROOT: root, ...env },
  })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

/**
 * A sandbox root with a LaunchAgent plist in it, booted out and removed when
 * the test ends.
 *
 * @param {import('node:test').TestContext} t
 * @param {string} [label]
 */
export function sandboxRoot(t, label = 'com.hyperparam.hypaware.test') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-shim-test-'))
  // Stop before delete, in one hook, for the same reason `systemdRoot` gives
  // below: node:test runs `after` hooks in registration order, so a bootout a
  // test body registers later runs after this root has already been removed.
  // The mock reads empty state, answers 3, and kills nothing, which leaves the
  // KeepAlive supervisor and the program it keeps restarting alive past the
  // end of `npm test` for as long as the machine stays up.
  t.after(() => {
    shim(root, 'launchctl', ['bootout', `gui/501/${label}`])
    fs.rmSync(root, { recursive: true, force: true })
  })
  const plist = path.join(root, `${label}.plist`)
  fs.writeFileSync(plist, [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${label}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>/usr/bin/true</string>',
    '  </array>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n'))
  return { root, plist, label, target: `gui/501/${label}` }
}

/**
 * A sandbox root with a systemd user unit in it.
 *
 * @param {import('node:test').TestContext} t
 * @param {string} [unit]
 */
export function systemdRoot(t, unit = 'hypaware.service') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-shim-systemd-test-'))
  const home = path.join(root, 'home')
  // Stop before delete, in one hook: node:test runs `after` hooks in
  // registration order, so a separate stop hook registered by the test body
  // would run after this root was already removed, the mock would read empty
  // state, find no unit, and leave the detached supervisor and its child
  // orphaned past the end of `npm test`.
  t.after(() => {
    shim(root, 'systemctl', ['--user', 'stop', unit], { HOME: home })
    fs.rmSync(root, { recursive: true, force: true })
  })
  const unitDir = path.join(home, '.config', 'systemd', 'user')
  const unitPath = path.join(unitDir, unit)
  fs.mkdirSync(unitDir, { recursive: true })
  fs.writeFileSync(unitPath, [
    '[Service]',
    'Type=simple',
    'ExecStart=/bin/sleep 30',
    'Restart=no',
    '',
  ].join('\n'))
  return { root, home, unit }
}

/**
 * The body a job wrote into `file`, once `ready` accepts it.
 *
 * A shell `>` truncates the path into existence, and `>>` creates it, before
 * `printf` writes into it, so a poll on the file existing can read it empty in
 * the gap between. The default `ready` takes any content, which is enough only
 * because every job here writes its whole payload in one `printf`; a job that
 * wrote in two steps would read back as a prefix, so give that one a `ready`
 * that recognizes the end of the body. Returns the last read when nothing
 * satisfies `ready`, so the caller's assertion reports what the job did write.
 *
 * @param {string} file
 * @param {(body: string) => boolean} [ready]
 * @returns {Promise<string>}
 */
export async function waitForBody(file, ready = (body) => body !== '') {
  let body = ''
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { body = fs.readFileSync(file, 'utf8') } catch { /* the job has not created it yet */ }
    if (ready(body)) return body
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return body
}

/**
 * Write a plist over `sandboxRoot`'s default one, running `argv` under the
 * `KeepAlive` the installed HypAware LaunchAgent uses.
 *
 * @param {string} root
 * @param {string} label
 * @param {string[]} argv
 * @param {{ keepAlive?: boolean }} [options]
 */
export function writePlist(root, label, argv, options = {}) {
  const keepAlive = options.keepAlive !== false
  const plist = path.join(root, `${label}.plist`)
  const escape = (/** @type {string} */ value) => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  fs.writeFileSync(plist, [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${label}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...argv.map((arg) => `    <string>${escape(arg)}</string>`),
    '  </array>',
    ...(keepAlive ? ['  <key>KeepAlive</key>', '  <true/>'] : []),
    '</dict>',
    '</plist>',
    '',
  ].join('\n'))
  return plist
}

/**
 * Poll `launchctl print` until it reports a running pid other than `not`.
 *
 * @param {string} root
 * @param {string} target
 * @param {Record<string, string>} env
 * @param {number | null} [not]
 * @returns {Promise<number | null>}
 */
export async function waitForPid(root, target, env, not = null) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const printed = shim(root, 'launchctl', ['print', target], env)
    const match = /\bpid = (\d+)/.exec(printed.stdout)
    if (match && Number(match[1]) !== not) return Number(match[1])
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return null
}

/**
 * A pid that has exited but has not been reaped. It still answers signal 0 and
 * shrugs off SIGKILL, which is exactly the state the sandbox's detached,
 * orphaned supervisors end up in under a PID 1 that does not reap. Resolves to
 * null when this host cannot produce one.
 *
 * @param {import('node:test').TestContext} t
 * @returns {Promise<number | null>}
 */
export async function unreapedPid(t) {
  // `$| = 1` so the pid reaches us before the parent parks; perl does not reap
  // on its own, so the child stays unreaped for as long as the parent lives.
  const maker = spawn('perl', ['-e', '$| = 1; my $p = fork(); if ($p == 0) { exit 0 } print "$p\\n"; sleep 30;'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  t.after(() => { try { maker.kill('SIGKILL') } catch { /* already gone */ } })

  const pid = await new Promise((resolve) => {
    let seen = ''
    const done = setTimeout(() => resolve(null), 5000)
    maker.on('error', () => { clearTimeout(done); resolve(null) })
    maker.stdout.on('data', (chunk) => {
      seen += chunk.toString('utf8')
      if (!seen.includes('\n')) return
      clearTimeout(done)
      resolve(Number(seen.trim()))
    })
  })
  if (!Number.isInteger(pid) || Number(pid) <= 0) return null

  // Only useful if it really is unreaped, and the fork reports its pid before
  // the child has finished exiting, so poll rather than read once: under the
  // full suite's load a single read catches it still running and the test
  // silently skips the thing it exists to cover. A host whose perl or /proc
  // behaves differently still skips rather than asserting something it never
  // managed to set up.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let stat = ''
    try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8') } catch { return null }
    const close = stat.lastIndexOf(')')
    if (close !== -1 && stat[close + 2] === 'Z') return Number(pid)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return null
}

/**
 * Whether `pid` is a live process rather than an unreaped corpse.
 *
 * `process.kill(pid, 0)` alone is not enough, and this file is the wrong place
 * to forget it: the shim's supervisors are detached and orphaned on purpose,
 * so under a PID 1 that does not reap, a supervisor a `stop` has already
 * killed keeps answering the signal probe. Same rule as `alivePid`/`isZombie`
 * in `scripts/sandbox/lib/shim.js`.
 *
 * @param {number} pid
 * @returns {boolean}
 */
export function isAlive(pid) {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  let stat = ''
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
  } catch {
    // No `/proc` (macOS), where launchd always reaps, so the probe stands.
    return true
  }
  const close = stat.lastIndexOf(')')
  return !(close !== -1 && stat[close + 2] === 'Z')
}

/**
 * The supervisor pid the mock has recorded for `label`, or null.
 *
 * `launchctl print` reports the *program's* pid, not the supervisor's, and it
 * is the supervisor that teardown has to be able to find.
 *
 * @param {string} root
 * @param {string} file
 * @param {string} collection
 * @param {string} key
 * @returns {number | null}
 */
export function recordedPid(root, file, collection, key) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(root, 'state', file), 'utf8'))
    return state[collection][key]?.pid ?? null
  } catch {
    return null
  }
}

/**
 * The state lock's path for `file`, which the shim derives the same way.
 *
 * @param {string} root
 * @param {string} file
 */
export function lockPathFor(root, file) {
  return path.join(root, 'state', `${file}.lock`)
}

/**
 * Poll until the lock file holds a token other than `not`, and return it.
 *
 * @param {string} lockPath
 * @param {string | null} not
 * @returns {Promise<string | null>}
 */
export async function waitForLockToken(lockPath, not) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    /** @type {string | null} */
    let token = null
    try { token = fs.readFileSync(lockPath, 'utf8') } catch { /* not taken yet */ }
    if (token && token !== not) return token
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return null
}

/**
 * The lock events `calls.jsonl` recorded, oldest first.
 *
 * @param {string} root
 * @returns {{ tool: string, exit: number, note: string, lock: { file: string, event: string, ageMs: number | null, waitedMs: number } }[]}
 */
export function lockEvents(root) {
  let raw = ''
  try { raw = fs.readFileSync(path.join(root, 'state', 'calls.jsonl'), 'utf8') } catch { return [] }
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.lock)
}

/**
 * The observations a detached supervisor appended to `calls.jsonl`.
 *
 * @param {string} root
 * @returns {{ tool: string, note: string }[]}
 */
export function supervisorNotes(root) {
  let raw = ''
  try { raw = fs.readFileSync(path.join(root, 'state', 'calls.jsonl'), 'utf8') } catch { return [] }
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .filter((entry) => entry.args && entry.args[0] === '(supervisor)')
}
