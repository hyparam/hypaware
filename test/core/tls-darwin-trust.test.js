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
  const { calls, run } = recordingRunner({ exitCode: 0 })
  const removed = await removeCaTrust({ homeDir: '/Users/u', run })
  assert.equal(removed.removed, true)
  assert.deepEqual(calls[0].args, [
    'delete-certificate',
    '-c', CA_COMMON_NAME,
    '-t',
    '/Users/u/Library/Keychains/login.keychain-db',
  ])

  const absent = recordingRunner({
    exitCode: 1,
    stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.',
  })
  const alreadyGone = await removeCaTrust({ run: absent.run })
  assert.equal(alreadyGone.removed, false)
  assert.equal(alreadyGone.detail, undefined)
})

test('loginKeychainPath resolves under the given home', () => {
  assert.equal(
    loginKeychainPath('/Users/u'),
    '/Users/u/Library/Keychains/login.keychain-db'
  )
})
