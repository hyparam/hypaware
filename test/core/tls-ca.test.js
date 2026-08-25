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
  displayableCaHosts,
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
  if (process.platform !== 'win32') assert.equal(keyStat.mode & 0o077, 0, 'CA key is not readable by anyone else')
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

// `LocalCaInfo.hosts` is the only part of a read-back CA that is bytes off
// disk: `readNameConstraints` hands back whatever the DER's permitted subtrees
// held, decoded as latin1, with no charset, length or count check. Two
// surfaces put those bytes in front of a person (`hyp status`, and the line
// the attach dialog writes just before macOS raises its password prompt), so
// the policy that makes them safe is shared and lives here.
// @ref LLP 0225#scope [tests]: the label-plane surfaces 0225 left to argue for themselves strip, and say what they stripped
test('displayableCaHosts leaves an ordinary permitted set exactly as it is', () => {
  const hosts = ['api.anthropic.com', 'api.openai.com', 'chatgpt.com']
  assert.deepEqual(displayableCaHosts(hosts), hosts)
  assert.deepEqual(displayableCaHosts([]), [])
})

test('displayableCaHosts strips bytes that would drive a terminal', () => {
  assert.deepEqual(
    displayableCaHosts(['api.anthropic.com', `evil[2K\nforged.example`]),
    ['api.anthropic.com', 'evil[2Kforged.example']
  )
})

// Stripped, never dropped: both callers exist to state how wide a trust grant
// is, and an entry that vanished would understate it by exactly one subtree.
test('displayableCaHosts names a host that sanitizes away rather than losing it', () => {
  const shown = displayableCaHosts(['', 'api.anthropic.com'])
  assert.equal(shown.length, 2)
  assert.equal(shown[0], '(unprintable dNSName)')
  assert.equal(shown[1], 'api.anthropic.com')
})

// The third way one of these values is hostile, after control bytes and
// length: count. Nothing between the certificate file and the terminal bounds
// how many subtrees it carries, and a list too long to read is a list that
// hides what it says.
test('displayableCaHosts bounds the list and says how much it left out', () => {
  const many = Array.from({ length: 30 }, (_, i) => `h${i}.example`)
  const shown = displayableCaHosts(many)

  assert.equal(shown.length, 25, '24 named hosts plus the count of the rest')
  assert.deepEqual(shown.slice(0, 24), many.slice(0, 24))
  assert.equal(shown[24], '(+6 more dNSName constraints)')
  // A list that exactly fills the bound is not truncated, so no reader is
  // told something was withheld when nothing was.
  assert.deepEqual(displayableCaHosts(many.slice(0, 24)), many.slice(0, 24))
})

// The bound has to survive a real certificate, not just an array: the same
// hosts have to come back out of the DER for `hyp status` to be reading the
// grant rather than a copy of the config.
test('a CA carrying more subtrees than the bound reports them bounded', async (t) => {
  const stateRoot = await tempRoot()
  t.after(() => fsp.rm(stateRoot, { recursive: true, force: true }))

  const hosts = Array.from({ length: 30 }, (_, i) => `h${i}.example`)
  await ensureLocalCa({ stateRoot, hosts })

  const info = await readLocalCaInfo({ stateRoot })
  assert.equal(info?.hosts.length, 30, 'the certificate itself keeps every constraint')
  const shown = displayableCaHosts(/** @type {string[]} */ (info?.hosts))
  assert.equal(shown.length, 25)
  assert.equal(shown[24], '(+6 more dNSName constraints)')
})

// #886 finding 1, end to end. A ten-year CA minted on a machine whose clock
// reads past 2039 has a `notAfter` beyond 2049, and the two-digit UTCTime year
// wrapped it into the 19xx window: the CA was born expired, `loadLocalCa` saw
// it inside the renewal window and re-minted on every single boot, and every
// intercepted handshake failed with nothing naming the cause.
// @ref LLP 0275#generalized-time-past-2049 [tests]
test('a CA minted on a clock past 2039 is not born expired', async (t) => {
  const stateRoot = await tempRoot()
  t.after(() => fsp.rm(stateRoot, { recursive: true, force: true }))

  const now = new Date(Date.UTC(2041, 0, 1))
  const ca = await ensureLocalCa({ stateRoot, hosts: [HOST], now })
  assert.equal(ca.created, true)

  // What is on disk has to agree with the lifetime the minter intended.
  const info = await readLocalCaInfo({ stateRoot })
  assert.ok(info)
  assert.equal(info.notAfter.getTime(), ca.notAfter.getTime())
  assert.ok(info.notAfter.getTime() > now.getTime(), 'the stored CA is not already expired')

  // And it is reusable: the boot after this one must not re-mint.
  const second = await ensureLocalCa({ stateRoot, hosts: [HOST], now })
  assert.equal(second.created, false)
  assert.equal(second.fingerprint, ca.fingerprint)
})

// #886 finding 4. The stored constraint set had to equal the requested host
// list exactly, so *narrowing* the upstream set re-minted the CA and stranded
// the keychain trust grant the user gave once by password dialog - the whole
// reason the CA is long-lived (LLP 0238#ten-year-validity). Only widening needs
// a new CA; a stored superset already vouches for everything asked for.
// @ref LLP 0275#stored-superset-is-reusable [tests]
test('narrowing the host set reuses the stored CA rather than stranding its trust', async (t) => {
  const stateRoot = await tempRoot()
  t.after(() => fsp.rm(stateRoot, { recursive: true, force: true }))

  const wide = ['api.anthropic.com', 'api.openai.com', 'chatgpt.com', 'llm.corp.example']
  const first = await ensureLocalCa({ stateRoot, hosts: wide })
  assert.equal(first.created, true)

  // The operator drops their own upstream from config; the next daemon boot
  // asks for the static three.
  const narrowed = await ensureLocalCa({ stateRoot, hosts: wide.slice(0, 3) })
  assert.equal(narrowed.created, false)
  assert.equal(narrowed.fingerprint, first.fingerprint)
  // The CA still reports the wider set it actually permits, so status and the
  // leaf store both stay honest about the trust grant in force.
  assert.deepEqual([...narrowed.hosts].sort(), [...wide].sort())
})

// The invariant the exact-match rule was protecting, kept: a CA that cannot
// vouch for a host being asked for is still regenerated.
// @ref LLP 0275#stored-superset-is-reusable [tests]
test('a stored CA missing a requested host is still regenerated', async (t) => {
  const stateRoot = await tempRoot()
  t.after(() => fsp.rm(stateRoot, { recursive: true, force: true }))

  const first = await ensureLocalCa({ stateRoot, hosts: [HOST, 'api.openai.com'] })
  const widened = await ensureLocalCa({ stateRoot, hosts: [HOST, 'llm.corp.example'] })

  assert.equal(widened.created, true)
  assert.notEqual(widened.fingerprint, first.fingerprint)
})
