// @ts-check

import {
  fileCatalog,
  icebergAppend,
  icebergCreateTable,
  loadLatestFileCatalogMetadata,
} from 'icebird'

import { icebergSchemaForColumns, mergeFieldIdsFromTable, rowsToIcebergRecords } from './schema.js'

/** @typedef {import('../../../../collectivus-plugin-kernel-types').ColumnSpec} ColumnSpec */

/**
 * @typedef {Object} TableState
 * @property {boolean} exists                 True when at least one metadata file is visible.
 * @property {import('icebird/src/types.js').TableMetadata | null} metadata
 * @property {string | undefined} currentSnapshotId
 */

/**
 * @typedef {Object} CommitInput
 * @property {string} tableUrl                Table URL the resolver understands.
 * @property {readonly ColumnSpec[]} columns  Dataset column schema.
 * @property {readonly Record<string, unknown>[]} rows  Coerced records.
 * @property {import('icebird/src/types.js').Resolver} resolver
 * @property {import('icebird/src/types.js').Lister} lister
 */

/**
 * @typedef {Object} CommitResult
 * @property {string} snapshotId
 * @property {string} metadataVersion
 * @property {string[]} dataFiles
 * @property {number} bytesWritten
 * @property {number} rowCount
 */

/**
 * Probe the table for an existing snapshot. Returns `exists=false`
 * when no metadata file is visible yet; the sink uses that to decide
 * between `icebergCreateTable` + `icebergAppend` and a plain
 * `icebergAppend`.
 *
 * @param {string} tableUrl
 * @param {import('icebird/src/types.js').Resolver} resolver
 * @param {import('icebird/src/types.js').Lister} lister
 * @returns {Promise<TableState>}
 */
export async function probeTable(tableUrl, resolver, lister) {
  try {
    const { metadata } = await loadLatestFileCatalogMetadata({ tableUrl, resolver, lister })
    if (!metadata) {
      return { exists: false, metadata: null, currentSnapshotId: undefined }
    }
    const currentSnapshotId = metadata['current-snapshot-id']
    return {
      exists: true,
      metadata,
      currentSnapshotId: currentSnapshotId === undefined ? undefined : String(currentSnapshotId),
    }
  } catch (err) {
    // `loadLatestFileCatalogMetadata` throws when the metadata
    // directory is empty/missing. Treat ONLY explicit not-found
    // signals (ENOENT, "no metadata files" messages) as "table does
    // not exist yet"; transient read failures must propagate so the
    // sink driver can retry instead of silently re-driving `create`.
    if (isProbeMissError(err)) {
      return { exists: false, metadata: null, currentSnapshotId: undefined }
    }
    throw err
  }
}

/**
 * Commit a batch of rows onto `tableUrl`. Creates the table on first
 * use (initial commit), otherwise appends with field ids reconciled
 * against the existing schema (`mergeFieldIdsFromTable`).
 *
 * Returns a `CommitResult` describing the new snapshot so the caller
 * can persist an idempotency marker.
 *
 * @param {CommitInput} input
 * @param {{ exists: boolean, metadata: import('icebird/src/types.js').TableMetadata | null }} priorState
 * @returns {Promise<CommitResult>}
 */
export async function commitBatch(input, priorState) {
  const catalog = fileCatalog({
    resolver: input.resolver,
    lister: input.lister,
    conditionalCommits: true,
  })
  const targetSchema = priorState.exists && priorState.metadata
    ? schemaFromExistingMetadata(input.columns, priorState.metadata)
    : icebergSchemaForColumns(input.columns)

  // Coerce rows AFTER deciding the schema so type errors fire with the
  // user-facing schema (not the post-merge id-aware one). The two are
  // structurally equivalent for value coercion.
  const records = rowsToIcebergRecords(input.columns, input.rows)

  if (!priorState.exists) {
    try {
      await icebergCreateTable({
        catalog,
        tableUrl: input.tableUrl,
        schema: targetSchema,
        formatVersion: 3,
      })
    } catch (err) {
      throw wrapCommitError(err, 'iceberg_commit_failed', `create table failed at '${input.tableUrl}'`)
    }
  }

  /** @type {import('icebird/src/types.js').TableMetadata} */
  let postMetadata
  try {
    postMetadata = await icebergAppend({
      catalog,
      tableUrl: input.tableUrl,
      records,
    })
  } catch (err) {
    if (isConflictError(err)) {
      throw wrapCommitError(err, 'iceberg_commit_conflict', `append commit conflict at '${input.tableUrl}'`)
    }
    throw wrapCommitError(err, 'iceberg_commit_failed', `append failed at '${input.tableUrl}'`)
  }

  const snapshotId = postMetadata['current-snapshot-id']
  if (snapshotId === undefined) {
    throw newError(
      'iceberg_commit_failed',
      `iceberg-format: append at '${input.tableUrl}' produced no snapshot`
    )
  }
  const snapshot = (postMetadata.snapshots ?? []).find((s) => String(s['snapshot-id']) === String(snapshotId))
  const summary = snapshot?.summary ?? {}
  const dataFiles = readManifestList(snapshot)
  return {
    snapshotId: String(snapshotId),
    metadataVersion: `v${postMetadata['last-sequence-number'] ?? postMetadata['format-version'] ?? 1}`,
    dataFiles,
    bytesWritten: toNumber(summary['added-files-size']),
    rowCount: toNumber(summary['added-records']),
  }
}

