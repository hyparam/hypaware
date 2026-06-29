// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { keyIsWithinPrefix, partitionSegment, renderObjectKey } from '../../hypaware-core/plugins-workspace/s3/src/keys.js'

test('partitionSegment renders empty partition as "all"', () => {
  assert.equal(partitionSegment({ dataset: 'logs', partition: {} }), 'all')
})

test('partitionSegment joins ordered key=value pairs', () => {
  assert.equal(
    partitionSegment({ dataset: 'logs', partition: { date: '2026-05-21' } }),
    'date=2026-05-21'
  )
})

test('partitionSegment strips path-separator characters so the segment cannot escape its dataset directory', () => {
  // `/` is the only character that lets a key escape its S3 "directory"
  // because S3 prefix listing is purely lexical against `/`. Literal `.`
  // (and even `..`) inside one segment is harmless.
  const seg = partitionSegment({ dataset: 'logs', partition: { date: '../etc/passwd' } })
  assert.equal(seg.includes('/'), false)
  assert.equal(seg.includes('\\'), false)
  assert.match(seg, /^date=/)
})

test('renderObjectKey composes prefix/dataset/segment/filename', () => {
  const key = renderObjectKey({
    prefix: 'hypaware',
    partition: { dataset: 'ai_gateway_messages', partition: {} },
    filename: 'all.parquet',
  })
  assert.equal(key, 'hypaware/ai_gateway_messages/all/all.parquet')
})

test('renderObjectKey omits the prefix segment when prefix is empty', () => {
  const key = renderObjectKey({
    prefix: '',
    partition: { dataset: 'logs', partition: {} },
    filename: 'all.parquet',
  })
  assert.equal(key, 'logs/all/all.parquet')
})

test('renderObjectKey normalizes leading and trailing slashes in prefix', () => {
  const key = renderObjectKey({
    prefix: '///hypaware///',
    partition: { dataset: 'logs', partition: { date: '2026-05-21' } },
    filename: 'all.parquet',
  })
  assert.equal(key, 'hypaware/logs/date=2026-05-21/all.parquet')
})

test('renderObjectKey strips path separators from dataset and filename so the key stays inside the configured prefix', () => {
  const key = renderObjectKey({
    prefix: 'acme',
    partition: { dataset: '../escape', partition: {} },
    filename: '../../etc/passwd',
  })
  // Exactly three separators (prefix / dataset / segment / filename), so
  // the inputs cannot inject any more.
  assert.equal((key.match(/\//g) ?? []).length, 3)
  assert.equal(key.startsWith('acme/'), true)
  // The dangerous substring `/etc/` (with separators on both sides)
  // cannot survive, even though the individual letters do.
  assert.equal(key.includes('/etc/'), false)
})

test('renderObjectKey requires a non-empty dataset', () => {
  assert.throws(
    () =>
      renderObjectKey({
        prefix: 'acme',
        partition: /** @type {any} */ ({ dataset: '', partition: {} }),
        filename: 'all.parquet',
      }),
    /dataset/
  )
})

test('renderObjectKey requires a non-empty filename', () => {
  assert.throws(
    () =>
      renderObjectKey({
        prefix: 'acme',
        partition: { dataset: 'logs', partition: {} },
        filename: '',
      }),
    /filename/
  )
})

test('keyIsWithinPrefix accepts keys under the prefix+dataset namespace', () => {
  assert.equal(
    keyIsWithinPrefix({
      prefix: 'hypaware',
      dataset: 'logs',
      key: 'hypaware/logs/date=2026-05-21/all.parquet',
    }),
    true
  )
})

test('keyIsWithinPrefix rejects keys outside the prefix+dataset namespace', () => {
  assert.equal(
    keyIsWithinPrefix({
      prefix: 'hypaware',
      dataset: 'logs',
      key: 'hypaware/other_dataset/key.parquet',
    }),
    false
  )
  assert.equal(
    keyIsWithinPrefix({
      prefix: 'hypaware',
      dataset: 'logs',
      key: 'random/logs/key.parquet',
    }),
    false
  )
})

test('keyIsWithinPrefix tolerates an empty prefix', () => {
  assert.equal(
    keyIsWithinPrefix({ prefix: '', dataset: 'logs', key: 'logs/all/all.parquet' }),
    true
  )
  assert.equal(
    keyIsWithinPrefix({ prefix: '', dataset: 'logs', key: 'logs_other/all.parquet' }),
    false
  )
})
