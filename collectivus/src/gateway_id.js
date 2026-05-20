import os from 'node:os'

/**
 * Defense-in-depth pattern for any value that will become a `gateway_id` and
 * eventually be joined into a filesystem path. The alphabet permits the
 * punctuation found in real-world email addresses (`.`, `_`, `-`, `+`, and
 * the at-sign) so operators can use `firstname.last(at)acme.com` shapes,
 * while still excluding `/`, `\`, shell metacharacters, and the leading-dot
 * case that would create hidden files on the filesystem.
 *
 * Mirrors the regex enforced server-side in `src/server/ingest.js`.
 */
export const GATEWAY_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._+@-]*$/
export const GATEWAY_ID_MAX_LENGTH = 128

/** Used when the OS-username fallback fails or yields an unsafe value. */
const FALLBACK_GATEWAY_ID = '_unknown'

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidGatewayId(value) {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > GATEWAY_ID_MAX_LENGTH) return false
  return GATEWAY_ID_PATTERN.test(value)
}

/**
 * Resolve the gateway_id to use for filesystem partitioning in standalone
 * mode. Tries the configured value first, then the OS username, then a
 * hardcoded `_unknown` so we never crash on an unusual host environment.
 *
 * @param {string | undefined} configured
 * @returns {string}
 */
export function resolveStandaloneGatewayId(configured) {
  if (configured !== undefined) {
    if (!isValidGatewayId(configured)) {
      throw new Error(`invalid gateway_id ${JSON.stringify(configured)}: must match ${GATEWAY_ID_PATTERN}`)
    }
    return configured
  }
  let username
  try {
    username = os.userInfo().username
  } catch {
    return FALLBACK_GATEWAY_ID
  }
  if (isValidGatewayId(username)) return username
  return FALLBACK_GATEWAY_ID
}
