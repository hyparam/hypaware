// @ts-check

import { Buffer } from 'node:buffer'

import { collectStream, pathToKey } from './blob-io.js'

/** @typedef {import('../../../../collectivus-plugin-kernel-types').BlobStore} BlobStore */

/**
 * Layout of idempotency markers under the sink instance's BlobStore.
 *
 *   <prefix>/state/exported-batches/<sink-instance>/<dataset>/<batch-id>.json
 *
 * The marker records the dataset, batch id, partition keys, row count,
 * data-file paths the writer staged, and the snapshot id the commit
 * produced. On retry the sink reads the marker first; if both the
 * marker and the snapshot it points at are visible we skip the
 * dataset; otherwise we re-stage.
 */
const STATE_DIR = 'state/exported-batches'

/**
 * @typedef {Object} ExportMarker
 * @property {string} dataset
 * @property {string} batchId
 * @property {Record<string, string>} partition
 * @property {number} rowCount
 * @property {number} bytesWritten
 * @property {string[]} dataFiles  Iceberg-relative or BlobStore-key data file paths.
 * @property {string} snapshotId   `current-snapshot-id` after the commit (stringified bigint or number).
 * @property {string} metadataVersion  e.g. `v3`.
 * @property {string} committedAt  ISO timestamp.
 */

/**
 * Build the BlobStore key for a marker.
 *
 * @param {string} prefix
 * @param {string} sinkInstance
 * @param {string} dataset
 * @param {string} batchId
 * @returns {string}
 */
export function markerKey(prefix, sinkInstance, dataset, batchId) {
  return joinKeys(
    pathToKey(prefix),
    STATE_DIR,
    sanitizeSegment(sinkInstance, 'sink-instance'),
    sanitizeSegment(dataset, 'dataset'),
    `${sanitizeSegment(batchId, 'batch-id')}.json`
  )
}

/**
 * Read an existing export marker. Returns `null` when no marker exists
 * (treated as "no prior attempt"). Any other read failure surfaces with
 * `iceberg_metadata_read_failed` so retries don't silently re-stage on
 * top of a healthy marker.
 *
 * @param {BlobStore} blobStore
 * @param {string} key
 * @returns {Promise<ExportMarker | null>}
 */
export async function loadMarker(blobStore, key) {
  let result
  try {
    result = await blobStore.getObject({ key })
  } catch (err) {
    throw newError(
      'iceberg_metadata_read_failed',
      `iceberg-format: marker read failed for '${key}': ${describeError(err)}`
    )
  }
  if (!result) return null
  const bytes = await collectStream(result.body)
  const text = Buffer.from(bytes).toString('utf8')
  try {
    return /** @type {ExportMarker} */ (JSON.parse(text))
  } catch (err) {
    throw newError(
      'iceberg_metadata_read_failed',
      `iceberg-format: marker JSON parse failed for '${key}': ${describeError(err)}`
    )
  }
}

/**
 * Write an export marker. Writes are non-conditional because the marker
 * is the *result* of a successful commit — overwriting a stale marker
 * is the desired behavior when a later snapshot subsumes the one the
 * marker referred to.
 *
 * @param {BlobStore} blobStore
 * @param {string} key
 * @param {ExportMarker} marker
 */
export async function writeMarker(blobStore, key, marker) {
  const body = Buffer.from(`${JSON.stringify(marker, null, 2)}\n`, 'utf8')
  try {
    await blobStore.putObject({ key, body, contentType: 'application/json' })
  } catch (err) {
    throw newError(
      'iceberg_data_write_failed',
      `iceberg-format: marker write failed for '${key}': ${describeError(err)}`
    )
  }
}

/**
 * Decide whether the marker proves the current batch has already
 * committed cleanly. A marker is considered "complete" when:
 *  - The marker exists.
 *  - It carries a non-empty `snapshotId`.
 *  - The current table snapshot id equals (or supersedes) the marker's
 *    snapshot id.
 *
 * The third clause is best-effort — `currentSnapshotId` may be
 * undefined when the table has been emptied or recreated. In that case
 * we treat the marker as STALE and the sink will re-stage.
 *
 * @param {ExportMarker | null} marker
 * @param {string | undefined} currentSnapshotId
 * @returns {boolean}
 */
export function markerSubsumedBySnapshot(marker, currentSnapshotId) {
  if (!marker) return false
  if (!marker.snapshotId) return false
  if (!currentSnapshotId) return false
  return String(currentSnapshotId) === String(marker.snapshotId) ||
    isSupersededBy(marker.snapshotId, currentSnapshotId)
}

/**
 * Heuristic for "this snapshot id is a strict ancestor of `current`".
 * Iceberg snapshot ids are non-monotonic in general (they're random
 * longs), but within a single-writer table the manifest's lineage walk
 * is what proves ancestry. The plugin caches that walk through the
 * marker itself: when the marker's snapshot equals current, we know
 * we're safe. When current is different we DON'T assume ancestry — we
 * re-stage. The function exists as a hook for a future ancestry
 * check; for now it always returns false.
 *
 * @param {string} _markerSnapshotId
 * @param {string} _currentSnapshotId
 * @returns {boolean}
 */
function isSupersededBy(_markerSnapshotId, _currentSnapshotId) {
  return false
}

/**
 * @param {...string} parts
 */
function joinKeys(...parts) {
  return parts
    .map((p) => stripSlashes(p))
    .filter((p) => p.length > 0)
    .join('/')
}

/**
 * @param {string} value
 */
function stripSlashes(value) {
  let v = value
  while (v.startsWith('/')) v = v.slice(1)
  while (v.endsWith('/')) v = v.slice(0, -1)
  return v
}

/**
 * Restrict path segments to a safe character class so a stray dataset
 * name like `foo/../bar` cannot escape the marker prefix.
 *
 * @param {string} value
 * @param {string} field
 */
function sanitizeSegment(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw newError(
      'iceberg_state_invalid',
      `iceberg-format: marker '${field}' must be a non-empty string`
    )
  }
  const cleaned = value.replace(/[^A-Za-z0-9._=,-]/g, '_')
  if (cleaned.length === 0) {
    throw newError(
      'iceberg_state_invalid',
      `iceberg-format: marker '${field}' sanitized to empty string from '${value}'`
    )
  }
  return cleaned
}

/**
 * @param {unknown} err
 */
function describeError(err) {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * @param {string} kind
 * @param {string} message
 */
function newError(kind, message) {
  const err = /** @type {Error & { hypErrorKind: string }} */ (new Error(message))
  err.hypErrorKind = kind
  return err
}
