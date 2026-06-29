// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

/**
 * Query-scoped credential store for the human-CLI `--remote` path (LLP 0033
 * §credentials). The token is **never** config (secrets-never-in-config): it
 * lives in a single `0600` file, written atomically, mirroring `central`'s
 * `identity.json` single-file precedent.
 *
 * Stakes are low by scoping: what lands here is the **query-scoped** token
 * (read/compute tools only; cannot author configs or mint tokens), not the
 * all-powerful operator token (LLP 0033 §credential-stakes). AI clients that
 * install the endpoint directly hold their own token in their own MCP
 * config; this store is only for `hyp`'s client path.
 */

const CREDENTIALS_BASENAME = 'remote-credentials.json'

/**
 * @param {string} stateDir
 * @returns {string}
 */
export function remoteCredentialsPath(stateDir) {
  return path.join(stateDir, CREDENTIALS_BASENAME)
}

/**
 * Per-target env override variable, e.g. target `prod` → `HYP_REMOTE_TOKEN_PROD`.
 * A **per-target** var (not a single global) so a stored value can never
 * silently authenticate the wrong server (LLP 0033 §credentials).
 *
 * @param {string} target
 * @returns {string}
 */
export function remoteTokenEnvVar(target) {
  return `HYP_REMOTE_TOKEN_${target.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
}

/**
 * Read the credential map. Returns `{}` when the file is absent; throws on a
 * corrupt file so a silent empty map can't mask a broken store.
 *
 * @param {string} stateDir
 * @returns {Promise<Record<string, { token: string }>>}
 */
export async function readCredentials(stateDir) {
  let raw
  try {
    raw = await fs.readFile(remoteCredentialsPath(stateDir), 'utf8')
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return {}
    throw err
  }
  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`remote credentials file is not valid JSON: ${remoteCredentialsPath(stateDir)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`remote credentials file must be a JSON object: ${remoteCredentialsPath(stateDir)}`)
  }
  /** @type {Record<string, { token: string }>} */
  const out = {}
  for (const [target, entry] of Object.entries(/** @type {Record<string, unknown>} */ (parsed))) {
    if (entry && typeof entry === 'object' && typeof (/** @type {any} */ (entry).token) === 'string') {
      out[target] = { token: /** @type {any} */ (entry).token }
    }
  }
  return out
}

/**
 * Store (or replace) the token for a target. Atomic tmp+rename, mode `0600`.
 *
 * @param {string} stateDir
 * @param {string} target
 * @param {string} token
 * @returns {Promise<void>}
 */
export async function writeToken(stateDir, target, token) {
  await fs.mkdir(stateDir, { recursive: true })
  const current = await readCredentials(stateDir)
  current[target] = { token }
  await writeCredentials(stateDir, current)
}

/**
 * Remove a target's stored token. Returns whether one was present.
 *
 * @param {string} stateDir
 * @param {string} target
 * @returns {Promise<boolean>}
 */
export async function removeToken(stateDir, target) {
  const current = await readCredentials(stateDir)
  if (!Object.prototype.hasOwnProperty.call(current, target)) return false
  delete current[target]
  await writeCredentials(stateDir, current)
  return true
}

/**
 * Resolve a target's token at query time. Order: per-target env var
 * (CI/ephemeral) → stored file → error. An env override never falls through
 * to the file, so an ephemeral token always wins (LLP 0033 §credentials).
 *
 * @param {{ target: string, env: NodeJS.ProcessEnv, stateDir: string }} args
 * @returns {Promise<{ ok: true, token: string, source: 'env' | 'file' } | { ok: false, error: string }>}
 */
export async function resolveToken({ target, env, stateDir }) {
  const envName = remoteTokenEnvVar(target)
  const fromEnv = env[envName]
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return { ok: true, token: fromEnv, source: 'env' }
  }
  const creds = await readCredentials(stateDir)
  const entry = creds[target]
  if (entry && entry.token.length > 0) {
    return { ok: true, token: entry.token, source: 'file' }
  }
  return {
    ok: false,
    error: `no token for '${target}' - run 'hyp remote login ${target}' (or set ${envName})`,
  }
}

/**
 * @param {string} stateDir
 * @param {Record<string, { token: string }>} map
 * @returns {Promise<void>}
 */
async function writeCredentials(stateDir, map) {
  await fs.mkdir(stateDir, { recursive: true })
  const finalPath = remoteCredentialsPath(stateDir)
  const tmpPath = `${finalPath}.tmp-${process.pid}`
  await fs.writeFile(tmpPath, JSON.stringify(map, null, 2) + '\n', { mode: 0o600 })
  // Rename is atomic on the same filesystem; the 0600 mode carries over.
  await fs.rename(tmpPath, finalPath)
  // Re-assert the mode in case the file pre-existed with looser perms.
  await fs.chmod(finalPath, 0o600).catch(() => {})
}
