// @ts-check

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { Attr, getLogger } from '../observability/index.js'
import { resolveLayeredConfigFromDisk } from '../runtime/boot.js'

/**
 * Bridge from a login-minted gateway credential to the `central` forward
 * sink's persisted identity (LLP 0061 D5). The login command and the sink
 * run under the same `HYP_HOME`, so the seed is written directly where the
 * sink's `IdentityClient.acquire()` reads it - no handoff protocol.
 *
 * The sink's forward-identity path is resolved config-driven, the same way
 * the sink itself resolves it: each `@hypaware/central` sink block's
 * `identity.persisted_path`, defaulting to the per-plugin state path
 * `<stateDir>/plugins/@hypaware/central/identity.json` (LLP 0004). The
 * effective config is the layered local+central merge the daemon runs, so
 * a server-pushed sink block seeds the same file a locally-configured one
 * does.
 *
 * @import { LoginGatewayCredential, SeededGateway } from '../../../src/core/remote/types.js'
 * @import { PersistedIdentity } from '../../../hypaware-core/plugins-workspace/central/src/types.js'
 */

const CENTRAL_PLUGIN = '@hypaware/central'

/**
 * Seed every configured `central` forward sink that targets the logged-in
 * server. A login `<target>` maps to forward sinks by URL **origin** - the
 * same derivation that maps the target to its identity endpoints (LLP 0058
 * D6) - so one login seeds exactly the sinks that forward to the server
 * that minted the credential, and a second central target's sink is never
 * touched. Paths are deduped: several instances sharing one persisted path
 * (the per-plugin default) get one write.
 *
 * Returns the seeded sinks (empty when no central sink targets the origin);
 * throws when a matched sink's seed cannot be written.
 *
 * @param {{
 *   stateDir: string,
 *   configPath: string | null,
 *   targetUrl: string,
 *   gateway: LoginGatewayCredential,
 * }} args
 * @returns {Promise<SeededGateway[]>}
 * @ref LLP 0061#d5 [implements]: login resolves the sink's persistedPath from the target's central sink block and writes the seed where acquire() reads it
 */
export async function seedLoginGateway({ stateDir, configPath, targetUrl, gateway }) {
  const log = getLogger('remote')
  const origin = originOf(targetUrl)
  if (!origin) return []
  const { effective } = await resolveLayeredConfigFromDisk({ stateRoot: stateDir, configPath })
  const sinks = effective?.sinks ?? {}

  /** @type {SeededGateway[]} */
  const seeded = []
  const seenPaths = new Set()
  for (const [name, entry] of Object.entries(sinks)) {
    if (!entry || /** @type {any} */ (entry).plugin !== CENTRAL_PLUGIN) continue
    const config = /** @type {Record<string, any>} */ (/** @type {any} */ (entry).config ?? {})
    const centralUrl = typeof config.url === 'string' ? config.url : ''
    if (originOf(centralUrl) !== origin) continue
    const persistedPath = typeof config.identity?.persisted_path === 'string'
      ? config.identity.persisted_path
      : path.join(stateDir, 'plugins', CENTRAL_PLUGIN, 'identity.json')
    if (seenPaths.has(persistedPath)) continue
    seenPaths.add(persistedPath)
    const { replaced } = writeLoginSeed({
      persistedPath,
      centralUrl,
      jwt: gateway.jwt,
      expiresAt: gateway.expiresAt,
      gatewayId: gateway.gatewayId,
    })
    log.info('remote.gateway_seeded', {
      [Attr.COMPONENT]: 'remote-oidc',
      [Attr.OPERATION]: 'remote.gateway_seed',
      [Attr.STATUS]: 'ok',
      hyp_sink_instance: name,
      gateway_id: gateway.gatewayId,
      replaced_origin: replaced ? replaced.origin ?? 'bootstrap' : 'none',
    })
    seeded.push({ sink: name, persistedPath, centralUrl, ...(replaced ? { replaced } : {}) })
  }
  return seeded
}

/**
 * The URL origins that `@hypaware/central` sinks target in the **central
 * config layer** — i.e. which server(s) this machine is *enrolled* to. A
 * fresh, login-first box returns `[]`. Drives login's D4 exclusivity gate
 * (LLP 0063): already enrolled to this origin (re-login, idempotent), enrolled
 * to a different origin (reject), or not enrolled (may enroll).
 *
 * Deliberately reads the central layer, **not** the effective (local+central)
 * config: a hand-authored `@hypaware/central` sink in the user-owned local
 * layer is not an enrollment (`hyp leave` refuses to touch it, #111), so it
 * must not count as "connected" — otherwise the gate would block login to a
 * different server with `hyp leave` advice that cannot clear a local sink. The
 * gate and `hyp leave` therefore agree that enrollment == the central layer.
 *
 * @param {{ stateDir: string, configPath: string | null }} args
 * @returns {Promise<string[]>}
 * @ref LLP 0063#d4 [implements]: one enrollment per machine — the central-layer sink origins are the gate; a local sink is the user's own, not an enrollment
 */
