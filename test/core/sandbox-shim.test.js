// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const SHIM = fileURLToPath(new URL('../../scripts/sandbox/lib/shim.js', import.meta.url))

/**
 * The sandbox's mock `launchctl` / `security` (`scripts/sandbox/lib/shim.js`)
 * is what keeps a sandboxed `hyp daemon install` or `hyp attach` off the real
 * launchd domain and out of the real login keychain, so the contract it
 * presents to `runServiceCommand` is worth pinning: the exit codes the kernel
 * branches on (bootout's 3, print's 113, bootstrap's transient 5) and the
 * trust round trip attach reads its mode from.
 *
 * Every case runs the shim as a child process, the way the PATH wrappers do.
 */

/**
 * Run the shim once against `root`.
 *
 * @param {string} root
 * @param {string} tool
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 */
function shim(root, tool, args, env = {}) {
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
function sandboxRoot(t, label = 'com.hyperparam.hypaware.test') {
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
function systemdRoot(t, unit = 'hypaware.service') {
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

test('launchctl mock: bootstrap → print → bootout round trip', (t) => {
  const { root, plist, label, target } = sandboxRoot(t)

  assert.equal(shim(root, 'launchctl', ['print', target]).code, 113, 'unknown service prints 113')

  assert.equal(shim(root, 'launchctl', ['bootstrap', 'gui/501', plist]).code, 0)

  const printed = shim(root, 'launchctl', ['print', target])
  assert.equal(printed.code, 0)
  assert.match(printed.stdout, new RegExp(`^${label} = \\{`), 'print reports the label launchd would')

  // Not spawned (HYP_SANDBOX_SPAWN unset), so there is no pid to report.
  assert.doesNotMatch(printed.stdout, /\bpid = \d+/)

  assert.equal(
    shim(root, 'launchctl', ['bootstrap', 'gui/501', plist]).code,
    5,
    'a second bootstrap of a loaded label is launchd error 5'
  )

  assert.equal(shim(root, 'launchctl', ['bootout', target]).code, 0)
  assert.equal(shim(root, 'launchctl', ['bootout', target]).code, 3, 'bootout of an absent service is 3')
  assert.equal(shim(root, 'launchctl', ['print', target]).code, 113)
})

test('launchctl mock: the label comes from the plist body, not the filename', (t) => {
  const { root } = sandboxRoot(t)
  const plist = path.join(root, 'misnamed.plist')
  fs.writeFileSync(plist, [
    '<plist version="1.0"><dict>',
    '<key>Label</key><string>com.example.real</string>',
    '</dict></plist>',
    '',
  ].join('\n'))

  assert.equal(shim(root, 'launchctl', ['bootstrap', 'gui/501', plist]).code, 0)
  assert.equal(shim(root, 'launchctl', ['print', 'gui/501/com.example.real']).code, 0)
})

test('launchctl mock: setenv / getenv / unsetenv', (t) => {
  const { root } = sandboxRoot(t)

  const unset = shim(root, 'launchctl', ['getenv', 'NODE_USE_SYSTEM_CA'])
  assert.equal(unset.code, 0, 'real launchctl exits 0 for an unset variable')
  assert.equal(unset.stdout, '')

  assert.equal(shim(root, 'launchctl', ['setenv', 'NODE_USE_SYSTEM_CA', '1']).code, 0)
  assert.equal(shim(root, 'launchctl', ['getenv', 'NODE_USE_SYSTEM_CA']).stdout, '1\n')

  assert.equal(shim(root, 'launchctl', ['unsetenv', 'NODE_USE_SYSTEM_CA']).code, 0)
  assert.equal(shim(root, 'launchctl', ['getenv', 'NODE_USE_SYSTEM_CA']).stdout, '')
})

test('launchctl mock: setenv reaches the job launchd starts', async (t) => {
  const { root, label } = sandboxRoot(t)
  // Storing a setenv value is not the behaviour attach depends on; delivering
  // it into the daemon launchd starts afterwards is. A mock that only stored
  // it would let `getenv` report NODE_USE_SYSTEM_CA set while the daemon
  // never saw it, and whether the run looked green would come down to what
  // the developer's own shell happened to export.
  const seen = path.join(root, 'job-env.txt')
  const plist = path.join(root, 'env-job.plist')
  fs.writeFileSync(plist, [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${label}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>/bin/sh</string>',
    '    <string>-c</string>',
    `    <string>printf '%s' "\$NODE_USE_SYSTEM_CA" &gt; ${seen}</string>`,
    '  </array>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n'))
  const env = { HYP_SANDBOX_SPAWN: '1', NODE_USE_SYSTEM_CA: '' }

  assert.equal(shim(root, 'launchctl', ['setenv', 'NODE_USE_SYSTEM_CA', '1'], env).code, 0)
  assert.equal(shim(root, 'launchctl', ['bootstrap', 'gui/501', plist], env).code, 0)

  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (fs.existsSync(seen)) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.equal(fs.readFileSync(seen, 'utf8'), '1', 'the domain variable is in the job env')
})

test('security mock: the CN is read from the certificate without shelling out', (t) => {
  const { root } = sandboxRoot(t)
  const certPath = path.join(root, 'ca-cert.pem')
  const openssl = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', path.join(root, 'ca-key.pem'),
    '-out', certPath, '-days', '1', '-nodes', '-subj', '/CN=HypAware Local CA',
  ], { encoding: 'utf8' })
  if (openssl.status !== 0) {
    t.skip('openssl is unavailable, so no certificate to trust')
    return
  }
  const keychain = path.join(root, 'login.keychain-db')
  // A null CN would store a cert that `delete-certificate -c <CN>` can never
  // match; `removeCaTrust` reads the resulting "could not be found" as
  // already-absent, so `hyp daemon uninstall` would report it removed trust
  // that is still there.
  const withoutOpenssl = { PATH: path.join(root, 'empty-path') }

  assert.equal(
    shim(root, 'security', ['add-trusted-cert', '-r', 'trustRoot', '-k', keychain, certPath], withoutOpenssl).code,
    0
  )
  const stored = JSON.parse(fs.readFileSync(path.join(root, 'state', 'keychain.json'), 'utf8'))
  assert.equal(stored.certs[0].cn, 'HypAware Local CA')

  assert.equal(
    shim(root, 'security', ['delete-certificate', '-c', 'HypAware Local CA', '-t', keychain], withoutOpenssl).code,
    0,
    'removal matches the stored CN'
  )
  assert.equal(shim(root, 'security', ['verify-cert', '-c', certPath, '-p', 'ssl']).code, 1)
})

test('systemctl mock: --spawn starts the unit and reports its MainPID', async (t) => {
  const { root, home, unit } = systemdRoot(t)
  const env = { HOME: home, HYP_SANDBOX_SPAWN: '1' }

  assert.equal(shim(root, 'systemctl', ['--user', 'restart', unit], env).code, 0)

  let shown
  for (let attempt = 0; attempt < 20; attempt += 1) {
    shown = shim(root, 'systemctl', [
      '--user', 'show', unit, '--property=LoadState,ActiveState,MainPID',
    ], env)
    if (/^MainPID=[1-9]\d*$/m.test(shown.stdout)) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.equal(shown.code, 0)
  assert.match(shown.stdout, /^MainPID=[1-9]\d*$/m)
  assert.match(shown.stdout, /^ActiveState=active$/m)
})

test('security mock: verify → trust → verify → delete round trip', (t) => {
  const { root } = sandboxRoot(t)
  const certPath = path.join(root, 'ca-cert.pem')
  const openssl = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', path.join(root, 'ca-key.pem'),
    '-out', certPath, '-days', '1', '-nodes', '-subj', '/CN=HypAware Local CA',
  ], { encoding: 'utf8' })
  if (openssl.status !== 0) {
    t.skip('openssl is unavailable, so no certificate to trust')
    return
  }
  const keychain = path.join(root, 'login.keychain-db')

  assert.equal(
    shim(root, 'security', ['verify-cert', '-c', certPath, '-p', 'ssl']).code,
    1,
    'an untrusted CA fails verify-cert, which is what makes attach pick base-URL mode'
  )

  assert.equal(
    shim(root, 'security', ['add-trusted-cert', '-r', 'trustRoot', '-k', keychain, certPath]).code,
    0
  )
  assert.equal(shim(root, 'security', ['verify-cert', '-c', certPath, '-p', 'ssl']).code, 0)

  assert.equal(
    shim(root, 'security', ['delete-certificate', '-c', 'HypAware Local CA', '-t', keychain]).code,
    0
  )
  assert.equal(shim(root, 'security', ['verify-cert', '-c', certPath, '-p', 'ssl']).code, 1)

  const missing = shim(root, 'security', ['delete-certificate', '-c', 'HypAware Local CA', '-t', keychain])
  assert.equal(missing.code, 1)
  assert.match(missing.stderr, /could not be found/, 'removeCaTrust reads this as already-absent, not an error')
})

