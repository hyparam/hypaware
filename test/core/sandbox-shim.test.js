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
