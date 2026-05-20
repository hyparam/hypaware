import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createEnrollmentStore,
  deleteEnrollment,
  registerEnrollment,
} from '../../src/server/enrollment.js'

/**
 * @import { EnrollmentStore } from '../../src/server/enrollment.d.ts'
 */

const FIXED_NOW = 1_700_000_000_000

/**
 * @param {string} value
 * @returns {string}
 */
function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

describe('deleteEnrollment', () => {
  /** @type {string} */
  let dir
  /** @type {EnrollmentStore} */
  let store

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-enroll-delete-'))
    store = createEnrollmentStore({
      path: path.join(dir, 'enrollments.json'),
      now: () => FIXED_NOW,
    })
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('returns false and is a no-op when the store file does not exist', () => {
    const removed = deleteEnrollment(store, sha256Hex('NEVERSEEN'))
    expect(removed).toBe(false)
    expect(fs.existsSync(store.path)).toBe(false)
  })

  it('returns false when the hash does not match any record', () => {
    const aHash = sha256Hex('AAAAAAAAA1')
    registerEnrollment(store, {
      joinCodeHash: aHash,
      gatewayId: 'gw-a',
      maxUses: 1,
      ttlSeconds: 60,
    })
    const removed = deleteEnrollment(store, sha256Hex('NOSUCHCODE'))
    expect(removed).toBe(false)
    const remaining = JSON.parse(fs.readFileSync(store.path, 'utf8'))
    expect(remaining).toHaveLength(1)
    expect(remaining[0].joinCodeHash).toBe(aHash)
  })

  it('returns true and removes only the matching record', () => {
    const aHash = sha256Hex('AAAAAAAAA1')
    const bHash = sha256Hex('BBBBBBBBB2')
    registerEnrollment(store, { joinCodeHash: aHash, gatewayId: 'gw-a', maxUses: 1, ttlSeconds: 60 })
    registerEnrollment(store, { joinCodeHash: bHash, gatewayId: 'gw-b', maxUses: 1, ttlSeconds: 60 })

    const removed = deleteEnrollment(store, aHash)
    expect(removed).toBe(true)

    const remaining = JSON.parse(fs.readFileSync(store.path, 'utf8'))
    expect(remaining).toHaveLength(1)
    expect(remaining[0].joinCodeHash).toBe(bHash)
  })

  it('is idempotent: a second delete on the same hash returns false', () => {
    const hash = sha256Hex('IDEMPOTENT1')
    registerEnrollment(store, { joinCodeHash: hash, gatewayId: 'gw', maxUses: 1, ttlSeconds: 60 })
    expect(deleteEnrollment(store, hash)).toBe(true)
    expect(deleteEnrollment(store, hash)).toBe(false)
  })

  it('throws when given a malformed hash so callers cannot mask bugs as no-ops', () => {
    expect(() => deleteEnrollment(store, 'not-a-hash')).toThrow()
    // SHA-256 hex is 64 lowercase chars — uppercase is rejected by normalizeHash
    expect(() => deleteEnrollment(store, 'A'.repeat(64))).toThrow()
  })
})
