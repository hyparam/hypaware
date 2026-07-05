// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'

import {
  loadMarker,
  markerKey,
  markerSubsumedBySnapshot,
  writeMarker,
} from '../../hypaware-core/plugins-workspace/format-iceberg/src/state.js'

/**
 * @import { BlobStore, HypError } from '../../hypaware-plugin-kernel-types.js'
 */

/**
 * @returns {{
 *   objects: Map<string, Uint8Array>,
 *   blobStore: BlobStore,
 * }}
 */
function makeBlobStore() {
  /** @type {Map<string, Uint8Array>} */
  const objects = new Map()
  return {
    objects,
    blobStore: {
      kind: 'memory',
      async putObject(input) {
        const bytes = input.body instanceof Uint8Array ? input.body : new Uint8Array()
        objects.set(input.key, bytes)
        return { key: input.key }
      },
      async getObject(input) {
        const bytes = objects.get(input.key)
        if (!bytes) return null
        return { body: Readable.from([bytes]), contentLength: bytes.byteLength }
      },
      listObjects() {
        return { async *[Symbol.asyncIterator]() {} }
      },
      async deleteObject(input) {
        objects.delete(input.key)
      },
    },
  }
}

test('markerKey renders <prefix>/state/exported-batches/<sink>/<dataset>/<batch>.json', () => {
  const key = markerKey('blob://iceberg/lake', 'archive', 'ai_gateway_messages', 'batch-2026-05-21')
  assert.equal(key, 'iceberg/lake/state/exported-batches/archive/ai_gateway_messages/batch-2026-05-21.json')
})

test('markerKey rejects empty segments with iceberg_state_invalid', () => {
  assert.throws(
    () => markerKey('iceberg/lake', '', 'ds', 'b'),
    (err) => /** @type {HypError} */ (err).hypErrorKind === 'iceberg_state_invalid'
  )
  assert.throws(
    () => markerKey('iceberg/lake', 'sink', 'ds', ''),
    (err) => /** @type {HypError} */ (err).hypErrorKind === 'iceberg_state_invalid'
  )
})

test('markerKey sanitizes path-separator characters out of dataset/batch ids', () => {
  const key = markerKey('iceberg/lake', 'archive', 'ds/with/slash', 'batch?evil')
  // `/` and `?` are both replaced with `_` so the marker stays inside
  // its parent prefix.
  assert.equal(key, 'iceberg/lake/state/exported-batches/archive/ds_with_slash/batch_evil.json')
})

test('writeMarker / loadMarker roundtrips a record verbatim', async () => {
  const fixture = makeBlobStore()
  const key = markerKey('iceberg/lake', 'archive', 'ds', 'b1')
  const marker = {
    dataset: 'ds',
    batchId: 'b1',
    partition: { partition: 'all' },
    rowCount: 50,
    bytesWritten: 12345,
    dataFiles: ['blob://iceberg/lake/ds/metadata/snap-1.avro'],
    snapshotId: '999',
    metadataVersion: 'v2',
    committedAt: '2026-05-21T17:08:00Z',
  }
  await writeMarker(fixture.blobStore, key, marker)
  const recovered = await loadMarker(fixture.blobStore, key)
  assert.deepEqual(recovered, marker)
})

test('loadMarker returns null for missing markers', async () => {
  const fixture = makeBlobStore()
  const recovered = await loadMarker(
    fixture.blobStore,
    markerKey('iceberg/lake', 'archive', 'ds', 'never-committed')
  )
  assert.equal(recovered, null)
})

test('loadMarker surfaces malformed JSON as iceberg_metadata_read_failed', async () => {
  const fixture = makeBlobStore()
  const key = markerKey('iceberg/lake', 'archive', 'ds', 'broken')
  fixture.objects.set(key, Buffer.from('{ not json', 'utf8'))
  await assert.rejects(
    () => loadMarker(fixture.blobStore, key),
    (err) => /** @type {HypError} */ (err).hypErrorKind === 'iceberg_metadata_read_failed'
  )
})

