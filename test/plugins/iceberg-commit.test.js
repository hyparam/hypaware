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
import { markerSubsumedBySnapshot } from '../../hypaware-core/plugins-workspace/format-iceberg/src/state.js'
import { createLocalFsBlobStore } from '../../hypaware-core/plugins-workspace/local-fs/src/blob-store.js'

/**
 * @import { BlobStore, HypError } from '../../collectivus-plugin-kernel-types.d.ts'
 */

/**
 * Build a real `@hypaware/local-fs` BlobStore over a fresh temp dir.
 * The commit module runs through icebird, which needs real bytes on
 * disk — an in-memory shim doesn't exercise the metadata read/write
 * cycle, so the test pins the contract by writing to disk.
 *
 * @returns {Promise<{ blobStore: BlobStore, baseDir: string, cleanup: () => Promise<void> }>}
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

test('commitBatch retries past a transient metadata precondition collision', async () => {
  // Simulates the S3 ifNoneMatch retry path: icebird issues v1.metadata.json
  // with ifNoneMatch='*', the blob-store reports a precondition collision
  // on the FIRST attempt only, and icebird's append retry loop is expected
  // to reload metadata + re-stage on its second pass.
  const fixture = await freshLocalFsStore()
  try {
    // Pre-create the table so we exercise the append retry path
    // (icebergCreateTable does not retry; icebergAppend does).
    const { resolver: r0, lister: l0 } = await createBlobStoreIO(fixture.blobStore)
    const tableUrl = tableUrlForBlobPrefix('iceberg/datasets/conflict')
    await commitBatch(
      {
        tableUrl,
        columns: [
          { name: 'id', type: 'INT64', nullable: false },
          { name: 'value', type: 'STRING', nullable: false },
        ],
        rows: [{ id: 1n, value: 'a' }],
        resolver: r0,
        lister: l0,
      },
      { exists: false, metadata: null }
    )

    // Wrap the underlying blob-store so the FIRST conditional metadata
    // put surfaces blob_precondition_failed (a 412 the writer maps to
    // iceberg_commit_conflict). The retry attempt is allowed through —
    // icebird should reload metadata, re-stage, and succeed.
    /** @type {{ key: string, ifNoneMatch?: string }[]} */
    const puts = []
    let firstConditionalMetadataAttempt = true
    const wrappedStore = /** @type {BlobStore} */ ({
      kind: 'wrapped',
      async putObject(input) {
        puts.push({ key: input.key, ifNoneMatch: input.ifNoneMatch })
        if (
          firstConditionalMetadataAttempt &&
          /metadata\/v\d+\.metadata\.json$/.test(input.key) &&
          input.ifNoneMatch === '*'
        ) {
          firstConditionalMetadataAttempt = false
          const err = /** @type {Error & { errorKind?: string }} */ (
            new Error('precondition failed (simulated concurrent writer)')
          )
          err.errorKind = 'blob_precondition_failed'
          throw err
        }
        return fixture.blobStore.putObject(input)
      },
      getObject(input) { return fixture.blobStore.getObject(input) },
      listObjects(input) { return fixture.blobStore.listObjects(input) },
      async deleteObject(input) {
        if (fixture.blobStore.deleteObject) await fixture.blobStore.deleteObject(input)
      },
    })

    const { resolver, lister } = await createBlobStoreIO(wrappedStore)
    const next = await probeTable(tableUrl, resolver, lister)
    const result = await commitBatch(
      {
        tableUrl,
        columns: [
          { name: 'id', type: 'INT64', nullable: false },
          { name: 'value', type: 'STRING', nullable: false },
        ],
        rows: [{ id: 2n, value: 'b' }],
        resolver,
        lister,
      },
      { exists: next.exists, metadata: next.metadata }
    )
    assert.ok(result.snapshotId.length > 0, 'append must produce a snapshot after retry')

    // The retry was actually exercised: at least one v?.metadata.json
    // attempt failed (the simulated collision) and the eventual metadata
    // write landed on a later version.
    const metadataAttempts = puts.filter((p) => /metadata\/v\d+\.metadata\.json$/.test(p.key))
    assert.ok(metadataAttempts.length >= 2,
      `expected >=2 metadata-write attempts (had ${metadataAttempts.length})`)
    for (const attempt of metadataAttempts) {
      assert.equal(attempt.ifNoneMatch, '*',
        'every metadata commit must travel with ifNoneMatch=*')
    }
    assert.equal(firstConditionalMetadataAttempt, false,
      'the simulated precondition collision must have been triggered')

    // Reader sees the final snapshot end-to-end.
    const final = await probeTable(tableUrl, resolver, lister)
    assert.equal(final.exists, true)
    assert.equal(final.currentSnapshotId, result.snapshotId)
  } finally {
    await fixture.cleanup()
  }
})

