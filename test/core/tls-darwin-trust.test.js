// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CA_COMMON_NAME,
  installCaTrust,
  isCaTrusted,
  loginKeychainPath,
  removeCaTrust,
} from '../../src/core/tls/darwin_trust.js'

/**
 * @import { TrustCommandRunner } from '../../src/core/tls/types.js'
 */

/**
 * A runner that records the invocation and returns a canned result.
 *
 * @param {{ exitCode: number, stdout?: string, stderr?: string }} result
 */
function recordingRunner(result) {
  /** @type {{ cmd: string, args: string[] }[]} */
  const calls = []
  /** @type {TrustCommandRunner} */
  const run = async (cmd, args) => {
    calls.push({ cmd, args })
    return { stdout: '', stderr: '', ...result }
  }
  return { calls, run }
}

/** What `security` says once nothing matches the common name any more. */
const NOT_FOUND_STDERR =
  'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.'

/**
 * A keychain holding `count` certificates under the same common name, the
 * shape a re-minted machine really has. Each `delete-certificate` removes
 * one; once the last is gone, `security` reports no match.
 *
 * @param {number} count
 */
function keychainWithDuplicates(count) {
  let remaining = count
  /** @type {{ cmd: string, args: string[] }[]} */
  const calls = []
  /** @type {TrustCommandRunner} */
  const run = async (cmd, args) => {
    calls.push({ cmd, args })
    if (remaining === 0) return { exitCode: 1, stdout: '', stderr: NOT_FOUND_STDERR }
    remaining -= 1
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return { calls, run, remaining: () => remaining }
}

// The trust CN is how removal finds the certificate, so it must be exactly the
// CN the CA mints (`CA_SUBJECT` in ca.js). A drift here would install one name
// and try to delete another, stranding trusted roots.
test('the trust common name matches the minted CA subject', async () => {
  const { ensureLocalCa } = await import('../../src/core/tls/ca.js')
  const fsp = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const crypto = await import('node:crypto')

  const stateRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-trust-cn-'))
  try {
    const ca = await ensureLocalCa({ stateRoot, hosts: ['api.anthropic.com'] })
    const cert = new crypto.X509Certificate(ca.certPem)
    assert.match(cert.subject, new RegExp(`CN=${CA_COMMON_NAME}`))
  } finally {
    await fsp.rm(stateRoot, { recursive: true, force: true })
  }
})

test('isCaTrusted maps verify-cert exit codes to a boolean', async () => {
  const trusted = recordingRunner({ exitCode: 0 })
  assert.equal(await isCaTrusted({ certPath: '/tmp/ca.pem', run: trusted.run }), true)
  assert.deepEqual(trusted.calls, [
    { cmd: 'security', args: ['verify-cert', '-c', '/tmp/ca.pem', '-p', 'ssl'] },
  ])

  const untrusted = recordingRunner({ exitCode: 1 })
  assert.equal(await isCaTrusted({ certPath: '/tmp/ca.pem', run: untrusted.run }), false)
})

test('installCaTrust targets the login keychain user domain, no sudo shape', async () => {
  const { calls, run } = recordingRunner({ exitCode: 0 })
  const result = await installCaTrust({ certPath: '/tmp/ca.pem', homeDir: '/Users/u', run })

  assert.equal(result.installed, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].cmd, 'security')
  assert.deepEqual(calls[0].args, [
    'add-trusted-cert',
    '-r', 'trustRoot',
    '-k', '/Users/u/Library/Keychains/login.keychain-db',
    '/tmp/ca.pem',
  ])
  // No `-d`: the admin domain would demand privileges and trust machine-wide.
  assert.equal(calls[0].args.includes('-d'), false)
})

// A cancelled password dialog is a refusal the caller reports, not an error.
// @ref LLP 0237#attach-anyway-on-refusal [tests]
test('a cancelled dialog surfaces as installed:false with the detail', async () => {
  const { run } = recordingRunner({
    exitCode: 1,
    stderr: 'The authorization was canceled by the user.',
  })
  const result = await installCaTrust({ certPath: '/tmp/ca.pem', run })
  assert.equal(result.installed, false)
  assert.match(result.detail ?? '', /canceled/)
})

test('removeCaTrust deletes trust settings too and is idempotent', async () => {
  const keychain = keychainWithDuplicates(1)
  const removed = await removeCaTrust({ homeDir: '/Users/u', run: keychain.run })
  assert.equal(removed.removed, true)
  assert.equal(removed.detail, undefined)
  assert.deepEqual(keychain.calls[0].args, [
    'delete-certificate',
    '-c', CA_COMMON_NAME,
    '-t',
    '/Users/u/Library/Keychains/login.keychain-db',
  ])

  const absent = recordingRunner({ exitCode: 1, stderr: NOT_FOUND_STDERR })
  const alreadyGone = await removeCaTrust({ run: absent.run })
  assert.equal(alreadyGone.removed, false)
  assert.equal(alreadyGone.detail, undefined)
  // One pass, not a bounded sweep, when there was never anything to delete.
  assert.equal(absent.calls.length, 1)
})

// Every HypAware CA carries the same common name, and `delete-certificate -c`
// deletes one certificate per call, so a machine whose CA has been re-minted
// keeps trusting the older roots after an uninstall that reported success.
// Those roots outlive the key they were minted with, and nothing else ever
// looks for them again.
// @ref LLP 0238#ca-survives-detach [tests]: purge and uninstall end the whole grant, not one certificate of it
test('removeCaTrust clears every identically named root, not just the first', async () => {
  const keychain = keychainWithDuplicates(3)
  const result = await removeCaTrust({ homeDir: '/Users/u', run: keychain.run })

  assert.equal(result.removed, true)
  assert.equal(result.detail, undefined)
  assert.equal(keychain.remaining(), 0, 'no identically named root survives the removal')
  // Three deletions plus the pass that finds nothing left, which is the loop's
  // only exit condition.
  assert.equal(keychain.calls.length, 4)
  for (const call of keychain.calls) {
    assert.deepEqual(call.args, [
      'delete-certificate',
      '-c', CA_COMMON_NAME,
      '-t',
      '/Users/u/Library/Keychains/login.keychain-db',
    ])
  }
})

// A real failure (a locked keychain, a denied authorization) is not "nothing
// left to delete", so the sweep stops on it and hands the detail back rather
// than retrying into a wall.
test('removeCaTrust stops on a real failure and reports what it managed', async () => {
  let pass = 0
  /** @type {TrustCommandRunner} */
  const run = async () => {
    pass += 1
    if (pass === 1) return { exitCode: 0, stdout: '', stderr: '' }
    return { exitCode: 1, stdout: '', stderr: 'security: User interaction is not allowed.' }
  }
  const result = await removeCaTrust({ run })
  assert.equal(pass, 2)
  assert.equal(result.removed, true)
  assert.match(result.detail ?? '', /User interaction is not allowed/)
})

// The loop is bounded: a `security` that never stops reporting success must
// not spin, and the residue it leaves behind is named rather than assumed
// away.
test('removeCaTrust is bounded and says so when the bound is hit', async () => {
  const { calls, run } = recordingRunner({ exitCode: 0 })
  const result = await removeCaTrust({ run })

  assert.equal(result.removed, true)
  assert.equal(calls.length, 8)
  assert.match(result.detail ?? '', /stopped after 8 passes/)
  assert.match(result.detail ?? '', /Keychain Access/)
})

test('loginKeychainPath resolves under the given home', () => {
  assert.equal(
    loginKeychainPath('/Users/u'),
    '/Users/u/Library/Keychains/login.keychain-db'
  )
})
