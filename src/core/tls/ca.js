// @ts-check

import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'

import { atomicWriteFile, errCode, sanitizeLabel } from 'hypaware/core/util'
import { generateKeyPair, mintCertificate, readNameConstraints } from './x509.js'

/**
 * The machine-local certificate authority that proxy-mode capture terminates
 * TLS with.
 *
 * This lives in core rather than in the gateway plugin for the same reason the
 * attach undo does (LLP 0045 Part 3): `hyp daemon uninstall` and `hyp detach
 * --purge` must be able to delete the CA with the plugin unloaded. A trusted
 * signing key that outlives the *install* is the worst failure mode this
 * feature has, so its removal cannot depend on a plugin being loadable.
 * Routine detach keeps the CA (LLP 0238#ca-survives-detach) so the keychain
 * trust granted for it stays valid across attach cycles.
 *
 * Three properties do the security work, and each is tested:
 *
 * - **Per-machine, never shipped.** The key is generated locally at attach and
 *   written 0600 inside the state root. It is never an export, a sink payload,
 *   or a support-bundle file.
 * - **Constrained.** The CA carries `nameConstraints` permitting only the
 *   provider hosts this product can intercept, so a leaked key cannot mint a
 *   working certificate for anything else against a client that trusts it.
 * - **User-scoped trust.** On macOS the CA is additionally trusted in the
 *   user's login keychain (`darwin_trust.js`), because file-scoped
 *   `NODE_EXTRA_CA_CERTS` trust does not reach Claude Code's SSE transport
 *   (LLP 0236). Trust is never machine-wide.
 *
 * @import { LocalCa, LocalCaInfo } from '../../../src/core/tls/types.js'
 * @ref LLP 0235#client-scoped-trust: trust is scoped to the attached client's own settings file, which is why proxy mode needs no privileged install step
 */

const CA_DIR_NAME = 'tls'
const CA_KEY_FILE = 'ca-key.pem'
const CA_CERT_FILE = 'ca-cert.pem'

// Ten years, because the CA is now a keychain-trusted root and every re-mint
// strands that trust and costs the user a password dialog. Leaves stay short.
// @ref LLP 0238#ten-year-validity [implements]
const CA_VALID_DAYS = 3650

/** Leaf lifetime. Leaves are cheap and never leave the process, so keep them short. */
const LEAF_VALID_DAYS = 30

/**
 * Re-mint the CA once it is inside this window of expiry.
 *
 * Deliberately longer than {@link LEAF_VALID_DAYS}: leaves are minted against
 * whatever CA the process loaded at start, so a daemon that booted with less
 * CA life left than a leaf's lifetime would go on issuing leaves that outlive
 * their issuer. Long-lived launchd and systemd daemons make that reachable.
 */
const CA_RENEW_WITHIN_DAYS = 45

const CA_SUBJECT = /** @type {[string, string][]} */ ([
  ['2.5.4.3', 'HypAware Local CA'],
  ['2.5.4.10', 'HypAware'],
])

// Every host a HypAware client adapter can route through the gateway, not the
// subset this install has configured. The CA is minted against this full list
// so the one keychain trust grant covers a provider enabled later; which hosts
// are actually decrypted is still decided per-connection by the routing table.
// Widening this list is a real design change that goes through a doc, and only
// reaches users when their CA is next minted.
// @ref LLP 0238#full-provider-constraints [implements]
export const INTERCEPT_PROVIDER_HOSTS = Object.freeze([
  'api.anthropic.com',
  'api.openai.com',
  'chatgpt.com',
])

/**
 * The kernel state root, derived the same way the daemon boot derives it.
 *
 * Detach and uninstall have to find the CA without a booted kernel to ask, so
 * the location cannot come from an activation context. This mirrors
 * `boot.js`'s `path.join(hypHome, 'hypaware')`; if that ever moves, this moves
 * with it, and the round-trip test in `test/core/tls-ca.test.js` is what
 * catches the drift.
 *
 * `homeDir` is separate from `env` because callers that operate on a specific
 * home (the disk-driven detach undo, and every test that points at a sandbox)
 * must not fall through to the ambient one. Resolving the settings file from
 * `homeDir` while resolving the CA from `os.homedir()` deletes the wrong
 * machine's key material.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [homeDir]
 * @returns {string}
 */
export function defaultStateRoot(env = process.env, homeDir = os.homedir()) {
  const hypHome = env.HYP_HOME || path.join(homeDir, '.hyp')
  return path.join(hypHome, 'hypaware')
}

/**
 * Resolve the CA file locations for a state root.
 *
 * @param {string} stateRoot
 * @returns {{ dir: string, keyPath: string, certPath: string }}
 */
