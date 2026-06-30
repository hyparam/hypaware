// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { InvalidGrantError, refreshSession, sessionExpiredMessage } from './identity_client.js'

/**
 * @import { Stats } from 'node:fs'
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

/** Max time to wait for the cross-process write lock before giving up. */
const LOCK_TIMEOUT_MS = 5 * 1000

/** A lock file older than this is treated as abandoned by a crashed holder. */
const LOCK_STALE_MS = 30 * 1000

/**
 * Bound on the optimistic refresh compare-and-swap loop. Each extra attempt
 * means a sibling rotated the refresh token between our refresh and our commit;
 * a handful of rounds is far more than any real contention reaches.
 */
const REFRESH_MAX_ATTEMPTS = 4

/**
 * Single-entry parse cache for the credential file. The stdio proxy resolves a
 * token per forwarded message, so without this every message re-read and
 * re-parsed the 0600 file. Keyed by path + mtime + size and busted on every
 * write through this module, so a fresh-JWT message skips disk and parse while
 * any real change (our own write, or an external edit) is still picked up.
 *
 * @type {{ path: string, mtimeMs: number, size: number, value: Record<string, unknown> } | null}
 */
let rawCache = null

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
 * The read path (it builds a fresh normalized map and never mutates the parsed
 * object) takes the cached value directly; only a `mutable` caller that edits
 * the map in place before writing it back gets a defensive clone, so the
 * per-message proxy resolve doesn't deep-clone the whole store on every hit.
 *
 * @param {string} stateDir
 * @param {{ mutable?: boolean }} [opts]
 * @returns {Promise<Record<string, unknown>>}
 */