test('security mock: HYP_SANDBOX_TRUST_REFUSE simulates a cancelled password dialog', (t) => {
  const { root } = sandboxRoot(t)
  const certPath = path.join(root, 'ca-cert.pem')
  fs.writeFileSync(certPath, 'not a real certificate, only its bytes matter here\n')

  const refused = shim(
    root,
    'security',
    ['add-trusted-cert', '-r', 'trustRoot', '-k', path.join(root, 'login.keychain-db'), certPath],
    { HYP_SANDBOX_TRUST_REFUSE: '1' }
  )
  assert.equal(refused.code, 1)
  assert.match(refused.stderr, /User canceled the operation/)
  assert.equal(
    shim(root, 'security', ['verify-cert', '-c', certPath, '-p', 'ssl']).code,
    1,
    'a refused trust leaves nothing behind'
  )
})

test('security mock: a daemon-issued trust is refused by default, a user-issued one is not', (t) => {
  const { root } = sandboxRoot(t)
  const certPath = path.join(root, 'ca-cert.pem')
  fs.writeFileSync(certPath, 'stand-in certificate bytes\n')
  const trustArgs = ['add-trusted-cert', '-r', 'trustRoot', '-k', path.join(root, 'kc.db'), certPath]

  // HYP_SANDBOX_SERVICE marks the subtree the mock launchd started. Trusting a
  // CA in the login keychain needs the macOS password dialog answered, and a
  // background agent has nobody watching - so the sandbox refuses it rather
  // than letting an unattended fleet setup look like it establishes trust.
  const fromDaemon = shim(root, 'security', trustArgs, { HYP_SANDBOX_SERVICE: '1' })
  assert.equal(fromDaemon.code, 1)
  assert.match(fromDaemon.stderr, /User interaction is not allowed/)
  assert.equal(shim(root, 'security', ['verify-cert', '-c', certPath, '-p', 'ssl']).code, 1)

  // Whether real macOS actually refuses is unproven, so the other branch is
  // one flag away.
  const granted = shim(root, 'security', trustArgs, {
    HYP_SANDBOX_SERVICE: '1',
    HYP_SANDBOX_TRUST_FROM_DAEMON: 'grant',
  })
  assert.equal(granted.code, 0)
  assert.equal(shim(root, 'security', ['verify-cert', '-c', certPath, '-p', 'ssl']).code, 0)
})