export function caPaths(stateRoot) {
  const dir = path.join(stateRoot, CA_DIR_NAME)
  return {
    dir,
    keyPath: path.join(dir, CA_KEY_FILE),
    certPath: path.join(dir, CA_CERT_FILE),
  }
}

/**
 * SHA-256 fingerprint, colon-separated uppercase hex. This is what `hyp status`
 * shows and what a user compares against the certificate their client loaded.
 *
 * @param {Buffer} der
 * @returns {string}
 */
export function fingerprint(der) {
  const hex = crypto.createHash('sha256').update(der).digest('hex').toUpperCase()
  return /** @type {string[]} */ (hex.match(/.{2}/g)).join(':')
}

/**
 * Load the CA from disk, or generate and persist one.
 *
 * Regenerates when the stored CA is missing, unreadable, expiring within
 * {@link CA_RENEW_WITHIN_DAYS}, or does not already permit every host in
 * `hosts`. That last check is what makes adding an intercepted host safe: the
 * constraint set is part of the CA's identity, so widening it mints a new CA
 * rather than silently running with one that cannot vouch for the new host.
 *
 * @ref LLP 0235#ca-name-constraints [implements]: the constraint set can never silently lag the intercept set, so a CA that does not already permit a host is regenerated rather than reused
 * @param {object} args
 * @param {string} args.stateRoot
 * @param {string[]} args.hosts hosts this CA may vouch for
 * @param {Date} [args.now]
 * @returns {Promise<LocalCa>}
 */
export async function ensureLocalCa({ stateRoot, hosts, now = new Date() }) {
  if (!Array.isArray(hosts) || hosts.length === 0) {
    throw new Error('ensureLocalCa: at least one host is required')
  }
  const paths = caPaths(stateRoot)
  const existing = await loadLocalCa(paths, hosts, now)
  if (existing) return existing

  const keys = generateKeyPair()
  const notBefore = new Date(now.getTime() - 5 * 60_000)
  const notAfter = new Date(notBefore.getTime() + CA_VALID_DAYS * 86_400_000)
  const cert = mintCertificate({
    subject: CA_SUBJECT,
    issuer: CA_SUBJECT,
    publicKey: keys.publicKey,
    signingKey: keys.privateKey,
    notBefore,
    notAfter,
    isCa: true,
    permittedDnsNames: hosts,
  })

  const keyPem = /** @type {string} */ (
    keys.privateKey.export({ type: 'pkcs8', format: 'pem' })
  )

  await fsp.mkdir(paths.dir, { recursive: true, mode: 0o700 })
  // The key is written first and 0600. If the process dies between the two
  // writes the next boot finds a key with no certificate, fails to load, and
  // regenerates both - which is why loading requires the pair.
  await atomicWriteFile(paths.keyPath, keyPem, { mode: 0o600, fsync: true })
  await atomicWriteFile(paths.certPath, cert.pem, { mode: 0o644, fsync: true })

  return {
    certPath: paths.certPath,
    keyPath: paths.keyPath,
    certPem: cert.pem,
    privateKey: keys.privateKey,
    keyId: cert.keyId,
    hosts: [...hosts],
    fingerprint: fingerprint(cert.der),
    notAfter,
    created: true,
  }
}

/**
 * Read a stored CA and decide whether it is still usable for `hosts`.
 *
 * @param {{ dir: string, keyPath: string, certPath: string }} paths
 * @param {string[]} hosts
 * @param {Date} now
 * @returns {Promise<LocalCa | undefined>}
 */
async function loadLocalCa(paths, hosts, now) {
  /** @type {string} */
  let keyPem
  /** @type {string} */
  let certPem
  try {
    keyPem = await fsp.readFile(paths.keyPath, 'utf8')
    certPem = await fsp.readFile(paths.certPath, 'utf8')
  } catch (err) {
    if (errCode(err) === 'ENOENT') return undefined
    throw err
  }

  /** @type {crypto.X509Certificate} */
  let cert
  /** @type {crypto.KeyObject} */
  let privateKey
  try {
    cert = new crypto.X509Certificate(certPem)
    privateKey = crypto.createPrivateKey(keyPem)
  } catch {
    // Corrupt or truncated on disk. Regenerating is always safe: the only
    // thing that trusts this CA is a client we are about to re-point anyway.
    return undefined
  }

  // The key and the certificate are two separate writes, so they can diverge:
  // two daemons starting at once can interleave their renames and leave one
  // process's key beside the other's certificate. Nothing downstream notices -
  // the pair parses, the dates are fine - and every handshake then fails with
  // `certificate signature failure` until someone deletes the files by hand.
  if (!cert.checkPrivateKey(privateKey)) return undefined

  const notAfter = new Date(cert.validTo)
  if (Number.isNaN(notAfter.getTime())) return undefined
  if (notAfter.getTime() - now.getTime() < CA_RENEW_WITHIN_DAYS * 86_400_000) return undefined

  // The stored constraint set must *cover* the hosts asked for, not equal them.
  // Only widening needs a new CA; narrowing does not, and requiring equality
  // meant an install that had once configured an upstream outside the static
  // provider list silently re-minted the moment that upstream was removed from
  // config - stranding the one keychain trust grant the user gave by password
  // dialog, which is the entire reason the CA is long-lived, and failing every
  // proxied handshake until they re-attach and re-approve. A CA minted under
  // the old routing-table rule is still a strict subset of the full provider
  // list callers now ask for, so it still regenerates once (LLP 0238).
  // @ref LLP 0266#stored-superset-is-reusable [implements]
  const permitted = permittedHosts(cert)
  for (const host of hosts) {
    if (!permitted.includes(host)) return undefined
  }

  return {
    certPath: paths.certPath,
    keyPath: paths.keyPath,
    certPem,
    privateKey,
    keyId: subjectKeyId(cert),
    hosts: permitted,
    fingerprint: fingerprint(cert.raw),
    notAfter,
    created: false,
  }
}

