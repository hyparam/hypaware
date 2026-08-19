// @ts-check

import crypto from 'node:crypto'
import net from 'node:net'

/**
 * A minimal X.509 v3 certificate minter: DER by hand, signature via
 * `node:crypto`.
 *
 * Node can parse and verify certificates (`crypto.X509Certificate`) but cannot
 * generate them, so a local CA needs either an `openssl` shell-out or a
 * library. Both were rejected: macOS ships LibreSSL rather than OpenSSL and
 * their flag surfaces for extensions differ, Windows ships neither, and a
 * certificate library is a large dependency to audit for a package whose
 * runtime dependency list is deliberately short. What is actually needed here
 * is narrow - one self-signed CA and one server leaf per intercepted host, both
 * with a fixed extension set - and that is a few hundred lines of DER.
 *
 * Scope limits, deliberately: EC P-256 keys with ECDSA-SHA256 signatures only,
 * DNS names only (never an IP literal), and only the extensions the
 * interception path needs. This is not a general certificate authority.
 *
 * Times are UTCTime below 2050 and GeneralizedTime from 2050 on, which is what
 * RFC 5280 4.1.2.5 requires. LLP 0235's "UTCTime only" rested on nothing we
 * mint living longer than a year, and a ten-year CA outlives that assumption.
 *
 * @ref LLP 0235#minted-in-process: the options weighed, and why neither an `openssl` shell-out nor a certificate library survived them
 * @ref LLP 0266#generalized-time-past-2049 [constrained-by]: the encoding scope above, widened by exactly one tag
 */

// ---------------------------------------------------------------------------
// DER primitives
// ---------------------------------------------------------------------------

/**
 * Tag-length-value, the one shape every DER node takes. Lengths below 128 are
 * a single byte; anything larger is `0x80 | byteCount` followed by the length
 * big-endian.
 *
 * @param {number} tag
 * @param {Buffer} value
 * @returns {Buffer}
 */
function tlv(tag, value) {
  /** @type {Buffer} */
  let len
  if (value.length < 0x80) {
    len = Buffer.from([value.length])
  } else {
    /** @type {number[]} */
    const bytes = []
    let n = value.length
    while (n > 0) {
      bytes.unshift(n & 0xff)
      n = Math.floor(n / 256)
    }
    len = Buffer.from([0x80 | bytes.length, ...bytes])
  }
  return Buffer.concat([Buffer.from([tag]), len, value])
}

/** @param {...Buffer} parts */
const seq = (...parts) => tlv(0x30, Buffer.concat(parts))

/** @param {...Buffer} parts */
const derSet = (...parts) => tlv(0x31, Buffer.concat(parts))

/**
 * Constructed context-specific tag, EXPLICIT: the inner value keeps its own
 * tag and gets wrapped.
 *
 * @param {number} n
 * @param {...Buffer} parts
 */
const explicit = (n, ...parts) => tlv(0xa0 | n, Buffer.concat(parts))

/**
 * INTEGER, two's complement and minimally encoded. A leading zero byte is
 * prepended when the high bit is set so the value stays positive, which is
 * what keeps a random 16-byte serial from encoding as a negative number.
 *
 * @param {Buffer | number} input
 */
function integer(input) {
  let b = typeof input === 'number' ? Buffer.from([input]) : input
  let i = 0
  while (i < b.length - 1 && b[i] === 0 && (b[i + 1] & 0x80) === 0) i++
  b = b.subarray(i)
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b])
  return tlv(0x02, b)
}

/**
 * OBJECT IDENTIFIER from dotted decimal. The first two arcs pack into one
 * byte; the rest are base-128 with a continuation bit.
 *
 * @param {string} dotted
 */
function oid(dotted) {
  const parts = dotted.split('.').map(Number)
  /** @type {number[]} */
  const out = [parts[0] * 40 + parts[1]]
  for (const p of parts.slice(2)) {
    /** @type {number[]} */
    const chunk = []
    let n = p
    do {
      chunk.unshift(n & 0x7f)
      n = Math.floor(n / 128)
    } while (n > 0)
    for (let i = 0; i < chunk.length - 1; i++) chunk[i] |= 0x80
    out.push(...chunk)
  }
  return tlv(0x06, Buffer.from(out))
}

/**
 * @param {Buffer} buf
 * @param {number} [unused]
 */
const bitString = (buf, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), buf]))

/** @param {Buffer} buf */
const octetString = (buf) => tlv(0x04, buf)

/** @param {boolean} v */
const derBoolean = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]))

/** @param {string} s */
const utf8String = (s) => tlv(0x0c, Buffer.from(s, 'utf8'))

