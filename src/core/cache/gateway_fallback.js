// @ts-check

import { isPlainObject } from '../util/json_util.js'

/**
 * A committed row is a re-settle candidate when it carries the gateway's
 * provisional-identity marker. This is the documented contract
 * (`attributes.gateway.identity_source === 'gateway_fallback'`, LLP 0027
 * "Decision") - a dataset-agnostic predicate, so the marker is the only
 * coupling between core compaction and the gateway plugin. Tolerates the
 * `attributes` column whether stored as an object or a JSON string.
 *
 * Shared between the flush path (which counts marker rows into the
 * partition cursor as they land) and maintenance (which reads that count
 * instead of scanning the table's attributes column every tick).
 *
 * @param {Record<string, unknown>} row
 * @returns {boolean}
 */
export function isGatewayFallbackRow(row) {
  const attrs = row?.attributes
  if (typeof attrs === 'string') {
    // Substring prefilter: the attributes column holds whole recorded
    // exchanges, so parsing every value to answer "no" is the expensive
    // path. A string that never mentions the marker cannot carry it; one
    // that does (almost always a real marker row) pays the exact parse.
    if (!attrs.includes('gateway_fallback')) return false
    return hasFallbackMarker(safeParseJson(attrs))
  }
  return hasFallbackMarker(attrs)
}

/**
 * How many of these rows still carry the fallback marker.
 *
 * @param {readonly Record<string, unknown>[]} rows
 * @returns {number}
 */
export function countGatewayFallbackRows(rows) {
  let count = 0
  for (const row of rows) {
    if (isGatewayFallbackRow(row)) count++
  }
  return count
}

/** @param {unknown} parsed */
function hasFallbackMarker(parsed) {
  if (!isPlainObject(parsed)) return false
  const gateway = parsed.gateway
  return isPlainObject(gateway) && gateway.identity_source === 'gateway_fallback'
}

/** @param {string} value */
function safeParseJson(value) {
  try { return JSON.parse(value) } catch { return undefined }
}
