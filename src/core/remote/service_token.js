// @ts-check

import fsp from 'node:fs/promises'
import path from 'node:path'

import { withFileLock } from '../util/file_lock.js'
import { atomicWriteJson } from '../util/fs_atomic.js'
import { errCode, isPlainObject, sha256Hex } from '../util/json_util.js'

/**
 * The org service-account secret (hypaware-server LLP 0620) and the record
 * `hyp join` keeps of it beside the central sink's identity (LLP 0547 D2).
 * Core's join, leave and login enrollment write and retire the record; the
 * central plugin reads it at activation and rewrites it on a stop. One home,
 * so the shape check, the file name and the write classification cannot
 * drift between them.
 *
 * @import { KeptServiceToken, KeptServiceTokenRead, KeptServiceTokenWrite } from '../../../src/core/remote/types.js'
 */

/** Every service secret starts with this; the server decides what it is. */
export const SERVICE_TOKEN_PREFIX = 'hsa_'

/** `hsa_<16 hex id>_<43 base64url>`, 64 chars (hypaware-server LLP 0620#token). */
const SERVICE_TOKEN_SHAPE = /^hsa_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/

/** The server's permanent refusals of a service credential. */
const SERVICE_STOP_CODES = new Set(['service_token_revoked', 'service_account_disabled'])

/**
 * Whether a token carries the service prefix. A routing hint only: a token
 * with the prefix but not the shape is refused locally rather than sent.
 *
 * @param {unknown} token
 * @returns {boolean}
 */
export function hasServiceTokenPrefix(token) {
  return typeof token === 'string' && token.startsWith(SERVICE_TOKEN_PREFIX)
}

/**
 * @param {unknown} token
 * @returns {boolean}
 */
export function isServiceTokenShape(token) {
  return typeof token === 'string' && SERVICE_TOKEN_SHAPE.test(token)
}

/**
 * @param {unknown} code
 * @returns {code is string}
 */
export function isServiceStopCode(code) {
  return typeof code === 'string' && SERVICE_STOP_CODES.has(code)
}

/**
 * The kept record's path: `service-token` in the directory of the sink's
 * `identity.json`, so it follows `identity.persisted_path` with no key of its
 * own.
 *
 * @param {string} identityPath
 * @returns {string}
 */
export function serviceTokenPath(identityPath) {
  return path.join(path.dirname(identityPath), 'service-token')
}

/**
 * A fresh record for a join: no stop, whatever an older record held.
 *
 * @param {{ secret: string, centralUrl: string, now?: number }} args
 * @returns {KeptServiceToken}
 */
export function keptServiceToken({ secret, centralUrl, now = Date.now() }) {
  return {
    version: 1,
    secret,
    central_url: centralUrl,
    fingerprint: sha256Hex(secret),
    written_at: new Date(now).toISOString(),
  }
}

/**
 * Read the kept record. `ENOENT` is `absent`; any other failure, or a record
 * that does not check out, is `unreadable` with a short reason that never
 * carries the contents.
 *
 * @param {string} filePath
 * @param {{ fs?: typeof fsp }} [options]
 * @returns {Promise<KeptServiceTokenRead>}
 */
export async function readKeptServiceToken(filePath, { fs = fsp } = {}) {
  let raw
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch (err) {
    const code = errCode(err)
    if (code === 'ENOENT') return { state: 'absent' }
    return { state: 'unreadable', reason: code ?? 'read_failed' }
  }
  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { state: 'unreadable', reason: 'bad_json' }
  }
  if (!isPlainObject(parsed)) return { state: 'unreadable', reason: 'not_object' }
  const { version, secret, central_url, fingerprint, written_at, stopped_code } = /** @type {Record<string, unknown>} */ (parsed)
  if (version !== 1) return { state: 'unreadable', reason: 'unknown_version' }
  if (typeof secret !== 'string' || !isServiceTokenShape(secret)) return { state: 'unreadable', reason: 'bad_shape' }
  if (typeof central_url !== 'string' || central_url.length === 0 || typeof written_at !== 'string') {
    return { state: 'unreadable', reason: 'missing_field' }
  }
  if (fingerprint !== sha256Hex(secret)) return { state: 'unreadable', reason: 'fingerprint_mismatch' }
  if (stopped_code !== undefined && typeof stopped_code !== 'string') return { state: 'unreadable', reason: 'bad_field' }
  /** @type {KeptServiceToken} */
  const record = { version: 1, secret, central_url, fingerprint, written_at }
  if (stopped_code !== undefined) record.stopped_code = stopped_code
  return { state: 'ok', record }
}

