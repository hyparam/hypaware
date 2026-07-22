// @ts-check

import fs from 'node:fs'
import path from 'node:path'

import { atomicWriteJsonSync, isPlainObject, sha256Hex } from 'hypaware/core/util'

/**
 * @import { SubscriptionOauthRecord } from './types.js'
 */

/** Basename of the credential file under the plugin state dir. */
export const CREDENTIAL_BASENAME = 'credentials.json'

/** How long an abandoned lock file is honored before being broken (ms). */
const LOCK_STALE_MS = 30_000
const LOCK_RETRY_MS = 50
const LOCK_MAX_WAIT_MS = 5_000

/**
 * @param {string} stateDir
 * @returns {string}
 */
export function credentialFilePath(stateDir) {
  return path.join(stateDir, CREDENTIAL_BASENAME)
}

/**
 * Short fingerprint for logs and `status` output. A hash, never the
 * value, so no output path can leak the credential.
 *
 * @ref LLP 0117#store-discipline [implements]: fingerprints, never values, in diagnostics
 * @param {string} token
 * @returns {string}
 */
export function tokenFingerprint(token) {
  return sha256Hex(token).slice(0, 12)
}

/**
 * Read and validate the stored record. `undefined` when absent (not
 * signed in); throws on a corrupt file so the caller surfaces it rather
 * than silently re-prompting a sign-in over a file it cannot parse.
 *
 * @param {string} filePath
 * @returns {SubscriptionOauthRecord | undefined}
 */
export function readStoredCredential(filePath) {
  /** @type {string} */
  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return undefined
    throw err
  }
  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`claude-account credential file is not valid JSON: ${filePath}`)
  }
  if (!isValidRecord(parsed)) {
    throw new Error(`claude-account credential file has an unrecognized shape: ${filePath}`)
  }
  return parsed
}

/**
 * @param {unknown} value
 * @returns {value is SubscriptionOauthRecord}
 */
function isValidRecord(value) {
  if (!isPlainObject(value)) return false
  return value.kind === 'subscription_oauth'
    && typeof value.access_token === 'string' && value.access_token.length > 0
    && typeof value.refresh_token === 'string' && value.refresh_token.length > 0
    && typeof value.expires_at === 'number' && Number.isFinite(value.expires_at)
    && typeof value.obtained_at === 'number' && Number.isFinite(value.obtained_at)
    && (value.scopes === undefined
      || (Array.isArray(value.scopes) && value.scopes.every((s) => typeof s === 'string')))
}

/**
 * Persist the record with the credential-store discipline: atomic
 * tmp+rename, `0600` file under a `0700` dir, re-chmod to defeat umask.
 *
 * @ref LLP 0117#store-discipline [implements]: same file discipline as remote-credentials.json / identity.json
 * @param {string} filePath
 * @param {SubscriptionOauthRecord} record
 */
export function writeStoredCredential(filePath, record) {
  atomicWriteJsonSync(filePath, record, { mode: 0o600, dirMode: 0o700 })
  fs.chmodSync(filePath, 0o600)
}

/**
 * @param {string} filePath
 */
export function clearStoredCredential(filePath) {
  try {
    fs.unlinkSync(filePath)
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err
  }
}

/**
 * Run `fn` under a cross-process `O_EXCL` lock beside the credential
 * file. Refresh rotates the refresh token upstream, so two concurrent
 * helper runs must not both refresh: the loser would persist a
 * just-invalidated token pair over the winner's. Same mutex shape as
 * the remote credential store's lock (LLP 0065), simplified: retry with
 * a short backoff, break locks older than 30s.
 *
 * @template T
 * @param {string} filePath
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withCredentialLock(filePath, fn) {
  const lockPath = `${filePath}.lock`
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + LOCK_MAX_WAIT_MS
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600)
      fs.closeSync(fd)
      break
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') throw err
      if (lockIsStale(lockPath)) {
        try {
          fs.unlinkSync(lockPath)
        } catch {
          // Another process broke it first; loop and retry.
        }
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(`claude-account credential store is locked: ${lockPath}`)
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
    }
  }
  try {
    return await fn()
  } finally {
    try {
      fs.unlinkSync(lockPath)
    } catch {
      // Already gone (stale-broken by a waiter): nothing to release.
    }
  }
}

/**
 * @param {string} lockPath
 * @returns {boolean}
 */
function lockIsStale(lockPath) {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS
  } catch {
    return false
  }
}
