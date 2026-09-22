// @ts-check

/**
 * @import { HypAwareV2Config, QueryRemoteTarget } from '../../../hypaware-plugin-kernel-types.js'
 */

/**
 * Targets shipped preconfigured with the client, so an operator can attach to
 * the Hyperparam-hosted central server with just `hyp remote login` +
 * `hyp <verb> --remote`, no `hyp remote add` first. A user's own
 * `query.remotes` entry of the same name wins (see effectiveRemotes), so this
 * is a default, not a lock. The URL is non-secret and committable, exactly as
 * a `hyp remote add` URL is (LLP 0033 Targets).
 *
 * @ref LLP 0062#builtin [implements]: a built-in target the client ships, layered under user query.remotes, so the central server needs no local `remote add`
 * @type {Record<string, QueryRemoteTarget>}
 */
export const BUILTIN_REMOTES = {
  hyperparam: { url: 'https://api.hypaware.ai' },
}

/**
 * Name of the shipped default target, used by bare `--remote` (and bare
 * `hyp remote login`) when the local config sets no `query.default_remote`.
 */
export const BUILTIN_DEFAULT_REMOTE = 'hyperparam'

/**
 * Hosts a built-in target answered on before it moved, keyed by the old origin.
 * An install that enrolled or logged in under one of these is connected to
 * that built-in's server, not to a second server, so every "same server"
 * comparison (the login gate, the seed match, purge dedup, sync naming) reads
 * origins through this table. The server still answers on each alias, so a
 * sink or credential saved under the old host keeps working as it is.
 *
 * @type {Record<string, string>}
 */
export const BUILTIN_ORIGIN_ALIASES = {
  'https://hypaware.hyperparam.app': 'https://api.hypaware.ai',
}

/**
 * The origin of `url`, read through {@link BUILTIN_ORIGIN_ALIASES}; null when
 * `url` does not parse.
 *
 * @param {string} url
 * @returns {string | null}
 */
export function canonicalOrigin(url) {
  /** @type {string} */
  let origin
  try {
    origin = new URL(url).origin
  } catch {
    return null
  }
  return BUILTIN_ORIGIN_ALIASES[origin] ?? origin
}

/**
 * True when both URLs reach the same server: equal origins, or origins the
 * alias table folds together. Two unparseable URLs are never the same server.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameServer(a, b) {
  const origin = canonicalOrigin(a)
  return origin !== null && origin === canonicalOrigin(b)
}

/**
 * The effective target registry: shipped built-ins with the user's
 * `query.remotes` layered on top, so a user entry of the same name repoints
 * (or shadows) a built-in.
 *
 * @param {HypAwareV2Config | undefined} config
 * @returns {Record<string, QueryRemoteTarget>}
 */
export function effectiveRemotes(config) {
  return { ...BUILTIN_REMOTES, ...(config?.query?.remotes ?? {}) }
}

/**
 * The effective default target name: an explicit `query.default_remote` wins,
 * otherwise the shipped built-in. Never empty, so bare `--remote` always
 * resolves to a target.
 *
 * @param {HypAwareV2Config | undefined} config
 * @returns {string}
 */
export function effectiveDefaultRemote(config) {
  const configured = config?.query?.default_remote
  return typeof configured === 'string' && configured ? configured : BUILTIN_DEFAULT_REMOTE
}