/** UTCTime, `YYMMDDHHMMSSZ`. */
const TAG_UTC_TIME = 0x17

/** GeneralizedTime, `YYYYMMDDHHMMSSZ`. */
const TAG_GENERALIZED_TIME = 0x18

/**
 * A validity date, encoded the way RFC 5280 4.1.2.5 requires: UTCTime through
 * 2049, GeneralizedTime from 2050 on.
 *
 * UTCTime carries a two-digit year, read against a sliding window that puts
 * 50-99 in the 1900s, so it cannot express 2050 at all - such a date reads back
 * as 1950. That was unreachable while nothing we mint lived longer than a year,
 * and became reachable the moment CA validity went to ten years: a machine
 * whose clock is past 2039 (a dead RTC battery, a VM restored with a skewed
 * clock) minted a CA born expired, which was then re-minted on every boot while
 * every intercepted handshake failed with nothing naming the cause.
 *
 * @ref LLP 0266#generalized-time-past-2049 [implements]
 * @param {Date} date
 */
function x509Time(date) {
  const year = date.getUTCFullYear()
  if (!Number.isFinite(year)) throw new Error('certificate validity must be a valid Date')
  if (year < 1950 || year > 9999) {
    throw new Error(`certificate validity year ${year} is outside what X.509 can encode`)
  }
  /** @param {number} n */
  const p = (n) => String(n).padStart(2, '0')
  const utc = year < 2050
  const body = (utc ? p(year % 100) : String(year)) +
    p(date.getUTCMonth() + 1) + p(date.getUTCDate()) +
    p(date.getUTCHours()) + p(date.getUTCMinutes()) + p(date.getUTCSeconds()) + 'Z'
  return tlv(utc ? TAG_UTC_TIME : TAG_GENERALIZED_TIME, Buffer.from(body, 'ascii'))
}

// ---------------------------------------------------------------------------
// Object identifiers
// ---------------------------------------------------------------------------

const OID_COMMON_NAME = '2.5.4.3'
const OID_ORGANIZATION = '2.5.4.10'
const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2'
const OID_BASIC_CONSTRAINTS = '2.5.29.19'
const OID_KEY_USAGE = '2.5.29.15'
const OID_EXT_KEY_USAGE = '2.5.29.37'
const OID_SUBJECT_ALT_NAME = '2.5.29.17'
const OID_NAME_CONSTRAINTS = '2.5.29.30'
const OID_SUBJECT_KEY_ID = '2.5.29.14'
const OID_AUTHORITY_KEY_ID = '2.5.29.35'
const OID_SERVER_AUTH = '1.3.6.1.5.5.7.3.1'

/** dNSName inside a GeneralName is `[2] IMPLICIT IA5String`. */
const TAG_DNS_NAME = 0x82

/** iPAddress inside a GeneralName is `[7] IMPLICIT OCTET STRING`. */
const TAG_IP_ADDRESS = 0x87

/**
 * Key usage bit positions (RFC 5280 §4.2.1.3), numbered from the most
 * significant bit of the first byte.
 */
const KEY_USAGE_DIGITAL_SIGNATURE = 0
const KEY_USAGE_KEY_ENCIPHERMENT = 2
const KEY_USAGE_KEY_CERT_SIGN = 5
const KEY_USAGE_CRL_SIGN = 6

// ---------------------------------------------------------------------------
// Certificate assembly
// ---------------------------------------------------------------------------

/**
 * An RDNSequence from `[oid, value]` pairs, one attribute per RDN, which is
 * the conventional flat shape.
 *
 * @param {[string, string][]} attrs
 */
function distinguishedName(attrs) {
  return seq(...attrs.map(([o, v]) => derSet(seq(oid(o), utf8String(v)))))
}

/**
 * @param {string} extnOid
 * @param {boolean} critical
 * @param {Buffer} valueDer
 */
function extension(extnOid, critical, valueDer) {
  // `critical` is DEFAULT FALSE, so DER requires it be omitted when false.
  return seq(oid(extnOid), ...(critical ? [derBoolean(true)] : []), octetString(valueDer))
}

/**
 * KeyUsage BIT STRING. The trailing unused-bit count has to be exact: a
 * mismatched count is a DER violation that stricter parsers reject.
 *
 * @param {number[]} bits
 */
function keyUsage(bits) {
  const byteLen = Math.floor(Math.max(...bits) / 8) + 1
  const buf = Buffer.alloc(byteLen)
  for (const b of bits) buf[Math.floor(b / 8)] |= 0x80 >> (b % 8)
  let unused = 0
  const last = buf[byteLen - 1]
  while (unused < 8 && ((last >> unused) & 1) === 0) unused++
  return bitString(buf, unused)
}

