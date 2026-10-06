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
 * `url` does not parse or has no origin.
 *
 * @param {string} url
 * @returns {string | null}
 */
export function canonicalOrigin(url) {
  const origin = originOf(url)
  return origin === null ? null : BUILTIN_ORIGIN_ALIASES[origin] ?? origin
}

/**
 * How a sync destination is named on screen: "HypAware Cloud" for the
 * built-in default server (through the alias table, so an enrollment under
 * its old host reads the same), otherwise the server's host. Never a URL:
 * a printed `https://` run autolinks to a service endpoint (#391), and a
 * bare host does not.
 *
 * @ref LLP 0437#server-name [implements]: the hosted default reads as HypAware Cloud, any other server by its host
 * @param {string} url
 * @returns {string}
 */
export function serverDisplayName(url) {
  const builtin = BUILTIN_REMOTES[BUILTIN_DEFAULT_REMOTE]?.url
  if (builtin && sameServer(url, builtin)) return 'HypAware Cloud'
  const origin = canonicalOrigin(url)
  return origin === null ? url : new URL(origin).host
}

/**
 * The name a destination surface gives the place this machine's rows go,
 * resolved from the central sink origins it forwards to. Self-hosted
 * enrollment is a supported lane, so the destination is not the hosted
 * product's name by default: {@link serverDisplayName} is the one place that
 * mapping lives, and it calls only the built-in server (under either of its
 * hosts) HypAware Cloud.
 *
 * Every configured origin receives the rows, so when there are several they
 * are all named, deduplicated and in configuration order: naming the first
 * alone would understate the disclosure. An origin that does not parse is
 * skipped, because `serverDisplayName` returns such a string unchanged and
 * would put whatever is on disk into user-facing copy.
 *
 * The neutral fallback is what keeps a caller with nothing nameable from
 * rendering "forwarded to ." or a hosted service it may not be using, and it
 * is one spelling, so every surface that resolves a destination says the same
 * thing about a machine whose layer names nothing.
 *
 * @ref LLP 0134#custom-url-deferred [constrained-by]: self-hosted teams enroll by hand, so destination copy cannot assume the hosted server
 * @param {ReadonlyArray<string>} [origins] central sink origins for this machine
 * @returns {string}
 */
export function syncDestinationName(origins) {
  /** @type {string[]} */
  const names = []
  for (const origin of origins ?? []) {
    if (typeof origin !== 'string' || originOf(origin) === null) continue
    const name = serverDisplayName(origin)
    if (!names.includes(name)) names.push(name)
  }
  return names.length > 0 ? names.join(' and ') : 'your HypAware server'
}

/**
 * The origin of a URL, or null when it does not parse or has no origin to
 * compare (an opaque origin such as `file:` serializes as the string 'null',
 * which would otherwise read as a match between any two such URLs).
 *
 * @param {string} url
 * @returns {string | null}
 */
export function originOf(url) {
  try {
    const origin = new URL(url).origin
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}

/**
 * True when both URLs reach the same server: equal origins, or origins the
 * alias table folds together. Two URLs without an origin are never the same server.
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
