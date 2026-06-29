// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { refreshSession } from './identity_client.js'

/**
 * @import { RemoteCredentialRecord, RemoteOidcRecord } from '../../../src/core/remote/types.js'
 */

/**
 * Query-scoped credential store for the human-CLI `--remote` path (LLP 0033
 * §credentials). The token is **never** config (secrets-never-in-config): it
 * lives in a single `0600` file, written atomically, mirroring `central`'s
 * `identity.json` single-file precedent.
 *
 * Each per-target record is discriminated by `kind` (LLP 0046 D4): a
 * `static` record is the LLP 0033 `{ token }`; an `oidc` record carries the
 * refresh token + cached access JWT of a browser-login session. Migration is
 * read-implicit: a legacy record with a `token` and no `kind` reads as
 * `static`, so existing files keep working without a rewrite. One file, one
 * resolve path, one remove path.
 *
 * Stakes are low by scoping: what lands here is the **query-scoped** token
 * (read/compute tools only; cannot author configs or mint tokens), not the
 * all-powerful operator token (LLP 0033 §credential-stakes).
 */

const CREDENTIALS_BASENAME = 'remote-credentials.json'

/** Refresh an `oidc` access JWT once it is within this window of expiry. */
const REFRESH_SKEW_MS = 60 * 1000

/**
 * Derive the identity base `<origin>/v1/identity` from a target's MCP URL
 * (LLP 0046 D6): identity is mounted at the same origin, so no second URL is
 * configured. Returns `null` for an unparseable URL. Shared by the login
 * command and the attach path.
 *
 * @param {string} url
 * @returns {string | null}
 * @ref LLP 0046#d6 [implements]: identity endpoints derive from the configured remote URL origin
 */
export function deriveIdentityBase(url) {
  try {
    return `${new URL(url).origin}/v1/identity`
  } catch {
    return null
  }
}

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
 * Read the credential map, normalizing each record to a discriminated
 * {@link RemoteCredentialRecord}. Returns `{}` when the file is absent; throws
 * on a corrupt file so a silent empty map can't mask a broken store. A legacy
 * `token`-only record is read as `kind: 'static'` (read-implicit migration,
 * LLP 0046 D4).
 *
 * @param {string} stateDir
 * @returns {Promise<Record<string, RemoteCredentialRecord>>}
 * @ref LLP 0046#d4 [implements]: discriminated kind record; legacy token-only reads as static
 * @ref LLP 0033#credentials [constrained-by]: single 0600 per-target store, secrets never in config
 */
export async function readCredentials(stateDir) {
  const parsed = await readRawCredentials(stateDir)
  /** @type {Record<string, RemoteCredentialRecord>} */
  const out = {}
  for (const [target, entry] of Object.entries(parsed)) {
    const record = normalizeRecord(entry)
    if (record) out[target] = record
  }
  return out
}

/**
 * Read the credential file as its raw per-target object, **without** dropping
 * records that don't normalize. The write path uses this so an unrelated login
 * or remove rewrites the store without deleting a sibling record it could not
 * interpret (a hand-edited entry, or one written by a newer version). Returns
 * `{}` when the file is absent; throws on a corrupt file, same as
 * {@link readCredentials}.
 *
 * @param {string} stateDir
 * @returns {Promise<Record<string, unknown>>}
 */
async function readRawCredentials(stateDir) {
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
  return /** @type {Record<string, unknown>} */ (parsed)
}

/**
 * Normalize a stored entry into a discriminated record, or `null` if it is
 * neither a usable static nor oidc record.
 *
 * @param {unknown} entry
 * @returns {RemoteCredentialRecord | null}
 */
