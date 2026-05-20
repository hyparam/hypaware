import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { GATEWAY_ID_MAX_LENGTH, isValidGatewayId } from '../gateway_id.js'
import { defaultServerDataDir } from './config_registry.js'

/**
 * @import { ServerConfig } from '../types.js'
 * @import {
 *   EnrollmentIssueResult,
 *   EnrollmentRecord,
 *   EnrollmentStore,
 *   IssueEnrollmentInput,
 *   RegisterEnrollmentInput,
 * } from './enrollment.d.ts'
 */

const JOIN_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'
const DEFAULT_JOIN_CODE_LENGTH = 10
const MIN_JOIN_CODE_LENGTH = 6
const MAX_JOIN_CODE_LENGTH = 32

/**
 * @param {{ path: string, now?: () => number }} opts
 * @returns {EnrollmentStore}
 */
export function createEnrollmentStore(opts) {
  if (typeof opts?.path !== 'string' || opts.path.length === 0) {
    throw new Error('EnrollmentStore: path is required')
  }
  return {
    path: opts.path,
    now: opts.now ?? Date.now,
  }
}

/**
 * @param {ServerConfig} config
 * @param {{ homeDir?: string }} [opts]
 * @returns {string}
 */
export function resolveEnrollmentStorePath(config, opts = {}) {
  return path.join(config.data_dir ?? defaultServerDataDir(opts.homeDir), 'enrollments.json')
}

/**
 * @param {number} [length]
 * @returns {string}
 */
export function generateEnrollmentCode(length = DEFAULT_JOIN_CODE_LENGTH) {
  if (!Number.isInteger(length) || length < MIN_JOIN_CODE_LENGTH || length > MAX_JOIN_CODE_LENGTH) {
    throw new Error(`generateEnrollmentCode: length must be ${MIN_JOIN_CODE_LENGTH}..${MAX_JOIN_CODE_LENGTH}`)
  }
  let out = ''
  for (let i = 0; i < length; i++) {
    out += JOIN_CODE_ALPHABET[crypto.randomInt(JOIN_CODE_ALPHABET.length)]
  }
  return out
}

/**
 * @param {EnrollmentStore} store
 * @param {RegisterEnrollmentInput} input
 * @returns {EnrollmentRecord}
 */
export function registerEnrollment(store, input) {
  const joinCodeHash = normalizeHash(input.joinCodeHash)
  const gatewayId = validateGatewayId(input.gatewayId)
  const maxUses = validatePositiveInteger(input.maxUses, 'maxUses')
  const ttlSeconds = validatePositiveInteger(input.ttlSeconds, 'ttlSeconds')
  validateGatewayIdCapacity(gatewayId, maxUses)
  if (input.displayName !== undefined && (typeof input.displayName !== 'string' || input.displayName.length === 0)) {
    throw new Error('EnrollmentStore.register: displayName must be a non-empty string when provided')
  }

  const records = loadRecords(store)
  const existing = records.find((record) => record.joinCodeHash === joinCodeHash)
  const nowSec = Math.floor(store.now() / 1000)
  if (existing && existing.expiresAt > nowSec && existing.usedCount < existing.maxUses) {
    throw new Error('EnrollmentStore.register: active enrollment already exists for this join key')
  }

  /** @type {EnrollmentRecord} */
  const record = {
    joinCodeHash,
    gatewayId,
    maxUses,
    usedCount: 0,
    expiresAt: nowSec + ttlSeconds,
    createdAt: nowSec,
  }
  if (input.displayName !== undefined) record.displayName = input.displayName

  const next = records.filter((candidate) => candidate.joinCodeHash !== joinCodeHash)
  next.push(record)
  flushRecords(store, next)
  return record
}

/**
 * Remove an enrollment record by joinCodeHash. Idempotent — returns false
 * when no record matched the hash, true when a record existed and was
 * removed. Used by the admin-invite handler to roll back the enrollment
 * row when the downstream rendezvous registration fails so we don't leave a
 * usable join code with no rendezvous mapping behind it.
 *
 * @param {EnrollmentStore} store
 * @param {string} joinCodeHash
 * @returns {boolean}
 */