/**
 * The dNSName permitted subtrees on a CA certificate.
 *
 * Node's `X509Certificate` exposes no accessor for nameConstraints, so this
 * recovers them by walking the DER. Reading the constraint set back matters
 * because it is what decides whether a stored CA can be reused or has to be
 * regenerated for a newly intercepted host.
 *
 * @param {crypto.X509Certificate} cert
 * @returns {string[]}
 */
function permittedHosts(cert) {
  return readNameConstraints(cert.raw).permittedDns
}

/**
 * The subjectKeyIdentifier of a parsed certificate, used as the leaf's
 * authorityKeyIdentifier.
 *
 * @param {crypto.X509Certificate} cert
 * @returns {Buffer}
 */
function subjectKeyId(cert) {
  const spki = cert.publicKey.export({ type: 'spki', format: 'der' })
  return crypto.createHash('sha1').update(/** @type {Buffer} */ (spki)).digest()
}

/**
 * A per-host leaf minter with an in-memory cache.
 *
 * Leaves are minted per intercepted host and never written to disk: they are
 * cheap to recreate, and every file holding a private key is one more thing to
 * exclude from exports and clean up on detach. The cache is keyed by host and
 * re-mints once a leaf is inside a day of expiry.
 *
 * @param {LocalCa} ca
 * @returns {{ secureContextFor(host: string): tls.SecureContext, size(): number }}
 */
export function createLeafStore(ca) {
  /** @type {Map<string, { context: tls.SecureContext, notAfter: Date }>} */
  const cache = new Map()

  return {
    /** @param {string} host */
    secureContextFor(host) {
      const hit = cache.get(host)
      if (hit && hit.notAfter.getTime() - Date.now() > 86_400_000) return hit.context

      if (!ca.hosts.includes(host)) {
        // Minting outside the CA's own constraints produces a leaf no client
        // will accept. Failing here turns a silent handshake failure into a
        // named one.
        throw new Error(
          `local CA does not permit ${host}; permitted: ${ca.hosts.join(', ') || 'none'}`
        )
      }

      const keys = generateKeyPair()
      const notBefore = new Date(Date.now() - 5 * 60_000)
      const notAfter = new Date(notBefore.getTime() + LEAF_VALID_DAYS * 86_400_000)
      const leaf = mintCertificate({
        subject: [['2.5.4.3', host]],
        issuer: CA_SUBJECT,
        publicKey: keys.publicKey,
        signingKey: ca.privateKey,
        notBefore,
        notAfter,
        isCa: false,
        dnsNames: [host],
        authorityKeyId: ca.keyId,
      })

      const context = tls.createSecureContext({
        key: /** @type {string} */ (keys.privateKey.export({ type: 'pkcs8', format: 'pem' })),
        cert: leaf.pem,
      })
      cache.set(host, { context, notAfter })
      return context
    },
    size() {
      return cache.size
    },
  }
}

/**
 * Read the stored CA's identity without loading its private key, for `hyp
 * status`. Returns `undefined` when no CA is installed.
 *
 * @param {object} args
 * @param {string} args.stateRoot
 * @returns {Promise<LocalCaInfo | undefined>}
 */
export async function readLocalCaInfo({ stateRoot }) {
  const paths = caPaths(stateRoot)
  /** @type {string} */
  let certPem
  try {
    certPem = await fsp.readFile(paths.certPath, 'utf8')
  } catch (err) {
    if (errCode(err) === 'ENOENT') return undefined
    throw err
  }
  try {
    const cert = new crypto.X509Certificate(certPem)
    return {
      certPath: paths.certPath,
      fingerprint: fingerprint(cert.raw),
      notAfter: new Date(cert.validTo),
      hosts: permittedHosts(cert),
    }
  } catch {
    return undefined
  }
}

