// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { validateS3QuerySources } from '../../hypaware-core/plugins-workspace/s3/src/query-config.js'

test('validateS3QuerySources accepts parquet and iceberg sources', () => {
  const result = validateS3QuerySources([
    { name: 'events', format: 'parquet', prefix: 'exports/events/' },
    {
      name: 'ai_gw',
      format: 'iceberg',
      prefix: '/iceberg/datasets/ai_gateway_messages/',
      bucket: 'other-bucket',
      region: 'us-west-2',
      schema: [
        { name: 'id', type: 'INT64', nullable: false },
        { name: 'body', type: 'STRING', nullable: true },
      ],
    },
  ])
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.sources.length, 2)
  // prefixes are normalized (leading/trailing slashes stripped)
  assert.equal(result.sources[0].prefix, 'exports/events')
  assert.equal(result.sources[1].prefix, 'iceberg/datasets/ai_gateway_messages')
  assert.equal(result.sources[1].bucket, 'other-bucket')
  assert.equal(result.sources[1].schema?.length, 2)
})

test('validateS3QuerySources rejects a non-array', () => {
  const result = validateS3QuerySources({ name: 'x' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors[0].errorKind, 's3_query_source_invalid')
})

test('validateS3QuerySources reports stable pointers for malformed entries', () => {
  const result = validateS3QuerySources([
    { format: 'parquet', prefix: 'a' }, // missing name
    { name: 'b', format: 'csv', prefix: 'b' }, // bad format
    { name: 'c', format: 'parquet' }, // missing prefix
  ])
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.deepEqual(
    result.errors.map((e) => e.pointer).sort(),
    ['/0/name', '/1/format', '/2/prefix']
  )
  assert.ok(result.errors.every((e) => e.errorKind === 's3_query_source_invalid'))
})

test('validateS3QuerySources rejects duplicate names', () => {
  const result = validateS3QuerySources([
    { name: 'dup', format: 'parquet', prefix: 'a' },
    { name: 'dup', format: 'iceberg', prefix: 'b' },
  ])
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors[0].pointer, '/1/name')
  assert.match(result.errors[0].message, /duplicate/)
})

test('validateS3QuerySources validates declared column types', () => {
  const result = validateS3QuerySources([
    { name: 'x', format: 'parquet', prefix: 'a', schema: [{ name: 'c', type: 'WIDGET', nullable: false }] },
  ])
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors[0].pointer, '/0/schema/0/type')
})

test('validateS3QuerySources treats absent query_sources as caller concern (empty array ok)', () => {
  const result = validateS3QuerySources([])
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.sources.length, 0)
})

test('validateS3QuerySources rejects a prefix that normalizes to empty', () => {
  // "/" passes the non-empty string check but normalizes to "", which
  // would scope the dataset at the bucket root and union everything.
  const result = validateS3QuerySources([
    { name: 'events', format: 'parquet', prefix: '/' },
  ])
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors[0].pointer, '/0/prefix')
  assert.match(result.errors[0].message, /bucket root/)
})

test('validateS3QuerySources rejects an invalid endpoint_url at boot', () => {
  const result = validateS3QuerySources([
    { name: 'events', format: 'parquet', prefix: 'exports/events', endpoint_url: 'not-a-url' },
  ])
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors[0].pointer, '/0/endpoint_url')
  assert.equal(result.errors[0].errorKind, 's3_query_source_invalid')
})

test('validateS3QuerySources accepts a valid endpoint_url', () => {
  const result = validateS3QuerySources([
    { name: 'events', format: 'parquet', prefix: 'exports/events', endpoint_url: 'https://s3.example.com' },
  ])
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.sources[0].endpoint_url, 'https://s3.example.com')
})
