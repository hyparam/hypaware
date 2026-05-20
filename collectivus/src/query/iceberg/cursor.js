import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * @import { QueryCacheCursor } from './types.d.ts'
 */

/**
 * @param {string} value
 * @returns {string}
 */
export function stableId(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function stableFingerprint(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 16)
}

/**
 * @param {string} filePath
 * @returns {QueryCacheCursor | undefined}
 */
export function readCacheCursor(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return
    const cursor = /** @type {Partial<QueryCacheCursor>} */ (parsed)
    if (cursor.kind !== 'builtin' && cursor.kind !== 'collection') return
    if (typeof cursor.cache_schema_version !== 'number') return
    if (typeof cursor.source_id !== 'string') return
    if (typeof cursor.source_path !== 'string') return
    if (typeof cursor.source_epoch !== 'number') return
    if (typeof cursor.table_path !== 'string') return
    if (typeof cursor.table_url !== 'string') return
    if (typeof cursor.source_size !== 'number') return
    if (typeof cursor.source_mtime_ms !== 'number') return
    if (typeof cursor.byte_offset !== 'number') return
    if (typeof cursor.line_number !== 'number') return
    if (typeof cursor.row_count !== 'number') return
    if (typeof cursor.schema_fingerprint !== 'string') return
    if (typeof cursor.refreshed_at !== 'string') return
    if (cursor.kind === 'builtin') {
      if (typeof cursor.dataset !== 'string') return
      if (typeof cursor.gateway_id !== 'string') return
      if (typeof cursor.date !== 'string') return
    } else {
      if (typeof cursor.table !== 'string') return
      if (typeof cursor.name !== 'string') return
      if (!Array.isArray(cursor.columns)) return
    }
    return /** @type {QueryCacheCursor} */ (parsed)
  } catch {
    return undefined
  }
}

/**
 * @param {string} filePath
 * @param {QueryCacheCursor} cursor
 * @returns {void}
 */
export function writeCacheCursor(filePath, cursor) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(cursor, null, 2) + '\n')
  fs.renameSync(tmp, filePath)
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function canonicalJson(value) {
  return JSON.stringify(sortKeys(value))
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out = /** @type {Record<string, unknown>} */ ({})
    for (const key of Object.keys(/** @type {Record<string, unknown>} */ (value)).sort()) {
      out[key] = sortKeys(/** @type {Record<string, unknown>} */ (value)[key])
    }
    return out
  }
  return value
}