test('security mock: a user-issued trust succeeds with no service marker', (t) => {
  const { root } = sandboxRoot(t)
  const certPath = path.join(root, 'ca-cert.pem')
  fs.writeFileSync(certPath, 'stand-in certificate bytes\n')

  const result = shim(root, 'security', [
    'add-trusted-cert', '-r', 'trustRoot', '-k', path.join(root, 'kc.db'), certPath,
  ])
  assert.equal(result.code, 0, 'a CLI attach has a human at the dialog')
  assert.equal(shim(root, 'security', ['verify-cert', '-c', certPath, '-p', 'ssl']).code, 0)
})

test('shim records every intercepted call', (t) => {
  const { root, plist, target } = sandboxRoot(t)
  shim(root, 'launchctl', ['bootstrap', 'gui/501', plist])
  shim(root, 'launchctl', ['bootout', target])

  const lines = fs.readFileSync(path.join(root, 'state', 'calls.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))

  assert.equal(lines.length, 2)
  assert.deepEqual(lines.map((entry) => entry.args[0]), ['bootstrap', 'bootout'])
  assert.deepEqual(lines.map((entry) => entry.exit), [0, 0])
})

test('shim refuses to run without a sandbox root', () => {
  const result = spawnSync(process.execPath, [SHIM, 'launchctl', 'getenv', 'PATH'], {
    encoding: 'utf8',
    env: { ...process.env, HYP_SANDBOX_ROOT: '' },
  })
  assert.equal(result.status, 64)
  assert.match(result.stderr, /HYP_SANDBOX_ROOT is not set/)
})

/**
 * Write a plist over `sandboxRoot`'s default one, running `argv` under the
 * `KeepAlive` the installed HypAware LaunchAgent uses.
 *
 * @param {string} root
 * @param {string} label
 * @param {string[]} argv
 * @param {{ keepAlive?: boolean }} [options]
 */
function writePlist(root, label, argv, options = {}) {
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
async function waitForPid(root, target, env, not = null) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const printed = shim(root, 'launchctl', ['print', target], env)
    const match = /\bpid = (\d+)/.exec(printed.stdout)
    if (match && Number(match[1]) !== not) return Number(match[1])
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return null
}

test('launchctl mock: kickstart bounces the job only when -k asks it to', async (t) => {
  const { root, label, target } = sandboxRoot(t)
  const env = { HYP_SANDBOX_SPAWN: '1' }
  const plist = writePlist(root, label, ['/bin/sh', '-c', 'exec sleep 30'])

  assert.equal(shim(root, 'launchctl', ['bootstrap', 'gui/501', plist], env).code, 0)
  const first = await waitForPid(root, target, env)
  assert.ok(first, 'the supervisor started the program')

  // `installLaunchAgent` and `startLaunchAgent` (`src/core/daemon/macos.js`)
  // kickstart without `-k` and then poll for a pid. Real launchctl starts an
  // idle job and leaves a running one alone, so a mock that always killed
  // would report a successful start having just taken the daemon down.
  assert.equal(shim(root, 'launchctl', ['kickstart', target], env).code, 0)
  await new Promise((resolve) => setTimeout(resolve, 200))
  const printed = shim(root, 'launchctl', ['print', target], env)
  assert.match(printed.stdout, /\bstate = running/)
  assert.match(printed.stdout, new RegExp(`\\bpid = ${first}\\b`), 'a plain kickstart is a no-op on a running job')

  // `restartLaunchAgent` passes `-k`, and that one does bounce it.
  assert.equal(shim(root, 'launchctl', ['kickstart', '-k', target], env).code, 0)
  const second = await waitForPid(root, target, env, first)
  assert.ok(second, 'kickstart -k restarts the job')
  assert.notEqual(second, first)
})

test('launchctl mock: bootout does not return until the job has exited', async (t) => {
  const { root, label, target } = sandboxRoot(t)
  const env = { HYP_SANDBOX_SPAWN: '1' }
  // A real HypAware daemon drains before it exits, so the program here does
  // not die the instant it is signalled either. Against a program that dies
  // on the spot this test would pass without the wait and prove nothing.
  const plist = writePlist(root, label, [
    '/bin/sh', '-c', 'trap "sleep 1; exit 0" TERM; while :; do sleep 0.1; done',
  ])

  assert.equal(shim(root, 'launchctl', ['bootstrap', 'gui/501', plist], env).code, 0)
  const pid = await waitForPid(root, target, env)
  assert.ok(pid, 'the supervisor started the program')

  assert.equal(shim(root, 'launchctl', ['bootout', target], env).code, 0)
  // The instant bootout returns, the domain entry is gone and `print` answers
  // 113, which is all `waitUntilUnloaded` waits for. Anything still alive here
  // would still hold the gateway's listen port when the bootstrap that
  // follows a restart or reinstall tries to bind it.
  assert.equal(shim(root, 'launchctl', ['print', target], env).code, 113)
  assert.equal(isAlive(/** @type {number} */ (pid)), false, 'the job is gone, not merely signalled')
})

test('launchctl mock: a setenv after bootstrap reaches the next launch', async (t) => {
  const { root, label } = sandboxRoot(t)
  const env = { HYP_SANDBOX_SPAWN: '1', SANDBOX_PROBE: '' }
  const seen = path.join(root, 'probe.txt')
  // KeepAlive plus a program that exits is the restart cycle `hyp attach`
  // relies on: it setenvs and *then* lets the daemon come back to pick the
  // value up, so a domain snapshotted at bootstrap would never deliver it.
  const plist = writePlist(root, label, ['/bin/sh', '-c', `printf '[%s]\\n' "$SANDBOX_PROBE" >> ${seen}`])

  assert.equal(shim(root, 'launchctl', ['bootstrap', 'gui/501', plist], env).code, 0)
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (fs.existsSync(seen)) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.equal(fs.readFileSync(seen, 'utf8'), '[]\n', 'the first launch saw an unset variable')

  assert.equal(shim(root, 'launchctl', ['setenv', 'SANDBOX_PROBE', 'on'], env).code, 0)
  let body = ''
  for (let attempt = 0; attempt < 200; attempt += 1) {
    body = fs.readFileSync(seen, 'utf8')
    if (body.includes('[on]')) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.match(body, /\[on\]/, 'a restart after the setenv carries the domain value')
})

test('launchctl mock: a program that cannot be started is recorded, not swallowed', async (t) => {
  const { root, label, target } = sandboxRoot(t)
  const env = { HYP_SANDBOX_SPAWN: '1' }
  // `spawn` reports an unlaunchable program as an `error` event and no
  // `exit`; unhandled, that takes the supervisor down with it and the run has
  // nothing to say about why the daemon never appeared.
  const plist = writePlist(root, label, [path.join(root, 'no-such-program')], { keepAlive: false })

  assert.equal(shim(root, 'launchctl', ['bootstrap', 'gui/501', plist], env).code, 0)

  const callsPath = path.join(root, 'state', 'calls.jsonl')
  let notes = []
  for (let attempt = 0; attempt < 120; attempt += 1) {
    notes = fs.readFileSync(callsPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.args[0] === '(supervisor)')
      .map((entry) => entry.note)
    if (notes.length > 0) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.equal(notes.length, 1)
  assert.match(notes[0], /could not start .*no-such-program/)
  assert.equal(shim(root, 'launchctl', ['print', target], env).stdout.includes('state = running'), false)
})

test('launchctl mock: a setenv during a bootout survives the bootout', async (t) => {
  const { root, label, target } = sandboxRoot(t)
  const env = { HYP_SANDBOX_SPAWN: '1' }
  // `bootout` blocks until the job it signalled has actually drained. The
  // domain it writes back when it returns has to be re-read after that wait,
  // not the copy it read before: `hyp attach` setenvs NODE_USE_SYSTEM_CA and
  // the daemon's reconciler runs on its own clock, so a setenv landing inside
  // the wait is exactly the traffic this mock is here to model. Writing back
  // the stale copy erases it, `getenv` then reports it unset, and the run
  // blames HypAware for a value the mock threw away. `writeState`'s rename
  // does not cover this: it stops torn reads, not lost updates.
  const plist = writePlist(root, label, [
    '/bin/sh', '-c', 'trap "sleep 1; exit 0" TERM; while :; do sleep 0.1; done',
  ])

  assert.equal(shim(root, 'launchctl', ['bootstrap', 'gui/501', plist], env).code, 0)
  assert.ok(await waitForPid(root, target, env), 'the supervisor started the program')

  const bootout = spawn(process.execPath, [SHIM, 'launchctl', 'bootout', target], {
    env: { ...process.env, HYP_SANDBOX_ROOT: root, ...env },
    stdio: 'ignore',
  })
  const booted = new Promise((resolve) => bootout.on('exit', resolve))
  // Well inside the ~1s the trapped program spends draining.
  await new Promise((resolve) => setTimeout(resolve, 300))

  assert.equal(shim(root, 'launchctl', ['setenv', 'NODE_USE_SYSTEM_CA', '1'], env).code, 0)
  // Without this the test passes vacuously whenever the setenv lands after the
  // bootout has already written back: the pre-fix shim is green at that end of
  // the window, so a timing shift on a slow host would quietly stop testing
  // anything. `exitCode` is null only while the child is still running.
  assert.equal(bootout.exitCode, null, 'the bootout was still waiting when the setenv committed')
  assert.equal(
    shim(root, 'launchctl', ['getenv', 'NODE_USE_SYSTEM_CA'], env).stdout,
    '1\n',
    'the setenv committed'
  )

  assert.equal(await booted, 0, 'the bootout succeeded')
  assert.equal(
    shim(root, 'launchctl', ['getenv', 'NODE_USE_SYSTEM_CA'], env).stdout,
    '1\n',
    'the bootout did not write back the domain it read before it waited'
  )
  assert.equal(shim(root, 'launchctl', ['print', target], env).code, 113, 'the bootout still unloaded')
})

/**
 * A pid that has exited but has not been reaped. It still answers signal 0 and
 * shrugs off SIGKILL, which is exactly the state the sandbox's detached,
 * orphaned supervisors end up in under a PID 1 that does not reap. Resolves to
 * null when this host cannot produce one.
 *
 * @param {import('node:test').TestContext} t
 * @returns {Promise<number | null>}
 */
async function unreapedPid(t) {
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

test('hyp-sandbox: stopping does not wait on, or warn about, an unreaped pid', async (t) => {
  const sandboxCli = fileURLToPath(new URL('../../scripts/sandbox/hyp-sandbox', import.meta.url))
  const zombiePid = await unreapedPid(t)
  if (zombiePid === null) {
    t.skip('this host cannot produce an unreaped pid to stop')
    return
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-sandbox-stop-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'state'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'state', 'launchd.json'),
    `${JSON.stringify({ services: { 'com.example.gone': { pid: zombiePid } }, env: {} }, null, 2)}\n`
  )

  const started = Date.now()
  const reset = spawnSync('bash', [sandboxCli, '--root', root, 'reset'], {
    encoding: 'utf8',
    input: 'y\n',
    timeout: 60_000,
  })
  const elapsed = Date.now() - started

  assert.equal(reset.status, 0, reset.stderr)
  // Positive control: without it, a `stop_everything` that stopped reading
  // `launchd.json` at all would satisfy every assertion below by doing nothing.
  assert.match(
    reset.stdout,
    /stopped 1 sandbox process/,
    'the pid in the domain was actually read and signalled'
  )
  // `stop_everything` probes with signal 0 alone unless it also checks for an
  // unreaped pid, and a corpse answers that probe forever. The visible cost is
  // a reset that spends its whole 5s SIGTERM budget plus its 2s SIGKILL budget
  // on a process that had already exited, then warns about survivors that are
  // not there - the sandbox reporting a confident wrong answer about its own
  // teardown, which is the one thing it must not do.
  assert.doesNotMatch(
    reset.stdout,
    /still running after SIGKILL/,
    'a pid that has already exited is gone, not a survivor to warn about'
  )
  assert.ok(elapsed < 5000, `reset spent ${elapsed}ms waiting on a pid that had already exited`)
  assert.equal(fs.existsSync(root), false, 'the root is deleted once nothing is running')
})

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
function isAlive(pid) {
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
function recordedPid(root, file, collection, key) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(root, 'state', file), 'utf8'))
    return state[collection][key]?.pid ?? null
  } catch {
    return null
  }
}

test('launchctl mock: a bootout leaves alone a supervisor started while it waited', async (t) => {
  const { root, label, target } = sandboxRoot(t)
  const env = { HYP_SANDBOX_SPAWN: '1' }
  // The supervisor dies on the first SIGTERM while its program is still
  // draining, so for the whole of that wait the domain holds a dead pid and a
  // `kickstart` (which is what `startLaunchAgent` and `hyp daemon restart`
  // issue) installs a replacement. A bootout that deletes by label alone then
  // removes the replacement it never killed: `print` answers 113 while that
  // supervisor is live, the next `bootstrap` puts a second daemon on the port,
  // and `stop_everything` cannot reach it because it enumerates the domain.
  const plist = writePlist(root, label, [
    '/bin/sh', '-c', 'trap "sleep 2; exit 0" TERM; while :; do sleep 0.1; done',
  ])

  assert.equal(shim(root, 'launchctl', ['bootstrap', 'gui/501', plist], env).code, 0)
  assert.ok(await waitForPid(root, target, env), 'the supervisor started the program')
  const first = recordedPid(root, 'launchd.json', 'services', label)

  const bootout = spawn(process.execPath, [SHIM, 'launchctl', 'bootout', target], {
    env: { ...process.env, HYP_SANDBOX_ROOT: root, ...env },
    stdio: 'ignore',
  })
  const booted = new Promise((resolve) => bootout.on('exit', resolve))
  // Well inside the ~2s the trapped program spends draining.
  await new Promise((resolve) => setTimeout(resolve, 400))

  assert.equal(shim(root, 'launchctl', ['kickstart', target], env).code, 0)
  const second = recordedPid(root, 'launchd.json', 'services', label)
  assert.ok(second && second !== first, 'the kickstart installed a replacement supervisor')

  await booted
  assert.equal(
    recordedPid(root, 'launchd.json', 'services', label),
    second,
    'the bootout deleted the instance it killed, not the one that replaced it'
  )
  assert.ok(
    isAlive(/** @type {number} */ (second)),
    'the replacement is still running, so leaving it in the domain is what keeps it reachable'
  )
  // The domain entry is only half of staying reachable. `killService` also
  // clears the child pid file, and that file is where `print` reads the
  // `pid = N` line `waitUntilRunning` and `hyp status` branch on, so clearing
  // the replacement's entry would report a live daemon as `not running`.
  assert.match(
    shim(root, 'launchctl', ['print', target], env).stdout,
    /\bpid = \d+/,
    'print still reports the daemon the replacement is running'
  )
})

test('systemctl mock: a start while the unit is between restarts does not add a second supervisor', async (t) => {
  const { root, home, unit } = systemdRoot(t)
  const env = { HOME: home, HYP_SANDBOX_SPAWN: '1' }
  // A supervisor waiting out `RestartSec` has already removed its child's pid
  // file, so a liveness check that only asks `childPid` calls the unit stopped
  // and starts a second supervisor for it. Only the newer pid reaches
  // `systemd.json`, and both `stop` and `hyp-sandbox`'s `stop_everything` kill
  // only what it records, so the older one survives teardown.
  fs.writeFileSync(path.join(home, '.config', 'systemd', 'user', unit), [
    '[Service]',
    'Type=simple',
    'ExecStart=/bin/sh -c "sleep 0.2"',
    'Restart=always',
    'RestartSec=2',
    '',
  ].join('\n'))

  assert.equal(shim(root, 'systemctl', ['--user', 'start', unit], env).code, 0)
  const first = recordedPid(root, 'systemd.json', 'units', unit)
  assert.ok(first, 'the unit got a supervisor')

  // Long enough for the program to exit and the supervisor to be sitting in
  // its restart delay with no child pid file on disk.
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.equal(shim(root, 'systemctl', ['--user', 'start', unit], env).code, 0)
  assert.equal(
    recordedPid(root, 'systemd.json', 'units', unit),
    first,
    'the second start reused the running supervisor rather than adding one'
  )

  assert.equal(shim(root, 'systemctl', ['--user', 'stop', unit], env).code, 0)
  assert.equal(
    isAlive(/** @type {number} */ (first)),
    false,
    'stop reached every supervisor the unit had'
  )
})

/**
 * The state lock's path for `file`, which the shim derives the same way.
 *
 * @param {string} root
 * @param {string} file
 */
function lockPathFor(root, file) {
  return path.join(root, 'state', `${file}.lock`)
}

/**
 * Poll until the lock file holds a token other than `not`, and return it.
 *
 * @param {string} lockPath
 * @param {string | null} not
 * @returns {Promise<string | null>}
 */
async function waitForLockToken(lockPath, not) {
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
function lockEvents(root) {
  let raw = ''
  try { raw = fs.readFileSync(path.join(root, 'state', 'calls.jsonl'), 'utf8') } catch { return [] }
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.lock)
}

/**
 * The observations a detached supervisor appended to `calls.jsonl`.
 *
 * @param {string} root
 * @returns {{ note: string }[]}
 */
function supervisorNotes(root) {
  let raw = ''
  try { raw = fs.readFileSync(path.join(root, 'state', 'calls.jsonl'), 'utf8') } catch { return [] }
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .filter((entry) => entry.args && entry.args[0] === '(supervisor)')
}

test('state lock: a holder whose lock was broken does not delete its successor lock', async (t) => {
  const { root } = sandboxRoot(t)
  const lockPath = lockPathFor(root, 'launchd.json')
  const base = { ...process.env, HYP_SANDBOX_ROOT: root }

  // A takes the lock and parks inside the critical section, the way a shim
  // killed mid-update or descheduled under load would.
  const holder = spawn(process.execPath, [SHIM, 'launchctl', 'setenv', 'FROM_A', '1'], {
    env: { ...base, HYP_SANDBOX_TEST_HOLD_MS: '2500' },
    stdio: 'ignore',
  })
  const holderExit = new Promise((resolve) => holder.on('exit', resolve))
  const tokenA = await waitForLockToken(lockPath, null)
  assert.ok(tokenA, 'A took the lock')

  // B waits out its budget, breaks A's lock, takes it for itself, and is still
  // holding it when A wakes up. Releasing by name alone would then have A
  // delete a lock B is inside, and hand the read-change-write to a third shim
  // underneath it - which is the lost update the lock exists to stop.
  const successor = spawn(process.execPath, [SHIM, 'launchctl', 'setenv', 'FROM_B', '1'], {
    env: { ...base, HYP_SANDBOX_TEST_LOCK_WAIT_MS: '200', HYP_SANDBOX_TEST_HOLD_MS: '4000' },
    stdio: 'ignore',
  })
  const successorExit = new Promise((resolve) => successor.on('exit', resolve))
  const tokenB = await waitForLockToken(lockPath, tokenA)
  assert.ok(tokenB, 'B broke the lock at its budget and took it')
  assert.notEqual(tokenB, tokenA, 'B wrote its own ownership token')

  assert.equal(await holderExit, 0, 'A finished its update')
  assert.equal(fs.existsSync(lockPath), true, 'A did not remove the lock B is holding')
  assert.equal(fs.readFileSync(lockPath, 'utf8'), tokenB, 'the lock still names B as its owner')

  assert.equal(await successorExit, 0, 'B finished its update')
  assert.equal(fs.existsSync(lockPath), false, 'B released the lock it owned')
})

test('state lock: breaking a lock at the wait budget is recorded in calls.jsonl', async (t) => {
  const { root } = sandboxRoot(t)
  const lockPath = lockPathFor(root, 'launchd.json')
  const base = { ...process.env, HYP_SANDBOX_ROOT: root }

  const holder = spawn(process.execPath, [SHIM, 'launchctl', 'setenv', 'FROM_A', '1'], {
    env: { ...base, HYP_SANDBOX_TEST_HOLD_MS: '1500' },
    stdio: 'ignore',
  })
  const holderExit = new Promise((resolve) => holder.on('exit', resolve))
  assert.ok(await waitForLockToken(lockPath, null), 'A took the lock')

  const broke = shim(root, 'launchctl', ['setenv', 'FROM_B', '1'], { HYP_SANDBOX_TEST_LOCK_WAIT_MS: '200' })
  assert.equal(broke.code, 0, 'the waiter gave up on the lock rather than deadlocking')

  // A run that broke a lock and a run that never contended are different
  // worlds for anyone reading back why a state file lost an update, and
  // `calls.jsonl` is the only account the sandbox can give of itself.
  const events = lockEvents(root)
  assert.equal(events.length, 1, 'exactly one lock event')
  assert.equal(events[0].lock.event, 'broke-budget')
  assert.equal(events[0].lock.file, 'launchd.json')
  assert.ok(events[0].lock.waitedMs >= 200, 'it records how long it waited first')
  assert.match(events[0].note, /state lock/)

  await holderExit
})

test('state lock: breaking a stale lock is recorded in calls.jsonl', (t) => {
  const { root } = sandboxRoot(t)
  const lockPath = lockPathFor(root, 'launchd.json')
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  // A lock left behind by a shim that was killed mid-update.
  fs.writeFileSync(lockPath, '999999.abandoned\n')
  const old = new Date(Date.now() - 120_000)
  fs.utimesSync(lockPath, old, old)

  assert.equal(shim(root, 'launchctl', ['setenv', 'FOO', '1']).code, 0)

  const events = lockEvents(root)
  assert.equal(events.length, 1, 'exactly one lock event')
  assert.equal(events[0].lock.event, 'broke-stale')
  // A null age here would mean the record was written without ever reading
  // the lock it claims to have broken.
  assert.notEqual(events[0].lock.ageMs, null, 'it measured the lock before breaking it')
  assert.ok(Number(events[0].lock.ageMs) >= 60_000, 'it records how old the lock it broke was')
})

test('state lock: proceeding unlocked after losing the retake is recorded in calls.jsonl', (t) => {
  const { root } = sandboxRoot(t)
  const lockPath = lockPathFor(root, 'launchd.json')
  // A lock path the shim can neither take nor remove, which is what losing
  // the retake to a third shim looks like from inside `acquireStateLock`: it
  // fails to get the lock back and does the update unlocked. Nothing was
  // evicted on the way there, because the removal failed too, so the only
  // line is the one saying this run went unlocked.
  fs.mkdirSync(lockPath, { recursive: true })

  assert.equal(
    shim(root, 'launchctl', ['setenv', 'FOO', '1'], { HYP_SANDBOX_TEST_LOCK_WAIT_MS: '0' }).code,
    0,
    'a mock that deadlocks is worse than one that races, so it still proceeds'
  )
  assert.equal(shim(root, 'launchctl', ['getenv', 'FOO']).stdout, '1\n', 'the update still landed')

  assert.deepEqual(
    lockEvents(root).map((entry) => entry.lock.event),
    ['degraded-unlocked'],
    'the unlocked update is on the record, and nothing claims a break that did not happen'
  )
})

test('state lock: an eviction is recorded from the removal, not from an age it could not read', (t) => {
  const { root } = sandboxRoot(t)
  const lockPath = lockPathFor(root, 'launchd.json')
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  // A lock path the take refuses and the age check cannot measure: `wx` fails
  // EEXIST on the link itself, `statSync` follows it to nothing. It stands in
  // for the race no age read can see - a holder releasing between the failed
  // take and the stat, and a successor taking the lock again before the rm -
  // where the removal evicts something the age said was not there. Deciding
  // from the age alone drops that eviction off the record, and the record is
  // the only account the sandbox can give of a lost update.
  fs.symlinkSync(path.join(root, 'state', 'no-such-lock-target'), lockPath)

  assert.equal(
    shim(root, 'launchctl', ['setenv', 'FOO', '1'], { HYP_SANDBOX_TEST_LOCK_WAIT_MS: '0' }).code,
    0
  )
  assert.equal(shim(root, 'launchctl', ['getenv', 'FOO']).stdout, '1\n', 'the update still landed')

  const events = lockEvents(root)
  assert.deepEqual(events.map((entry) => entry.lock.event), ['broke-budget'], 'the eviction is on the record')
  assert.equal(events[0].lock.ageMs, null, 'and says the age of what it removed could not be read')
})

// Root reads through mode 000 (CAP_DAC_OVERRIDE), so the EACCES this case is
// built on does not happen there and the shim would legitimately succeed.
test('state lock: an unreadable state file is not committed as an empty domain', {
  skip: process.getuid?.() === 0 && 'chmod does not deny root the read this case needs',
}, (t) => {
  const { root, plist, target } = sandboxRoot(t)
  assert.equal(shim(root, 'launchctl', ['bootstrap', 'gui/501', plist]).code, 0)
  const file = path.join(root, 'state', 'launchd.json')
  // EACCES stands in for any read that fails for a reason other than the file
  // not being there (EMFILE under a fanned-out install is the likely one).
  // Treating it as an empty domain does not just misreport this call: the
  // update commits the empty state under the lock and the mock domain is gone.
  fs.chmodSync(file, 0o000)
  t.after(() => { try { fs.chmodSync(file, 0o600) } catch { /* already restored */ } })

  const setenv = shim(root, 'launchctl', ['setenv', 'NODE_USE_SYSTEM_CA', '1'])
  assert.notEqual(setenv.code, 0, 'a state file it cannot read is an error, not an empty domain')

  fs.chmodSync(file, 0o600)
  assert.equal(shim(root, 'launchctl', ['print', target]).code, 0, 'the bootstrapped service survived')
})

test('supervisor: a definition file it cannot read leaves a note rather than dying silently', (t) => {
  const { root, label } = sandboxRoot(t)
  const { root: systemdRootDir, unit } = systemdRoot(t)
  // Both supervisors run detached with stdio ignored, so a throw at the read
  // that opens them is a KeepAlive supervisor gone without a word while the
  // `bootstrap` or `start` that spawned it recorded a pid and exit 0. It is
  // reachable without the file ever being corrupt: `kickstart` respawns from
  // the path the domain remembers, and re-reads nothing before it does.
  const missing = path.join(root, 'gone.plist')
  const supervised = shim(root, '__supervise', [label, missing])
  assert.equal(supervised.code, 0, 'the launchd supervisor exits rather than throwing')

  const missingUnit = path.join(systemdRootDir, 'gone.service')
  const supervisedUnit = shim(systemdRootDir, '__supervise_systemd', [unit, missingUnit])
  assert.equal(supervisedUnit.code, 0, 'the systemd supervisor exits rather than throwing')

  for (const [where, name] of [[root, missing], [systemdRootDir, missingUnit]]) {
    const notes = supervisorNotes(where)
    assert.equal(notes.length, 1, `one supervisor note for ${name}`)
    assert.match(notes[0].note, /could not read/, 'the note says the read is what failed')
    assert.match(notes[0].note, /ENOENT/, 'and names the errno, which is the whole of what it can say')
  }
})

test('state lock: a no-op update does not materialise a state file', (t) => {
  const { root, home, unit } = systemdRoot(t)
  fs.rmSync(path.join(home, '.config', 'systemd', 'user', unit))

  const started = shim(root, 'systemctl', ['--user', 'start', unit], { HOME: home, HYP_SANDBOX_SPAWN: '1' })
  assert.equal(started.code, 5, 'systemd fails a start of a unit that is not installed')

  // `hyp-sandbox state` prints `(empty)` for a file that is not there and the
  // file's contents when it is, so an error path that writes one reports a
  // domain the mock never actually created.
  assert.equal(
    fs.existsSync(path.join(root, 'state', 'systemd.json')),
    false,
    'the failed start left no state file behind'
  )
})

test('systemctl mock: a stop says when it kept the instance that replaced the one it killed', async (t) => {
  const { root, home, unit } = systemdRoot(t)
  const env = { HOME: home, HYP_SANDBOX_SPAWN: '1' }
  // The supervisor exits on the first SIGTERM while its program is still
  // draining, so a `start` (or the start half of a `restart`) landing in that
  // window installs a replacement. The stop that follows still exits 0, which
  // is deliberate - stranding the replacement is worse - but `calls.jsonl` has
  // to say so, or the record claims the unit was stopped while it is live.
  const drain = path.join(root, 'drain.sh')
  fs.writeFileSync(drain, 'trap "sleep 2; exit 0" TERM\nwhile :; do sleep 0.1; done\n')
  fs.writeFileSync(path.join(home, '.config', 'systemd', 'user', unit), [
    '[Service]',
    'Type=simple',
    `ExecStart=/bin/sh ${drain}`,
    'Restart=always',
    'RestartSec=1',
    '',
  ].join('\n'))

  assert.equal(shim(root, 'systemctl', ['--user', 'start', unit], env).code, 0)
  const first = recordedPid(root, 'systemd.json', 'units', unit)
  assert.ok(first, 'the unit got a supervisor')
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (/MainPID=[1-9]/.test(shim(root, 'systemctl', ['--user', 'show', unit], env).stdout)) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  const stopping = spawn(process.execPath, [SHIM, 'systemctl', '--user', 'stop', unit], {
    env: { ...process.env, HYP_SANDBOX_ROOT: root, ...env },
    stdio: 'ignore',
  })
  const stopped = new Promise((resolve) => stopping.on('exit', resolve))
  // Well inside the ~2s the trapped program spends draining.
  await new Promise((resolve) => setTimeout(resolve, 400))

  assert.equal(shim(root, 'systemctl', ['--user', 'start', unit], env).code, 0)
  const second = recordedPid(root, 'systemd.json', 'units', unit)
  assert.ok(second && second !== first, 'the start installed a replacement supervisor')

  assert.equal(await stopped, 0)
  assert.equal(
    recordedPid(root, 'systemd.json', 'units', unit),
    second,
    'the stop cleared the instance it killed, not the one that replaced it'
  )
  const notes = fs.readFileSync(path.join(root, 'state', 'calls.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line).note)
  assert.ok(
    notes.includes(`stop ${unit} (kept the instance that replaced it)`),
    `the stop said it left a live supervisor behind, got ${JSON.stringify(notes)}`
  )
})