/**
 * @param {string} snapshotId
 */
function markerWithSnapshot(snapshotId) {
  return {
    dataset: 'ds',
    batchId: 'b',
    partition: {},
    rowCount: 0,
    bytesWritten: 0,
    dataFiles: [],
    snapshotId,
    metadataVersion: '',
    committedAt: '',
  }
}

test('markerSubsumedBySnapshot returns true when current snapshot matches the marker exactly', () => {
  assert.equal(markerSubsumedBySnapshot(null, { currentSnapshotId: '100', metadata: null }), false)
  assert.equal(markerSubsumedBySnapshot(markerWithSnapshot(''), { currentSnapshotId: '100', metadata: null }), false)
  assert.equal(markerSubsumedBySnapshot(markerWithSnapshot('100'), { currentSnapshotId: '100', metadata: null }), true)
  assert.equal(markerSubsumedBySnapshot(markerWithSnapshot('100'), { currentSnapshotId: '200', metadata: null }), false)
  assert.equal(markerSubsumedBySnapshot(markerWithSnapshot('100'), undefined), false)
})

test('markerSubsumedBySnapshot accepts a probe-state object and resolves equality without metadata', () => {
  assert.equal(
    markerSubsumedBySnapshot(markerWithSnapshot('100'), { currentSnapshotId: '100', metadata: null }),
    true
  )
  assert.equal(
    markerSubsumedBySnapshot(markerWithSnapshot('100'), { currentSnapshotId: '200', metadata: null }),
    false,
    'without metadata, only equality counts - ancestry cannot be proven'
  )
})

test('markerSubsumedBySnapshot walks parent-snapshot-id to recognise a superseded ancestor', () => {
  // Linear history S1 -> S2 -> S3. A marker for S1 must be considered
  // subsumed when current is S2 OR S3, because the rows the marker
  // recorded are already on the table via the ancestor chain.
  const metadata = /** @type {any} */ ({
    snapshots: [
      { 'snapshot-id': 100, 'parent-snapshot-id': undefined },
      { 'snapshot-id': 200, 'parent-snapshot-id': 100 },
      { 'snapshot-id': 300, 'parent-snapshot-id': 200 },
    ],
  })
  const marker = markerWithSnapshot('100')
  assert.equal(
    markerSubsumedBySnapshot(marker, { currentSnapshotId: '200', metadata }),
    true,
    'ancestor one step back must be recognised'
  )
  assert.equal(
    markerSubsumedBySnapshot(marker, { currentSnapshotId: '300', metadata }),
    true,
    'ancestor multiple steps back must be recognised'
  )
})

test('markerSubsumedBySnapshot returns false when the marker snapshot is no longer in the snapshot graph (expired)', () => {
  // Expired snapshots get pruned from `metadata.snapshots`. Without the
  // marker's snapshot in the graph we cannot prove ancestry, and
  // re-staging is the safe default.
  const metadata = /** @type {any} */ ({
    snapshots: [
      { 'snapshot-id': 300, 'parent-snapshot-id': 200 },
    ],
  })
  assert.equal(
    markerSubsumedBySnapshot(markerWithSnapshot('100'), { currentSnapshotId: '300', metadata }),
    false
  )
})

test('markerSubsumedBySnapshot tolerates a malformed cyclic parent chain without spinning', () => {
  // Defensive: a corrupted metadata that loops S1 -> S2 -> S1 should
  // not hang the supersedence walk. The walk is bounded by the
  // snapshots-array length and returns false on a cycle.
  const metadata = /** @type {any} */ ({
    snapshots: [
      { 'snapshot-id': 100, 'parent-snapshot-id': 200 },
      { 'snapshot-id': 200, 'parent-snapshot-id': 100 },
    ],
  })
  assert.equal(
    markerSubsumedBySnapshot(markerWithSnapshot('999'), { currentSnapshotId: '200', metadata }),
    false
  )
})