test('commitBatch surfaces iceberg_commit_conflict when initial create races', async () => {
  // Two writers concurrently try to create the same table. icebergCreateTable
  // does NOT retry, so the second writer must see iceberg_commit_conflict
  // bubble out instead of a misleading iceberg_commit_failed.
  const fixture = await freshLocalFsStore()
  try {
    const tableUrl = tableUrlForBlobPrefix('iceberg/datasets/race')
    const columns = /** @type {const} */ ([
      { name: 'id', type: 'INT64', nullable: false },
      { name: 'value', type: 'STRING', nullable: false },
    ])
    const { resolver: rA, lister: lA } = await createBlobStoreIO(fixture.blobStore)
    const { resolver: rB, lister: lB } = await createBlobStoreIO(fixture.blobStore)

    const winnerFirst = commitBatch(
      { tableUrl, columns, rows: [{ id: 1n, value: 'a' }], resolver: rA, lister: lA },
      { exists: false, metadata: null }
    )
    // Wait for the winner to complete so the second create sees v1
    // already on disk; O_EXCL guarantees the conflict surfaces.
    await winnerFirst
    await assert.rejects(
      () =>
        commitBatch(
          { tableUrl, columns, rows: [{ id: 2n, value: 'b' }], resolver: rB, lister: lB },
          { exists: false, metadata: null }
        ),
      (err) => /** @type {HypError} */ (err).hypErrorKind === 'iceberg_commit_conflict',
    )
  } finally {
    await fixture.cleanup()
  }
})

test('probeTable discovers latest snapshot when version-hint.text is stale', async () => {
  // The reader must fall back to listing the metadata/ directory when
  // version-hint.text points at an older version. icebird's
  // loadLatestFileCatalogMetadata reads the listing first; we prove it
  // here by overwriting version-hint.text with stale content after a
  // commit and asserting the next probe still sees the latest snapshot.
  const fixture = await freshLocalFsStore()
  try {
    const tableUrl = tableUrlForBlobPrefix('iceberg/datasets/stale_hint')
    const columns = /** @type {const} */ ([
      { name: 'id', type: 'INT64', nullable: false },
      { name: 'value', type: 'STRING', nullable: false },
    ])
    const { resolver, lister } = await createBlobStoreIO(fixture.blobStore)

    await commitBatch(
      { tableUrl, columns, rows: [{ id: 1n, value: 'a' }], resolver, lister },
      { exists: false, metadata: null }
    )
    const afterFirst = await probeTable(tableUrl, resolver, lister)
    const firstSnapshot = afterFirst.currentSnapshotId

    const second = await commitBatch(
      { tableUrl, columns, rows: [{ id: 2n, value: 'b' }], resolver, lister },
      { exists: afterFirst.exists, metadata: afterFirst.metadata }
    )
    assert.notEqual(second.snapshotId, firstSnapshot)

    // Rewind the hint to v1 (stale) and confirm the reader still sees v2.
    const hintPath = path.join(fixture.baseDir,
      'iceberg', 'datasets', 'stale_hint', 'metadata', 'version-hint.text')
    await fs.writeFile(hintPath, '1\n')
    const reread = await probeTable(tableUrl, resolver, lister)
    assert.equal(reread.exists, true,
      'table must remain discoverable when version-hint is stale')
    assert.equal(reread.currentSnapshotId, second.snapshotId,
      'reader must surface the latest snapshot via listing fallback')
  } finally {
    await fixture.cleanup()
  }
})

test('probeTable discovers latest snapshot when version-hint.text is missing', async () => {
  const fixture = await freshLocalFsStore()
  try {
    const tableUrl = tableUrlForBlobPrefix('iceberg/datasets/missing_hint')
    const columns = /** @type {const} */ ([
      { name: 'id', type: 'INT64', nullable: false },
    ])
    const { resolver, lister } = await createBlobStoreIO(fixture.blobStore)
    const create = await commitBatch(
      { tableUrl, columns, rows: [{ id: 1n }], resolver, lister },
      { exists: false, metadata: null }
    )
    // Delete the hint file entirely.
    const hintPath = path.join(fixture.baseDir,
      'iceberg', 'datasets', 'missing_hint', 'metadata', 'version-hint.text')
    await fs.rm(hintPath)

    const reread = await probeTable(tableUrl, resolver, lister)
    assert.equal(reread.currentSnapshotId, create.snapshotId,
      'reader must still resolve metadata without version-hint.text')
  } finally {
    await fixture.cleanup()
  }
})

