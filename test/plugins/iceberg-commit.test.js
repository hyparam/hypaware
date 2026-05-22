// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import {
  commitBatch,
  probeTable,
} from '../../hypaware-core/plugins-workspace/format-iceberg/src/commit.js'
import {
  createBlobStoreIO,
  tableUrlForBlobPrefix,
} from '../../hypaware-core/plugins-workspace/format-iceberg/src/blob-io.js'
import { createLocalFsBlobStore } from '../../hypaware-core/plugins-workspace/local-fs/src/blob-store.js'

/**
 * Build a real `@hypaware/local-fs` BlobStore over a fresh temp dir.
 * The commit module runs through icebird, which needs real bytes on
 * disk — an in-memory shim doesn't exercise the metadata read/write
 * cycle, so the test pins the contract by writing to disk.
 *
 * @returns {Promise<{ blobStore: import('../../collectivus-plugin-kernel-types').BlobStore, baseDir: string, cleanup: () => Promise<void> }>}
 */
async function freshLocalFsStore() {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-iceberg-commit-'))
  const blobStore = createLocalFsBlobStore({ baseDir })
  return {
    blobStore,
    baseDir,
    cleanup: () => fs.rm(baseDir, { recursive: true, force: true }),
  }
}

test('probeTable reports exists=false when no metadata has been written', async () => {
  const fixture = await freshLocalFsStore()
  try {
    const { resolver, lister } = await createBlobStoreIO(fixture.blobStore)
    const state = await probeTable(tableUrlForBlobPrefix('iceberg/datasets/empty'), resolver, lister)
    assert.equal(state.exists, false)
    assert.equal(state.metadata, null)
    assert.equal(state.currentSnapshotId, undefined)
  } finally {
    await fixture.cleanup()
  }
})

test('commitBatch creates an Iceberg table on first append and produces a snapshot', async () => {
  const fixture = await freshLocalFsStore()
  try {
    const { resolver, lister } = await createBlobStoreIO(fixture.blobStore)
    const tableUrl = tableUrlForBlobPrefix('iceberg/datasets/dummy_rows')
    const columns = /** @type {const} */ ([
      { name: 'id', type: 'INT64', nullable: false },
      { name: 'value', type: 'STRING', nullable: false },
    ])
    const rows = [
      { id: 1n, value: 'a' },
      { id: 2n, value: 'b' },
    ]
    const initial = await probeTable(tableUrl, resolver, lister)
    assert.equal(initial.exists, false)
    const result = await commitBatch(
      { tableUrl, columns, rows, resolver, lister },
      { exists: initial.exists, metadata: initial.metadata }
    )
    assert.ok(result.snapshotId.length > 0, 'snapshotId must be populated')
    assert.ok(result.rowCount === 2, `expected row_count=2, got ${result.rowCount}`)
    assert.ok(result.bytesWritten > 0, 'bytesWritten must be > 0 after a real commit')

    const subsequent = await probeTable(tableUrl, resolver, lister)
    assert.equal(subsequent.exists, true)
    assert.equal(subsequent.currentSnapshotId, result.snapshotId)
  } finally {
    await fixture.cleanup()
  }
})

test('commitBatch appends keep schema ids stable across batches', async () => {
  const fixture = await freshLocalFsStore()
  try {
    const { resolver, lister } = await createBlobStoreIO(fixture.blobStore)
    const tableUrl = tableUrlForBlobPrefix('iceberg/datasets/dummy_rows')
    const columns = /** @type {const} */ ([
      { name: 'id', type: 'INT64', nullable: false },
      { name: 'value', type: 'STRING', nullable: false },
    ])
    await commitBatch(
      { tableUrl, columns, rows: [{ id: 1n, value: 'a' }], resolver, lister },
      { exists: false, metadata: null }
    )
    const next = await probeTable(tableUrl, resolver, lister)
    const result = await commitBatch(
      { tableUrl, columns, rows: [{ id: 2n, value: 'b' }], resolver, lister },
      { exists: next.exists, metadata: next.metadata }
    )
    assert.notEqual(result.snapshotId, next.currentSnapshotId)

    const final = await probeTable(tableUrl, resolver, lister)
    // The merged schema preserves the original field ids (`id`->1, `value`->2)
    // because mergeFieldIdsFromTable rebinds them from the existing table.
    const schema = final.metadata?.schemas?.find((s) => s['schema-id'] === final.metadata?.['current-schema-id'])
      ?? final.metadata?.schemas?.[0]
    const fieldIds = (schema?.fields ?? []).map((f) => [f.name, f.id])
    assert.deepEqual(fieldIds, [['id', 1], ['value', 2]])
  } finally {
    await fixture.cleanup()
  }
})

test('commitBatch normalises blob_precondition_failed into iceberg_commit_conflict', async () => {
  // Build a stub BlobStore whose putObject always raises a
  // precondition-failed error for the metadata write. This proves the
  // adapter's conflict translation lands on the commit-level error
  // kind the spec calls out.
  /** @type {import('../../collectivus-plugin-kernel-types').BlobStore} */
  const blobStore = {
    kind: 'broken',
    async putObject(input) {
      // Allow data-file writes through; only metadata commits raise.
      if (!input.key.endsWith('.metadata.json')) {
        return { key: input.key }
      }
      const err = /** @type {Error & { errorKind?: string }} */ (
        new Error(`precondition failed for ${input.key}`)
      )
      err.errorKind = 'blob_precondition_failed'
      throw err
    },
    async getObject() {
      return null
    },
    listObjects() {
      return { async *[Symbol.asyncIterator]() {} }
    },
    async deleteObject() {},
  }
  const { resolver, lister } = await createBlobStoreIO(blobStore)
  await assert.rejects(
    () =>
      commitBatch(
        {
          tableUrl: tableUrlForBlobPrefix('iceberg/datasets/dummy_rows'),
          columns: [{ name: 'id', type: 'INT64', nullable: false }],
          rows: [{ id: 1n }],
          resolver,
          lister,
        },
        { exists: false, metadata: null }
      ),
    (err) => err.hypErrorKind === 'iceberg_commit_conflict'
  )
})
