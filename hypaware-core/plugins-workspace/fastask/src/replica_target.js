// @ts-check

import { effectiveDefaultRemote, effectiveRemotes } from '../../../../src/core/remote/builtin_remotes.js'
import { deriveIdentityBase, readCredentials, remoteTokenEnvVar, resolveAccessJwt } from '../../../../src/core/remote/credentials.js'

/**
 * @import { HypAwareV2Config } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { ReplicaTarget } from '../../../../hypaware-core/plugins-workspace/fastask/src/types.js'
 */

/**
 * The replica's target, resolved fresh on every sync pass: the default remote
 * (`query.default_remote`, else the built-in) when it has a login. Returns
 * null only when there definitely is none (no such target, no stored
 * credential and no env override), because null makes the sync loop delete
 * every replica. A credential file that cannot be read throws instead, so a
 * transient read error backs off rather than deleting anything.
 *
 * The org comes from an OIDC login record; static and env tokens carry none,
 * and the sync loop learns it from the manifest.
 *
 * @ref LLP 0480#replica [implements]: one replica per process, for the default remote target when it has a login
 * @param {{ config: HypAwareV2Config | undefined, env: NodeJS.ProcessEnv, hypStateDir: string }} args
 *   `hypStateDir` is HypAware's state directory (where `remote-credentials.json` lives), not the plugin's
 * @returns {() => Promise<ReplicaTarget | null>}
 */
export function createDefaultTargetResolver({ config, env, hypStateDir }) {
  return async () => {
    const target = effectiveDefaultRemote(config)
    const remotes = effectiveRemotes(config)
    const entry = Object.hasOwn(remotes, target) ? remotes[target] : undefined
    if (!entry || typeof entry.url !== 'string') return null

    const fromEnv = env[remoteTokenEnvVar(target)]
    const creds = await readCredentials(hypStateDir)
    const record = Object.hasOwn(creds, target) ? creds[target] : undefined
    if (!record && !(typeof fromEnv === 'string' && fromEnv.length > 0)) return null

    const identityBase = deriveIdentityBase(entry.url) ?? undefined
    return {
      target,
      url: entry.url,
      org: record?.kind === 'oidc' && typeof record.org === 'string' && record.org ? record.org : null,
      token: (forceRefresh = false) => resolveAccessJwt({ target, env, stateDir: hypStateDir, identityBase, forceRefresh }),
    }
  }
}