/**
 * A key identifier: the SHA-1 of the whole SubjectPublicKeyInfo.
 *
 * Not RFC 5280 method 1, which hashes only the `subjectPublicKey` BIT STRING,
 * so this value will not match what `openssl x509 -text` prints for a
 * third-party certificate. That is fine and deliberate: the identifier only has
 * to link a leaf to its issuer, both sides of that link are computed here by
 * this same function, and chain validation rests on the signature. SHA-1 is a
 * naming scheme here, not a security claim.
 *
 * @param {Buffer} spkiDer
 */
function keyIdentifier(spkiDer) {
  return crypto.createHash('sha1').update(spkiDer).digest()
}

/**
 * Whether a host string is an IP literal rather than a DNS name, with an
 * IPv6 URL host's brackets tolerated because `URL.hostname` keeps them.
 *
 * Exported because the gateway has to make the same judgement one step earlier,
 * on the upstreams it is about to ask for a CA: skipping one IP-literal
 * upstream is right, letting it fail the whole mint is not.
 *
 * @ref LLP 0266#ip-literals-are-refused [implements]
 * @param {string} host
 * @returns {boolean}
 */
export function isIpLiteralHost(host) {
  if (typeof host !== 'string') return false
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  return net.isIP(bare) !== 0
}

/**
 * Reject a host that cannot be encoded as an IA5String, or that is not a DNS
 * name at all.
 *
 * `Buffer.from(host, 'ascii')` masks each code unit to 7 bits rather than
 * failing, so an internationalised name silently becomes a different name:
 * `api.anthröpic.com` encodes as `api.anthrvpic.com`. A certificate quietly
 * issued for the wrong host is worse than a refusal, and callers hand us
 * hostnames from config.
 *
 * An IP literal is printable ASCII, so it used to pass, and every host here is
 * encoded as a `dNSName`. No TLS client matches a dNSName against a connection
 * made to an IP address, and the CA excludes the whole IP space anyway
 * (LLP 0235#ca-name-constraints), so the mint succeeded and produced a
 * certificate nothing would ever accept. Same rule as the non-ASCII case: a
 * certificate that cannot work is refused, not quietly issued.
 *
 * @ref LLP 0266#ip-literals-are-refused [implements]
 * @param {string} host
 */
function assertAsciiHost(host) {
  if (typeof host !== 'string' || host.length === 0) {
    throw new Error('certificate host must be a non-empty string')
  }
  // eslint-disable-next-line no-control-regex
  if (!/^[\x21-\x7e]+$/.test(host)) {
    throw new Error(
      `certificate host must be printable ASCII, got ${JSON.stringify(host)}; ` +
      'punycode-encode an internationalised name before minting'
    )
  }
  if (isIpLiteralHost(host)) {
    throw new Error(
      `certificate host must be a DNS name, got the IP literal ${JSON.stringify(host)}; ` +
      'this CA constrains dNSName and excludes all IP space, so an IP-literal ' +
      'certificate could never be accepted'
    )
  }
}

/**
 * Generate an EC P-256 key pair for a CA or a leaf.
 *
 * @returns {{ privateKey: crypto.KeyObject, publicKey: crypto.KeyObject }}
 */
export function generateKeyPair() {
  return crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
}

/**
 * Mint one certificate and return it as DER, PEM, and its key identifier.
 *
 * @param {object} args
 * @param {[string, string][]} args.subject      subject RDNs
 * @param {[string, string][]} args.issuer       issuer RDNs (equal to `subject` when self-signed)
 * @param {crypto.KeyObject} args.publicKey      the key being certified
 * @param {crypto.KeyObject} args.signingKey     the issuer's private key
 * @param {Date} args.notBefore
 * @param {Date} args.notAfter
 * @param {boolean} args.isCa
 * @param {string[]} [args.dnsNames]             subjectAltName entries (leaf certs)
 * @param {string[]} [args.permittedDnsNames]    nameConstraints permitted subtrees (CA certs)
 * @param {Buffer} [args.authorityKeyId]         issuer's subjectKeyIdentifier
 * @returns {{ der: Buffer, pem: string, keyId: Buffer, serial: Buffer }}
 */
