// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizePrefix, validateS3SinkConfig } from '../../hypaware-core/plugins-workspace/s3/src/config.js'

test('validateS3SinkConfig accepts a minimum bucket-only config', () => {
  const result = validateS3SinkConfig({ bucket: 'acme' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.config.bucket, 'acme')
  assert.equal(result.config.prefix, '')
})

test('validateS3SinkConfig accepts a full real-AWS config shape', () => {
  const result = validateS3SinkConfig({
    bucket: 'acme',
    prefix: 'hypaware/',
    region: 'us-east-1',
    profile: 'staging',
    storage_class: 'STANDARD_IA',
    server_side_encryption: 'AES256',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.config.prefix, 'hypaware')
  assert.equal(result.config.region, 'us-east-1')
  assert.equal(result.config.profile, 'staging')
  assert.equal(result.config.storage_class, 'STANDARD_IA')
  assert.equal(result.config.server_side_encryption, 'AES256')
})

test('validateS3SinkConfig accepts an S3-compatible config (MinIO)', () => {
  const result = validateS3SinkConfig({
    bucket: 'acme',
    endpoint_url: 'http://localhost:9000',
    force_path_style: true,
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.config.endpoint_url, 'http://localhost:9000')
  assert.equal(result.config.force_path_style, true)
})

test('validateS3SinkConfig rejects missing bucket with s3_config_invalid', () => {
  const result = validateS3SinkConfig({ region: 'us-east-1' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors[0].errorKind, 's3_config_invalid')
  assert.equal(result.errors[0].pointer, '/bucket')
})

test('validateS3SinkConfig rejects non-string bucket', () => {
  const result = validateS3SinkConfig({ bucket: 123 })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors[0].errorKind, 's3_config_invalid')
  assert.equal(result.errors[0].pointer, '/bucket')
})

test('validateS3SinkConfig rejects non-object input', () => {
  const result = validateS3SinkConfig('not an object')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors[0].errorKind, 's3_config_invalid')
})

test('validateS3SinkConfig rejects unknown storage class', () => {
  const result = validateS3SinkConfig({ bucket: 'acme', storage_class: 'BANANA' })
  assert.equal(result.ok, false)
  if (result.ok) return
  const storageClassError = result.errors.find((e) => e.pointer === '/storage_class')
  assert.ok(storageClassError)
  assert.equal(storageClassError?.errorKind, 's3_config_invalid')
})

test('validateS3SinkConfig rejects malformed endpoint_url', () => {
  const result = validateS3SinkConfig({ bucket: 'acme', endpoint_url: 'not a url' })
  assert.equal(result.ok, false)
  if (result.ok) return
  const endpointError = result.errors.find((e) => e.pointer === '/endpoint_url')
  assert.ok(endpointError)
  assert.equal(endpointError?.errorKind, 's3_config_invalid')
})

test('validateS3SinkConfig rejects non-http(s) endpoint_url', () => {
  const result = validateS3SinkConfig({ bucket: 'acme', endpoint_url: 'ftp://example.com' })
  assert.equal(result.ok, false)
  if (result.ok) return
  const endpointError = result.errors.find((e) => e.pointer === '/endpoint_url')
  assert.ok(endpointError)
  assert.match(endpointError?.message ?? '', /http\(s\)/)
})

test('validateS3SinkConfig rejects non-boolean force_path_style', () => {
  const result = validateS3SinkConfig({ bucket: 'acme', force_path_style: 'yes' })
  assert.equal(result.ok, false)
  if (result.ok) return
  const error = result.errors.find((e) => e.pointer === '/force_path_style')
  assert.ok(error)
  assert.equal(error?.errorKind, 's3_config_invalid')
})

test('normalizePrefix strips leading and trailing slashes', () => {
  assert.equal(normalizePrefix('///foo/bar///'), 'foo/bar')
  assert.equal(normalizePrefix('foo/bar'), 'foo/bar')
  assert.equal(normalizePrefix(''), '')
  assert.equal(normalizePrefix('/'), '')
})
