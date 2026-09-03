// @ts-check

import { createGithubClient } from './github_client.js'

/**
 * Module-local runtime singleton (same pattern as context-graph-enrich and
 * gascity): `activate()` captures the resolved config + handles, and the daemon
 * source / commands retrieve it. Keeps the source `start` and command `run`
 * functions free of constructor plumbing.
 *
 * @import { GithubClient, GithubRuntime } from './types.js'
 */

/** @type {GithubRuntime | null} */
let runtime = null

/** @param {GithubRuntime} value */
export function setGithubRuntime(value) {
  runtime = value
}

/** @returns {GithubRuntime} */
export function requireGithubRuntime() {
  if (!runtime) {
    throw new Error('@hypaware/github: not activated yet - runtime singleton is empty')
  }
  return runtime
}

/**
 * Build a GitHub client for the current config. Authentication is resolved by
 * the client from the configured environment or the local GitHub CLI store.
 *
 * @param {GithubRuntime} rt
 * @returns {GithubClient}
 */
export function getClient(rt) {
  if (rt.clientFactory) return rt.clientFactory()
  return createGithubClient({ tokenEnv: rt.config.token_env, env: rt.env, log: rt.log })
}