test('markerSubsumedBySnapshot recognises a marker whose snapshot is an ancestor of the current snapshot (no duplicate rows on retry)', async () => {
  // End-to-end shape of the codex finding: commit batch A, advance the
  // snapshot with batch B, then re-load the marker for A against the
  // post-B probe state. The supersedence check must report true so the
  // sink skips re-staging A and the table never accumulates duplicate
  // rows from a retried-after-success batch.
  const fixture = await freshLocalFsStore()
  try {
    const { resolver, lister } = await createBlobStoreIO(fixture.blobStore)
    const tableUrl = tableUrlForBlobPrefix('iceberg/datasets/supersede')
    const columns = /** @type {const} */ ([
      { name: 'id', type: 'INT64', nullable: false },
      { name: 'value', type: 'STRING', nullable: false },
    ])

    const initial = await probeTable(tableUrl, resolver, lister)
    const aCommit = await commitBatch(
      { tableUrl, columns, rows: [{ id: 1n, value: 'a' }], resolver, lister },
      { exists: initial.exists, metadata: initial.metadata }
    )
    const markerA = {
      dataset: 'supersede',
      batchId: 'batch-A',
      partition: {},
      rowCount: aCommit.rowCount,
      bytesWritten: aCommit.bytesWritten,
      dataFiles: aCommit.dataFiles,
      snapshotId: aCommit.snapshotId,
      metadataVersion: aCommit.metadataVersion,
      committedAt: '2026-05-22T00:00:00Z',
    }

    // Advance the table snapshot with batch B.
    const afterA = await probeTable(tableUrl, resolver, lister)
    await commitBatch(
      { tableUrl, columns, rows: [{ id: 2n, value: 'b' }], resolver, lister },
      { exists: afterA.exists, metadata: afterA.metadata }
    )

    // Probe again after B lands; metadata.snapshots now lists both
    // snapshots and the current snapshot's parent is A's snapshot.
    const afterB = await probeTable(tableUrl, resolver, lister)
    assert.notEqual(afterB.currentSnapshotId, aCommit.snapshotId,
      'snapshot must have advanced past batch A')
    assert.equal(
      markerSubsumedBySnapshot(markerA, afterB),
      true,
      'a marker pointing at an ancestor snapshot must be recognised as subsumed so retries are no-ops'
    )

    // Equivalence guard: the marker for the latest snapshot should
    // still self-match. Catches a regression that breaks the equality
    // path while wiring up ancestry.
    const markerCurrent = { ...markerA, snapshotId: afterB.currentSnapshotId ?? '' }
    assert.equal(markerSubsumedBySnapshot(markerCurrent, afterB), true)
  } finally {
    await fixture.cleanup()
  }
})

test('probeTable propagates transient metadata read failures instead of masking them as miss', async () => {
  // Regression guard for the codex finding: when the blob-store
  // reader raises iceberg_metadata_read_failed for a *transient*
  // failure (no `code` field, kind is the same as a true miss),
  // probeTable used to swallow it and return `exists=false`. That
  // would drive the sink into a fresh `create` path against an
  // existing table. The reader must surface the real error so the
  // sink driver can retry.
  /** @type {BlobStore} */
  const blobStore = {
    kind: 'transient-fail',
    async putObject() {
      throw new Error('unused in test')
    },
    async getObject(input) {
      // listObjects returned a metadata file, so the reader is asked
      // to fetch it. Raise a non-fatal transient error: not in the
      // FATAL_KINDS set, no `code='ENOENT'`. The reader will wrap
      // this as iceberg_metadata_read_failed without an ENOENT
      // marker — exactly the shape the previous probeTable masked.
      const err = /** @type {Error & { errorKind?: string }} */ (
        new Error(`simulated transient read failure for ${input.key}`)
      )
      err.errorKind = 's3_put_failed'
      throw err
    },
    listObjects(input) {
      return {
        async *[Symbol.asyncIterator]() {
          if (!input.prefix?.endsWith('/metadata/')) return
          yield { key: `${input.prefix}v1.metadata.json`, size: 0, lastModified: new Date(0) }
        },
      }
    },
    async deleteObject() {},
  }
  const { resolver, lister } = await createBlobStoreIO(blobStore)
  await assert.rejects(
    () => probeTable(tableUrlForBlobPrefix('iceberg/datasets/transient'), resolver, lister),
    (err) => {
      const e = /** @type {HypError} */ (err)
      return e.hypErrorKind === 'iceberg_metadata_read_failed' && e.code !== 'ENOENT'
    },
    'transient read must surface, not be masked as a probe miss'
  )
})

test('commitBatch normalises blob_precondition_failed into iceberg_commit_conflict', async () => {
  // Build a stub BlobStore whose putObject always raises a
  // precondition-failed error for the metadata write. This proves the
  // adapter's conflict translation lands on the commit-level error
  // kind the spec calls out.
  /** @type {BlobStore} */
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
    (err) => /** @type {HypError} */ (err).hypErrorKind === 'iceberg_commit_conflict'
  )
})