export function mintCertificate({
  subject,
  issuer,
  publicKey,
  signingKey,
  notBefore,
  notAfter,
  isCa,
  dnsNames,
  permittedDnsNames,
  authorityKeyId,
}) {
  const spkiDer = /** @type {Buffer} */ (publicKey.export({ type: 'spki', format: 'der' }))

  // A positive random serial. The high bit is cleared rather than letting
  // `integer()` prepend a pad byte, purely to keep the encoded serial 16 bytes.
  const serial = crypto.randomBytes(16)
  serial[0] &= 0x7f

  /** @type {Buffer[]} */
  const exts = []

  exts.push(extension(
    OID_BASIC_CONSTRAINTS,
    true,
    // pathLenConstraint 0: this CA may sign leaves but no further CAs.
    isCa ? seq(derBoolean(true), integer(0)) : seq()
  ))

  exts.push(extension(
    OID_KEY_USAGE,
    true,
    isCa
      ? keyUsage([KEY_USAGE_KEY_CERT_SIGN, KEY_USAGE_CRL_SIGN])
      : keyUsage([KEY_USAGE_DIGITAL_SIGNATURE, KEY_USAGE_KEY_ENCIPHERMENT])
  ))

  if (!isCa) {
    exts.push(extension(OID_EXT_KEY_USAGE, false, seq(oid(OID_SERVER_AUTH))))
  }

  if (dnsNames && dnsNames.length > 0) {
    for (const host of dnsNames) assertAsciiHost(host)
    exts.push(extension(
      OID_SUBJECT_ALT_NAME,
      false,
      seq(...dnsNames.map((h) => tlv(TAG_DNS_NAME, Buffer.from(h, 'ascii'))))
    ))
  }

  if (permittedDnsNames && permittedDnsNames.length > 0) {
    // NameConstraints ::= SEQUENCE {
    //   permittedSubtrees [0] GeneralSubtrees OPTIONAL,
    //   excludedSubtrees  [1] GeneralSubtrees OPTIONAL }
    //
    // Both tags are IMPLICIT, so each REPLACES the `SEQUENCE OF` tag rather
    // than wrapping it: the GeneralSubtree elements are concatenated straight
    // into the context tag. Wrapping them in an extra SEQUENCE encodes a
    // structure OpenSSL cannot parse, which silently voids the constraint and
    // takes chain validation down with it.
    for (const host of permittedDnsNames) assertAsciiHost(host)
    const permitted = permittedDnsNames.map((h) => seq(tlv(TAG_DNS_NAME, Buffer.from(h, 'ascii'))))

    // Constraining dNSName alone does not contain a leaked key. RFC 5280
    // §4.2.1.10 leaves any name form absent from permittedSubtrees
    // *unrestricted*, so a CA permitting only `api.anthropic.com` will still
    // sign a chain-valid leaf for `IP:93.184.216.34`, and a client connecting
    // by IP accepts it. Excluding the whole IPv4 and IPv6 space closes the one
    // other name form a TLS client will identify a server by.
    //
    // An iPAddress constraint is address followed by mask: 8 bytes for v4, 32
    // for v6. All-zero is `0.0.0.0/0` and `::/0`, i.e. everything.
    const excluded = [
      seq(tlv(TAG_IP_ADDRESS, Buffer.alloc(8))),
      seq(tlv(TAG_IP_ADDRESS, Buffer.alloc(32))),
    ]
    exts.push(extension(
      OID_NAME_CONSTRAINTS,
      true,
      seq(tlv(0xa0, Buffer.concat(permitted)), tlv(0xa1, Buffer.concat(excluded)))
    ))
  }

  const keyId = keyIdentifier(spkiDer)
  exts.push(extension(OID_SUBJECT_KEY_ID, false, octetString(keyId)))
  if (authorityKeyId) {
    exts.push(extension(OID_AUTHORITY_KEY_ID, false, seq(tlv(0x80, authorityKeyId))))
  }

  const sigAlg = seq(oid(OID_ECDSA_SHA256))
  const tbs = seq(
    explicit(0, integer(2)),
    integer(serial),
    sigAlg,
    distinguishedName(issuer),
    seq(x509Time(notBefore), x509Time(notAfter)),
    distinguishedName(subject),
    spkiDer,
    explicit(3, seq(...exts))
  )

  // ECDSA signatures default to DER encoding in Node, which is what X.509
  // wants; the IEEE P1363 form would be rejected.
  const signature = crypto.sign('sha256', tbs, signingKey)
  const der = seq(tbs, sigAlg, bitString(signature))

  return { der, pem: derToPem(der), keyId, serial }
}

/**
 * Wrap DER as a PEM certificate block.
 *
 * @param {Buffer} der
 */