async function readRawCredentials(stateDir, { mutable = false } = {}) {
  const p = remoteCredentialsPath(stateDir)
  /** @type {Stats} */
  let stat
  try {
    stat = await fs.stat(p)
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return {}
    throw err
  }
  // Cache hit: same file, unchanged since the last parse.
  if (rawCache && rawCache.path === p && rawCache.mtimeMs === stat.mtimeMs && rawCache.size === stat.size) {
    return mutable ? structuredClone(rawCache.value) : rawCache.value
  }
  let raw
  try {
    raw = await fs.readFile(p, 'utf8')
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return {}
    throw err
  }
  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`remote credentials file is not valid JSON: ${p}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`remote credentials file must be a JSON object: ${p}`)
  }
  const value = /** @type {Record<string, unknown>} */ (parsed)
  rawCache = { path: p, mtimeMs: stat.mtimeMs, size: stat.size, value }
  return mutable ? structuredClone(value) : value
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
  /** @param {string} accessJwt @returns {RemoteOidcRecord} */
  const oidc = (accessJwt) => ({
    kind: 'oidc',
    refreshToken: e.refreshToken,
    accessJwt,
    expiresAt: typeof e.expiresAt === 'string' ? e.expiresAt : '',
    org: typeof e.org === 'string' ? e.org : '',
  })
  if (e.kind === 'oidc') {
    // Explicit oidc: the refresh token is what makes the record usable - the
    // cached access JWT is derivable from it. So keep a record whose `accessJwt`
    // is missing or empty (a partial write, an interrupted refresh, a hand edit)
    // rather than dropping it; resolveAccessJwt mints a fresh JWT from the
    // refresh token, where dropping it would force a needless full re-login.
    if (typeof e.refreshToken === 'string' && e.refreshToken.length > 0) {
      return oidc(typeof e.accessJwt === 'string' ? e.accessJwt : '')
    }
    // No usable refresh token: fall through to the static `token` check.
  } else if (e.kind === undefined && typeof e.refreshToken === 'string' && e.refreshToken.length > 0 && typeof e.accessJwt === 'string') {
    // Inferred oidc (legacy file with no explicit kind): require the full
    // refresh + access pair before reading an unkinded record as oidc, so a
    // record that also carries a static `token` is not hijacked away from it.
    return oidc(e.accessJwt)
  }
  // Legacy / static: a bare token with no (or static) kind. An empty token is
  // no credential at all - resolveToken/resolveAccessJwt both reject it - so
  // drop it here too, otherwise `remote list` would report a present-but-unusable
  // record as `stored` while every query says the target is logged out.
  if (typeof e.token === 'string' && e.token.length > 0) {
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
  await withCredentialsLock(stateDir, async () => {
    const current = await readRawCredentials(stateDir, { mutable: true })
    current[target] = { kind: 'static', token }
    await writeCredentials(stateDir, current)
  })
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
  await withCredentialsLock(stateDir, () => commitSession(stateDir, target, session))
}

/**
 * Persist an oidc session WITHOUT taking the write lock: the caller must already
 * hold it. {@link writeSession} is the locked public entry point; the refresh
 * compare-and-swap in {@link refreshOidcSession} re-reads and writes inside one
 * lock acquisition and uses this directly to keep that read-modify-write atomic.
 *
 * @param {string} stateDir
 * @param {string} target
 * @param {{ refreshToken: string, accessJwt: string, expiresAt: string, org: string }} session
 * @returns {Promise<void>}
 */
async function commitSession(stateDir, target, session) {
  const current = await readRawCredentials(stateDir, { mutable: true })
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
  return withCredentialsLock(stateDir, async () => {
    const current = await readRawCredentials(stateDir, { mutable: true })
    if (!Object.prototype.hasOwnProperty.call(current, target)) return false
    delete current[target]
    await writeCredentials(stateDir, current)
    return true
  })
}

/**
 * Resolve a target's bearer token at query time, **without** session-aware
 * refresh. Order: per-target env var (CI/ephemeral) → stored file → error. An
 * env override never falls through to the file (LLP 0033 §credentials).
 *
 * This is a **presence** check, not a working-token guarantee: an `oidc` record
 * reports `ok` whenever it can yield a token, which includes a refreshable
 * record whose cached JWT is empty or stale (the returned `token` is then that
 * cached value, possibly `''`). A caller that needs a usable bearer must go
 * through {@link resolveAccessJwt}, which refreshes; this lower-level reader
 * exists for the stdio proxy's fail-fast probe, which only asks "is there a
 * credential here at all" and must not refuse a session it could refresh.
 *
 * @param {{ target: string, env: NodeJS.ProcessEnv, stateDir: string }} args
 * @returns {Promise<{ ok: true, token: string, source: 'env' | 'file' } | { ok: false, error: string }>}
 */
export async function resolveToken({ target, env, stateDir }) {
  const envName = remoteTokenEnvVar(target)
  const fromEnv = envOverride(env, target)
  if (fromEnv !== undefined) {
    return { ok: true, token: fromEnv, source: 'env' }
  }
  const creds = await readCredentials(stateDir)
  const entry = creds[target]
  if (entry) {
    const token = bearerOf(entry)
    // A non-empty cached bearer is usable as-is; an oidc record is also present
    // when only its refresh token survives (normalizeRecord guarantees a
    // non-empty refreshToken), since resolveAccessJwt can mint a fresh JWT.
    if (token.length > 0 || entry.kind === 'oidc') {
      return { ok: true, token, source: 'file' }
    }
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
  const fromEnv = envOverride(env, target)
  if (fromEnv !== undefined) {
    return { ok: true, token: fromEnv, source: 'env', kind: 'static' }
  }

  // A forced refresh is the live-401 retry: drop the parse cache so the read
  // below sees the freshest refresh token a sibling may have just rotated in.
  if (forceRefresh) rawCache = null
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

  // oidc: a fresh cached JWT needs neither a network call nor the lock.
  if (!forceRefresh && isFresh(entry, now)) {
    return { ok: true, token: entry.accessJwt, source: 'file', kind: 'oidc' }
  }
  if (!identityBase) {
    return { ok: false, error: `cannot refresh '${target}': no identity endpoint resolved` }
  }
  return refreshOidcSession({ target, stateDir, identityBase, fetchImpl, now, from: entry, envName })
}

/**
 * Refresh an oidc session with an optimistic compare-and-swap commit, so two
 * `hyp` processes sharing this 0600 store (a verb call beside a proxy, two MCP
 * clients) never double-spend a one-time-use refresh row or clobber a session a
 * sibling just rotated.
 *
 * The network refresh runs OUTSIDE the write lock: a 30s identity call must not
 * wedge the 5s lock that static-token writes also contend for. Only the commit
 * takes the lock, and persists our result solely when the stored refresh token
 * still matches the one we refreshed from. A mismatch means a sibling rotated
 * first (a parallel proxy refresh, or a concurrent `hyp remote login`); we adopt
 * the stored session when it is usable, or loop and refresh again with the
 * rotated token, rather than overwriting it. On `invalid_grant` we re-read under
 * the lock - which blocks until any in-flight sibling commit lands, closing the
 * window where a loser refreshed before the winner persisted - and adopt a
 * changed token; an unchanged token is a genuine revocation and re-throws.
 *
 * @param {{
 *   target: string,
 *   stateDir: string,
 *   identityBase: string,
 *   fetchImpl?: typeof fetch,
 *   now: number,
 *   from: RemoteOidcRecord,
 *   envName: string,
 * }} args
 * @returns {Promise<{ ok: true, token: string, source: 'file', kind: 'oidc' } | { ok: false, error: string }>}
 * @ref LLP 0046#d5 [implements]: serialized refresh commit - no double-spend or clobber across concurrent hyp processes
 */
async function refreshOidcSession({ target, stateDir, identityBase, fetchImpl, now, from, envName }) {
  for (let attempt = 0; attempt < REFRESH_MAX_ATTEMPTS; attempt++) {
    let refreshed
    try {
      refreshed = await refreshSession({ identityBase, refreshToken: from.refreshToken, fetchImpl })
    } catch (err) {
      if (!(err instanceof InvalidGrantError)) throw err
      // Our refresh row was consumed. Re-read under the lock so a sibling's
      // winning commit is guaranteed visible (it holds the lock across its
      // write). A changed-and-fresh token is an adoptable rotation; a changed
      // stale token means loop and refresh with it; an unchanged token is a
      // genuine revocation - re-throw.
      const latest = await withCredentialsLock(stateDir, () => readOidcRecord(stateDir, target))
      if (!latest || latest.refreshToken === from.refreshToken) throw err
      if (isFresh(latest, now)) {
        return { ok: true, token: latest.accessJwt, source: 'file', kind: 'oidc' }
      }
      from = latest
      continue
    }
    const outcome = await withCredentialsLock(stateDir, async () => {
      const latest = await readOidcRecord(stateDir, target)
      if (!latest) {
        // `hyp remote remove` deleted the session while our refresh was in
        // flight. Honor the deletion under the lock instead of writing the
        // stale row back and resurrecting removed credentials.
        return { removed: true }
      }
      if (latest.refreshToken !== from.refreshToken) {
        // A sibling rotated the one-time-use session under us while our refresh
        // was in flight. Adopt a usable stored session; otherwise loop and
        // refresh with the rotated token rather than clobber it.
        if (isFresh(latest, now)) return { token: latest.accessJwt }
        return { retryFrom: latest }
      }
      // No rotation: our result is authoritative. A rotated refresh token (from
      // a one-time-use server) replaces the consumed one, otherwise the stored
      // token is kept; `org` is fixed for the token's life, so an omitted one
      // keeps the stored value.
      await commitSession(stateDir, target, {
        refreshToken: refreshed.refreshToken || latest.refreshToken,
        accessJwt: refreshed.accessJwt,
        expiresAt: refreshed.expiresAt,
        org: refreshed.org || latest.org,
      })
      return { token: refreshed.accessJwt }
    })
    if (outcome.removed) return { ok: false, error: noTokenError(target, envName) }
    if (outcome.token !== undefined) {
      return { ok: true, token: outcome.token, source: 'file', kind: 'oidc' }
    }
    from = /** @type {RemoteOidcRecord} */ (outcome.retryFrom)
  }
  // The stored session kept rotating under us past the attempt bound; treat it
  // as unresolvable rather than spin forever.
  return { ok: false, error: noTokenError(target, envName) }
}

/**
 * Read a target's normalized record inside a held lock, returning it only when
 * it is an oidc session (a static record or absent target yields null). The
 * caller's lock acquisition dropped the parse cache, so this reads from disk.
 *
 * @param {string} stateDir
 * @param {string} target
 * @returns {Promise<RemoteOidcRecord | null>}
 */
async function readOidcRecord(stateDir, target) {
  const rec = (await readCredentials(stateDir))[target]
  return rec && rec.kind === 'oidc' ? rec : null
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
 * The one-shot refresh + retry policy both attach paths share (LLP 0046 D5):
 * run `op(token)` with the already-resolved token; if `op` reports an auth
 * failure on a refreshable (oidc/file) credential, force one refresh and run
 * `op` once more. Env overrides and static tokens cannot refresh, so their auth
 * failure is returned as-is. The two callers differ only in how `op` detects an
 * auth failure (a thrown 401 for the verb path, an HTTP 401 response for the
 * stdio proxy) and how they format the outcome; the retry decision lives here.
 *
 * `op` returns `{ authFailed, value }` and never throws for an auth failure (it
 * folds it into `value`), so the final attempt's `value` is returned verbatim
 * even when it too failed auth. A `refresh()` that throws (e.g. a typed
 * `invalid_grant`) propagates to the caller, which maps it to re-login guidance.
 *
 * The `ok` result carries the final attempt's `authFailed` so the caller can
 * tell a 401 that *survived* the refresh + retry (a dead credential) from a
 * clean success, and word the guidance accordingly via {@link describeAuthRejection}.
 *
 * @template T
 * @param {{
 *   resolved: { ok: true, token: string, source?: 'env' | 'file', kind?: 'static' | 'oidc' },
 *   refresh: () => Promise<{ ok: true, token: string, source?: 'env' | 'file', kind?: 'static' | 'oidc' } | { ok: false, error: string }>,
 *   op: (token: string) => Promise<{ authFailed: boolean, value: T }>,
 * }} args
 * @returns {Promise<{ ok: true, value: T, authFailed: boolean } | { ok: false, error: string }>}
 * @ref LLP 0046#d5 [implements]: the 401 -> force refresh -> retry-once policy, one home for both attach paths
 */
export async function attachWithRefresh({ resolved, refresh, op }) {
  const first = await op(resolved.token)
  if (!first.authFailed || !isRefreshable(resolved)) {
    return { ok: true, value: first.value, authFailed: first.authFailed }
  }
  const refreshed = await refresh()
  if (!refreshed.ok) return { ok: false, error: refreshed.error }
  const second = await op(refreshed.token)
  return { ok: true, value: second.value, authFailed: second.authFailed }
}

/**
 * Explain a 401/403 that survived the one-shot refresh + retry, by *why* the
 * credential is dead, so the stdio proxy and the verb attach path advise the
 * user identically (LLP 0046 D5). One home so the two can never drift:
 *  - a refreshable oidc session that still 401s is an expired session: re-login
 *    (exit 2, same as an invalid_grant refresh failure);
 *  - a per-target env override can't be fixed by re-login (it always wins over
 *    the store), so point at the env var (exit 1);
 *  - a static file token re-login *does* replace, so advise re-login (exit 1).
 *
 * @param {{ target: string, status: number, resolved: { source?: 'env' | 'file', kind?: 'static' | 'oidc' } }} args
 * @returns {{ message: string, exitCode: number }}
 * @ref LLP 0046#d5 [implements]: 401-after-retry guidance, one home for both attach paths
 */
export function describeAuthRejection({ target, status, resolved }) {
  if (isRefreshable(resolved)) {
    return { message: sessionExpiredMessage(target), exitCode: 2 }
  }
  if (resolved.source === 'env') {
    return {
      message: `remote rejected the credential for '${target}' (HTTP ${status}) - re-login cannot fix an env override; check ${remoteTokenEnvVar(target)}`,
      exitCode: 1,
    }
  }
  return {
    message: `remote rejected the credential (HTTP ${status}) - re-run 'hyp remote login'`,
    exitCode: 1,
  }
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
 * The per-target env override, or `undefined`. `HYP_REMOTE_TOKEN_<TARGET>`
 * always wins over the stored file (LLP 0033 §credentials); both resolvers read
 * it through here so the "env always wins" rule has one home.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} target
 * @returns {string | undefined}
 */
function envOverride(env, target) {
  const value = env[remoteTokenEnvVar(target)]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * @param {string} target
 * @param {string} envName
 * @returns {string}
 */
function noTokenError(target, envName) {
  return `no token for '${target}' - run 'hyp remote login ${target}' (or set ${envName})`
}

/** @param {number} ms @returns {Promise<void>} */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Serialize the read-modify-write of the shared 0600 store across concurrent
 * `hyp` processes (a verb call beside a proxy, two MCP clients). Without it two
 * writers to *different* targets each read the whole map and rename; the later
 * rename clobbers the earlier writer's just-rotated one-time-use refresh token
 * for the other target, forcing a needless re-login. An `O_EXCL` lock file is
 * the cross-process mutex, and the cache is dropped on entry so the locked body
 * reads the freshest on-disk map (an identical-size sibling rewrite the parse
 * cache would otherwise miss). A stale lock left by a crashed holder is stolen
 * by age, so a crash can't wedge every future write.
 *
 * @template T
 * @param {string} stateDir
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withCredentialsLock(stateDir, fn) {
  await fs.mkdir(stateDir, { recursive: true })
  const lockPath = `${remoteCredentialsPath(stateDir)}.lock`
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      const handle = await fs.open(lockPath, 'wx')
      await handle.close()
      break
    } catch (err) {
      if (!err || /** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') throw err
      // Steal a lock abandoned by a crashed holder, identified by age.
      try {
        const st = await fs.stat(lockPath)
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await fs.rm(lockPath, { force: true })
          continue
        }
      } catch { /* lock vanished between open and stat: retry the acquire */ }
      if (Date.now() > deadline) {
        throw new Error('timed out acquiring the remote credentials lock')
      }
      await delay(25)
    }
  }
  try {
    // Read the freshest on-disk map inside the lock; see the doc comment.
    rawCache = null
    return await fn()
  } finally {
    await fs.rm(lockPath, { force: true })
  }
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
  // Invalidate the read cache: our own write must be visible to the next read
  // regardless of mtime resolution.
  rawCache = null
}
