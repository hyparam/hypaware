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
  hyperparam: { url: 'https://hypaware.hyperparam.app' },
}

/**
 * Name of the shipped default target, used by bare `--remote` (and bare
 * `hyp remote login`) when the local config sets no `query.default_remote`.
 */
export const BUILTIN_DEFAULT_REMOTE = 'hyperparam'

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
