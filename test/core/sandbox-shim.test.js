// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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
 * A sandbox root with a LaunchAgent plist in it, removed when the test ends.
 *
 * @param {import('node:test').TestContext} t
 * @param {string} [label]
 */
function sandboxRoot(t, label = 'com.hyperparam.hypaware.test') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-shim-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
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
  t.after(() => shim(root, 'launchctl', ['bootout', `gui/501/${label}`], env))

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
  t.after(() => shim(root, 'launchctl', ['bootout', target], env))

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
  assert.throws(() => process.kill(/** @type {number} */ (pid), 0), 'the job is gone, not merely signalled')
})

test('launchctl mock: a setenv after bootstrap reaches the next launch', async (t) => {
  const { root, label, target } = sandboxRoot(t)
  const env = { HYP_SANDBOX_SPAWN: '1', SANDBOX_PROBE: '' }
  const seen = path.join(root, 'probe.txt')
  // KeepAlive plus a program that exits is the restart cycle `hyp attach`
  // relies on: it setenvs and *then* lets the daemon come back to pick the
  // value up, so a domain snapshotted at bootstrap would never deliver it.
  const plist = writePlist(root, label, ['/bin/sh', '-c', `printf '[%s]\\n' "$SANDBOX_PROBE" >> ${seen}`])
  t.after(() => shim(root, 'launchctl', ['bootout', target], env))

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
  t.after(() => shim(root, 'launchctl', ['bootout', target], env))

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
