// @ts-check

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import tls from 'node:tls'

import {
  caPaths,
  createLeafStore,
  deleteLocalCa,
  ensureLocalCa,
  readLocalCaInfo,
  waitForLocalCa,
} from '../../src/core/tls/ca.js'

const HOST = 'api.anthropic.com'

/** @returns {Promise<string>} */
async function tempRoot() {
  return await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-tls-'))
}

test('ensureLocalCa generates a CA and persists it 0600', async (t) => {
  const stateRoot = await tempRoot()
  t.after(() => fsp.rm(stateRoot, { recursive: true, force: true }))

  const ca = await ensureLocalCa({ stateRoot, hosts: [HOST] })
  assert.equal(ca.created, true)
  assert.deepEqual(ca.hosts, [HOST])
  assert.match(ca.fingerprint, /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/)

  const paths = caPaths(stateRoot)
  const keyStat = await fsp.stat(paths.keyPath)
  // The private key must not be group- or world-readable.
  assert.equal(keyStat.mode & 0o077, 0, 'CA key is not readable by anyone else')
})

test('a second call reuses the stored CA rather than minting a new one', async (t) => {
  const stateRoot = await tempRoot()
  t.after(() => fsp.rm(stateRoot, { recursive: true, force: true }))

  const first = await ensureLocalCa({ stateRoot, hosts: [HOST] })
  const second = await ensureLocalCa({ stateRoot, hosts: [HOST] })

  assert.equal(second.created, false)
  assert.equal(second.fingerprint, first.fingerprint)
})

// The constraint set is part of the CA's identity. Reusing a stored CA that
// cannot vouch for a newly intercepted host would produce leaves that no client
// accepts, and the failure would surface as an unexplained handshake error.
test('adding an intercepted host regenerates the CA', async (t) => {
  const stateRoot = await tempRoot()
  t.after(() => fsp.rm(stateRoot, { recursive: true, force: true }))

  const first = await ensureLocalCa({ stateRoot, hosts: [HOST] })
  const widened = await ensureLocalCa({ stateRoot, hosts: [HOST, 'api.openai.com'] })

  assert.equal(widened.created, true)
  assert.notEqual(widened.fingerprint, first.fingerprint)
  assert.deepEqual(widened.hosts.sort(), [HOST, 'api.openai.com'].sort())
})

test('a CA near expiry is rolled', async (t) => {
  const stateRoot = await tempRoot()
  t.after(() => fsp.rm(stateRoot, { recursive: true, force: true }))

  const first = await ensureLocalCa({ stateRoot, hosts: [HOST] })
  // 3610 days on: inside the 45-day renewal window of a ten-year CA
  // (LLP 0238#ten-year-validity).
  const later = new Date(Date.now() + 3610 * 86_400_000)
  const rolled = await ensureLocalCa({ stateRoot, hosts: [HOST], now: later })

  assert.equal(rolled.created, true)
  assert.notEqual(rolled.fingerprint, first.fingerprint)
})

test('a truncated CA on disk is regenerated instead of throwing', async (t) => {
  const stateRoot = await tempRoot()
  t.after(() => fsp.rm(stateRoot, { recursive: true, force: true }))

  await ensureLocalCa({ stateRoot, hosts: [HOST] })
  await fsp.writeFile(caPaths(stateRoot).certPath, '-----BEGIN CERTIFICATE-----\ntruncated\n')

  const recovered = await ensureLocalCa({ stateRoot, hosts: [HOST] })
  assert.equal(recovered.created, true)
})

test('leaf store serves a certificate a CA-trusting client accepts', async (t) => {
  const stateRoot = await tempRoot()
  t.after(() => fsp.rm(stateRoot, { recursive: true, force: true }))

  const ca = await ensureLocalCa({ stateRoot, hosts: [HOST] })
  const leaves = createLeafStore(ca)

  const server = tls.createServer(
    { SNICallback: (_name, cb) => cb(null, leaves.secureContextFor(HOST)) },
    (socket) => socket.end('ok')
  )
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const address = server.address()
  const port = address && typeof address === 'object' ? address.port : 0
  t.after(() => new Promise((resolve) => server.close(() => resolve(undefined))))

  const verdict = await new Promise((resolve) => {
    const raw = net.connect(port, '127.0.0.1', () => {
      const secure = tls.connect({ socket: raw, servername: HOST, ca: [ca.certPem] }, () => {
        resolve({ authorized: secure.authorized, error: secure.authorizationError?.message })
        secure.destroy()
      })
      secure.on('error', (err) => resolve({ authorized: false, error: err.message }))
    })
  })

  assert.equal(verdict.error, undefined)
  assert.equal(verdict.authorized, true)
})

