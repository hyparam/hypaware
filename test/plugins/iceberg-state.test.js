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
 * @returns {{
 *   objects: Map<string, Uint8Array>,
 *   blobStore: import('../../collectivus-plugin-kernel-types').BlobStore,
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
    (err) => err.hypErrorKind === 'iceberg_state_invalid'
  )
  assert.throws(
    () => markerKey('iceberg/lake', 'sink', 'ds', ''),
    (err) => err.hypErrorKind === 'iceberg_state_invalid'
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
    (err) => err.hypErrorKind === 'iceberg_metadata_read_failed'
  )
})

test('markerSubsumedBySnapshot returns true only when marker snapshot matches current snapshot', () => {
  assert.equal(markerSubsumedBySnapshot(null, '100'), false)
  assert.equal(
    markerSubsumedBySnapshot(
      { dataset: 'ds', batchId: 'b', partition: {}, rowCount: 0, bytesWritten: 0, dataFiles: [], snapshotId: '', metadataVersion: '', committedAt: '' },
      '100'
    ),
    false
  )
  assert.equal(
    markerSubsumedBySnapshot(
      { dataset: 'ds', batchId: 'b', partition: {}, rowCount: 0, bytesWritten: 0, dataFiles: [], snapshotId: '100', metadataVersion: '', committedAt: '' },
      '100'
    ),
    true
  )
  assert.equal(
    markerSubsumedBySnapshot(
      { dataset: 'ds', batchId: 'b', partition: {}, rowCount: 0, bytesWritten: 0, dataFiles: [], snapshotId: '100', metadataVersion: '', committedAt: '' },
      '200'
    ),
    false
  )
  assert.equal(
    markerSubsumedBySnapshot(
      { dataset: 'ds', batchId: 'b', partition: {}, rowCount: 0, bytesWritten: 0, dataFiles: [], snapshotId: '100', metadataVersion: '', committedAt: '' },
      undefined
    ),
    false
  )
})
