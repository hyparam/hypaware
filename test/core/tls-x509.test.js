// @ts-check

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import net from 'node:net'
import test from 'node:test'
import tls from 'node:tls'

import { generateKeyPair, mintCertificate } from '../../src/core/tls/x509.js'

const HOST = 'api.anthropic.com'
const CA_SUBJECT = /** @type {[string, string][]} */ ([
  ['2.5.4.3', 'HypAware Local CA'],
  ['2.5.4.10', 'HypAware'],
])

/**
 * Mint a CA and a leaf for `host`, the same pair the interception path uses.
 *
 * @param {object} [opts]
 * @param {string} [opts.leafHost] host the leaf vouches for (defaults to the constrained host)
 * @param {string[]} [opts.permitted] nameConstraints permitted subtrees
 */
function mintPair(opts = {}) {
  const leafHost = opts.leafHost ?? HOST
  const permitted = opts.permitted ?? [HOST]
  const now = Date.now()

  const caKeys = generateKeyPair()
  const ca = mintCertificate({
    subject: CA_SUBJECT,
    issuer: CA_SUBJECT,
    publicKey: caKeys.publicKey,
    signingKey: caKeys.privateKey,
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 365 * 86_400_000),
    isCa: true,
    permittedDnsNames: permitted,
  })

  const leafKeys = generateKeyPair()
  const leaf = mintCertificate({
    subject: [['2.5.4.3', leafHost]],
    issuer: CA_SUBJECT,
    publicKey: leafKeys.publicKey,
    signingKey: caKeys.privateKey,
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 30 * 86_400_000),
    isCa: false,
    dnsNames: [leafHost],
    authorityKeyId: ca.keyId,
  })

  return { ca, caKeys, leaf, leafKeys, leafHost }
}

/**
 * Stand up a TLS server presenting `leaf` and connect to it trusting only
 * `caPem`. Returns the client's verification verdict.
 *
 * @param {{ leaf: { pem: string }, leafKeys: { privateKey: crypto.KeyObject }, caPem: string, servername: string }} args
 * @returns {Promise<{ authorized: boolean, error: string | undefined }>}
 */
async function handshake({ leaf, leafKeys, caPem, servername }) {
  const server = tls.createServer(
    {
      key: /** @type {string} */ (leafKeys.privateKey.export({ type: 'pkcs8', format: 'pem' })),
      cert: leaf.pem,
      ALPNProtocols: ['http/1.1'],
    },
    (socket) => socket.end('ok')
  )
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const address = server.address()
  const port = address && typeof address === 'object' ? address.port : 0

  try {
    return await new Promise((resolve) => {
      const raw = net.connect(port, '127.0.0.1', () => {
        const secure = tls.connect({ socket: raw, servername, ca: [caPem] }, () => {
          resolve({ authorized: secure.authorized, error: secure.authorizationError?.message })
          secure.destroy()
        })
        secure.on('error', (err) => resolve({ authorized: false, error: err.message }))
      })
      raw.on('error', (err) => resolve({ authorized: false, error: err.message }))
    })
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)))
  }
}

test('minted CA parses as a certificate authority', () => {
  const { ca } = mintPair()
  const parsed = new crypto.X509Certificate(ca.der)
  assert.equal(parsed.ca, true)
  assert.match(parsed.subject, /CN=HypAware Local CA/)
  // Self-signed: subject and issuer match.
  assert.equal(parsed.subject, parsed.issuer)
})

test('leaf chains to the CA and carries the host as a SAN', () => {
  const { ca, leaf } = mintPair()
  const parsedCa = new crypto.X509Certificate(ca.der)
  const parsedLeaf = new crypto.X509Certificate(leaf.der)

  assert.equal(parsedLeaf.checkIssued(parsedCa), true)
  assert.equal(parsedLeaf.verify(parsedCa.publicKey), true)
  assert.equal(parsedLeaf.subjectAltName, `DNS:${HOST}`)
  // A SAN match is what modern clients check; a bare CN is not enough.
  assert.equal(parsedLeaf.checkHost(HOST), HOST)
})

test('a client trusting only the CA completes a real TLS handshake', async () => {
  const { ca, leaf, leafKeys } = mintPair()
  const result = await handshake({ leaf, leafKeys, caPem: ca.pem, servername: HOST })
  assert.equal(result.error, undefined)
  assert.equal(result.authorized, true)
})

// The containment property the whole design rests on: leaking the CA key must
// not let anyone mint a trusted certificate for an arbitrary domain. Without
// working nameConstraints the CA is a universal signing key for any client
// that trusts it.
// @ref LLP 0235#ca-name-constraints [tests]: the CA cannot vouch for a host outside its permitted subtrees
test('nameConstraints stop the CA vouching for another host', async () => {
  const { ca, leaf, leafKeys, leafHost } = mintPair({
    leafHost: 'evil.example.com',
    permitted: [HOST],
  })
  const result = await handshake({ leaf, leafKeys, caPem: ca.pem, servername: leafHost })
  assert.equal(result.authorized, false)
  assert.match(String(result.error), /permitted subtree violation/)
})

test('serial numbers are positive and unique across mints', () => {
  const first = mintPair().ca
  const second = mintPair().ca
  assert.equal(first.serial.length, 16)
  assert.equal((first.serial[0] & 0x80) === 0, true, 'high bit clear keeps the serial positive')
  assert.notEqual(first.serial.toString('hex'), second.serial.toString('hex'))
})

