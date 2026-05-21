// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { classifyAwsError, describeS3ErrorKind } from '../../hypaware-core/plugins-workspace/s3/src/errors.js'

test('classifyAwsError maps CredentialsProviderError to s3_credentials_missing', () => {
  const err = Object.assign(new Error('Could not load credentials from any provider'), {
    name: 'CredentialsProviderError',
  })
  assert.equal(classifyAwsError(err), 's3_credentials_missing')
})

test('classifyAwsError maps AccessDenied to s3_access_denied', () => {
  assert.equal(
    classifyAwsError({ name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }),
    's3_access_denied'
  )
})

test('classifyAwsError maps HTTP 403 even when name is generic', () => {
  assert.equal(
    classifyAwsError({ name: 'S3ServiceException', $metadata: { httpStatusCode: 403 } }),
    's3_access_denied'
  )
})

test('classifyAwsError maps NoSuchBucket to s3_bucket_missing', () => {
  assert.equal(classifyAwsError({ name: 'NoSuchBucket' }), 's3_bucket_missing')
})

test('classifyAwsError maps PermanentRedirect to s3_region_mismatch', () => {
  assert.equal(classifyAwsError({ name: 'PermanentRedirect' }), 's3_region_mismatch')
})

test('classifyAwsError maps AuthorizationHeaderMalformed to s3_region_mismatch', () => {
  assert.equal(
    classifyAwsError({ name: 'AuthorizationHeaderMalformed' }),
    's3_region_mismatch'
  )
})

test('classifyAwsError maps SlowDown to s3_throttled', () => {
  assert.equal(classifyAwsError({ name: 'SlowDown' }), 's3_throttled')
})

test('classifyAwsError maps HTTP 503 to s3_throttled', () => {
  assert.equal(
    classifyAwsError({ name: 'ServiceUnavailable', $metadata: { httpStatusCode: 503 } }),
    's3_throttled'
  )
})

test('classifyAwsError maps HTTP 429 to s3_throttled', () => {
  assert.equal(
    classifyAwsError({ name: 'TooManyRequestsException', $metadata: { httpStatusCode: 429 } }),
    's3_throttled'
  )
})

test('classifyAwsError uses .Code when .name is missing', () => {
  assert.equal(classifyAwsError({ Code: 'NoSuchBucket' }), 's3_bucket_missing')
  assert.equal(classifyAwsError({ Code: 'AccessDenied' }), 's3_access_denied')
  assert.equal(classifyAwsError({ Code: 'SlowDown' }), 's3_throttled')
})

test('classifyAwsError falls back to s3_put_failed for unknown errors', () => {
  assert.equal(classifyAwsError(new Error('some non-AWS thing exploded')), 's3_put_failed')
  assert.equal(classifyAwsError({ name: 'TotallyUnknownError' }), 's3_put_failed')
})

test('classifyAwsError survives non-object inputs', () => {
  assert.equal(classifyAwsError(null), 's3_put_failed')
  assert.equal(classifyAwsError(undefined), 's3_put_failed')
  assert.equal(classifyAwsError('string error'), 's3_put_failed')
  assert.equal(classifyAwsError(42), 's3_put_failed')
})

test('describeS3ErrorKind returns a non-empty diagnostic for every error kind', () => {
  /** @type {import('../../hypaware-core/plugins-workspace/s3/src/errors.js').S3ErrorKind[]} */
  const allKinds = [
    's3_config_invalid',
    's3_credentials_missing',
    's3_access_denied',
    's3_bucket_missing',
    's3_region_mismatch',
    's3_put_failed',
    's3_throttled',
    'encoder_failed',
  ]
  for (const kind of allKinds) {
    const description = describeS3ErrorKind(kind)
    assert.equal(typeof description, 'string')
    assert.ok(description.length > 0, `description for ${kind} should be non-empty`)
    assert.equal(/AKIA|secret|signature/i.test(description), false, `description must not leak credential material`)
  }
})
