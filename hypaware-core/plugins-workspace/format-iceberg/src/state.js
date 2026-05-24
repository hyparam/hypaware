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

/** @import { ExportMarker } from './types.d.ts' */

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

/** @import { ProbeStateLike } from './types.d.ts' */
/** @typedef {import('icebird/src/types.js').TableMetadata} TableMetadata */

/**
 * Decide whether the marker proves the current batch has already
 * committed cleanly. A marker is considered "complete" when:
 *  - The marker exists.
 *  - It carries a non-empty `snapshotId`.
 *  - The current table snapshot id either equals the marker's snapshot
 *    or descends from it (an ancestor walk over the table metadata).
 *
 * The third clause is best-effort: when `currentSnapshotId` is
 * undefined (empty / recreated table) or the marker's snapshot is no
 * longer in `metadata.snapshots` (expired), we cannot prove ancestry
 * and conservatively treat the marker as STALE. The sink will re-stage
 * in that case rather than risk silently swallowing rows that never
 * actually committed.
 *
 * @param {ExportMarker | null} marker
 * @param {ProbeStateLike | string | undefined} state
 *   The current probe state. A bare snapshot id string is accepted for
 *   backward compatibility — without metadata ancestry can only be
 *   proven via equality.
 * @returns {boolean}
 */
export function markerSubsumedBySnapshot(marker, state) {
  if (!marker) return false
  if (!marker.snapshotId) return false
  const { currentSnapshotId, metadata } = normalizeProbeState(state)
  if (!currentSnapshotId) return false
  if (String(currentSnapshotId) === String(marker.snapshotId)) return true
  return isAncestorSnapshot(marker.snapshotId, currentSnapshotId, metadata)
}

/**
 * @param {ProbeStateLike | string | undefined} state
 * @returns {{ currentSnapshotId: string | undefined, metadata: TableMetadata | null }}
 */
function normalizeProbeState(state) {
  if (typeof state === 'string') return { currentSnapshotId: state, metadata: null }
  if (!state) return { currentSnapshotId: undefined, metadata: null }
  return {
    currentSnapshotId: state.currentSnapshotId,
    metadata: state.metadata ?? null,
  }
}

/**
 * Walk `parent-snapshot-id` from `currentSnapshotId` looking for
 * `markerSnapshotId`. Returns true iff the marker's snapshot is a
 * strict ancestor of current — i.e. a commit landed on top of the
 * marker's snapshot via the usual single-writer linear history.
 *
 * Iceberg snapshot ids are random 64-bit longs, so a numeric compare
 * cannot order them. The only authoritative ancestry signal is the
 * snapshot graph carried by `metadata.snapshots`. When that graph is
 * unavailable (no metadata, snapshots array missing, marker's snapshot
 * expired out of the array), we return false and the caller re-stages.
 *
 * The walk is bounded by the array length to defend against any
 * malformed `parent-snapshot-id` cycle.
 *
 * @param {string} markerSnapshotId
 * @param {string} currentSnapshotId
 * @param {TableMetadata | null} metadata
 * @returns {boolean}
 */
function isAncestorSnapshot(markerSnapshotId, currentSnapshotId, metadata) {
  if (!metadata) return false
  const snapshots = metadata.snapshots
  if (!Array.isArray(snapshots) || snapshots.length === 0) return false
  /** @type {Map<string, string | undefined>} */
  const parents = new Map()
  for (const snap of snapshots) {
    const id = snap && /** @type {Record<string, unknown>} */ (snap)['snapshot-id']
    if (id === undefined || id === null) continue
    const parentRaw = /** @type {Record<string, unknown>} */ (snap)['parent-snapshot-id']
    const parent = parentRaw === undefined || parentRaw === null
      ? undefined
      : String(parentRaw)
    parents.set(String(id), parent)
  }
  const target = String(markerSnapshotId)
  let cursor = parents.get(String(currentSnapshotId))
  const maxSteps = parents.size
  for (let step = 0; step < maxSteps; step += 1) {
    if (cursor === undefined) return false
    if (cursor === target) return true
    cursor = parents.get(cursor)
  }
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
