// @ts-check

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWriteJsonSync, withFileLock } from 'hypaware/core/util'
import { authError, deviceLogin, githubIdentity, refreshGithubToken } from './oauth.js'

/** @import { GithubAuthRecord, GithubOAuthOptions } from '../../../../hypaware-core/plugins-workspace/github/src/types.js' */

/** @param {string} stateDir */
export function githubCredentialsPath(stateDir) {
  return path.join(stateDir, 'auth', 'credentials.json')
}

/** @param {string} stateDir */
function privateDirectory(stateDir) {
  const dir = path.dirname(githubCredentialsPath(stateDir))
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!fs.lstatSync(dir).isDirectory()) throw authError('store', 'credential directory is not a directory')
  fs.chmodSync(dir, 0o700)
  return dir
}

/** @param {string} stateDir @returns {GithubAuthRecord | null} */
export function readGithubAuth(stateDir) {
  try {
    const file = githubCredentialsPath(stateDir)
    const dir = fs.lstatSync(path.dirname(file))
    if (!dir.isDirectory() || (process.platform !== 'win32' && (dir.mode & 0o077) !== 0)) throw new Error()
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.size > 64 * 1024 || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new Error()
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!data || typeof data.generation !== 'string' || !['pending', 'logged_out', 'active'].includes(data.status)) throw new Error()
    if (data.status === 'active' && (typeof data.access_token !== 'string' || !data.access_token ||
        !data.account || typeof data.account.login !== 'string' || !Number.isSafeInteger(data.account.id) ||
        (data.expires_at !== undefined && !Number.isFinite(data.expires_at)) ||
        (data.refresh_token !== undefined && typeof data.refresh_token !== 'string') ||
        (data.refresh_expires_at !== undefined && !Number.isFinite(data.refresh_expires_at)))) throw new Error()
    return data
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err)?.code === 'ENOENT') return null
    throw authError('store', 'credential file is invalid or not private; run `hyp github login` again')
  }
}

/** @param {string} stateDir @param {GithubAuthRecord} record */
function write(stateDir, record) {
  privateDirectory(stateDir)
  atomicWriteJsonSync(githubCredentialsPath(stateDir), record, { mode: 0o600 })
  fs.chmodSync(githubCredentialsPath(stateDir), 0o600)
}

/** @template T @param {string} stateDir @param {() => Promise<T>} fn */
function locked(stateDir, fn) {
  privateDirectory(stateDir)
  return withFileLock(`${githubCredentialsPath(stateDir)}.lock`, fn)
}

/** @param {string} stateDir */
export async function logoutGithub(stateDir) {
  await locked(stateDir, async () => write(stateDir, { generation: randomUUID(), status: 'logged_out' }))
}

/**
 * @param {string} stateDir
 * @param {GithubOAuthOptions & { onCode: (code: string, uri: string) => void | Promise<void> }} opts
 */
// @ref LLP 0409#authentication [implements]: select before waiting; generation prevents a superseded login resurrecting an account
export async function loginGithub(stateDir, opts) {
  const generation = randomUUID()
  await locked(stateDir, async () => write(stateDir, { generation, status: 'pending' }))
  const tokens = await deviceLogin(opts)
  const account = await githubIdentity(tokens.access_token, opts)
  await locked(stateDir, async () => {
    if (opts.signal?.aborted) throw authError('cancelled', 'login cancelled')
    if (readGithubAuth(stateDir)?.generation !== generation) throw authError('changed', 'another login or logout superseded this login')
    write(stateDir, { ...tokens, generation, status: 'active', account })
  })
  return account
}

/** @param {GithubAuthRecord | null} record @returns {asserts record is GithubAuthRecord & { status: 'active', access_token: string }} */
function requireActive(record) {
  if (!record || record.status !== 'active' || !record.access_token) throw authError('required', 'local OAuth is logged out or incomplete; run `hyp github login`')
}

/** @param {GithubAuthRecord} record @param {number} now */
function fresh(record, now) {
  return record.expires_at === undefined || record.expires_at > now + 60_000
}

/**
 * Null means OAuth has never been selected. Every selected-but-unusable state
 * throws, so the caller cannot fall through to another identity.
 * @param {string} stateDir
 * @param {GithubOAuthOptions} [opts]
 * @returns {Promise<string | null>}
 */
// @ref LLP 0409#private-state-and-refresh [implements]: constant-size per-request read; rotate single-flight and compare before commit
export async function resolveGithubOAuth(stateDir, opts = {}) {
  const now = opts.now ?? Date.now
  const record = readGithubAuth(stateDir)
  if (!record) return null
  requireActive(record)
  if (fresh(record, now())) return record.access_token
  return locked(stateDir, async () => {
    const current = readGithubAuth(stateDir)
    requireActive(current)
    if (fresh(current, now())) return current.access_token
    if (!current.refresh_token || (current.refresh_expires_at !== undefined && current.refresh_expires_at <= now())) {
      throw authError('expired', 'session expired; run `hyp github login` again')
    }
    const tokens = await refreshGithubToken(current.refresh_token, opts)
    const latest = readGithubAuth(stateDir)
    if (latest?.generation !== current.generation || latest?.refresh_token !== current.refresh_token) {
      throw authError('changed', 'credentials changed during refresh; retry the command')
    }
    // No await between the final compare and atomic write.
    write(stateDir, { ...current, ...tokens, expires_at: tokens.expires_at, refresh_expires_at: tokens.refresh_expires_at })
    return tokens.access_token
  })
}
