// @ts-check

import {
  fileCatalog,
  icebergAppend,
  icebergCreateTable,
  loadLatestFileCatalogMetadata,
} from 'icebird'

import { validatePartitionSpecStability } from '../../../../src/core/iceberg/partition-spec.js'

import { icebergSchemaForColumns, mergeFieldIdsFromTable, rowsToIcebergRecords } from './schema.js'

/**
 * @import { ColumnSpec } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { CommitInput, CommitResult, DatasetPartitioning, TableState } from './types.js'
 * @import { Lister, PartitionSpec, Resolver, Snapshot, TableMetadata } from 'icebird/src/types.js'
 */

/**
 * Probe the table for an existing snapshot. Returns `exists=false`
 * when no metadata file is visible yet; the sink uses that to decide
 * between `icebergCreateTable` + `icebergAppend` and a plain
 * `icebergAppend`.
 *
 * @param {string} tableUrl
 * @param {Resolver} resolver
 * @param {Lister} lister
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
 * @param {{ exists: boolean, metadata: TableMetadata | null }} priorState
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
      // @ref LLP 0022#partition-derivation: create with the writer-owned
      // day-grain partitionSpec + conversation sort order. Both default to
      // unpartitioned/unsorted in icebird when `partitioning` is absent.
      await icebergCreateTable({
        catalog,
        tableUrl: input.tableUrl,
        schema: targetSchema,
        formatVersion: 3,
        partitionSpec: input.partitioning?.partitionSpec,
        sortOrder: input.partitioning?.sortOrder,
      })
    } catch (err) {
      throw wrapCommitError(err, 'iceberg_commit_failed', `create table failed at '${input.tableUrl}'`)
    }
  } else if (priorState.metadata) {
    // @ref LLP 0022#drift-rejection: an existing table whose partition spec no
    // longer matches the dataset's derived day grain is rejected; the export
    // cannot retroactively repartition object-store data files. [constrained-by]
    const existingSpec = currentPartitionSpec(priorState.metadata) ?? { 'spec-id': 0, fields: [] }
    if (input.partitioning) {
      try {
        validatePartitionSpecStability(input.partitioning.declaration, existingSpec, targetSchema)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw newError(
          'iceberg_partition_spec_drift',
          `iceberg-format: partition spec drift at '${input.tableUrl}': ${message}`
        )
      }
    } else if (existingSpec.fields.length > 0) {
      // Reverse drift: the dataset stopped deriving partitioning but the
      // table on disk is partitioned. The append itself would succeed (icebird
      // keeps routing rows through the existing spec) while the sink reports
      // `unpartitioned`. Reject rather than let layout and telemetry diverge.
      const existingLabel = existingSpec.fields.map((f) => `${f.transform}(${f.name})`).join(',')
      throw newError(
        'iceberg_partition_spec_drift',
        `iceberg-format: partition spec drift at '${input.tableUrl}': dataset derives no partitioning but the existing table is partitioned (${existingLabel})`
      )
    }
  }

  /** @type {TableMetadata} */
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
    metadata: postMetadata,
  }
}

const DEFAULT_STREAM_BYTE_LIMIT = 128 * 1024 * 1024
const DEFAULT_STREAM_ROW_LIMIT = 100_000

/**
 * Stream rows from an async iterable and commit them in target-sized
 * batches.  Each batch is a single Iceberg append; the table is
 * created on the first non-empty batch.
 *
 * Returns cumulative stats across all committed batches.
 *
 * @param {{
 *   tableUrl: string,
 *   columns: readonly ColumnSpec[],
 *   rows: AsyncIterable<Record<string, unknown>>,
 *   resolver: Resolver,
 *   lister: Lister,
 *   partitioning?: DatasetPartitioning | null,
 * }} input
 * @param {{ exists: boolean, metadata: TableMetadata | null }} priorState
 * @param {{ batchByteLimit?: number, batchRowLimit?: number }} [opts]
 * @returns {Promise<{ snapshotId: string, metadataVersion: string, bytesWritten: number, rowCount: number, batchCount: number, dataFiles: string[] }>}
 */
export async function commitRowStream(input, priorState, opts = {}) {
  const batchByteLimit = opts.batchByteLimit ?? DEFAULT_STREAM_BYTE_LIMIT
  const batchRowLimit = opts.batchRowLimit ?? DEFAULT_STREAM_ROW_LIMIT

  let state = { exists: priorState.exists, metadata: priorState.metadata }
  let totalBytesWritten = 0
  let totalRowCount = 0
  let batchCount = 0
  let lastSnapshotId = ''
  let lastMetadataVersion = ''
  /** @type {string[]} */
  const allDataFiles = []

  /** @type {Record<string, unknown>[]} */
  let batch = []
  let batchBytes = 0

  async function flushBatch() {
    if (batch.length === 0) return
    const result = await commitBatch(
      { tableUrl: input.tableUrl, columns: input.columns, rows: batch, resolver: input.resolver, lister: input.lister, partitioning: input.partitioning },
      state
    )
    state = { exists: true, metadata: result.metadata }
    totalBytesWritten += result.bytesWritten
    totalRowCount += result.rowCount || batch.length
    batchCount += 1
    lastSnapshotId = result.snapshotId
    lastMetadataVersion = result.metadataVersion
    allDataFiles.push(...result.dataFiles)
    batch = []
    batchBytes = 0
  }

  for await (const row of input.rows) {
    batch.push(row)
    batchBytes += Buffer.byteLength(jsonStringifyBigIntSafe(row), 'utf8')
    if (batch.length >= batchRowLimit || batchBytes >= batchByteLimit) {
      await flushBatch()
    }
  }
  await flushBatch()

  return { snapshotId: lastSnapshotId, metadataVersion: lastMetadataVersion, bytesWritten: totalBytesWritten, rowCount: totalRowCount, batchCount, dataFiles: allDataFiles }
}

/**
 * Pluck data-file paths out of the snapshot summary. Iceberg V2/V3
 * snapshots don't surface the path list directly; we use the manifest
 * list URL as a single-entry placeholder so the marker has something
 * stable to record. (A future cut may resolve the full data-file list
 * by walking the manifest.)
 *
 * @param {Snapshot | undefined} snapshot
 * @returns {string[]}
 */
function readManifestList(snapshot) {
  if (!snapshot) return []
  const listPath = /** @type {string|undefined} */ (snapshot['manifest-list'])
  return listPath ? [listPath] : []
}

/**
 * @param {readonly ColumnSpec[]} columns
 * @param {TableMetadata} metadata
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
  return mergeFieldIdsFromTable(columns, existing)
}

/**
 * Resolve the table's current `PartitionSpec` from metadata (the default spec,
 * falling back to the last). Used for the on-append drift check.
 *
 * @param {TableMetadata} metadata
 * @returns {PartitionSpec | undefined}
 */
function currentPartitionSpec(metadata) {
  const specId = metadata['default-spec-id']
  const specs = metadata['partition-specs']
  if (specs?.length) {
    const match = specs.find((s) => s['spec-id'] === specId)
    return match ?? specs[specs.length - 1]
  }
  return undefined
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
 *  - The object is genuinely missing: adapter sets `code = 'ENOENT'`.
 *  - The underlying read errored (timeout, throttle, 500, SDK failure)
 *    Adapter leaves `code` unset.
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
 * @param {unknown} value
 * @returns {string}
 */
function jsonStringifyBigIntSafe(value) {
  return JSON.stringify(value, (_key, v) =>
    typeof v === 'bigint' ? Number(v) : v
  )
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
