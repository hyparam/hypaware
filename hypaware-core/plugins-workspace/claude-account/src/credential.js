// @ts-check

import { resolveMode } from './config.js'
import { OAUTH_BETA_HEADER, refreshSubscriptionToken } from './oauth.js'
import {
  credentialFilePath,
  readStoredCredential,
  withCredentialLock,
  writeStoredCredential,
} from './store.js'

/**
 * @import { HelperCredential, SubscriptionOauthRecord } from './types.js'
 */

/** Refresh when this close to expiry (seconds). */
export const REFRESH_WINDOW_SECONDS = 5 * 60

/** Advertised cache ttl for a static org key (seconds). */
const ORG_KEY_TTL_SECONDS = 60 * 60

const MIN_TTL_SECONDS = 60
const MAX_TTL_SECONDS = 60 * 60

/**
 * Resolve the credential the helper prints, per fleet policy.
 *
 * @ref LLP 0116#helper-contract [implements]: the helper surface returns { token, headers, ttlSec }; Desktop merges headers over static config
 * @param {{
 *   config: Record<string, unknown> | undefined,
 *   env: NodeJS.ProcessEnv,
 *   stateDir: string,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 * }} opts
 * @returns {Promise<HelperCredential>}
 */
export async function resolveCredential(opts) {
  const mode = resolveMode(opts.config)
  if (mode === 'org_key') return orgKeyCredential(opts.config, opts.env)
  return subscriptionCredential(opts)
}

/**
 * @param {Record<string, unknown> | undefined} config
 * @param {NodeJS.ProcessEnv} env
 * @returns {HelperCredential}
 */
export function orgKeyCredential(config, env) {
  const direct = config?.api_key
  if (typeof direct === 'string' && direct.length > 0) {
    return { token: direct, headers: {}, ttlSec: ORG_KEY_TTL_SECONDS }
  }
  const envName = config?.api_key_env
  if (typeof envName === 'string' && envName.length > 0) {
    const fromEnv = env[envName]
    if (typeof fromEnv !== 'string' || fromEnv.length === 0) {
      throw new Error(`org_key mode: environment variable ${envName} is not set`)
    }
    return { token: fromEnv, headers: {}, ttlSec: ORG_KEY_TTL_SECONDS }
  }
  throw new Error('org_key mode requires claude_account.api_key or api_key_env')
}

/**
 * Subscription mode: read the stored sign-in, refresh inside the
 * expiry window, and present the bearer token with the OAuth beta
 * header. Runs under the store lock because a refresh rotates the
 * refresh token upstream.
 *
 * @param {{
 *   stateDir: string,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 * }} opts
 * @returns {Promise<HelperCredential>}
 */
export async function subscriptionCredential(opts) {
  const now = opts.now ?? Date.now
  const filePath = credentialFilePath(opts.stateDir)
  return withCredentialLock(filePath, async () => {
    let record = readStoredCredential(filePath)
    if (!record) {
      throw new Error("not signed in: run 'hyp claude-account login' first")
    }
    const nowSec = Math.floor(now() / 1000)
    if (record.expires_at - nowSec <= REFRESH_WINDOW_SECONDS) {
      record = await refreshSubscriptionToken({
        refreshToken: record.refresh_token,
        fetchImpl: opts.fetchImpl,
        now,
      })
      writeStoredCredential(filePath, record)
    }
    return {
      token: record.access_token,
      headers: { 'anthropic-beta': OAUTH_BETA_HEADER },
      ttlSec: helperTtlSeconds(record, nowSec),
    }
  })
}

/**
 * Advertise a ttl that expires comfortably before the token does, so
 * Desktop's silent refresh re-runs the helper while a refresh can
 * still succeed against a live token.
 *
 * @param {SubscriptionOauthRecord} record
 * @param {number} nowSec
 * @returns {number}
 */
function helperTtlSeconds(record, nowSec) {
  const remaining = record.expires_at - nowSec - REFRESH_WINDOW_SECONDS
  return Math.max(MIN_TTL_SECONDS, Math.min(MAX_TTL_SECONDS, remaining))
}