/**
 * Publish a record private from creation (tmp at 0600, synced, renamed over
 * the target, directory created 0700). A rejection is classified by reading
 * the target back once, because the error alone cannot say whether the
 * rename happened:
 *
 * - `written`: no error;
 * - `visible`: an error, but the target is exactly this record. The rename
 *   happened; its directory sync may not have, so it is visible, not durable;
 * - `not_written`: any other record, or none, is visible;
 * - `unreadable`: the target cannot be read back.
 *
 * - `superseded`: `expected` was given and the record on disk is not it, so
 *   nothing was written.
 *
 * No retry: the caller decides what each outcome means. Every write and
 * retirement holds the record's lock, so a stop written with `expected`
 * cannot land over a record a join published after it was read.
 *
 * @ref LLP 0547#write-failure [implements]: classify a failed write by re-reading it once; only an exact match counts as written
 * @param {string} filePath
 * @param {KeptServiceToken} record
 * @param {{ fs?: typeof fsp, expected?: KeptServiceToken }} [options]
 * @returns {Promise<KeptServiceTokenWrite>}
 */
export async function writeKeptServiceToken(filePath, record, { fs = fsp, expected } = {}) {
  try {
    return await withRecordLock(filePath, async () => {
      if (expected !== undefined) {
        const current = await readKeptServiceToken(filePath, { fs })
        if (current.state !== 'ok' || !sameRecord(current.record, expected)) return { outcome: 'superseded' }
      }
      await atomicWriteJson(filePath, record, { mode: 0o600, dirMode: 0o700, fsync: true, fs })
      return { outcome: 'written' }
    })
  } catch (err) {
    const error = errCode(err) ?? (err instanceof Error ? err.message : String(err))
    const seen = await readKeptServiceToken(filePath, { fs })
    if (seen.state === 'unreadable') return { outcome: 'unreadable', error }
    if (seen.state === 'ok' && sameRecord(seen.record, record)) return { outcome: 'visible', error }
    return { outcome: 'not_written', error }
  }
}

/**
 * Remove the kept record. Returns whether one was there; `ENOENT` is success
 * and any other error is thrown, so the caller stops before it writes a new
 * enrollment.
 *
 * @param {string} filePath
 * @param {{ fs?: typeof fsp }} [options]
 * @returns {Promise<boolean>}
 */
export async function retireKeptServiceToken(filePath, { fs = fsp } = {}) {
  if (await fs.stat(filePath).then(() => false, (err) => errCode(err) === 'ENOENT')) return false
  return withRecordLock(filePath, async () => {
    try {
      await fs.unlink(filePath)
      return true
    } catch (err) {
      if (errCode(err) === 'ENOENT') return false
      throw err
    }
  })
}

/**
 * Run `fn` holding the record's lock, beside it in its directory. The
 * directory is created private first, as the write would create it, so the
 * lock never creates it with a wider mode.
 *
 * @template T
 * @param {string} filePath
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withRecordLock(filePath, fn) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  return withFileLock(`${filePath}.lock`, fn)
}

/**
 * Every field, the stop state included: an absent `stopped_code` matches only
 * an absent one.
 *
 * @param {KeptServiceToken} a
 * @param {KeptServiceToken} b
 * @returns {boolean}
 */
function sameRecord(a, b) {
  return a.version === b.version &&
    a.secret === b.secret &&
    a.central_url === b.central_url &&
    a.fingerprint === b.fingerprint &&
    a.written_at === b.written_at &&
    a.stopped_code === b.stopped_code
}