/**
 * Pluck data-file paths out of the snapshot summary. Iceberg V2/V3
 * snapshots don't surface the path list directly; we use the manifest
 * list URL as a single-entry placeholder so the marker has something
 * stable to record. (A future cut may resolve the full data-file list
 * by walking the manifest.)
 *
 * @param {import('icebird/src/types.js').Snapshot | undefined} snapshot
 * @returns {string[]}
 */
function readManifestList(snapshot) {
  if (!snapshot) return []
  const listPath = /** @type {string|undefined} */ (snapshot['manifest-list'])
  return listPath ? [listPath] : []
}

/**
 * @param {readonly ColumnSpec[]} columns
 * @param {import('icebird/src/types.js').TableMetadata} metadata
 */
function schemaFromExistingMetadata(columns, metadata) {
  const currentSchemaId = metadata['current-schema-id']
  const schemas = metadata.schemas ?? []
  const existing = currentSchemaId !== undefined
    ? schemas.find((s) => s['schema-id'] === currentSchemaId)
    : schemas[schemas.length - 1]
  if (!existing) {
    return icebergSchemaForColumns(columns)
  }
  return mergeFieldIdsFromTable(columns, /** @type {any} */ (existing))
}

/**
 * @param {unknown} value
 */
function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return 0
}

/**
 * Restrict probe-miss classification to *explicit* not-found signals.
 *
 * The blob-io adapter raises `iceberg_metadata_read_failed` for two
 * structurally distinct conditions:
 *  - The object is genuinely missing — adapter sets `code = 'ENOENT'`.
 *  - The underlying read errored (timeout, throttle, 500, SDK failure)
 *    — adapter leaves `code` unset.
 *
 * Treating the kind alone as a miss conflates the two and lets a
 * flaky read drive the sink into `create` mode. Match only the
 * explicit ENOENT marker plus the well-known "no metadata files"
 * messages icebird raises when the metadata directory is genuinely
 * empty. Any other error surfaces upstream so the sink driver can
 * retry the batch.
 *
 * @param {unknown} err
 */
function isProbeMissError(err) {
  if (!err || typeof err !== 'object') return false
  const record = /** @type {Record<string, unknown>} */ (err)
  if (record.code === 'ENOENT') return true
  if (typeof record.message === 'string' && /no metadata files found|failed to determine latest iceberg version/.test(record.message)) {
    return true
  }
  return false
}

/**
 * @param {unknown} err
 */
function isConflictError(err) {
  if (!err || typeof err !== 'object') return false
  const record = /** @type {Record<string, unknown>} */ (err)
  if (record.hypErrorKind === 'iceberg_commit_conflict') return true
  if (record.status === 412 || record.statusCode === 412) return true
  if (record.status === 409 || record.statusCode === 409) return true
  if (typeof record.name === 'string' && record.name === 'IcebergTransactionConflictError') return true
  return false
}

/**
 * @param {unknown} err
 * @param {string} kind
 * @param {string} hint
 */
function wrapCommitError(err, kind, hint) {
  const message = err instanceof Error ? err.message : String(err)
  // If our adapter already tagged the error, prefer the adapter's
  // kind; the caller still gets to see the wrapper's hint via
  // `message` so the failure context isn't lost.
  if (err && typeof err === 'object') {
    const record = /** @type {Record<string, unknown>} */ (err)
    const innerKind = typeof record.hypErrorKind === 'string' ? record.hypErrorKind : undefined
    if (innerKind === 'iceberg_commit_conflict' || innerKind === 'iceberg_data_write_failed') {
      return newError(innerKind, `iceberg-format: ${hint}: ${message}`)
    }
  }
  return newError(kind, `iceberg-format: ${hint}: ${message}`)
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