export function deleteEnrollment(store, joinCodeHash) {
  const normalized = normalizeHash(joinCodeHash)
  const records = loadRecords(store)
  const next = records.filter((record) => record.joinCodeHash !== normalized)
  if (next.length === records.length) return false
  flushRecords(store, next)
  return true
}

/**
 * @param {IssueEnrollmentInput} input
 * @returns {EnrollmentIssueResult}
 */
export function issueEnrollmentBootstrap(input) {
  const records = loadRecords(input.enrollmentStore)
  const hash = sha256Hex(input.joinCode)
  const record = records.find((candidate) => candidate.joinCodeHash === hash)
  if (!record) return { ok: false, reason: 'unknown_key' }

  const nowSec = Math.floor(input.enrollmentStore.now() / 1000)
  if (record.expiresAt <= nowSec) return { ok: false, reason: 'expired' }
  if (record.usedCount >= record.maxUses) return { ok: false, reason: 'exhausted' }

  const nextUse = record.usedCount + 1
  const gatewayId = gatewayIdForUse(record, nextUse)
  const ttlSeconds = record.expiresAt - nowSec
  const issued = input.bootstrapStore.register({ gatewayId, ttlSeconds })

  record.usedCount = nextUse
  flushRecords(input.enrollmentStore, records)
  return { ok: true, token: issued.token, gatewayId, expiresAt: issued.expiresAt }
}

/**
 * @param {EnrollmentStore} store
 * @returns {EnrollmentRecord[]}
 */
function loadRecords(store) {
  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(store.path, 'utf8'))
  } catch (err) {
    if (isEnoent(err)) return []
    throw err
  }
  if (!Array.isArray(parsed)) throw new Error(`EnrollmentStore: expected array in ${store.path}`)
  /** @type {EnrollmentRecord[]} */
  const records = []
  for (const value of parsed) {
    if (!isPlainObject(value)) continue
    const { joinCodeHash, gatewayId, maxUses, usedCount, expiresAt, createdAt, displayName } = value
    if (!isHash(joinCodeHash)) continue
    if (typeof gatewayId !== 'string' || !isValidGatewayId(gatewayId)) continue
    if (typeof maxUses !== 'number' || !Number.isInteger(maxUses) || maxUses <= 0) continue
    if (typeof usedCount !== 'number' || !Number.isInteger(usedCount) || usedCount < 0) continue
    if (typeof expiresAt !== 'number' || !Number.isInteger(expiresAt)) continue
    if (typeof createdAt !== 'number' || !Number.isInteger(createdAt)) continue
    /** @type {EnrollmentRecord} */
    const record = { joinCodeHash, gatewayId, maxUses, usedCount, expiresAt, createdAt }
    if (typeof displayName === 'string' && displayName.length > 0) record.displayName = displayName
    records.push(record)
  }
  return records
}

/**
 * @param {EnrollmentStore} store
 * @param {EnrollmentRecord[]} records
 * @returns {void}
 */
function flushRecords(store, records) {
  const dir = path.dirname(store.path)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${store.path}.tmp.${process.pid}.${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, store.path)
}

/**
 * @param {EnrollmentRecord} record
 * @param {number} nextUse
 * @returns {string}
 */
function gatewayIdForUse(record, nextUse) {
  return record.maxUses === 1 ? record.gatewayId : `${record.gatewayId}-${nextUse}`
}

/**
 * @param {string} gatewayId
 * @param {number} maxUses
 * @returns {void}
 */
function validateGatewayIdCapacity(gatewayId, maxUses) {
  if (maxUses === 1) return
  const longest = `${gatewayId}-${maxUses}`
  if (longest.length > GATEWAY_ID_MAX_LENGTH) {
    throw new Error('EnrollmentStore.register: gatewayId prefix is too long for maxUses suffixes')
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function validateGatewayId(value) {
  if (!isValidGatewayId(value)) {
    throw new Error('EnrollmentStore.register: gatewayId is invalid')
  }
  return /** @type {string} */ (value)
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {number}
 */
function validatePositiveInteger(value, label) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`EnrollmentStore.register: ${label} must be a positive integer`)
  }
  return value
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeHash(value) {
  if (!isHash(value)) {
    throw new Error('EnrollmentStore.register: joinCodeHash must be a sha256 hex string')
  }
  return value
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isHash(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isEnoent(err) {
  return Boolean(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT')
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {string} input
 * @returns {string}
 */
function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex')
}