/**
 * How many permitted subtrees any surface will name before it stops listing
 * and starts counting. Our own mint produces one entry per provider host, so
 * the bound is never reached by a certificate this build wrote; it exists for
 * the certificate it did not.
 */
const MAX_NAMED_CA_HOSTS = 24

/**
 * `LocalCaInfo.hosts` made safe to put in front of a person.
 *
 * The entries are the only part of a read-back CA that is bytes off disk
 * rather than a string this build wrote: a `dNSName` is an IA5String, and
 * `readNameConstraints` hands back whatever the DER held, decoded as latin1,
 * with no charset, length or count check anywhere on the way. Our own mint
 * refuses a non-printable host (`assertAsciiHost`), so reaching one takes a
 * foreign or damaged certificate at the CA path - which is exactly the case
 * both callers already have an arm for, so it is reachable by construction.
 * All three of the ways such a value is hostile are answered here, at the one
 * point the hosts leave this module for a terminal: control and invisible
 * bytes and unbounded length (`sanitizeLabel`), and unbounded count (the
 * bound below).
 *
 * Strip rather than escape, and nothing is silently dropped. LLP 0225#scope
 * leaves `hyp status` and the attach adapters to make that argument for
 * themselves, and here it is: these are label-plane values, so the shortest
 * safe answer is to drop the bytes - but both callers exist to state how wide
 * a trust grant is, and a short list understates it. So an entry that
 * sanitizes away is still named as an entry, and a truncated list says how
 * much it left out.
 *
 * @ref LLP 0225#scope [implements]: the per-surface strip-versus-escape argument 0225 leaves to hyp status and the attach adapters
 * @param {string[]} hosts
 * @returns {string[]}
 */
export function displayableCaHosts(hosts) {
  const named = hosts
    .slice(0, MAX_NAMED_CA_HOSTS)
    .map((host) => sanitizeLabel(host) ?? '(unprintable dNSName)')
  const omitted = hosts.length - named.length
  if (omitted > 0) named.push(`(+${omitted} more dNSName constraints)`)
  return named
}

/**
 * Wait, bounded, for the gateway to mint the local CA. Two callers, one
 * reason: proxy attach preflights on the CA file's existence (LLP 0232), so
 * a flow that just (re)started a proxy-mode daemon must not race the mint or
 * the client silently lands back on base-URL mode. The wizard finale waits
 * here after installing the daemon, and the LLP 0244 migration waits here
 * after its restart.
 *
 * @param {object} args
 * @param {string} args.stateRoot
 * @param {number} [args.timeoutMs]
 * @param {number} [args.intervalMs]
 * @param {(ms: number) => Promise<void>} [args.sleep]
 * @param {() => number} [args.now]
 * @returns {Promise<{ ready: boolean, certPath?: string }>}
 */
export async function waitForLocalCa({ stateRoot, timeoutMs = 15_000, intervalMs = 250, sleep, now }) {
  const sleepFn = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const nowFn = now ?? Date.now
  const deadline = nowFn() + timeoutMs
  for (;;) {
    /** @type {LocalCaInfo | undefined} */
    let ca
    try {
      ca = await readLocalCaInfo({ stateRoot })
    } catch {
      ca = undefined
    }
    if (ca) return { ready: true, certPath: ca.certPath }
    if (nowFn() >= deadline) return { ready: false }
    await sleepFn(intervalMs)
  }
}

/**
 * Delete the CA key and certificate. Called by `hyp daemon uninstall` and
 * `hyp detach --purge`; plain detach keeps the CA so the keychain trust
 * granted for it stays valid across attach cycles.
 * @ref LLP 0238#ca-survives-detach [constrained-by]: routine detach must not call this
 *
 * Idempotent, and reports what it actually removed so callers can tell the user.
 *
 * @ref LLP 0235#detach-removes-the-ca [implements]: removal lives in core so `hyp detach` and `hyp daemon uninstall` can run it with the plugin unloaded
 * @param {object} args
 * @param {string} args.stateRoot
 * @returns {Promise<{ removed: string[] }>}
 */
export async function deleteLocalCa({ stateRoot }) {
  const paths = caPaths(stateRoot)
  /** @type {string[]} */
  const removed = []
  for (const target of [paths.keyPath, paths.certPath]) {
    try {
      await fsp.unlink(target)
      removed.push(target)
    } catch (err) {
      if (errCode(err) !== 'ENOENT') throw err
    }
  }
  // Only remove the directory when it is ours and now empty; a non-empty dir
  // means something else is in there and deleting it is not our call.
  try {
    await fsp.rmdir(paths.dir)
  } catch {
    // ENOENT or ENOTEMPTY are both fine.
  }
  return { removed }
}
