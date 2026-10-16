// @ts-check

import { createHash } from 'node:crypto'

export const SYNC_INVENTORY_VERSION = 1
export const SYNC_INVENTORY_DATASET = 'ai_gateway_messages'
export const SYNC_INVENTORY_MAX_KEYS = 100_000
export const SYNC_INVENTORY_PAGE_KEYS = 1000

/** @param {unknown} value */
export function inventoryDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'undated'
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : 'undated'
}

/** Identity coverage, deliberately not payload equality. @param {unknown} partId */
export function inventoryKey(partId) {
  if (typeof partId !== 'string' || !partId || Buffer.byteLength(partId) > 4096) {
    throw new Error('sync inventory: missing or invalid part_id')
  }
  return createHash('sha256').update('hypaware.sync-inventory/1\0ai_gateway_messages\0').update(partId).digest('hex')
}

/** @param {string} day @param {string} key */
export function inventoryBucket(day, key) { return `${day}/${key[0]}` }

/** @param {string} value */
export function validInventoryBucket(value) {
  const [day, prefix, extra] = value.split('/')
  return extra === undefined && /^[0-9a-f]$/.test(prefix ?? '') &&
    (day === 'undated' || inventoryDay(day) === day)
}

// @ref LLP 0501#meaning [implements]: sorted distinct identities make replay order irrelevant and same-count replacements detectable.
/** @param {Iterable<string>} values */
export function summarizeInventoryKeys(values) {
  const unique = new Set()
  for (const value of values) {
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('sync inventory: invalid key')
    unique.add(value)
    if (unique.size > SYNC_INVENTORY_MAX_KEYS) throw new Error('sync inventory: bucket exceeds key budget')
  }
  const keys = [...unique].sort()
  const hash = createHash('sha256').update('hypaware.sync-inventory.bucket/1\n')
  for (const key of keys) hash.update(key).update('\n')
  return { keys, count: keys.length, fingerprint: hash.digest('hex') }
}