function normalizeRecord(entry) {
  if (!entry || typeof entry !== 'object') return null
  const e = /** @type {Record<string, any>} */ (entry)
  // A complete oidc record (explicit kind, or an inferable refresh+access pair).
  if (e.kind === 'oidc' || (e.kind === undefined && typeof e.refreshToken === 'string')) {
    if (typeof e.refreshToken === 'string' && typeof e.accessJwt === 'string') {
      return {
        kind: 'oidc',
        refreshToken: e.refreshToken,
        accessJwt: e.accessJwt,
        expiresAt: typeof e.expiresAt === 'string' ? e.expiresAt : '',
        org: typeof e.org === 'string' ? e.org : '',
      }
    }
    // Incomplete oidc shape: fall through so a usable static `token` on the
    // same (corrupt/hand-edited) record is not silently dropped.
  }
  // Legacy / static: a bare token with no (or static) kind.
  if (typeof e.token === 'string') {
    return { kind: 'static', token: e.token }
  }
  return null
}

/**
 * Store (or replace) a static query-scoped token for a target, stamped
 * `kind: 'static'`. Atomic tmp+rename, mode `0600`.
 *
 * @param {string} stateDir
 * @param {string} target
 * @param {string} token
 * @returns {Promise<void>}
 */
export async function writeToken(stateDir, target, token) {
  await fs.mkdir(stateDir, { recursive: true })
  const current = await readRawCredentials(stateDir)
  current[target] = { kind: 'static', token }
  await writeCredentials(stateDir, current)
}

/**
 * Store (or replace) an OIDC session for a target, stamped `kind: 'oidc'`.
 * Same atomic 0600 path as {@link writeToken} (LLP 0046 D4).
 *
 * @param {string} stateDir
 * @param {string} target
 * @param {{ refreshToken: string, accessJwt: string, expiresAt: string, org: string }} session
 * @returns {Promise<void>}
 * @ref LLP 0046#d4 [implements]: oidc session written through the same atomic 0600 store as static tokens
 */
export async function writeSession(stateDir, target, session) {
  await fs.mkdir(stateDir, { recursive: true })
  const current = await readRawCredentials(stateDir)
  current[target] = {
    kind: 'oidc',
    refreshToken: session.refreshToken,
    accessJwt: session.accessJwt,
    expiresAt: session.expiresAt,
    org: session.org,
  }
  await writeCredentials(stateDir, current)
}

/**
 * Remove a target's stored record (either kind). Returns whether one was
 * present.
 *
 * @param {string} stateDir
 * @param {string} target
 * @returns {Promise<boolean>}
 */
export async function removeToken(stateDir, target) {
  // Operate on the raw file so a record we can't normalize is still removable,
  // and so removing one target never drops an unrelated sibling.
  const current = await readRawCredentials(stateDir)
  if (!Object.prototype.hasOwnProperty.call(current, target)) return false
  delete current[target]
  await writeCredentials(stateDir, current)
  return true
}

/**
 * Resolve a target's bearer token at query time, **without** session-aware
 * refresh. Order: per-target env var (CI/ephemeral) → stored file → error. An
 * env override never falls through to the file (LLP 0033 §credentials). For an
 * `oidc` record this returns the cached access JWT as-is. Both the query attach
 * path and the stdio proxy now use {@link resolveAccessJwt} for session-aware
 * refresh; this lower-level reader is kept for any non-refreshing caller.
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
  const token = entry ? bearerOf(entry) : ''
  if (token.length > 0) {
    return { ok: true, token, source: 'file' }
  }
  return { ok: false, error: noTokenError(target, envName) }
}

/**
 * Session-aware resolver for the query attach path (LLP 0046 D5). The
 * per-target env override still wins. A `static` record returns its token. An
 * `oidc` record returns a fresh access JWT, calling `refreshSession` and
 * persisting the new JWT/expiry when the stored one is within a skew window of
 * expiry; a non-stale JWT is returned untouched. A refresh failure (including
 * a typed `invalid_grant`) propagates to the caller.
 *
 * @param {{
 *   target: string,
 *   env: NodeJS.ProcessEnv,
 *   stateDir: string,
 *   identityBase?: string,
 *   now?: number,
 *   fetchImpl?: typeof fetch,
 *   forceRefresh?: boolean,
 * }} args
 * @returns {Promise<{ ok: true, token: string, source: 'env' | 'file', kind?: 'static' | 'oidc' } | { ok: false, error: string }>}
 * @ref LLP 0046#d5 [implements]: silent refresh on the attach path; env override still wins
 */