test('an expired leaf is rejected by a verifying client', async () => {
  const now = Date.now()
  const caKeys = generateKeyPair()
  const ca = mintCertificate({
    subject: CA_SUBJECT,
    issuer: CA_SUBJECT,
    publicKey: caKeys.publicKey,
    signingKey: caKeys.privateKey,
    notBefore: new Date(now - 365 * 86_400_000),
    notAfter: new Date(now + 365 * 86_400_000),
    isCa: true,
    permittedDnsNames: [HOST],
  })
  const leafKeys = generateKeyPair()
  const leaf = mintCertificate({
    subject: [['2.5.4.3', HOST]],
    issuer: CA_SUBJECT,
    publicKey: leafKeys.publicKey,
    signingKey: caKeys.privateKey,
    notBefore: new Date(now - 10 * 86_400_000),
    notAfter: new Date(now - 86_400_000),
    isCa: false,
    dnsNames: [HOST],
    authorityKeyId: ca.keyId,
  })

  const result = await handshake({ leaf, leafKeys, caPem: ca.pem, servername: HOST })
  assert.equal(result.authorized, false)
  assert.match(String(result.error), /expired/i)
})

// #886 finding 1. UTCTime carries a two-digit year, so anything from 2050 on
// wraps into the 19xx half of RFC 5280's sliding window and the certificate is
// born expired. That became reachable the moment CA validity went to ten years
// (LLP 0238#ten-year-validity): a machine whose clock reads 2041 mints a CA
// whose `notAfter` is 2050, which parses back as 1950.
// @ref LLP 0266#generalized-time-past-2049 [tests]
test('a notAfter past 2049 round-trips instead of wrapping into the 19xx window', () => {
  const notBefore = new Date(Date.UTC(2041, 0, 1))
  const notAfter = new Date(Date.UTC(2051, 5, 2, 3, 4, 5))
  const keys = generateKeyPair()
  const ca = mintCertificate({
    subject: CA_SUBJECT,
    issuer: CA_SUBJECT,
    publicKey: keys.publicKey,
    signingKey: keys.privateKey,
    notBefore,
    notAfter,
    isCa: true,
    permittedDnsNames: [HOST],
  })

  const parsed = new crypto.X509Certificate(ca.der)
  assert.equal(new Date(parsed.validFrom).getTime(), notBefore.getTime())
  assert.equal(new Date(parsed.validTo).getTime(), notAfter.getTime())
  // The date is only correct if it was encoded as GeneralizedTime (tag 0x18);
  // UTCTime (tag 0x17) has nowhere to put the century.
  assert.equal(ca.der.includes(Buffer.from('20510602030405Z', 'ascii')), true)
})

// The other half of the same boundary: dates UTCTime can hold must keep using
// it, because that is what every parser expects below 2050 and switching would
// be a silent encoding change for every certificate this product mints.
// @ref LLP 0266#generalized-time-past-2049 [tests]
test('a notAfter inside the UTCTime window is still encoded as UTCTime', () => {
  const notBefore = new Date(Date.UTC(2026, 0, 1))
  const notAfter = new Date(Date.UTC(2035, 5, 2, 3, 4, 5))
  const keys = generateKeyPair()
  const ca = mintCertificate({
    subject: CA_SUBJECT,
    issuer: CA_SUBJECT,
    publicKey: keys.publicKey,
    signingKey: keys.privateKey,
    notBefore,
    notAfter,
    isCa: true,
    permittedDnsNames: [HOST],
  })

  const parsed = new crypto.X509Certificate(ca.der)
  assert.equal(new Date(parsed.validTo).getTime(), notAfter.getTime())
  assert.equal(ca.der.includes(Buffer.from('350602030405Z', 'ascii')), true)
  assert.equal(ca.der.includes(Buffer.from('20350602030405Z', 'ascii')), false)
})

// #886 finding 3. An IP literal is printable ASCII, so the host guard let it
// through and it was encoded as a dNSName - a name form no TLS client matches
// against an IP connection, inside a CA that excludes all IP space anyway
// (LLP 0235#ca-name-constraints). The mint succeeded and the handshake failed
// with nothing naming the cause.
// @ref LLP 0266#ip-literals-are-refused [tests]
test('an IP-literal host is refused rather than minted as a dNSName', () => {
  const keys = generateKeyPair()
  /** @param {Partial<Parameters<typeof mintCertificate>[0]>} extra */
  const mint = (extra) => mintCertificate({
    subject: [['2.5.4.3', 'leaf']],
    issuer: CA_SUBJECT,
    publicKey: keys.publicKey,
    signingKey: keys.privateKey,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 86_400_000),
    isCa: false,
    .../** @type {any} */ (extra),
  })

  for (const literal of ['10.0.0.5', '::1', '2001:db8::1', '[::1]']) {
    assert.throws(() => mint({ dnsNames: [literal] }), /IP literal/, `SAN ${literal}`)
    assert.throws(
      () => mint({ isCa: true, permittedDnsNames: [literal] }),
      /IP literal/,
      `constraint ${literal}`
    )
  }

  // A hostname that merely looks numeric in one label is still a hostname.
  assert.doesNotThrow(() => mint({ dnsNames: ['10.0.0.5.nip.io'] }))
})
