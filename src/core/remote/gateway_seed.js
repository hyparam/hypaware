// @ts-check

import path from 'node:path'

import { writeLoginSeed } from '../../../hypaware-core/plugins-workspace/central/src/identity_client.js'
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
