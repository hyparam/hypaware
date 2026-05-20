import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { GATEWAY_ID_MAX_LENGTH, GATEWAY_ID_PATTERN } from '../gateway_id.js'

/**
 * @import {
 *   RegisterInviteInput,
 *   RendezvousInviteRecord,
 *   RendezvousStore,
 *   RendezvousStoreErrorCode,
 * } from './types.d.ts'
 */

const HASH_PATTERN = /^[0-9a-f]{64}$/

export class RendezvousStoreError extends Error {
  /**
   * @param {RendezvousStoreErrorCode} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'RendezvousStoreError'
    /** @type {RendezvousStoreErrorCode} */
    this.code = code
  }
}

/**
 * @param {{ dataDir: string, now?: () => number }} opts
 * @returns {RendezvousStore}
 */
export function createRendezvousStore(opts) {
  if (!opts || typeof opts.dataDir !== 'string' || opts.dataDir.length === 0) {
    throw new Error('createRendezvousStore: dataDir is required')
  }
  return {
    dataDir: opts.dataDir,
    invitesDir: path.join(opts.dataDir, 'invites'),
    now: opts.now ?? Date.now,
  }
}

/**
 * Register an invite by join-code hash. Duplicate active hashes are rejected;
 * expired records may be overwritten so operators can recover from stale files.
 *
 * @param {RendezvousStore} store
 * @param {RegisterInviteInput} input
 * @returns {RendezvousInviteRecord}
 */
export function registerInvite(store, input) {
  const kind = validateKind(input.kind)
  const joinCodeHash = normalizeHash(input.join_code_hash)
  const connectUrl = normalizeConnectUrl(input.connect_url)
  const gatewayId = validateGatewayId(input.gateway_id)
  const expiresAt = validateFutureIsoTime(input.expires_at, store.now())
  const maxUses = validateMaxUses(input.max_uses)

  if (input.display_name !== undefined && (typeof input.display_name !== 'string' || input.display_name.length === 0)) {
    throw new RendezvousStoreError('invalid_display_name', 'display_name must be a non-empty string when provided')
  }

  const existing = readInviteByHash(store, joinCodeHash)
  if (existing && !isExpired(existing, store.now())) {
    throw new RendezvousStoreError('duplicate_active', 'active invite already exists for this join_code_hash')
  }

  /** @type {RendezvousInviteRecord} */
  const record = {
    kind,
    join_code_hash: joinCodeHash,
    connect_url: connectUrl,
    gateway_id: gatewayId,
    expires_at: expiresAt,
    created_at: new Date(store.now()).toISOString(),
  }
  if (maxUses !== undefined) record.max_uses = maxUses
  if (input.display_name !== undefined) record.display_name = input.display_name
  writeInvite(store, record)
  return record
}

/**
 * Resolve a plaintext join code to its registered Central server metadata.
 * The join code is not consumed; the customer Central server remains the
 * one-shot authority through its normal bootstrap-token exchange.
 *
 * @param {RendezvousStore} store
 * @param {string} joinCode
 * @returns {RendezvousInviteRecord}
 */
export function resolveInvite(store, joinCode) {
  if (typeof joinCode !== 'string' || joinCode.length === 0) {
    throw new RendezvousStoreError('invalid_join_code', 'join_code is required')
  }
  const record = readInviteByHash(store, sha256Hex(joinCode))
  if (!record) {
    throw new RendezvousStoreError('unknown_join_code', 'join code not found')
  }
  if (isExpired(record, store.now())) {
    throw new RendezvousStoreError('expired', 'join code has expired')
  }
  return record
}

/**
 * Remove expired invite files from the store.
 *
 * @param {RendezvousStore} store
 * @returns {number}
 */
export function cleanupExpiredInvites(store) {
  /** @type {string[]} */
  let names
  try {
    names = fs.readdirSync(store.invitesDir)
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined
    if (code === 'ENOENT') return 0
    throw err
  }

  let removed = 0
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const hash = name.slice(0, -'.json'.length)
    if (!HASH_PATTERN.test(hash)) continue
    const record = readInviteByHash(store, hash)
    if (!record || !isExpired(record, store.now())) continue
    fs.unlinkSync(invitePath(store, hash))
    removed++
  }
  return removed
}

/**
 * @param {RendezvousStore} store
 * @param {string} hash
 * @returns {RendezvousInviteRecord | undefined}
 */
export function readInviteByHash(store, hash) {
  const normalized = normalizeHash(hash)
  let raw
  try {
    raw = fs.readFileSync(invitePath(store, normalized), 'utf8')
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined
    if (code === 'ENOENT') return undefined
    throw err
  }
  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new RendezvousStoreError('invalid_record', `invalid invite JSON for ${normalized}: ${msg}`)
  }
  return validateRecord(parsed)
}