export async function resolveAccessJwt({ target, env, stateDir, identityBase, now = Date.now(), fetchImpl, forceRefresh = false }) {
  const envName = remoteTokenEnvVar(target)
  const fromEnv = env[envName]
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return { ok: true, token: fromEnv, source: 'env', kind: 'static' }
  }

  const creds = await readCredentials(stateDir)
  const entry = creds[target]
  if (!entry) {
    return { ok: false, error: noTokenError(target, envName) }
  }
  if (entry.kind === 'static') {
    return entry.token.length > 0
      ? { ok: true, token: entry.token, source: 'file', kind: 'static' }
      : { ok: false, error: noTokenError(target, envName) }
  }

  // oidc: refresh if forced (a live 401 retry), or the cached JWT is missing,
  // unparseable, or near expiry.
  if (forceRefresh || !isFresh(entry, now)) {
    if (!identityBase) {
      return { ok: false, error: `cannot refresh '${target}': no identity endpoint resolved` }
    }
    const refreshed = await refreshSession({ identityBase, refreshToken: entry.refreshToken, fetchImpl })
    /** @type {RemoteOidcRecord} */
    // `org` is fixed for the refresh token's life; keep the stored one when the
    // refresh response omits it (refreshSession returns '' in that case). A
    // rotated refresh token (one-time-use servers) replaces the stored one;
    // otherwise keep it, so the next refresh sends a live token rather than a
    // consumed one that would 401 and force a re-login every session.
    const next = {
      ...entry,
      accessJwt: refreshed.accessJwt,
      expiresAt: refreshed.expiresAt,
      org: refreshed.org || entry.org,
      refreshToken: refreshed.refreshToken || entry.refreshToken,
    }
    await writeSession(stateDir, target, next)
    return { ok: true, token: refreshed.accessJwt, source: 'file', kind: 'oidc' }
  }
  return { ok: true, token: entry.accessJwt, source: 'file', kind: 'oidc' }
}

/**
 * Whether a resolved credential can be silently refreshed: an `oidc` record
 * read from the file. A per-target env override and a `static` token cannot be
 * refreshed. The attach paths call this instead of each re-deriving the
 * kind+source rule, so "what is refreshable" has one owner (LLP 0046 D5).
 *
 * @param {{ source?: 'env' | 'file', kind?: 'static' | 'oidc' }} resolved a successful resolveAccessJwt result
 * @returns {boolean}
 */
export function isRefreshable(resolved) {
  return resolved.kind === 'oidc' && resolved.source === 'file'
}

/**
 * Whether an `oidc` record's cached JWT is still safely usable: present and
 * more than the skew window from its parseable expiry.
 *
 * @param {RemoteOidcRecord} record
 * @param {number} now
 * @returns {boolean}
 */
function isFresh(record, now) {
  if (!record.accessJwt) return false
  const expiry = Date.parse(record.expiresAt)
  if (Number.isNaN(expiry)) return false
  return expiry - now > REFRESH_SKEW_MS
}

/**
 * The bearer token a record presents as-is (no refresh): the static token, or
 * the oidc cached access JWT.
 *
 * @param {RemoteCredentialRecord} record
 * @returns {string}
 */
function bearerOf(record) {
  return record.kind === 'oidc' ? record.accessJwt : record.token
}

/**
 * @param {string} target
 * @param {string} envName
 * @returns {string}
 */
function noTokenError(target, envName) {
  return `no token for '${target}' - run 'hyp remote login ${target}' (or set ${envName})`
}

/**
 * @param {string} stateDir
 * @param {Record<string, unknown>} map
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