test('leaf store caches per host', async (t) => {
  const stateRoot = await tempRoot()
  t.after(() => fsp.rm(stateRoot, { recursive: true, force: true }))

  const ca = await ensureLocalCa({ stateRoot, hosts: [HOST] })
  const leaves = createLeafStore(ca)
  const a = leaves.secureContextFor(HOST)
  const b = leaves.secureContextFor(HOST)

  assert.equal(a, b)
  assert.equal(leaves.size(), 1)
})

test('leaf store refuses a host the CA does not permit', async (t) => {
  const stateRoot = await tempRoot()
  t.after(() => fsp.rm(stateRoot, { recursive: true, force: true }))

  const ca = await ensureLocalCa({ stateRoot, hosts: [HOST] })
  const leaves = createLeafStore(ca)

  assert.throws(
    () => leaves.secureContextFor('example.com'),
    /does not permit example\.com/
  )
})

test('readLocalCaInfo reports identity without the private key', async (t) => {
  const stateRoot = await tempRoot()
  t.after(() => fsp.rm(stateRoot, { recursive: true, force: true }))

  const ca = await ensureLocalCa({ stateRoot, hosts: [HOST] })
  const info = await readLocalCaInfo({ stateRoot })

  assert.ok(info)
  assert.equal(info.fingerprint, ca.fingerprint)
  assert.deepEqual(info.hosts, [HOST])
  assert.equal(Object.hasOwn(info, 'privateKey'), false)
})

test('readLocalCaInfo returns undefined when nothing is installed', async (t) => {
  const stateRoot = await tempRoot()
  t.after(() => fsp.rm(stateRoot, { recursive: true, force: true }))

  assert.equal(await readLocalCaInfo({ stateRoot }), undefined)
})

// A trusted signing key that outlives the thing that installed it is the worst
// failure mode this feature has.
// @ref LLP 0235#ca-lifecycle [tests]: detach and uninstall leave no key behind
test('deleteLocalCa removes the key and certificate, and is idempotent', async (t) => {
  const stateRoot = await tempRoot()
  t.after(() => fsp.rm(stateRoot, { recursive: true, force: true }))

  const paths = caPaths(stateRoot)
  await ensureLocalCa({ stateRoot, hosts: [HOST] })

  const first = await deleteLocalCa({ stateRoot })
  assert.deepEqual(first.removed.sort(), [paths.certPath, paths.keyPath].sort())
  await assert.rejects(fsp.stat(paths.keyPath), /ENOENT/)
  await assert.rejects(fsp.stat(paths.dir), /ENOENT/)

  const second = await deleteLocalCa({ stateRoot })
  assert.deepEqual(second.removed, [])
})

// The polling loop both proxy-attach flows ride (the wizard finale and the
// LLP 0244 migration). Deterministic via the injectable sleep/now hooks: the
// fake clock advances per poll, and the mint happens inside a fake sleep.
// @ref LLP 0232#proxy-attach-preflight [tests]: the wait resolves with the certPath attach preflights on, or reports not-ready at the deadline
test('waitForLocalCa returns ready with the certPath once the CA appears mid-wait', async (t) => {
  const stateRoot = await tempRoot()
  t.after(() => fsp.rm(stateRoot, { recursive: true, force: true }))

  let clock = 0
  let polls = 0
  const result = await waitForLocalCa({
    stateRoot,
    timeoutMs: 10_000,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
      polls += 1
      if (polls === 3) await ensureLocalCa({ stateRoot, hosts: [HOST] })
    },
  })

  assert.equal(result.ready, true)
  assert.equal(result.certPath, caPaths(stateRoot).certPath)
  assert.equal(polls, 3, 'resolved on the poll after the mint, not the deadline')
})

test('waitForLocalCa reports not-ready at the deadline when no CA ever appears', async (t) => {
  const stateRoot = await tempRoot()
  t.after(() => fsp.rm(stateRoot, { recursive: true, force: true }))

  let clock = 0
  let polls = 0
  const result = await waitForLocalCa({
    stateRoot,
    timeoutMs: 1_000,
    intervalMs: 250,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
      polls += 1
    },
  })

  assert.deepEqual(result, { ready: false })
  assert.equal(polls, 4, 'exactly the polls the deadline allows, then it stops')
})