export function derToPem(der) {
  const body = der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`
}

// ---------------------------------------------------------------------------
// Reading back
// ---------------------------------------------------------------------------

/**
 * Read one DER node at `offset`.
 *
 * @param {Buffer} buf
 * @param {number} offset
 * @returns {{ tag: number, start: number, end: number, next: number }}
 */
function readNode(buf, offset) {
  if (offset + 2 > buf.length) throw new Error('truncated DER')
  const tag = buf[offset]
  let len = buf[offset + 1]
  let start = offset + 2
  if (len & 0x80) {
    const n = len & 0x7f
    if (n === 0 || n > 4 || start + n > buf.length) throw new Error('unsupported DER length')
    len = 0
    for (let i = 0; i < n; i++) len = len * 256 + buf[start + i]
    start += n
  }
  const end = start + len
  if (end > buf.length) throw new Error('DER node overruns buffer')
  return { tag, start, end, next: end }
}

/**
 * Every child node of a constructed DER node.
 *
 * @param {Buffer} buf
 * @param {number} start
 * @param {number} end
 * @returns {{ tag: number, start: number, end: number, next: number }[]}
 */
function readChildren(buf, start, end) {
  /** @type {{ tag: number, start: number, end: number, next: number }[]} */
  const out = []
  let at = start
  while (at < end) {
    const node = readNode(buf, at)
    out.push(node)
    at = node.next
  }
  return out
}

/**
 * Parse a certificate's nameConstraints extension.
 *
 * A real structural walk rather than a byte scan. Searching the whole
 * certificate for context-tag bytes matches the SubjectKeyIdentifier hash, the
 * AuthorityKeyIdentifier hash and the ECDSA signature too, so roughly one CA in
 * seven hundred reported a phantom permitted host; it also could not tell
 * `permittedSubtrees` from `excludedSubtrees`, and gave up on any name needing
 * a long-form length.
 *
 * Returns empty lists when the extension is absent or unparseable, which the
 * caller reads as "cannot confirm this CA covers the hosts", i.e. regenerate.
 *
 * @ref LLP 0235#constraints-are-read-back-structurally [implements]: the byte scan this replaces reported phantom permitted hosts and re-minted the machine's CA on every boot
 * @param {Buffer} der a DER-encoded certificate
 * @returns {{ permittedDns: string[], excludedIp: Buffer[] }}
 */
export function readNameConstraints(der) {
  /** @type {{ permittedDns: string[], excludedIp: Buffer[] }} */
  const empty = { permittedDns: [], excludedIp: [] }
  try {
    const cert = readNode(der, 0)
    const [tbs] = readChildren(der, cert.start, cert.end)
    // Extensions are `[3] EXPLICIT` and always the last tbs field.
    const extsHolder = readChildren(der, tbs.start, tbs.end).find((n) => n.tag === 0xa3)
    if (!extsHolder) return empty
    const [extsSeq] = readChildren(der, extsHolder.start, extsHolder.end)

    for (const ext of readChildren(der, extsSeq.start, extsSeq.end)) {
      const parts = readChildren(der, ext.start, ext.end)
      const oidNode = parts[0]
      // 2.5.29.30 encodes as 55 1D 1E.
      const isNameConstraints = oidNode.tag === 0x06 &&
        der.subarray(oidNode.start, oidNode.end).equals(Buffer.from([0x55, 0x1d, 0x1e]))
      if (!isNameConstraints) continue

      const value = parts[parts.length - 1]
      if (value.tag !== 0x04) return empty
      // extnValue wraps the extension's own DER.
      const [constraints] = readChildren(der, value.start, value.end)

      /** @type {string[]} */
      const permittedDns = []
      /** @type {Buffer[]} */
      const excludedIp = []
      for (const subtrees of readChildren(der, constraints.start, constraints.end)) {
        // [0] permittedSubtrees, [1] excludedSubtrees, both IMPLICIT.
        const permitted = subtrees.tag === 0xa0
        if (!permitted && subtrees.tag !== 0xa1) continue
        for (const subtree of readChildren(der, subtrees.start, subtrees.end)) {
          const [base] = readChildren(der, subtree.start, subtree.end)
          if (permitted && base.tag === TAG_DNS_NAME) {
            permittedDns.push(der.subarray(base.start, base.end).toString('latin1'))
          } else if (!permitted && base.tag === TAG_IP_ADDRESS) {
            excludedIp.push(Buffer.from(der.subarray(base.start, base.end)))
          }
        }
      }
      return { permittedDns, excludedIp }
    }
    return empty
  } catch {
    // A certificate we cannot parse is one we will not vouch for.
    return empty
  }
}