/**
 * @param {string} input
 * @returns {string}
 */
export function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex')
}

/**
 * @param {RendezvousStore} store
 * @param {RendezvousInviteRecord} record
 * @returns {void}
 */
function writeInvite(store, record) {
  fs.mkdirSync(store.invitesDir, { recursive: true, mode: 0o700 })
  const dest = invitePath(store, record.join_code_hash)
  const tmp = path.join(store.invitesDir, `${record.join_code_hash}.tmp.${process.pid}.${Date.now()}`)
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, dest)
  try {
    fs.chmodSync(dest, 0o600)
  } catch {
    // The fresh tmp file was already created with 0600; chmod is best-effort.
  }
}

/**
 * @param {RendezvousStore} store
 * @param {string} hash
 * @returns {string}
 */
function invitePath(store, hash) {
  const normalized = normalizeHash(hash)
  return path.join(store.invitesDir, `${normalized}.json`)
}

/**
 * @param {unknown} value
 * @returns {RendezvousInviteRecord}
 */
function validateRecord(value) {
  if (!isPlainObject(value)) {
    throw new RendezvousStoreError('invalid_record', 'invite record must be an object')
  }
  const kind = validateKind(value.kind)
  const joinCodeHash = normalizeHash(value.join_code_hash)
  const connectUrl = normalizeConnectUrl(value.connect_url)
  const gatewayId = validateGatewayId(value.gateway_id)
  const expiresAt = validateIsoTime(value.expires_at)
  const maxUses = validateMaxUses(value.max_uses)
  const createdAt = validateIsoTime(value.created_at)

  /** @type {RendezvousInviteRecord} */
  const record = {
    kind,
    join_code_hash: joinCodeHash,
    connect_url: connectUrl,
    gateway_id: gatewayId,
    expires_at: expiresAt,
    created_at: createdAt,
  }
  if (maxUses !== undefined) record.max_uses = maxUses
  if (value.display_name !== undefined) {
    if (typeof value.display_name !== 'string' || value.display_name.length === 0) {
      throw new RendezvousStoreError('invalid_record', 'invite record display_name must be a non-empty string')
    }
    record.display_name = value.display_name
  }
  return record
}

/**
 * @param {unknown} value
 * @returns {'one_time_gateway' | 'enterprise_enrollment'}
 */
function validateKind(value) {
  // Existing rendezvous files did not carry `kind`; those active invites are
  // one-time gateway bootstrap-token invites and should survive this rollout.
  if (value === undefined) return 'one_time_gateway'
  if (value === 'one_time_gateway' || value === 'enterprise_enrollment') return value
  throw new RendezvousStoreError('invalid_kind', 'kind must be one_time_gateway or enterprise_enrollment')
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeHash(value) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw new RendezvousStoreError('invalid_join_code_hash', 'join_code_hash must be a 64-character lowercase sha256 hex string')
  }
  return value
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeConnectUrl(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RendezvousStoreError('invalid_connect_url', 'connect_url is required')
  }
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('bad protocol')
    }
    return value.replace(/\/+$/, '')
  } catch {
    throw new RendezvousStoreError('invalid_connect_url', 'connect_url must be an http(s) URL')
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function validateGatewayId(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RendezvousStoreError('invalid_gateway_id', 'gateway_id is required')
  }
  if (value.length > GATEWAY_ID_MAX_LENGTH || !GATEWAY_ID_PATTERN.test(value) || value === '.' || value === '..') {
    throw new RendezvousStoreError('invalid_gateway_id', 'gateway_id is invalid')
  }
  return value
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function validateMaxUses(value) {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new RendezvousStoreError('invalid_max_uses', 'max_uses must be a positive integer')
  }
  return value
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function validateIsoTime(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RendezvousStoreError('invalid_expires_at', 'timestamp must be an ISO-8601 string')
  }
  const millis = Date.parse(value)
  if (!Number.isFinite(millis)) {
    throw new RendezvousStoreError('invalid_expires_at', 'timestamp must be an ISO-8601 string')
  }
  return new Date(millis).toISOString()
}

/**
 * @param {unknown} value
 * @param {number} nowMs
 * @returns {string}
 */
function validateFutureIsoTime(value, nowMs) {
  const iso = validateIsoTime(value)
  if (Date.parse(iso) <= nowMs) {
    throw new RendezvousStoreError('expired', 'expires_at must be in the future')
  }
  return iso
}

/**
 * @param {RendezvousInviteRecord} record
 * @param {number} nowMs
 * @returns {boolean}
 */
function isExpired(record, nowMs) {
  return Date.parse(record.expires_at) <= nowMs
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
