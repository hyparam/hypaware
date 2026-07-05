// @ts-check

import { normalizePrefix } from './config.js'

/**
 * @import { QueryPartition } from '../../../../hypaware-plugin-kernel-types.js'
 */

/**
 * Render the partition's directory segment using the same convention as
 * `@hypaware/local-fs`: `key1=value1,key2=value2`, with an `all` fallback
 * for partition-less datasets. Characters outside `[A-Za-z0-9._=,-]`
 * become `_` so partition values cannot inject `/` and escape the
 * dataset directory.
 *
 * @param {QueryPartition} partition
 * @returns {string}
 */
export function partitionSegment(partition) {
  const entries = Object.entries(partition.partition ?? {})
  if (entries.length === 0) return 'all'
  return entries
    .map(([k, v]) => `${k}=${v}`)
    .join(',')
    .replace(/[^A-Za-z0-9._=,-]/g, '_')
}

/**
 * Render the S3 object key for `partition` + `filename` under `prefix`.
 * Always shaped as `<prefix>/<dataset>/<partition-segment>/<filename>`
 * (omitting `<prefix>/` when the prefix is empty). The result never
 * starts with `/` so it is a valid S3 object key.
 *
 * @param {Object} args
 * @param {string} args.prefix    Caller-supplied prefix. Leading/trailing slashes are stripped.
 * @param {QueryPartition} args.partition
 * @param {string} args.filename  Filename produced by the encoder (e.g. `all.parquet`).
 * @returns {string}
 */
export function renderObjectKey({ prefix, partition, filename }) {
  if (!partition || typeof partition.dataset !== 'string' || partition.dataset.length === 0) {
    throw new Error('renderObjectKey: partition.dataset is required')
  }
  if (typeof filename !== 'string' || filename.length === 0) {
    throw new Error('renderObjectKey: filename is required')
  }
  const cleanPrefix = normalizePrefix(prefix ?? '')
  const segment = partitionSegment(partition)
  const dataset = sanitizeSegment(partition.dataset)
  const safeFilename = sanitizeSegment(filename)
  const parts = []
  if (cleanPrefix.length > 0) parts.push(cleanPrefix)
  parts.push(dataset)
  parts.push(segment)
  parts.push(safeFilename)
  return parts.join('/')
}

/**
 * Strip any path traversal characters from a single path segment. The
 * partition partition object is user-controlled (it comes from
 * `dataset.discoverPartitions`); using a strict allowlist prevents a
 * malicious dataset key from emitting keys outside its prefix even if
 * the partition value somehow contained `/` or `..`.
 *
 * @param {string} value
 * @returns {string}
 */
function sanitizeSegment(value) {
  return value.replace(/[^A-Za-z0-9._=,-]/g, '_')
}

/**
 * Verify that a rendered key sits inside the configured prefix +
 * dataset namespace. Used as a final assertion before issuing PutObject
 * so we can never overwrite an object outside the intended directory
 * even if the prefix or partition rendering changes in the future.
 *
 * @param {Object} args
 * @param {string} args.prefix
 * @param {string} args.dataset
 * @param {string} args.key
 * @returns {boolean}
 */
export function keyIsWithinPrefix({ prefix, dataset, key }) {
  const cleanPrefix = normalizePrefix(prefix ?? '')
  const datasetSegment = sanitizeSegment(dataset)
  const expected = cleanPrefix.length > 0 ? `${cleanPrefix}/${datasetSegment}/` : `${datasetSegment}/`
  return key.startsWith(expected)
}