export async function readCentralSinkOrigins({ stateDir, configPath }) {
  const { centralConfig } = await resolveLayeredConfigFromDisk({ stateRoot: stateDir, configPath })
  const sinks = centralConfig?.sinks ?? {}
  const origins = new Set()
  for (const entry of Object.values(sinks)) {
    if (!entry || /** @type {any} */ (entry).plugin !== CENTRAL_PLUGIN) continue
    const config = /** @type {Record<string, any>} */ (/** @type {any} */ (entry).config ?? {})
    const origin = typeof config.url === 'string' ? originOf(config.url) : null
    if (origin) origins.add(origin)
  }
  return [...origins]
}

/**
 * Seed the sink's persisted identity from a login-minted gateway credential
 * (LLP 0061 D2): the file `acquire()` already loads, pre-populated, so the
 * sink skips `bootstrap()` and the unchanged refresh / 401-retry path carries
 * the credential from there. Written with the same atomic 0600 discipline the
 * sink uses for its own persistence, but from the login (producer) side of the
 * package boundary - the sink (`hypaware-core`) only ever reads and refreshes
 * this file, so `src` never imports a sink value to write it. Stamps
 * `central_url` so the re-point guards apply to a login seed exactly as to a
 * bootstrap mint (LLP 0061 D4), and `origin: 'login'` for the re-enrollment
 * guard and diagnostics.
 *
 * The write always lands (the login is a fresh mint for this server, the same
 * authority a re-bootstrap has), but never silently: the replaced identity is
 * returned so the caller can report what the seed displaced - a prior login
 * seed (idempotent: the server dedups to the same gateway), a bootstrap-minted
 * identity, or a stale identity from another server.
 *
 * @param {{ persistedPath: string, centralUrl: string, jwt: string, expiresAt: number, gatewayId: string }} args
 * @returns {{ replaced: PersistedIdentity | undefined }}
 * @ref LLP 0061#d2 [implements]: a login seed is the persisted identity pre-populated; only the writer is new, the forward path is untouched
 */
export function writeLoginSeed({ persistedPath, centralUrl, jwt, expiresAt, gatewayId }) {
  if (typeof jwt !== 'string' || jwt.length === 0) {
    throw new Error('writeLoginSeed: jwt is required')
  }
  if (typeof expiresAt !== 'number' || !Number.isInteger(expiresAt) || expiresAt <= 0) {
    throw new Error('writeLoginSeed: expiresAt must be a Unix epoch second')
  }
  if (typeof gatewayId !== 'string' || gatewayId.length === 0) {
    throw new Error('writeLoginSeed: gatewayId is required')
  }
  if (typeof centralUrl !== 'string' || centralUrl.length === 0) {
    throw new Error('writeLoginSeed: centralUrl is required')
  }
  // Read the current identity for the caller's report; a missing or corrupt
  // file is simply no prior identity (the fresh mint supersedes it).
  const replaced = readPersistedIdentity(persistedPath)
  /** @type {PersistedIdentity} */
  const identity = {
    jwt,
    expires_at: expiresAt,
    gateway_id: gatewayId,
    central_url: centralUrl,
    origin: 'login',
  }
  writePersistedIdentity(persistedPath, identity)
  return { replaced }
}

/**
 * Read the persisted identity for the seed's replacement report. Mirrors the
 * sink's read validation (LLP 0031 physical-layout), but leniently: a missing
 * or malformed file counts as no prior identity rather than throwing, because
 * this is only diagnostics for what the seed displaced.
 *
 * @param {string} filePath
 * @returns {PersistedIdentity | undefined}
 */
function readPersistedIdentity(filePath) {
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object') return undefined
  const { jwt, expires_at, gateway_id, central_url, bootstrap_token_fp, origin } = parsed
  if (typeof jwt !== 'string' || jwt.length === 0) return undefined
  if (typeof gateway_id !== 'string' || gateway_id.length === 0) return undefined
  if (typeof expires_at !== 'number' || !Number.isInteger(expires_at)) return undefined
  /** @type {PersistedIdentity} */
  const identity = { jwt, expires_at, gateway_id }
  if (typeof central_url === 'string') identity.central_url = central_url
  if (typeof bootstrap_token_fp === 'string') identity.bootstrap_token_fp = bootstrap_token_fp
  if (origin === 'login') identity.origin = origin
  return identity
}

/**
 * Atomic tmp+rename write at mode 0600, matching the sink's own persistence.
 * The JWT is the gateway's only credential against the central server, so a
 * crash mid-write must never leave a half-finished file in place.
 *
 * @param {string} filePath
 * @param {PersistedIdentity} identity
 */
function writePersistedIdentity(filePath, identity) {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(identity, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, filePath)
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    // best effort: rename already replaced the file
  }
}

/**
 * The URL's origin, or `null` when unparseable (an unparseable sink URL
 * simply never matches; the sink's own validation reports it).
 *
 * @param {string} url
 * @returns {string | null}
 */
function originOf(url) {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}
